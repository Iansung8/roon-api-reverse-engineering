/**
 * Capture decoding: turn the byte streams between the official client and a Core into method calls.
 * Client direction: DEFMETHOD maps method ids to signatures, DEFTYPE declares struct types, and each CALL
 * is decoded parameter by parameter. Server direction: responses (status + return value) pair up by request id.
 * Capture from connection start (restart the Roon desktop app) so no declaration is missed.
 */
import { FrameParser, Frame } from '../proto/frame';
import { BinaryReader } from '../proto/reader';
import { ObjectGraph, PropertyType } from '../proto/objects';
import { Cmd } from '../proto/remoting';
import { structSchema } from '../generated/struct-schemas';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const catalog = require('../catalog/catalog.authoritative.json') as {
  typeKinds: Record<string, string>;
  enums: { name: string }[];
  structs: Record<string, { members: { name: string; type: string; propType: number }[] }>;
};
const ENUMS = new Set(catalog.enums.map((e) => e.name));

export interface DecodedArg { type: string; value: unknown; hex: string }
export interface DecodedCall {
  /** sequence number of the message in the client direction */
  seq: number;
  rid: number | null;
  objectId: bigint;
  methodId: number;
  signature: string | null;
  args: DecodedArg[];
  argsHex: string;
  /** raw bytes from the first argument that could not be decoded (unknown type, etc.) */
  undecodedHex?: string;
  response?: { status: string; payloadHex: string };
}

/** Strip the ROON handshake records: client 0104 (38 bytes) and 0102 (6); server 0180 (6) and 0182 (22). */
export function stripHandshake(buf: Buffer): Buffer {
  let off = 0;
  while (buf.length >= off + 6 && buf.subarray(off, off + 4).toString('latin1') === 'ROON') {
    const code = buf.readUInt16BE(off + 4);
    off += code === 0x0104 ? 38 : code === 0x0182 ? 22 : 6;
  }
  return buf.subarray(off);
}

/** Split a signature's parameter list on top-level commas (respecting <> nesting). */
export function signatureParams(signature: string): string[] {
  const open = signature.indexOf('(');
  const inner = signature.slice(open + 1, signature.lastIndexOf(')'));
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '<') depth++;
    if (ch === '>') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const COLLECTION = /^System\.Collections\.Generic\.(IEnumerable|IList|ICollection|List)<(.+)>$/;

/** The ...Link struct used when a by-ref type is sent inline by durable id: AlbumBase -> AlbumLink, Playlist -> PlaylistLink. */
function linkTypeOf(type: string): string | undefined {
  const name = `${type.replace(/Base$/, '')}Link`;
  return structSchema(name) ? name : undefined;
}

const PRIMITIVE_PROP: Record<string, number> = {
  int: 0, long: 1, bool: 2, 'System.Guid': 3, 'System.Sooid': 4, double: 5, float: 6, char: 7, 'System.DateTime': 8,
  string: 20, 'byte[]': 21, 'System.Byte[]': 21,
};

/**
 * Member table for a struct: struct-schemas first. Generic wrappers without one (EditRequiredVal<long>,
 * EditOptionalVal<bool>, ...) instantiate the catalog template (EditRequiredVal`1) with T, whose PropertyType
 * comes from the primitive or enum type; anything else is treated as Object.
 */
function schemaFor(name: string): readonly { name: string; propType: number }[] | undefined {
  const known = structSchema(name);
  if (known) return known;
  const g = /^(Sooloos\.Broker\.Api\.\w+)<(.+)>$/.exec(name);
  const tpl = g && catalog.structs[`${g[1]}\`1`];
  if (!g || !tpl) return undefined;
  const arg = g[2];
  const valuePt = PRIMITIVE_PROP[arg] ?? (ENUMS.has(arg) ? 9 : undefined);
  return tpl.members.map((mm) => {
    const type = mm.type.replace(/\bT\b/g, arg);
    let propType = mm.propType;
    if (mm.type === 'T') propType = valuePt ?? PropertyType.Object;
    else if (mm.type === 'T?') propType = valuePt !== undefined && valuePt <= 9 ? valuePt + 10 : PropertyType.Object;
    return { name: `${type} ${name}::${mm.name}`, propType };
  });
}

export class CaptureDecoder {
  /** Struct types declared by the client live in their own graph and are used to read struct arguments. */
  readonly clientTypes = new ObjectGraph();
  readonly methods = new Map<number, string>();
  readonly calls: DecodedCall[] = [];
  private byRid = new Map<number, DecodedCall>();
  private seq = 0;

  /** Feed the client -> server byte stream (with or without the ROON handshake). */
  feedClient(stream: Buffer): void {
    for (const f of new FrameParser().push(stripHandshake(stream))) this.onClientFrame(f);
  }

  /** Feed the server -> client byte stream to pair responses with calls. */
  feedServer(stream: Buffer): void {
    for (const f of new FrameParser().push(stripHandshake(stream))) {
      if (!f.isResponse || f.rid === null) continue;
      const call = this.byRid.get(f.rid);
      if (!call || !f.isFinal) continue;
      const r = new BinaryReader(f.body);
      const status = r.string() ?? '';
      call.response = { status: status || 'Success', payloadHex: Buffer.from(f.body.subarray(r.pos)).toString('hex') };
    }
  }

