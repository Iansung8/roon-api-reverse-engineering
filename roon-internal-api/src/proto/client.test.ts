import { RoonClient } from './client';
import { RemotingClient, Cmd, Transport } from './remoting';
import { FrameParser, encodeResponse } from './frame';
import { BinaryWriter } from './writer';
import { BinaryReader } from './reader';
import { RoonObject } from './objects';

class MockTransport implements Transport {
  sent: Buffer[] = [];
  private handler: (c: Buffer) => void = () => {};
  send(data: Buffer) {
    this.sent.push(data);
  }
  onData(h: (c: Buffer) => void) {
    this.handler = h;
  }
  deliver(data: Buffer) {
    this.handler(data);
  }
  sentFrames() {
    const p = new FrameParser();
    return p.push(Buffer.concat(this.sent));
  }
}

/** A RoonClient wired to a mock transport instead of a live socket. */
function buildClient(profileSooid?: Buffer) {
  const t = new MockTransport();
  const c = new RoonClient({ host: 'test', serverBrokerId: Buffer.alloc(16), profileSooid });
  // Swap the remoting layer for one on the mock transport (readonly is
  // compile-time only); keep pushes flowing into the same graph.
  (c as any).remoting = new RemotingClient(t);
  c.remoting.onPush = (f) => c.graph.ingest(f);
  (c as any).searchSettleMs = 30; // keep the test fast
  return { c, t };
}

function seed(c: RoonClient, oid: bigint, typeName: string, fields: Record<string, unknown> = {}) {
  c.graph.objects.set(oid.toString(), { oid, typeId: 0, typeName, fields } as RoonObject);
}

const PROFILE_ID = Buffer.from('3f01162027273a55d64bbf4a85f335410e2f', 'hex');

function seedCore(c: RoonClient) {
  seed(c, 43n, 'Sooloos.Broker.Api.Library');
  seed(c, 124n, 'Sooloos.Broker.Api.Profile', {
    'Sooloos.Broker.Api.Profile::ProfileId': PROFILE_ID,
  });
}

interface DeclaredType {
  name: string;
  members: { name: string; propType: number }[];
}

function declaredTypes(t: MockTransport): Map<number, DeclaredType> {
  const types = new Map<number, DeclaredType>();
  for (const frame of t.sentFrames().filter((f) => f.cmd === Cmd.DEFTYPE)) {
    const r = new BinaryReader(frame.body);
    const id = r.flexInt();
    const name = r.string() ?? '';
    const members = Array.from({ length: r.flexInt() }, () => ({
      name: r.string() ?? '',
      propType: r.integer(),
    }));
    types.set(id, { name, members });
  }
  return types;
}

function inlineValue(r: BinaryReader): { typeId: number; body: BinaryReader } {
  expect(r.long()).toBe(1n);
  const typeId = r.flexInt();
  return { typeId, body: new BinaryReader(r.bytes(r.flexInt())) };
}

async function completeLatestCall(t: MockTransport, result: Promise<unknown>): Promise<void> {
  const call = t.sentFrames().filter((f) => f.cmd === Cmd.CALL).at(-1)!;
  t.deliver(encodeResponse(call.rid!, new BinaryWriter().string('').toBuffer(), true));
  await result;
}

function latestAlbumEdit(t: MockTransport): { memberName: string; value: BinaryReader } {
  const types = declaredTypes(t);
  const call = t.sentFrames().filter((f) => f.cmd === Cmd.CALL).at(-1)!;
  const callBody = new BinaryReader(call.body);
  callBody.long(); // Library service oid
  callBody.flexInt(); // Edit method id

  const libraryEdit = inlineValue(callBody);
  const libraryBody = libraryEdit.body;
  expect(libraryBody.flexInt()).toBe(1); // LibraryEdit::Albums
  const albumsBlob = new BinaryReader(libraryBody.bytes(libraryBody.integer()));
  expect(albumsBlob.flexInt()).toBe(1); // one AlbumEdit

  const albumEdit = inlineValue(albumsBlob);
  const albumType = types.get(albumEdit.typeId)!;
  const albumBody = albumEdit.body;
  expect(albumBody.flexInt()).toBe(1); // AlbumId
  albumBody.long();
  const memberIndex = albumBody.flexInt();
  return {
    memberName: albumType.members[memberIndex - 1].name,
    value: albumBody,
  };
}

describe('profile resolution', () => {
  test('profile() reads the ProfileId from the graph Profile object', () => {
    const { c } = buildClient();
    seedCore(c);
    expect(c.profile().toString('hex')).toBe(PROFILE_ID.toString('hex'));
  });

  test('an explicit profileSooid option wins over the graph', () => {
    const explicit = Buffer.from('3f01ff', 'hex');
    const { c } = buildClient(explicit);
    seedCore(c);
    expect(c.profile().toString('hex')).toBe('3f01ff');
  });

  test('profile() fails with a pointer to connect() when nothing is available', () => {
    const { c } = buildClient();
    expect(() => c.profile()).toThrow(/connect\(\)/);
  });
});

