/**
 * Play-history export via VirtualHistoryQuery (READ-ONLY).
 *   npx ts-node examples/play-history.ts [limit]
 *
 * Walks the profile's play history, newest first, and prints one JSON line
 * per play: { playedAt, artist, title, album?, completionPct?, roonTrackId? }.
 * A limit of zero is valid: it reports Count without retaining any pages.
 *
 * Wire facts (live-probed):
 * - HistoryPlay::Time is a .NET DateTime int64 — the top two bits are the
 *   Kind (Utc = bit 62), the low 62 bits are ticks (100ns) since
 *   0001-01-01 UTC.
 * - HistoryPlay::HistoryPlayId is an opaque stable per-play identity. An older
 *   2.71 probe observed values equal to Time ticks, but that does not hold on
 *   every Core; ordering always uses HistoryPlay::Time.
 * - HistoryPlay::TrackBase is an inline TrackLink value struct carrying the
 *   STABLE TrackId (the same id family the favorite/playlist flows use).
 * - HistoryPlay::Track refs a TrackLite (Title, LengthSeconds, Album ref);
 *   the referenced AlbumLite carries Title + PerformedBy (album artist).
 * - RetainPage/ReleasePage resolve only under the DERIVED declaring type
 *   (VirtualHistoryPlayQuery::), and the Core never invokes ReleasePage's
 *   ResultCallback — send it fire-and-forget, exactly once per page (see
 *   docs on object lifetime; over-releasing corrupts refcounts).
 */
import { exportPlayHistory } from '../src/history-export';
import { RoonClient } from '../src/proto/client';

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 50;
  if (!/^\d+$/.test(value)) throw new Error('limit must be a non-negative integer');
  const limit = Number(value);
  if (!Number.isSafeInteger(limit)) throw new Error('limit must be a non-negative safe integer');
  return limit;
}

function parseBrokerId(value: string | undefined): Buffer {
  if (!value || !/^[0-9a-fA-F]{32}$/.test(value)) {
    throw new Error('set ROON_SERVER_BROKER_ID to the Core server broker ID (32 hex characters)');
  }
  return Buffer.from(value, 'hex');
}

async function main(): Promise<void> {
  const limit = parseLimit(process.argv[2]);
  const brokerId = parseBrokerId(
    process.env.ROON_SERVER_BROKER_ID ?? process.env.ROON_BROKER_ID
  );
  const roon = new RoonClient({
    host: process.env.ROON_HOST || 'YOUR_CORE_IP',
    serverBrokerId: brokerId,
  });

  try {
    await roon.connect();
    const { total, events, skipped, duplicates } = await exportPlayHistory(roon, { limit });
    console.error(
      `history: ${total} play(s) on the Core; exporting ${events.length}, ` +
        `skipped ${skipped} unresolved, deduplicated ${duplicates}`
    );
    for (const event of events) console.log(JSON.stringify(event));
  } finally {
    // close() is safe before or after establishment, so failed connects do not
    // leave a socket attempt behind.
    roon.close();
  }
}

main().catch((error: unknown) => {
  console.error('FAILED:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
