// Capture decoding: RemotingClient produces a real client byte stream, which is decoded back into calls.
import { CaptureDecoder, signatureParams, stripHandshake } from './decode';
import { Cmd, RemotingClient, Transport } from '../proto/remoting';
import { FrameParser, encodeRequest, encodeResponse } from '../proto/frame';
import { BinaryWriter } from '../proto/writer';
import { Arg, buildArgs, inlineStruct } from '../proto/serializer';
import { structArg } from '../proto/structs';
import { guessMethods } from './guess';

class Capture implements Transport {
  sent: Buffer[] = [];
  private h: (c: Buffer) => void = () => {};
  send(d: Buffer) { this.sent.push(d); }
  onData(h: (c: Buffer) => void) { this.h = h; }
  deliver(d: Buffer) { this.h(d); }
}

const RENAME = 'Sooloos.Broker.Api.Playlists::Rename(Sooloos.Broker.Api.Playlist, string, Base.ResultCallback)';
const FAV = 'Sooloos.Broker.Api.Library::FavoriteOrBan(System.Sooid, System.Collections.Generic.IEnumerable<Sooloos.Broker.Api.AlbumBase>, Sooloos.Broker.Api.FavoriteBanState, Base.ResultCallback)';
const LINK = 'Sooloos.Broker.Api.AlbumLink';

describe('capture decoding', () => {
  test('signatureParams splits parameters on top-level commas', () => {
    expect(signatureParams(FAV)).toEqual([
      'System.Sooid', 'System.Collections.Generic.IEnumerable<Sooloos.Broker.Api.AlbumBase>',
      'Sooloos.Broker.Api.FavoriteBanState', 'Base.ResultCallback',
    ]);
  });

  test('stripHandshake removes the ROON handshake records in both directions', () => {
    const hello = Buffer.concat([Buffer.from('ROON'), Buffer.from([1, 4]), Buffer.alloc(32)]);
    const c = Buffer.concat([hello, Buffer.from('ROON'), Buffer.from([1, 2]), Buffer.from([9])]);
    expect(stripHandshake(c)).toEqual(Buffer.from([9]));
    const s = Buffer.concat([Buffer.from('ROON'), Buffer.from([1, 0x80]), Buffer.from('ROON'), Buffer.from([1, 0x82]), Buffer.alloc(16), Buffer.from([7])]);
    expect(stripHandshake(s)).toEqual(Buffer.from([7]));
  });

  test('decodes signatures, references, strings, enums and inline struct collections, and pairs responses', async () => {
    const t = new Capture();
    const rc = new RemotingClient(t);
    const linkType = rc.defineType(LINK, [{ name: `long ${LINK}::AlbumId`, propType: 1 }]);
    const link = inlineStruct(linkType, [{ index: 1, value: new BinaryWriter().long(920111).toBuffer() }]);

    const p1 = rc.callMethod(44, RENAME, buildArgs([Arg.ref(1008185), Arg.str('Protocol test – playlist')]));
    const p2 = rc.callMethod(43, FAV, buildArgs([Arg.sooid(Buffer.alloc(16, 1)), Arg.collection([link]), Arg.enum_(1)]));
    const responses = [
      encodeResponse(1, new BinaryWriter().string('').toBuffer(), true),
      encodeResponse(2, new BinaryWriter().string('Failed').toBuffer(), true),
    ];
    for (const r of responses) t.deliver(r);
    await Promise.all([p1, p2]);

    const d = new CaptureDecoder();
    d.feedClient(Buffer.concat(t.sent));
    d.feedServer(Buffer.concat(responses));
    expect(d.calls).toHaveLength(2);
    const [rename, fav] = d.calls;
    expect(rename.signature).toBe(RENAME);
    expect(rename.objectId).toBe(44n);
    expect(rename.args.map((a) => a.value)).toEqual([{ $ref: 1008185n }, 'Protocol test – playlist']);
    expect(rename.response?.status).toBe('Success');
    expect(fav.args[1].value).toEqual([{ $type: LINK, AlbumId: 920111n }]);
    expect(fav.args[2].value).toBe(1);
    expect(fav.undecodedHex).toBeUndefined();
    expect(fav.response?.status).toBe('Failed');
  });
});

