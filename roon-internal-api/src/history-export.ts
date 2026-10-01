import { CatalogParam } from './catalog/signature';
import { readFlexLong } from './proto/flex';
import { PropertyType, RoonObject } from './proto/objects';
import { CallResult } from './proto/remoting';
import { Arg, buildArgs, inlineStruct } from './proto/serializer';
import { BinaryWriter } from './proto/writer';

const SIG_RETAIN_PAGE =
  'Sooloos.Broker.Api.VirtualHistoryPlayQuery::RetainPage(int, Base.ResultCallback)';
const SIG_RELEASE_PAGE =
  'Sooloos.Broker.Api.VirtualHistoryPlayQuery::ReleasePage(int, Base.ResultCallback)';
const SIG_DISPOSE = 'Sooloos.Broker.Api.VirtualHistoryPlayQuery::Dispose()';

const TICKS_MASK = (1n << 62n) - 1n;
const UNIX_EPOCH_TICKS = 621355968000000000n;

interface HistoryGraph {
  findByType(shortName: string): RoonObject[];
  getObject(oid: bigint | number): RoonObject | undefined;
}

interface HistoryRemoting {
  defineType(typeName: string, members?: { name: string; propType: number }[]): number;
  callMethod(objectId: bigint | number, signature: string, args: Buffer): Promise<CallResult>;
  callMethodNoReply(objectId: bigint | number, signature: string, args: Buffer): void;
}

export interface HistoryExportClient {
  readonly graph: HistoryGraph;
  readonly remoting: HistoryRemoting;
  profile(): Buffer;
  structArg(
    typeName: string,
    fields: { name: string; propType: PropertyType; value: Buffer }[]
  ): Buffer;
  call(
    service: string,
    method: string,
    params: CatalogParam[],
    args: Buffer,
    objectId?: bigint
  ): Promise<CallResult>;
}

