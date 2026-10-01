/**
 * Single persistent RoonClient connection to the core, shared by the whole
 * backend. Object ids are session-scoped, so we keep exactly one connection.
 */
import { RoonClient } from '../../roon-internal-api/src/index';

const HOST = process.env.ROON_HOST || 'YOUR_CORE_IP';
const SERVER_BROKER_ID = Buffer.from(
  process.env.ROON_SERVER_BROKER_ID || 'YOUR_SERVER_BROKER_ID',
  'hex'
);

interface ConnectableClient {
  connect(): Promise<void>;
  close(): void;
  conn: object;
}

interface CloseAwareConnection {
  onclosed?: () => void;
}

export interface RoonHealth {
  connected: boolean;
  connecting: boolean;
  generation: number | null;
}

export interface RoonSession<T> {
  client: T;
  generation: number;
}

export interface RoonSessionChange {
  connected: boolean;
  generation: number;
}

/**
 * Owns one live, session-scoped client and replaces it after terminal close.
 * A client instance is never reused: its declarations, graph object ids and
 * session ids all belong to the socket on which it was created.
 */
export class RoonPool<T extends ConnectableClient> {
  private active: RoonSession<T> | null = null;
  private connecting: Promise<RoonSession<T>> | null = null;
  private connectingToken: symbol | null = null;
  private nextGeneration = 1;
  private readonly listeners = new Set<(change: RoonSessionChange) => void>();

  constructor(private readonly create: () => T) {}

  async get(): Promise<T> {
    return (await this.getSession()).client;
  }

  getSession(): Promise<RoonSession<T>> {
    if (this.active) return Promise.resolve(this.active);
    if (this.connecting) return this.connecting;

    const candidate = this.create();
    const conn = candidate.conn as CloseAwareConnection;
    const sdkOnclosed = conn.onclosed ?? (() => {});
    let closed = false;

    conn.onclosed = () => {
      try {
        sdkOnclosed.call(conn);
      } finally {
        closed = true;
        if (this.active?.client === candidate) {
          const { generation } = this.active;
          this.active = null;
          this.emit({ connected: false, generation });
        }
      }
    };

    const token = Symbol('connect attempt');
    this.connectingToken = token;
    const attempt = (async () => {
      try {
        // Defer invocation so even a synchronous connect() throw cannot race
        // the assignment of this attempt into the coalescing slot below.
        await Promise.resolve().then(() => candidate.connect());
        if (closed) throw new Error('broker connection closed while connecting');
        const session = { client: candidate, generation: this.nextGeneration++ };
        this.active = session;
        this.emit({ connected: true, generation: session.generation });
        return session;
      } catch (error) {
        try { candidate.close(); } catch { /* retain the setup failure */ }
        throw error;
      } finally {
        if (this.connectingToken === token) {
          this.connecting = null;
          this.connectingToken = null;
        }
      }
    })();
    this.connecting = attempt;
    return attempt;
  }

  current(): T | null {
    return this.active?.client ?? null;
  }

  currentSession(): RoonSession<T> | null {
    return this.active;
  }

  health(): RoonHealth {
    return {
      connected: this.active !== null,
      connecting: this.connecting !== null,
      generation: this.active?.generation ?? null,
    };
  }

  onChange(listener: (change: RoonSessionChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: RoonSessionChange): void {
    for (const listener of this.listeners) {
      try { listener(change); } catch { /* observers cannot break ownership */ }
    }
  }
}

const pool = new RoonPool(
  () => new RoonClient({ host: HOST, serverBrokerId: SERVER_BROKER_ID })
);

export async function getRoon(): Promise<RoonClient> {
  return pool.get();
}

export function getRoonSession(): Promise<RoonSession<RoonClient>> {
  return pool.getSession();
}

export function currentRoon(): RoonClient | null {
  return pool.current();
}

export function currentRoonSession(): RoonSession<RoonClient> | null {
  return pool.currentSession();
}

export function roonHealth(): RoonHealth {
  return pool.health();
}

export function onRoonSessionChange(listener: (change: RoonSessionChange) => void): () => void {
  return pool.onChange(listener);
}