describe('without declarations: schema-based struct decoding and method guessing', () => {
  test('LibraryEdit decodes from the standard schemas and Library::Edit ranks first among guesses', async () => {
    const t = new Capture();
    const rc = new RemotingClient(t);
    const EDIT = 'Sooloos.Broker.Api.Library::Edit(Sooloos.Broker.Api.LibraryEdit, Base.ResultCallback)';
    const ALBUM_EDIT = 'Sooloos.Broker.Api.AlbumEdit';
    const W = 'Sooloos.Broker.Api.EditRequiredRef<string>';
    const title = structArg(rc, W, [{ name: `string ${W}::EditValue`, propType: 20, value: new BinaryWriter().string('Neuer Titel').toBuffer() }]);
    const albumEdit = structArg(rc, ALBUM_EDIT, [
      { name: `long ${ALBUM_EDIT}::AlbumId`, propType: 1, value: new BinaryWriter().long(920111).toBuffer() },
      { name: `${W} ${ALBUM_EDIT}::Title`, propType: 23, value: title },
    ]);
    const blob = new BinaryWriter().flexInt(1).bytes(albumEdit).toBuffer();
    const libEdit = structArg(rc, 'Sooloos.Broker.Api.LibraryEdit', [{
      name: 'System.Collections.Generic.IList<Sooloos.Broker.Api.AlbumEdit> Sooloos.Broker.Api.LibraryEdit::Albums',
      propType: 24, value: new BinaryWriter().integer(blob.length).bytes(blob).toBuffer(),
    }]);
    const p = rc.callMethod(43, EDIT, libEdit);
    t.deliver(encodeResponse(1, new BinaryWriter().string('').toBuffer(), true));
    await p;

    // Simulate a capture that started mid-connection: drop DEFTYPE and DEFMETHOD.
    const frames = new FrameParser().push(Buffer.concat(t.sent)).filter((f) => f.cmd === Cmd.CALL);
    const stream = Buffer.concat(frames.map((f) => encodeRequest(f.cmd, f.body, f.rid)));
    const d = new CaptureDecoder();
    d.feedClient(stream);
    const call = d.calls[0];
    expect(call.signature).toBeNull();
    const args = d.tryDecode(EDIT, Buffer.from(call.argsHex, 'hex'));
    expect(args?.[0].value).toEqual({
      $type: 'Sooloos.Broker.Api.LibraryEdit',
      Albums: [{ $type: ALBUM_EDIT, AlbumId: 920111n, Title: { $type: W, EditValue: 'Neuer Titel' } }],
    });
    const [g] = guessMethods([{ methodId: call.methodId, objectId: '43', argsHex: call.argsHex }], { 43: 'Sooloos.Broker.Api.Library' });
    expect(g.candidates[0]).toBe(EDIT); // highest validation score
    expect(g.scores[0]).toBeGreaterThan(g.scores[1] ?? 0);
  });
});

describe('dictionary arguments', () => {
  test('IEnumerable<IDictionary<string,string>> arguments decode to plain objects (GetMatchingEditions)', () => {
    const SIG = 'Sooloos.Broker.Api.Metadata::GetMatchingEditions(long, System.Collections.Generic.IEnumerable<System.Collections.Generic.IDictionary<string, string>>, Base.ResultCallback<System.Collections.Generic.IList<Sooloos.Broker.Api.MatchingEdition>>)';
    const dict = (pairs: [string, string][]) => {
      const w = new BinaryWriter().flexInt(pairs.length);
      for (const [k, v] of pairs) w.string(k).string(v);
      const b = w.toBuffer();
      return Buffer.concat([new BinaryWriter().flexInt(b.length).toBuffer(), b]);
    };
    const inner = Buffer.concat([
      new BinaryWriter().flexInt(2).toBuffer(),
      dict([['TITLE', 'Track One'], ['TRACKNUMBER', '1'], ['LENGTHMS', '352181']]),
      dict([['TITLE', 'Prélude'], ['TRACKNUMBER', '2']]),
    ]);
    const args = Buffer.concat([buildArgs([Arg.long(1234567)]), new BinaryWriter().flexInt(inner.length).toBuffer(), inner]);
    const v = new CaptureDecoder().tryDecode(SIG, args);
    expect(v?.map((a) => a.value)).toEqual([1234567n, [
      { TITLE: 'Track One', TRACKNUMBER: '1', LENGTHMS: '352181' },
      { TITLE: 'Prélude', TRACKNUMBER: '2' },
    ]]);
  });
});
