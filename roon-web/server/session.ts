const SESSION_MESSAGES = new Set([
  'search', 'transport', 'volume', 'favorite', 'play', 'power',
]);

/** Snapshot is the recovery request; every data/action message is session-bound. */
export function messageMatchesSession(message: { t?: unknown; generation?: unknown }, generation: number): boolean {
  if (message.t === 'snapshot') return true;
  if (!SESSION_MESSAGES.has(String(message.t))) return true;
  return message.generation === generation;
}