  private onClientFrame(f: Frame): void {
    if (f.isResponse) return;
    this.seq++;
    if (f.cmd === Cmd.DEFMETHOD) {
      const r = new BinaryReader(f.body);
      const id = r.flexInt();
      this.methods.set(id, r.string() ?? '');
    } else if (f.cmd === Cmd.DEFTYPE) {
      // A client DEFTYPE body has the same format as the server's type push; server-side the command is 7.
      this.clientTypes.ingest({ ...f, cmd: 7 });
    } else if (f.cmd === Cmd.CALL) {
      const r = new BinaryReader(f.body);
      const objectId = r.long();
      const methodId = r.flexInt();
      const argsStart = r.pos;
      const signature = this.methods.get(methodId) ?? null;
      const call: DecodedCall = {
        seq: this.seq, rid: f.rid, objectId, methodId, signature, args: [],
        argsHex: Buffer.from(f.body.subarray(argsStart)).toString('hex'),
      };
      if (signature) this.decodeArgs(signature, r, call);
      this.calls.push(call);
      if (f.rid !== null) this.byRid.set(f.rid, call);
    }
  }

  /**
   * Try to decode argument bytes with a given signature. It matches only when every parameter decodes and the
   * bytes are consumed exactly; returns the arguments or null. Used to guess methods for calls without a
   * captured declaration (see guess.ts). Undeclared struct types are skipped whole ({$inline: typeId}).
   */
  tryDecode(signature: string, args: Buffer): DecodedArg[] | null {
    return this.tryDecodeScored(signature, args)?.args ?? null;
  }

  /** Like tryDecode, also returning how many members or list items were validated against standard schemas (for ranking). */
  tryDecodeScored(signature: string, args: Buffer): { args: DecodedArg[]; score: number } | null {
    const call: DecodedCall = { seq: 0, rid: null, objectId: 0n, methodId: 0, signature, args: [], argsHex: '' };
    this.validated = 0;
    this.decodeArgs(signature, new BinaryReader(args), call);
    return call.undecodedHex === undefined ? { args: call.args, score: this.validated } : null;
  }

  /** members and list items validated against standard schemas */
  private validated = 0;

  /** inline struct type ids seen in this decode -> inferred type names; one id must map to one type. */
  private inlineTypes = new Map<number, string>();

  private decodeArgs(signature: string, r: BinaryReader, call: DecodedCall): void {
    this.inlineTypes = new Map();
    for (const type of signatureParams(signature)) {
      if (type.startsWith('Base.ResultCallback')) continue; // callbacks are not on the wire
      const start = r.pos;
      try {
        const value = this.readStrict(type, r);
        if (value === UNKNOWN) { call.undecodedHex = Buffer.from(r.buf.subarray(start)).toString('hex'); return; }
        call.args.push({ type, value, hex: Buffer.from(r.buf.subarray(start, r.pos)).toString('hex') });
      } catch {
        call.undecodedHex = Buffer.from(r.buf.subarray(start)).toString('hex');
        return;
      }
    }
    // Arguments must end exactly at the last byte: no shortfall, no overrun.
    if (r.pos !== r.buf.length) call.undecodedHex = Buffer.from(r.buf.subarray(Math.min(r.pos, r.buf.length))).toString('hex');
  }

  /** Read one argument; throw on overrun (BinaryReader itself does not bounds-check). */
  private readStrict(type: string, r: BinaryReader): unknown {
    const v = this.readArg(type, r);
    if (r.pos > r.buf.length) throw new Error('read past end');
    return v;
  }

  private readArg(type: string, r: BinaryReader): unknown {
    switch (type) {
      case 'bool': {
        if (r.buf[r.pos] > 1) throw new Error('bool must be 0 or 1');
        return r.boolean();
      }
      case 'int': return r.integer();
      case 'long': return r.long();
      case 'string': {
        const len = r.integer();
        if (len < 0) return null;
        if (len > r.remaining) throw new Error('string past end');
        const text = UTF8.decode(r.buf.subarray(r.pos, r.pos + len)); // throws on invalid UTF-8
        r.pos += len;
        return text;
      }
      case 'double': return r.double();
      case 'System.Sooid': return r.sooid().toString('hex');
      case 'System.Guid': return r.guid().toString('hex');
      case 'int?': return r.optionalInteger();
      case 'long?': return r.optionalLong();
      case 'bool?': return r.optionalBoolean();
      case 'System.Sooid?': return r.optionalSooid()?.toString('hex') ?? null;
    }
    if (ENUMS.has(type)) return r.flexInt();
    if (type === 'System.Collections.Generic.IDictionary<string, string>') {
      // flexInt(len) + flexInt(pairs) + (string, string)... (file tags of Metadata::GetMatchingEditions)
      const len = r.flexInt();
      if (len > r.remaining) throw new Error('dictionary past end');
      const body = new BinaryReader(r.bytes(len));
      const n = body.flexInt();
      const pairs: [unknown, unknown][] = [];
      for (let i = 0; i < n; i++) pairs.push([this.readStrict('string', body), this.readStrict('string', body)]);
      if (body.pos !== body.buf.length) throw new Error('dictionary not fully consumed');
      return Object.fromEntries(pairs);
    }
    const coll = COLLECTION.exec(type);
    if (coll) {
      const len = r.flexInt();
      if (len > r.remaining) throw new Error('collection past end');
      const body = new BinaryReader(r.bytes(len));
      const count = body.flexInt();
      const items: unknown[] = [];
      for (let i = 0; i < count; i++) {
        const v = this.readStrict(coll[2], body);
        if (v === UNKNOWN) return { count, raw: Buffer.from(body.buf).toString('hex') };
        items.push(v);
      }
      if (body.pos !== body.buf.length) throw new Error('collection body not fully consumed');
      return items;
    }
    const kind = catalog.typeKinds[type];
    if (kind === 'byref' || kind === 'byval') return this.readTyped(r, type);
    return UNKNOWN;
  }

