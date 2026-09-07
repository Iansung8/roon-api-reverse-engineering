# Roon Internal API Examples

This directory contains both the current facade demo and historical protocol experiments.
Only run scripts against a Core you own and can restart.

## Read-only onboarding

`demo.ts` is the supported starting point. It uses the exported `RoonClient`, connects, and
prints object-graph lookups. It does not dispatch a service method that changes Core state.

```bash
ROON_HOST=192.168.1.50 ROON_SERVER_BROKER_ID=0123456789abcdef0123456789abcdef \
  npx ts-node examples/demo.ts
```

The script validates that `ROON_HOST` is present and that `ROON_SERVER_BROKER_ID` is a 16-byte
hex value before opening a connection. `ROON_BROKER_ID` is accepted as a legacy alias.

## Historical protocol experiments

The remaining scripts preserve capture-driven research and are not maintained onboarding
examples. Their names and old comments do not establish current behavior.

`debug-flow.ts` is a mutation attempt, not a read-only example: after the handshake and schema
request it registers and dispatches `FavoriteOrBan`. Treat its outcome as historical evidence,
not a supported or safe control workflow. Other `favorite-*`, `live-*`, `edit-*`, and
`test-*` scripts may likewise send commands or make assumptions tied to one captured Core.

## Read-only play-history export

### `play-history.ts`
**Status: WORKING** (validated live against a 2.71 Core with a 10,630-play
history: a single-page run and a 150-play multi-page run — newest-first
order, unique play identities, zero unresolvable skips)

Exports the profile's play history, newest first, via
`Library::VirtualHistoryQuery` + per-page `RetainPage`/`ReleasePage`,
printing one JSON line per play (playedAt / artist / title / album /
completionPct / roonTrackId). The header documents the HistoryPlay wire
layout: `Time` is a .NET DateTime int64 (Kind bits + ticks), `HistoryPlayId`
equals the raw ticks, `TrackBase` is an inline TrackLink carrying the stable
TrackId.

```bash
npx ts-node examples/play-history.ts 50
```
