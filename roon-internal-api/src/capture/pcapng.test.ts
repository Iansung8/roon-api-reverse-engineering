import { readPcapng, reassemble } from './pcapng';

describe('pcapng and TCP reassembly', () => {
  function block(type: number, body: Buffer): Buffer {
    const pad = Buffer.alloc((4 - (body.length % 4)) % 4);
    const len = 12 + body.length + pad.length;
    const h = Buffer.alloc(8); h.writeUInt32LE(type, 0); h.writeUInt32LE(len, 4);
    const tail = Buffer.alloc(4); tail.writeUInt32LE(len, 0);
    return Buffer.concat([h, body, pad, tail]);
  }
  function tcpPacket(src: number[], dst: number[], sport: number, dport: number, seq: number, flags: number, payload: Buffer): Buffer {
    const eth = Buffer.concat([Buffer.alloc(12), Buffer.from([0x08, 0x00])]);
    const ip = Buffer.alloc(20); ip[0] = 0x45; ip.writeUInt16BE(20 + 20 + payload.length, 2); ip[9] = 6;
    Buffer.from(src).copy(ip, 12); Buffer.from(dst).copy(ip, 16);
    const tcp = Buffer.alloc(20); tcp.writeUInt16BE(sport, 0); tcp.writeUInt16BE(dport, 2); tcp.writeUInt32BE(seq >>> 0, 4); tcp[12] = 0x50; tcp[13] = flags;
    return Buffer.concat([eth, ip, tcp, payload, Buffer.alloc(4)]); // 4 trailing bytes simulate Ethernet padding
  }
  function epb(pkt: Buffer): Buffer {
    const h = Buffer.alloc(20); h.writeUInt32LE(0, 0); h.writeUInt32LE(0, 4); h.writeUInt32LE(1000, 8); h.writeUInt32LE(pkt.length, 12); h.writeUInt32LE(pkt.length, 16);
    return block(6, Buffer.concat([h, pkt]));
  }

  test('reads pcapng, drops duplicates, reorders, splits directions and reports gaps', () => {
    const shbBody = Buffer.alloc(16); shbBody.writeUInt32LE(0x1a2b3c4d, 0); shbBody.writeUInt16LE(1, 4);
    const idbBody = Buffer.alloc(8); idbBody.writeUInt16LE(1, 0);
    const C = [192, 0, 2, 10]; const S = [192, 0, 2, 20];
    const isn = 0xfffffff0; // wraps around 32 bits
    const file = Buffer.concat([
      block(0x0a0d0d0a, shbBody), block(1, idbBody),
      epb(tcpPacket(C, S, 50000, 9332, isn, 0x02, Buffer.alloc(0))),
      epb(tcpPacket(C, S, 50000, 9332, isn + 1 + 4, 0x18, Buffer.from('EFGH'))),
      epb(tcpPacket(C, S, 50000, 9332, isn + 1, 0x18, Buffer.from('ABCD'))),
      epb(tcpPacket(C, S, 50000, 9332, isn + 1, 0x18, Buffer.from('ABCD'))), // duplicate
      epb(tcpPacket(S, C, 9332, 50000, 100, 0x18, Buffer.from('xy'))),
      epb(tcpPacket(S, C, 9332, 50000, 110, 0x18, Buffer.from('zz'))), // gap
    ]);
    const segs = readPcapng(file);
    expect(segs).toHaveLength(6);
    const [s] = reassemble(segs, 9332);
    expect(s.client).toBe('192.0.2.10:50000');
    expect(s.server).toBe('192.0.2.20:9332');
    expect(s.sawSyn).toBe(true);
    expect(s.toServer.toString()).toBe('ABCDEFGH');
    expect(s.toClient.toString()).toBe('xy');
    expect(s.gaps).toBe(8);
  });
});