describe('UnifiedSearch', () => {
  test('declares SearchParameters members by their FULL wire names', async () => {
    const { c, t } = buildClient();
    seedCore(c);

    const p = c.search('abbey road', 10);
    const call = t.sentFrames().find((f) => f.cmd === Cmd.CALL)!;
    t.deliver(encodeResponse(call.rid!, new BinaryWriter().string('').toBuffer(), true));
    await p;

    const deftypes = t
      .sentFrames()
      .filter((f) => f.cmd === Cmd.DEFTYPE)
      .map((f) => f.body.toString('utf8'))
      .join('\n');
    // The server matches DEFTYPE members by name and silently drops unknown
    // ones — short names ("Terms") make it discard every parameter.
    expect(deftypes).toContain('System.Sooid Sooloos.Broker.Api.SearchParameters::ProfileId');
    expect(deftypes).toContain('string Sooloos.Broker.Api.SearchParameters::Terms');
    expect(deftypes).toContain('int Sooloos.Broker.Api.SearchParameters::MaxCount');
    expect(deftypes).toContain('int Sooloos.Broker.Api.SearchParameters::MaxTopResultCount');
  });

  test('returns the objects pushed after the call, not stale graph matches', async () => {
    const { c, t } = buildClient();
    seedCore(c);
    // A result from some earlier search, already sitting in the graph — and
    // one whose title happens to contain the terms. Neither may come back.
    seed(c, 900n, 'Sooloos.Broker.Api.AlbumLite', {
      'Sooloos.Broker.Api.AlbumLite::Title': 'Abbey Road (stale)',
    });

    const p = c.search('abbey road', 10);
    const call = t.sentFrames().find((f) => f.cmd === Cmd.CALL)!;
    t.deliver(encodeResponse(call.rid!, new BinaryWriter().string('').toBuffer(), true));
    // Server pushes fresh results while we settle; the title need not contain
    // the search terms ("beatles abbey" would push "Abbey Road" too).
    seed(c, 901n, 'Sooloos.Broker.Api.AlbumLite', {
      'Sooloos.Broker.Api.AlbumLite::Title': 'Abbey Road',
    });
    seed(c, 902n, 'Sooloos.Broker.Api.TrackLite', {
      'Sooloos.Broker.Api.TrackLite::Title': 'Come Together',
    });

    const out = await p;
    expect(out.map((o) => o.oid).sort()).toEqual([901n, 902n]);
  });

  test('a failed call surfaces as an error instead of an empty result', async () => {
    const { c, t } = buildClient();
    seedCore(c);
    const p = c.search('anything', 10);
    const call = t.sentFrames().find((f) => f.cmd === Cmd.CALL)!;
    t.deliver(encodeResponse(call.rid!, new BinaryWriter().string('Exception').toBuffer(), true));
    await expect(p).rejects.toThrow(/UnifiedSearch failed/);
  });
});

describe('album edit struct schemas', () => {
  test('a labels edit after a genres edit retains the Labels member and values', async () => {
    const { c, t } = buildClient();
    seedCore(c);

    await completeLatestCall(t, c.editAlbum(17n, { addGenres: ['Jazz'] }));
    const labels = c.editAlbum(17n, { addLabels: ['ECM'] });
    const decoded = latestAlbumEdit(t);
    await completeLatestCall(t, labels);

    expect(decoded.memberName).toContain('::Labels');
    const editList = inlineValue(decoded.value);
    const editListType = declaredTypes(t).get(editList.typeId)!;
    expect(editListType.members[editList.body.flexInt() - 1].name).toContain('::AddValues');
    const added = new BinaryReader(editList.body.bytes(editList.body.integer()));
    expect(added.flexInt()).toBe(1);
    expect(added.string()).toBe('ECM');
  });

  test('a rating edit after a title edit retains the Rating member and value', async () => {
    const { c, t } = buildClient();
    seedCore(c);

    await completeLatestCall(t, c.editAlbum(17n, { title: 'Old title' }));
    const rating = c.editAlbum(17n, { rating: 5 });
    const decoded = latestAlbumEdit(t);
    await completeLatestCall(t, rating);

    expect(decoded.memberName).toContain('::Rating');
    const editRating = inlineValue(decoded.value);
    const ratingType = declaredTypes(t).get(editRating.typeId)!;
    expect(ratingType.members[editRating.body.flexInt() - 1].name).toContain('::EditValue');
    expect(editRating.body.boolean()).toBe(true);
    expect(editRating.body.integer()).toBe(5);
  });
});
