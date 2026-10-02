/**
 * Guess methods for captured calls whose method declaration was not captured. Input: decode_capture.ts --json output.
 * Usage: npx ts-node -T tools/guess_methods.ts <decoded.json> [--services 43=Library,44=Playlists,...] [--out guesses.json]
 * The default service map (6 Locations, 22 Transport, 43 Library, 44 Playlists, 104 Qobuz, 111 Radio, 114 Metadata,
 * 131 Backups) was observed on one Core (Roon 2.73 build 1696), where it stayed the same across connections.
 * Other Cores may differ; pass --services to override.
 */
import * as fs from 'fs';
import { guessMethods, CallSample } from '../src/capture/guess';

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const file = args[0];
if (!file) { console.error('usage: guess_methods.ts <decoded.json> [--services 43=Library,...] [--out guesses.json]'); process.exit(2); }
const defaults = '6=Locations,22=Transport,43=Library,44=Playlists,104=Qobuz,111=Radio,114=Metadata,131=Backups';
const serviceByObject = Object.fromEntries((opt('--services') ?? defaults).split(',').map((kv) => {
  const [oid, name] = kv.split('=');
  return [oid, `Sooloos.Broker.Api.${name}`];
}));

const streams = JSON.parse(fs.readFileSync(file, 'utf8')) as { calls: (CallSample & { signature: string | null })[] }[];
const unknown = streams.flatMap((s) => s.calls.filter((c) => !c.signature).map((c) => ({ methodId: c.methodId, objectId: String(c.objectId), argsHex: c.argsHex })));
const guesses = guessMethods(unknown, serviceByObject);
const short = (s: string) => s.replace(/Sooloos\.Broker\.Api\./g, '').replace(/System\.Collections\.Generic\./g, '').replace(/Base\.ResultCallback/g, 'cb');
for (const g of guesses) {
  const head = `#${g.methodId} | ${g.calls} call(s) | objects ${g.objectIds.slice(0, 3).join(',')}${g.service ? ` (${short(g.service)})` : ''} | ${g.candidates.length} candidate(s)`;
  console.log(head);
  g.candidates.slice(0, 4).forEach((c, i) => console.log(`    [${g.scores[i]}] ${short(c)}`));
}
const out = opt('--out');
// Keep the top 20 candidates (plus the total): calls on objects of unknown type can match thousands of signatures.
const trimmed = guesses.map((g) => ({ ...g, candidateCount: g.candidates.length, candidates: g.candidates.slice(0, 20), scores: g.scores.slice(0, 20) }));
if (out) { fs.writeFileSync(out, JSON.stringify(trimmed, null, 2)); console.log(`[written] ${out}`); }
