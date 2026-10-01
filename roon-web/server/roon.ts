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
  conn: object;
}

interface CloseAwareConnection {
  onclosed?: () => void;
}

export interface RoonHealth {
  connected: boolean;
  connecting: boolean;
}

/**
 * Owns one live, session-scoped client and replaces it after terminal close.
 * A client instance is never reused: its declarations, graph object ids and
 * session ids all belong to the socket on which it was created.
 */
export class RoonPool<T extends ConnectableClient> {
  private active: T | null = null;
  private connecting: Promise<T> | null = null;
  private connectingToken: symbol | null = null;

  constructor(private readonly create: () => T) {}

  get(): Promise<T> {
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
        if (this.active === candidate) this.active = null;
      }
    };

    const token = Symbol('connect attempt');
    this.connectingToken = token;
    const attempt = (async () => {
      try {
        await candidate.connect();
        if (closed) throw new Error('broker connection closed while connecting');
        this.active = candidate;
        return candidate;
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
    return this.active;
  }

  health(): RoonHealth {
    return { connected: this.active !== null, connecting: this.connecting !== null };
  }
}

const pool = new RoonPool(
  () => new RoonClient({ host: HOST, serverBrokerId: SERVER_BROKER_ID })
);

export async function getRoon(): Promise<RoonClient> {
  return pool.get();
}

export function currentRoon(): RoonClient | null {
  return pool.current();
}

export function roonHealth(): RoonHealth {
  return pool.health();
}