  /**
   * An Object-encoded value: flexLong marker 0 = null, 1 = inline struct, anything else = object reference.
   * Inline structs use the client-declared type when there is one; otherwise the catalog's standard
   * member table (struct-schemas) is applied member by member. Member indexes must be in range and the
   * body consumed exactly, or this throws. For by-ref types (AlbumBase, ...) only the matching ...Link struct is accepted inline.
   */
  private readTyped(r: BinaryReader, type: string): unknown {
    const marker = r.flexLong();
    if (marker === 0n) return null;
    const kind = catalog.typeKinds[type];
    if (marker !== 1n) {
      if (kind === 'byval') throw new Error(`by-value ${type} cannot be a reference`);
      return { $ref: marker };
    }
    const tid = r.flexInt();
    const len = r.flexInt();
    if (len > r.remaining) throw new Error('inline struct past end');
    const sub = new BinaryReader(r.bytes(len));
    const declared = this.clientTypes.types.get(tid);
    const name = declared?.name ?? (kind === 'byref' ? linkTypeOf(type) : type);
    const members = declared?.members ?? (name ? schemaFor(name) : undefined);
    if (!name || !members) {
      if (kind === 'byref') throw new Error(`no link struct for ${type}`);
      return { $inline: tid };
    }
    const seen = this.inlineTypes.get(tid);
    if (seen && seen !== name) throw new Error(`type id ${tid} used for ${seen} and ${name}`);
    this.inlineTypes.set(tid, name);
    const out: Record<string, unknown> = { $type: name };
    for (;;) {
      const idx = sub.flexInt();
      if (sub.pos > sub.buf.length) throw new Error('struct past end');
      if (idx === 0) break;
      const m = members[idx - 1];
      if (!m) throw new Error(`member index ${idx} out of range for ${name}`);
      out[m.name.slice(m.name.lastIndexOf('::') + 2)] = this.readMember(sub, m);
      this.validated++;
      if (sub.pos > sub.buf.length) throw new Error('member past end');
    }
    if (sub.pos !== sub.buf.length) throw new Error(`${name} not fully consumed`);
    return out;
  }

  /**
   * Struct members: Object recurses by the declared member type; LengthPrefixed lists decode item by item; the rest by PropertyType.
   * The catalog marks list members as Object, but on the wire most are LengthPrefixed (LibraryEdit lists,
   * EditList values), so Object-typed list members try LengthPrefixed first and fall back to Object.
   */
  private readMember(r: BinaryReader, m: { name: string; propType: number }): unknown {
    const type = m.name.slice(0, m.name.lastIndexOf(' '));
    if (m.propType === PropertyType.Object && COLLECTION.test(type)) {
      const start = r.pos;
      const validated = this.validated;
      try {
        return this.readMember(r, { name: m.name, propType: PropertyType.LengthPrefixed });
      } catch {
        r.pos = start;
        this.validated = validated;
      }
    }
    if (m.propType === PropertyType.Object) return this.readTyped(r, type);
    if (m.propType === PropertyType.LengthPrefixed) {
      const len = r.integer();
      if (len < 0 || len > r.remaining) throw new Error('length-prefixed past end');
      const body = new BinaryReader(r.bytes(len));
      const coll = COLLECTION.exec(type);
      if (!coll) return `0x${Buffer.from(body.buf).toString('hex')}`;
      const count = body.flexInt();
      const items: unknown[] = [];
      for (let i = 0; i < count; i++) {
        const v = this.readStrict(coll[2], body);
        if (v === UNKNOWN) return { count, raw: `0x${Buffer.from(body.buf).toString('hex')}` };
        items.push(v);
        this.validated++;
      }
      if (body.pos !== body.buf.length) throw new Error('list body not fully consumed');
      return items;
    }
    return this.clientTypes.readValue(r, m.propType);
  }
}

const UNKNOWN = Symbol('unknown');
const UTF8 = new TextDecoder('utf-8', { fatal: true });
