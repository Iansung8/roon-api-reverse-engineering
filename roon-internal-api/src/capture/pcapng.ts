/**
 * pcapng reading and TCP reassembly for captures saved by Wireshark/tcpdump or Windows pktmon (etl2pcap).
 * Handles Ethernet/IPv4/TCP only, which is enough to rebuild both directions of a port-9332 connection.
 */

export interface TcpSegment {
  /** packet time in Unix ms (assuming the default pcapng microsecond resolution) */
  t: number;
  src: string;
  dst: string;
  sport: number;
  dport: number;
  seq: number;
  flags: number;
  payload: Buffer;
}

const SYN = 0x02;

/** Read every IPv4/TCP packet in a pcapng file. Unknown blocks, link types and protocols are skipped. */
export function readPcapng(buf: Buffer): TcpSegment[] {
  const out: TcpSegment[] = [];
  let le = true;
  const linkTypes: number[] = [];
  let off = 0;
  while (off + 12 <= buf.length) {
    const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
    let type = u32(off);
    if (type === 0x0a0d0d0a) {
      // Section Header Block: the byte-order magic decides the endianness of this section.
      le = buf.readUInt32LE(off + 8) === 0x1a2b3c4d;
      type = 0x0a0d0d0a;
      linkTypes.length = 0;
    }
    const len = u32(off + 4);
    if (len < 12 || off + len > buf.length) break;
    const body = off + 8;
    if (type === 1) {
      linkTypes.push(le ? buf.readUInt16LE(body) : buf.readUInt16BE(body));
    } else if (type === 6) {
      const ifId = u32(body);
      const ts = (BigInt(u32(body + 4)) << 32n) | BigInt(u32(body + 8));
      const capLen = u32(body + 12);
      const pkt = buf.subarray(body + 20, body + 20 + capLen);
      const seg = linkTypes[ifId] === 1 ? parseEthernet(pkt) : undefined;
      if (seg) out.push({ ...seg, t: Number(ts / 1000n) });
    }
    off += len;
  }
  return out;
}

function parseEthernet(p: Buffer): Omit<TcpSegment, 't'> | undefined {
  if (p.length < 14) return undefined;
  let etherType = p.readUInt16BE(12);
  let ip = 14;
  if (etherType === 0x8100 && p.length >= 18) { etherType = p.readUInt16BE(16); ip = 18; }
  if (etherType !== 0x0800 || p.length < ip + 20) return undefined;
  const ihl = (p[ip] & 0x0f) * 4;
  if (p[ip + 9] !== 6) return undefined; // TCP only
  const totalLen = p.readUInt16BE(ip + 2);
  const end = Math.min(p.length, ip + totalLen); // drop Ethernet padding
  const src = Array.from(p.subarray(ip + 12, ip + 16)).join('.');
  const dst = Array.from(p.subarray(ip + 16, ip + 20)).join('.');
  const tcp = ip + ihl;
  if (end < tcp + 20) return undefined;
  const dataOff = (p[tcp + 12] >> 4) * 4;
  return {
    src, dst,
    sport: p.readUInt16BE(tcp), dport: p.readUInt16BE(tcp + 2),
    seq: p.readUInt32BE(tcp + 4), flags: p[tcp + 13],
    payload: Buffer.from(p.subarray(tcp + dataOff, end)),
  };
}

export interface TcpStream {
  client: string;
  server: string;
  /** client -> server byte stream */
  toServer: Buffer;
  /** server -> client byte stream */
  toClient: Buffer;
  /** whether the SYN was captured (if not, the capture began mid-connection and declarations may be missing) */
  sawSyn: boolean;
  /** bytes missing during reassembly; non-zero means packets were lost */
  gaps: number;
  firstT: number;
}

/**
 * Split packets into connections by server port and reassemble each direction by sequence number.
 * Packets captured twice (pktmon logs at several components) are deduplicated.
 */
export function reassemble(segs: TcpSegment[], serverPort: number): TcpStream[] {
  const conns = new Map<string, { toS: TcpSegment[]; toC: TcpSegment[] }>();
  for (const s of segs) {
    const toServer = s.dport === serverPort;
    if (!toServer && s.sport !== serverPort) continue;
    const key = toServer ? `${s.src}:${s.sport}>${s.dst}:${s.dport}` : `${s.dst}:${s.dport}>${s.src}:${s.sport}`;
    const c = conns.get(key) ?? { toS: [], toC: [] };
    (toServer ? c.toS : c.toC).push(s);
    conns.set(key, c);
  }
  const out: TcpStream[] = [];
  for (const [key, c] of conns) {
    const [client, server] = key.split('>');
    const a = joinDirection(c.toS);
    const b = joinDirection(c.toC);
    out.push({
      client, server, toServer: a.data, toClient: b.data, sawSyn: a.sawSyn,
      gaps: a.gaps + b.gaps, firstT: Math.min(...[...c.toS, ...c.toC].map((s) => s.t)),
    });
  }
  return out.sort((x, y) => x.firstT - y.firstT);
}

function joinDirection(segs: TcpSegment[]): { data: Buffer; sawSyn: boolean; gaps: number } {
  if (!segs.length) return { data: Buffer.alloc(0), sawSyn: false, gaps: 0 };
  const syn = segs.find((s) => s.flags & SYN);
  const base = syn ? (syn.seq + 1) >>> 0 : segs.reduce((m, s) => (((s.seq - m) | 0) < 0 ? s.seq : m), segs[0].seq);
  // seq is an unsigned 32-bit number; use relative offsets to survive wraparound.
  const pieces = segs.filter((s) => s.payload.length).map((s) => ({ off: (s.seq - base) >>> 0, data: s.payload }))
    .filter((p) => p.off < 0x80000000)
    .sort((x, y) => x.off - y.off);
  const chunks: Buffer[] = [];
  let pos = 0;
  let gaps = 0;
  for (const p of pieces) {
    const end = p.off + p.data.length;
    if (end <= pos) continue; // duplicate
    if (p.off > pos) { gaps += p.off - pos; break; } // data after a gap cannot be joined reliably
    chunks.push(p.data.subarray(pos - p.off));
    pos = end;
  }
  return { data: Buffer.concat(chunks), sawSyn: !!syn, gaps };
}
