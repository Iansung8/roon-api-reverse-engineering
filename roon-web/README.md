# roon-web

A web client showcasing the reverse-engineered Roon internal API
(`../roon-internal-api`). A thin Node backend holds one live `RoonClient`
connection to the core and serves a vanilla TS single-page app.

The browser can't open raw TCP, so the backend owns a live connection and replaces
it after terminal close. Session generations prevent old object ids from crossing
recovery; the browser clears and reloads its entities when the session changes.
The backend bridges the connection over HTTP + WebSocket.
The SPA is plain TypeScript bundled by esbuild — no framework.

## Features
- **Now Playing** — live zone cards (state, seek, transport: ⏮ ⏸/▶ ⏭), pushed
  over WS every 2 s.
- **Search** — Core UnifiedSearch results for albums, tracks, performers, works,
  playlists and genres, correlated to the current query.
- **Library** — loaded albums with play and profile-aware favorite state.
- **Devices** — per-endpoint volume sliders and power (standby) toggles.
- **API Explorer** — the full reverse-engineered surface (152 services /
  1550 methods) from `catalog.authoritative.json`, with a live filter.

### Safety
Audio (`play`) and power (`standby`/`power on`) are confirm-gated in the UI **and**
require `confirm:true` on the WS message; the play target defaults to the `HiFi`
zone. Favorites are reversible. Destructive methods are never exposed.

## Run
```
cd roon-web
npm install
npm run dev      # builds the SPA + starts the server
```
Then open http://localhost:4321

Env: `ROON_HOST` (default YOUR_CORE_IP), `ROON_SERVER_BROKER_ID`, `PORT` (4321).

Run `npm test`, `npm run typecheck`, and `npm run build` for web validation.
`../docs/plans/2026-06-12-WEB-CLIENT.md` preserves the historical implementation plan.
