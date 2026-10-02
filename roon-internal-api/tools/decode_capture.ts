/**
 * Decode a capture: pcapng -> TCP connections on port 9332 -> method calls with arguments.
 * Usage: npx ts-node -T tools/decode_capture.ts <capture.pcapng> [--port 9332] [--grep regex]
 *          [--json out.json] [--guesses output of guess_methods.ts] [--markdown out.md]
 * Lists every call by default; --grep keeps calls whose signature matches (e.g. "Library::Edit|Playlists::|Metadata::").
 * --guesses: for calls whose method declaration was not captured, adopt a guessed signature when it is the
 *   only candidate or scores strictly higher than the runner-up, and decode all arguments with it (marked "guessed").
 * --markdown: write a table of every call; write-like calls (Edit, Set, Create, Delete, ...) keep full arguments.
 */
import * as fs from 'fs';
import { readPcapng, reassemble } from '../src/capture/pcapng';
import { CaptureDecoder, DecodedCall } from '../src/capture/decode';
import { Guess } from '../src/capture/guess';

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const file = args[0];
if (!file) { console.error('usage: decode_capture.ts <capture.pcapng> [--port 9332] [--grep regex] [--json out.json] [--guesses guesses.json] [--markdown out.md]'); process.exit(2); }
const port = Number(opt('--port') ?? 9332);
const grep = opt('--grep') ? new RegExp(opt('--grep')!) : undefined;
const jsonOut = opt('--json');
const mdOut = opt('--markdown');
const guesses = opt('--guesses') ? JSON.parse(fs.readFileSync(opt('--guesses')!, 'utf8')) as Guess[] : [];

/** Adopt only confident guesses: a single candidate, or a top score above the runner-up. */
const guessed = new Map<number, string>();
for (const g of guesses) {
  if (g.candidates.length === 1 || (g.candidates.length > 1 && g.scores[0] > g.scores[1])) guessed.set(g.methodId, g.candidates[0]);
}

// Buffers reach the replacer already converted by toJSON ({type:'Buffer', data:[...]}); print them as hex.
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString()
  : x && typeof x === 'object' && x.type === 'Buffer' && Array.isArray(x.data) ? `0x${Buffer.from(x.data).toString('hex')}` : x));
const short = (sig: string | null) => (sig ?? '?').replace(/Sooloos\.Broker\.Api\./g, '').replace(/System\.Collections\.Generic\./g, '').replace(/Base\.ResultCallback/g, 'cb');
const WRITE = /::(Edit|Set|Create|Delete|Remove|Insert|Move|Rename|Add|Favorite|ReIdentify|ReScan|Merge|Clear|Update|Start|Force)/;

type Row = DecodedCall & { guessedSignature?: string };
const segs = readPcapng(fs.readFileSync(file));
const streams = reassemble(segs, port);
console.log(`[capture] ${file}: ${segs.length} TCP packets, ${streams.length} connection(s) on port ${port}`);
const report = [];
const md: string[] = [`# Decoded capture: ${file.split(/[\\/]/).pop()}`, ''];
for (const s of streams) {
  const d = new CaptureDecoder();
  d.feedClient(s.toServer);
  d.feedServer(s.toClient);
  const rows: Row[] = d.calls.map((c) => {
    const sig = c.signature ? undefined : guessed.get(c.methodId);
    if (!sig) return c;
    const decoded = d.tryDecode(sig, Buffer.from(c.argsHex, 'hex'));
    return decoded ? { ...c, guessedSignature: sig, args: decoded, undecodedHex: undefined } : c;
  });
  const head = `[connection] ${s.client} -> ${s.server} | start ${new Date(s.firstT).toISOString()} | SYN seen=${s.sawSyn} | gaps=${s.gaps} bytes | sent ${s.toServer.length}, received ${s.toClient.length} bytes | method declarations ${d.methods.size} | calls ${d.calls.length} | guessed ${rows.filter((r) => r.guessedSignature).length}`;
  console.log(`\n${head}`);
  if (!s.sawSyn) console.log('  ! connection start not captured; method declarations may be missing. Restart the Roon desktop app after starting the capture.');
  md.push(`## ${head.replace('[connection] ', 'Connection ')}`, '', '| # | Method | Object | Arguments | Response |', '|---|---|---|---|---|');
  for (const c of rows) {
    const sig = c.signature ?? c.guessedSignature ?? null;
    const name = `${short(sig)}${c.guessedSignature ? ' (guessed)' : ''}${sig ? '' : ` (method #${c.methodId})`}`;
    const argText = c.args.length ? c.args.map((a) => json(a.value)).join(', ') : c.undecodedHex ? `0x${c.undecodedHex}` : '';
    const full = sig && WRITE.test(sig);
    md.push(`| ${c.seq} | ${name.replace(/\|/g, '\\|')} | ${c.objectId} | ${(full ? argText : argText.slice(0, 200)).replace(/\|/g, '\\|')} | ${c.response?.status ?? ''} |`);
    if (grep && !grep.test(sig ?? '')) continue;
    console.log(`  #${c.seq} obj=${c.objectId} ${name}`);
    if (argText) console.log(`      args ${argText.slice(0, 600)}`);
    if (c.response) console.log(`      response ${c.response.status}${c.response.payloadHex ? ` ${c.response.payloadHex.slice(0, 120)}` : ''}`);
  }
  md.push('');
  report.push({ ...s, toServer: undefined, toClient: undefined, methods: Object.fromEntries(d.methods), calls: rows });
}
if (jsonOut) { fs.writeFileSync(jsonOut, json(report)); console.log(`\n[written] ${jsonOut}`); }
if (mdOut) { fs.writeFileSync(mdOut, md.join('\n')); console.log(`[written] ${mdOut}`); }
