import { readFlexInt, writeFlexLong } from './proto/flex';
import { RoonObject } from './proto/objects';
import { CallResult } from './proto/remoting';
import { HistoryExportClient, exportPlayHistory } from './history-export';

const QUERY_OID = 700n;
const EPOCH_TICKS = 621355968000000000n;
const KIND_UTC = 1n << 62n;

function ok(payload: Buffer = Buffer.alloc(0)): CallResult {
  return { success: true, status: 'Success', payload };
}

function queryPayload(): Buffer {
  const bytes: number[] = [];
  writeFlexLong(bytes, QUERY_OID);
  return Buffer.from(bytes);
}

function object(oid: bigint, typeName: string, fields: Record<string, unknown>): RoonObject {
  return { oid, typeId: 1, typeName: `Sooloos.Broker.Api.${typeName}`, fields };
}

function addPlay(
  objects: Map<string, RoonObject>,
  oid: bigint,
  seconds: number,
  complete = true
): RoonObject {
  const albumOid = oid + 10000n;
  const trackOid = oid + 20000n;
  const play = object(oid, 'HistoryPlay', {
    'long Sooloos.Broker.Api.HistoryPlay::HistoryPlayId': oid + 30000n,
    'System.DateTime Sooloos.Broker.Api.HistoryPlay::Time': KIND_UTC + EPOCH_TICKS + BigInt(seconds) * 10000000n,
    'Sooloos.Broker.Api.TrackLite Sooloos.Broker.Api.HistoryPlay::Track': { $ref: trackOid },
  });
  objects.set(oid.toString(), play);
  if (complete) {
    objects.set(trackOid.toString(), object(trackOid, 'TrackLite', {
      'string Sooloos.Broker.Api.TrackLite::Title': `Track ${seconds}`,
      'Sooloos.Broker.Api.AlbumLite Sooloos.Broker.Api.TrackLite::Album': { $ref: albumOid },
    }));
    objects.set(albumOid.toString(), object(albumOid, 'AlbumLite', {
      'string Sooloos.Broker.Api.AlbumLite::PerformedBy': `Artist ${seconds}`,
    }));
  }
  return play;
}

function mockClient(
  total: number,
  onRetain?: (page: number, objects: Map<string, RoonObject>) => CallResult | Promise<CallResult>,
  onNoReply?: (signature: string, objects: Map<string, RoonObject>) => void
) {
  const objects = new Map<string, RoonObject>();
  objects.set(QUERY_OID.toString(), object(QUERY_OID, 'VirtualHistoryPlayQuery', {
    'int Sooloos.Broker.Api.VirtualHistoryPlayQuery::Count': total,
  }));
  const noReply: string[] = [];
  const retainPages: number[] = [];
  const queryCalls = { count: 0 };
  const client: HistoryExportClient = {
    graph: {
      findByType: (name) => [...objects.values()].filter((item) => item.typeName.endsWith(`.${name}`)),
      getObject: (oid) => objects.get(oid.toString()),
    },
    remoting: {
      defineType: () => 1,
      callMethod: async (_oid, signature, args) => {
        expect(signature).toContain('::RetainPage');
        const [page] = readFlexInt(Uint8Array.from(args), 0);
        retainPages.push(page);
        return onRetain ? onRetain(page, objects) : ok();
      },
      callMethodNoReply: (_oid, signature) => {
        noReply.push(signature);
        onNoReply?.(signature, objects);
      },
    },
    profile: () => Buffer.alloc(16),
    structArg: () => Buffer.alloc(0),
    call: async () => {
      queryCalls.count++;
      return ok(queryPayload());
    },
  };
  return { client, objects, noReply, retainPages, queryCalls };
}

const options = { limit: 10, pageSize: 2, timeoutMs: 20, pollIntervalMs: 0 };

