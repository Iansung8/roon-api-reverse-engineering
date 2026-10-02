/**
 * Method guessing for captures that missed the connection start, where calls carry only a method id.
 * The client assigns a method id the first time it uses a method on that connection; it is not a
 * catalog index. So the arguments decide: a candidate signature must decode every call with that id
 * exactly, consuming all bytes.
 * Calls on a known service object (Library = 43, ...) only try that service's methods; others try all.
 */
import { CaptureDecoder, signatureParams } from './decode';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const catalog = require('../catalog/catalog.authoritative.json') as {
  services: { name: string; fullName: string; methods: { name: string; signature: string }[] }[];
};

export interface CallSample { methodId: number; objectId: string; argsHex: string }
export interface Guess {
  methodId: number;
  calls: number;
  objectIds: string[];
  service?: string;
  /** signatures that decode every call exactly, best validation score first; ties put accessors (get_/set_/add_/remove_) last */
  candidates: string[];
  /** validation score per candidate: members and list items checked against standard schemas, summed over calls */
  scores: number[];
}

const ACCESSOR = /::(get_|set_|add_|remove_)/;

export function guessMethods(calls: CallSample[], serviceByObject: Record<string, string>): Guess[] {
  const decoder = new CaptureDecoder();
  const groups = new Map<number, CallSample[]>();
  for (const c of calls) groups.set(c.methodId, [...(groups.get(c.methodId) ?? []), c]);
  const out: Guess[] = [];
  for (const [methodId, cs] of groups) {
    const objectIds = [...new Set(cs.map((c) => c.objectId))];
    const services = [...new Set(objectIds.map((o) => serviceByObject[o]).filter(Boolean))];
    const pool = catalog.services
      .filter((s) => (services.length === 1 && objectIds.every((o) => serviceByObject[o]) ? s.fullName === services[0] : true))
      .flatMap((s) => s.methods.map((m) => m.signature));
    const fits: { sig: string; score: number }[] = [];
    for (const sig of new Set(pool)) {
      const params = signatureParams(sig).filter((p) => !p.startsWith('Base.ResultCallback'));
      let score = 0;
      const ok = cs.every((c) => {
        const args = Buffer.from(c.argsHex, 'hex');
        if (!params.length) return args.length === 0;
        const r = decoder.tryDecodeScored(sig, args);
        if (r) score += r.score;
        return r !== null;
      });
      if (ok) fits.push({ sig, score });
    }
    fits.sort((a, b) => b.score - a.score || Number(ACCESSOR.test(a.sig)) - Number(ACCESSOR.test(b.sig)));
    out.push({
      methodId, calls: cs.length, objectIds, service: services.length === 1 ? services[0] : undefined,
      candidates: fits.map((f) => f.sig), scores: fits.map((f) => f.score),
    });
  }
  return out.sort((a, b) => a.methodId - b.methodId);
}