export interface HistoryExportOptions {
  limit: number;
  pageSize?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface HistoryEvent {
  playedAt: string;
  artist: string;
  title: string;
  album?: string;
  completionPct?: number;
  roonTrackId?: string;
}

function field(o: RoonObject | undefined, suffix: string): unknown {
  if (!o) return undefined;
  return Object.entries(o.fields).find(([key]) => key.endsWith(suffix))?.[1];
}

function refOf(value: unknown): bigint | undefined {
  if (value && typeof value === 'object' && '$ref' in value) {
    return BigInt(String((value as { $ref: unknown }).$ref));
  }
  return undefined;
}

function normalizedTicks(raw: bigint): bigint {
  return raw & TICKS_MASK;
}

function dotnetTicksToIso(raw: bigint): string {
  return new Date(Number((normalizedTicks(raw) - UNIX_EPOCH_TICKS) / 10000n)).toISOString();
}

async function pollFor<T>(
  label: string,
  timeoutMs: number,
  pollIntervalMs: number,
  read: () => T | undefined
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

function assembleEvent(client: HistoryExportClient, play: RoonObject): HistoryEvent | undefined {
  const time = field(play, '::Time');
  if (typeof time !== 'bigint') return undefined;

  const trackRef = refOf(field(play, '::Track'));
  const track = trackRef === undefined ? undefined : client.graph.getObject(trackRef);
  const albumRef = refOf(field(track, '::Album'));
  const album = albumRef === undefined ? undefined : client.graph.getObject(albumRef);
  const title = field(track, '::Title');
  const artist = field(album, '::PerformedBy');
  if (typeof title !== 'string' || typeof artist !== 'string') return undefined;

  const event: HistoryEvent = {
    playedAt: dotnetTicksToIso(time),
    artist,
    title,
  };
  const albumTitle = field(album, '::Title');
  if (typeof albumTitle === 'string') event.album = albumTitle;
  const secondsPlayed = field(play, '::SecondsPlayed');
  const lengthSeconds = field(track, '::LengthSeconds');
  if (typeof secondsPlayed === 'number' && typeof lengthSeconds === 'number' && lengthSeconds > 0) {
    event.completionPct = Math.min(100, Math.round((secondsPlayed / lengthSeconds) * 1000) / 10);
  }
  const link = field(play, '::TrackBase');
  if (link && typeof link === 'object') {
    const trackId = Object.entries(link as Record<string, unknown>).find(([key]) =>
      key.endsWith('::TrackId')
    )?.[1];
    if (trackId !== undefined) event.roonTrackId = String(trackId);
  }
  return event;
}

function validateOptions(options: HistoryExportOptions): Required<HistoryExportOptions> {
  const pageSize = options.pageSize ?? 100;
  const timeoutMs = options.timeoutMs ?? 5000;
  const pollIntervalMs = options.pollIntervalMs ?? 150;
  if (!Number.isSafeInteger(options.limit) || options.limit < 0) {
    throw new Error('history limit must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new Error('history page size must be a positive safe integer');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error('history timeout must be finite and non-negative');
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new Error('history poll interval must be finite and non-negative');
  }
  return { limit: options.limit, pageSize, timeoutMs, pollIntervalMs };
}

/**
 * Export play history through the read-only VirtualHistoryQuery lifecycle.
 * A resolved call is complete: it either returns exactly min(Count, limit)
 * hydrated records, or throws rather than silently returning a partial export.
 */
export async function exportPlayHistory(
  client: HistoryExportClient,
  options: HistoryExportOptions
): Promise<{ total: number; events: HistoryEvent[] }> {
  const { limit, pageSize, timeoutMs, pollIntervalMs } = validateOptions(options);

  const criteria = inlineStruct(
    client.remoting.defineType('Sooloos.Broker.Api.HistoryQueryCriteria', [])
  );
  const params = client.structArg('Sooloos.Broker.Api.VirtualQueryParameters', [
    {
      name: 'int Sooloos.Broker.Api.VirtualQueryParameters::PageSize',
      propType: PropertyType.Int,
      value: new BinaryWriter().integer(pageSize).toBuffer(),
    },
  ]);
  const args = Buffer.concat([buildArgs([Arg.sooid(client.profile())]), criteria, params]);
  const result = await client.call(
    'Library',
    'VirtualHistoryQuery',
    [
      { type: 'Sooid', name: 'profileid' },
      { type: 'HistoryQueryCriteria', name: 'criteria' },
      { type: 'VirtualQueryParameters', name: 'queryparams' },
      { type: 'ResultCallback<VirtualHistoryPlayQuery>', name: 'cb' },
    ],
    args
  );
  if (!result.success) throw new Error(`VirtualHistoryQuery failed: ${result.status}`);
  const [queryOid] = readFlexLong(Uint8Array.from(result.payload), 0);

  try {
    const total = await pollFor('history Count', timeoutMs, pollIntervalMs, () => {
      const count = field(client.graph.getObject(queryOid), '::Count');
      if (count === undefined) return undefined;
      if (!Number.isSafeInteger(count) || (count as number) < 0) {
        throw new Error(`invalid history Count: ${String(count)}`);
      }
      return count as number;
    });
    const target = Math.min(total, limit);
    if (target === 0) return { total, events: [] };

    const plays = new Map<string, RoonObject>();
    const harvest = (): number => {
      for (const play of client.graph.findByType('HistoryPlay')) {
        plays.set(play.oid.toString(), play);
      }
      return plays.size;
    };
    harvest();

    for (let page = 0; plays.size < target && page < Math.ceil(target / pageSize); page++) {
      let acquired = false;
      try {
        const retained = await client.remoting.callMethod(
          queryOid,
          SIG_RETAIN_PAGE,
          buildArgs([Arg.int(page)])
        );
        if (!retained.success) throw new Error(`RetainPage(${page}) failed: ${retained.status}`);
        acquired = true;
        const pageTarget = Math.min(target, (page + 1) * pageSize);
        await pollFor(`history page ${page}`, timeoutMs, pollIntervalMs, () =>
          harvest() >= pageTarget ? plays.size : undefined
        );
      } finally {
        if (acquired) {
          client.remoting.callMethodNoReply(
            queryOid,
            SIG_RELEASE_PAGE,
            buildArgs([Arg.int(page)])
          );
        }
      }
    }

    if (plays.size < target) {
      throw new Error(`history export incomplete: received ${plays.size} of ${target} play(s)`);
    }

    const sortable = await pollFor('history play timestamps', timeoutMs, pollIntervalMs, () => {
      const candidates = [...plays.values()];
      return candidates.every((play) => typeof field(play, '::Time') === 'bigint')
        ? candidates
        : undefined;
    });
    const selected = sortable
      .sort((a, b) => {
        const aTicks = normalizedTicks(field(a, '::Time') as bigint);
        const bTicks = normalizedTicks(field(b, '::Time') as bigint);
        return aTicks === bTicks ? a.oid.toString().localeCompare(b.oid.toString()) : aTicks > bTicks ? -1 : 1;
      })
      .slice(0, target);
    if (selected.length < target) {
      throw new Error(`history export incomplete: ${target - selected.length} play(s) missing Time`);
    }

    const events = await pollFor('history record hydration', timeoutMs, pollIntervalMs, () => {
      const hydrated = selected.map((play) => assembleEvent(client, play));
      return hydrated.every((event): event is HistoryEvent => event !== undefined)
        ? hydrated
        : undefined;
    });
    return { total, events };
  } finally {
    client.remoting.callMethodNoReply(queryOid, SIG_DISPOSE, Buffer.alloc(0));
  }
}