describe('exportPlayHistory', () => {
  test('exports a hydrated page and disposes the query', async () => {
    const mock = mockClient(2, (_page, objects) => {
      addPlay(objects, 1n, 1);
      addPlay(objects, 2n, 2);
      return ok();
    });

    const result = await exportPlayHistory(mock.client, options);

    expect(result.total).toBe(2);
    expect(result.events.map((event) => event.title)).toEqual(['Track 2', 'Track 1']);
    expect(mock.noReply.filter((signature) => signature.includes('ReleasePage'))).toHaveLength(1);
    expect(mock.noReply.at(-1)).toContain('::Dispose()');
  });

  test('returns an empty export without retaining a page', async () => {
    const mock = mockClient(0);

    await expect(exportPlayHistory(mock.client, options)).resolves.toEqual({
      total: 0,
      events: [],
      skipped: 0,
      duplicates: 0,
    });
    expect(mock.retainPages).toEqual([]);
    expect(mock.noReply).toHaveLength(1);
    expect(mock.noReply[0]).toContain('::Dispose()');
  });

  test('loads multiple pages and accepts a legitimate short final page', async () => {
    const mock = mockClient(3, (page, objects) => {
      if (page === 0) {
        addPlay(objects, 1n, 1);
        addPlay(objects, 2n, 2);
      } else {
        addPlay(objects, 3n, 3);
      }
      return ok();
    });

    const result = await exportPlayHistory(mock.client, options);

    expect(result.events.map((event) => event.title)).toEqual(['Track 3', 'Track 2', 'Track 1']);
    expect(mock.retainPages).toEqual([0, 1]);
    expect(mock.noReply.filter((signature) => signature.includes('ReleasePage'))).toHaveLength(2);
  });

  test('fails when Count never arrives and still disposes the query', async () => {
    const mock = mockClient(1);
    mock.objects.get(QUERY_OID.toString())!.fields = {};

    await expect(exportPlayHistory(mock.client, options)).rejects.toThrow('timed out waiting for history Count');
    expect(mock.noReply.at(-1)).toContain('::Dispose()');
  });

  test('fails a rejected retain without releasing an unacquired page', async () => {
    const mock = mockClient(1, () => ({ success: false, status: 'Denied', payload: Buffer.alloc(0) }));

    await expect(exportPlayHistory(mock.client, options)).rejects.toThrow('RetainPage(0) failed: Denied');
    expect(mock.noReply.filter((signature) => signature.includes('ReleasePage'))).toHaveLength(0);
    expect(mock.noReply.at(-1)).toContain('::Dispose()');
  });

  test('fails a stalled page and releases it exactly once', async () => {
    const mock = mockClient(1, () => ok());

    await expect(exportPlayHistory(mock.client, options)).rejects.toThrow('timed out waiting for history page 0');
    expect(mock.noReply.filter((signature) => signature.includes('ReleasePage'))).toHaveLength(1);
    expect(mock.noReply.at(-1)).toContain('::Dispose()');
  });

  test('fails when a retained page never receives its required identity', async () => {
    const mock = mockClient(1, (_page, objects) => {
      const play = addPlay(objects, 1n, 1);
      delete play.fields['long Sooloos.Broker.Api.HistoryPlay::HistoryPlayId'];
      return ok();
    });

    await expect(exportPlayHistory(mock.client, options)).rejects.toThrow(
      'timed out waiting for history page 0 identity and Time'
    );
    expect(mock.noReply.filter((signature) => signature.includes('ReleasePage'))).toHaveLength(1);
    expect(mock.noReply.at(-1)).toContain('::Dispose()');
  });

  test('tracks mutable plays by oid and waits for delayed identity and referenced fields', async () => {
    const mock = mockClient(2, (_page, objects) => {
      const play = addPlay(objects, 9n, 9, false);
      delete play.fields['long Sooloos.Broker.Api.HistoryPlay::HistoryPlayId'];
      setTimeout(() => {
        play.fields['long Sooloos.Broker.Api.HistoryPlay::HistoryPlayId'] = EPOCH_TICKS + 9n;
      }, 1);
      setTimeout(() => {
        const trackOid = 20009n;
        const albumOid = 10009n;
        objects.set(trackOid.toString(), object(trackOid, 'TrackLite', {
          'string Sooloos.Broker.Api.TrackLite::Title': 'Delayed track',
          'Sooloos.Broker.Api.AlbumLite Sooloos.Broker.Api.TrackLite::Album': { $ref: albumOid },
        }));
        objects.set(albumOid.toString(), object(albumOid, 'AlbumLite', {
          'string Sooloos.Broker.Api.AlbumLite::PerformedBy': 'Delayed artist',
        }));
        addPlay(objects, 10n, 10);
      }, 2);
      return ok();
    });

    const result = await exportPlayHistory(mock.client, options);

    expect(result.events).toHaveLength(2);
    expect(result.events[1]).toMatchObject({ title: 'Delayed track', artist: 'Delayed artist' });
  });

  test('sorts normalized DateTime ticks before applying the limit', async () => {
    const mock = mockClient(3, (_page, objects) => {
      addPlay(objects, 3n, 2);
      addPlay(objects, 1n, 3);
      addPlay(objects, 2n, 1);
      return ok();
    });

    const result = await exportPlayHistory(mock.client, { ...options, limit: 2, pageSize: 3 });

    expect(result.events.map((event) => event.title)).toEqual(['Track 3', 'Track 2']);
  });

  test('retains the full boundary page through delayed hydration before sorting and limiting', async () => {
    let newestTimer: NodeJS.Timeout | undefined;
    const mock = mockClient(
      3,
      (_page, objects) => {
        addPlay(objects, 1n, 1);
        addPlay(objects, 2n, 2);
        newestTimer = setTimeout(() => addPlay(objects, 3n, 3), 25);
        return ok();
      },
      (signature) => {
        if (signature.includes('ReleasePage') && newestTimer) clearTimeout(newestTimer);
      }
    );

    const result = await exportPlayHistory(mock.client, {
      limit: 2,
      pageSize: 3,
      timeoutMs: 80,
      pollIntervalMs: 1,
    });

    expect(result.events.map((event) => event.title)).toEqual(['Track 3', 'Track 2']);
    expect(mock.noReply.filter((signature) => signature.includes('ReleasePage'))).toHaveLength(1);
  });

  test('skips permanently unresolved display references without aborting valid records', async () => {
    const mock = mockClient(3, (_page, objects) => {
      addPlay(objects, 1n, 1);
      addPlay(objects, 2n, 2);
      addPlay(objects, 3n, 3, false);
      return ok();
    });

    const result = await exportPlayHistory(mock.client, {
      limit: 2,
      pageSize: 3,
      timeoutMs: 10,
      pollIntervalMs: 0,
    });

    expect(result.events.map((event) => event.title)).toEqual(['Track 2', 'Track 1']);
    expect(result.skipped).toBe(1);
  });

  test('deduplicates different graph objects with the same opaque HistoryPlayId', async () => {
    const mock = mockClient(2, (_page, objects) => {
      const first = addPlay(objects, 1n, 1);
      const second = addPlay(objects, 2n, 2);
      second.fields['long Sooloos.Broker.Api.HistoryPlay::HistoryPlayId'] =
        first.fields['long Sooloos.Broker.Api.HistoryPlay::HistoryPlayId'];
      return ok();
    });

    const result = await exportPlayHistory(mock.client, options);

    expect(result.events.map((event) => event.title)).toEqual(['Track 2']);
    expect(result.duplicates).toBe(1);
  });

  test('fails closed when a reused client graph already contains history objects', async () => {
    const mock = mockClient(1, (_page, objects) => {
      addPlay(objects, 1n, 1);
      return ok();
    });
    await exportPlayHistory(mock.client, options);

    await expect(exportPlayHistory(mock.client, options)).rejects.toThrow(
      'history export requires a fresh client graph'
    );
    expect(mock.queryCalls.count).toBe(1);
  });

  test('rejects invalid limits before dispatching a query', async () => {
    const mock = mockClient(0);

    await expect(exportPlayHistory(mock.client, { limit: Number.POSITIVE_INFINITY })).rejects.toThrow(
      'history limit must be a non-negative safe integer'
    );
  });
});
