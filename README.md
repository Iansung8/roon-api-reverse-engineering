# roon-internal-api — a reverse-engineering experiment

Roon ships a small, sandboxed extension API
([`node-roon-api`](https://github.com/RoonLabs/node-roon-api)) — no metadata editing, no real
library management, just a slice of what the desktop app can do. Roon users have been asking
for something more capable for years.

This is the brute-force route: watch what Roon's **desktop client** sends to the Core over
its private binary protocol (`Sooloos.Broker.Remoting`, **TCP port 9332**), work out the wire
format, and see how much of it you can replay from your own TypeScript. It's a
**proof-of-concept / investigation**, not a finished or supported tool — and it is **not
affiliated with or endorsed by Roon Labs**.

Most of it (the protocol decoding, the TS port, the codegen, the docs) was done
pair-programming with **Claude** (Anthropic's Claude Code).

📖 **Write-up & docs: https://arthursoares.github.io/roon-api-reverse-engineering/**

> [How this went](https://arthursoares.github.io/roon-api-reverse-engineering/journey/) ·
> [Protocol notes](https://arthursoares.github.io/roon-api-reverse-engineering/protocol/overview/) ·
> [Using the client](https://arthursoares.github.io/roon-api-reverse-engineering/api/getting-started/) ·
> [Contributing](https://arthursoares.github.io/roon-api-reverse-engineering/contributing/)

## What this is (and isn't)

One person tinkering against a single Core, confirmed by hand — not a tested product across
setups. Treat everything as "worked for me."

- 🔎 **The interesting finding:** on the local network the protocol doesn't seem to use any
  authentication. The expected wall — "mutations need a cloud auth token" — turned out (in my
  testing) to be wrong. The real difficulty was the wire format and the fact that object
  references are ephemeral, so it's **browse-then-mutate**, not authenticate-then-mutate.
- 🧩 **Protocol** — framing, varints, primitives, calls, by-val structs, and the object graph
  are mapped well enough to drive a Core, cross-checked against my own captures.
- ⌨️ **TypeScript port** (`roon-internal-api/`) — ~14k LOC. Typed wrappers are generated for
  all ~1550 methods, but **only a handful have been run live** — the rest are generated from
  metadata and untested.
- ✅ **Tried by hand** against one Core: read object graph, favorite, play (audio), pause,
  standby/power, a reversible metadata edit.
- 🚧 **Open:** broader generated methods and streaming-catalog behavior still need validation.
  Server-side UnifiedSearch and bounded play-history reads have working examples.

### Extension API vs internal protocol

| | Extension API (public) | Internal protocol (this experiment) |
|---|---|---|
| Port | 9330 | **9332** |
| Format | text (MOO/1) | **binary (`Sooloos.Broker.Remoting`)** |
| Transport | WebSocket | raw TCP |
| Auth | pairing | **none seen locally** |
| Reach | sandboxed subset | most of what the desktop app does |

## Quick start

```bash
cd roon-internal-api
npm install
npx tsc --noEmit && npx jest      # type-check + tests
ROON_HOST=192.168.1.50 ROON_SERVER_BROKER_ID=0123456789abcdef0123456789abcdef \
  npx ts-node examples/demo.ts     # connect + read your Core's object graph
```

`ROON_BROKER_ID` remains accepted as a legacy alias by `examples/demo.ts`; new scripts should
use `ROON_SERVER_BROKER_ID`.

```ts
import { RoonClient } from './src';

async function main(): Promise<void> {
  const host = process.env.ROON_HOST;
  const brokerId = process.env.ROON_SERVER_BROKER_ID;
  if (!host || !brokerId || !/^[0-9a-f]{32}$/i.test(brokerId)) {
    throw new Error('Set ROON_HOST and ROON_SERVER_BROKER_ID (32 hex characters)');
  }

  const roon = new RoonClient({
    host,
    serverBrokerId: Buffer.from(brokerId, 'hex'),
  });
  try {
    await roon.connect();
    console.log('Library oid:', roon.serviceOid('Library').toString());
  } finally {
    roon.close();
  }
}

main().catch(console.error);
```

See [Getting started](https://arthursoares.github.io/roon-api-reverse-engineering/api/getting-started/)
for how to find your Core's host + broker id.

## Repository layout

```
roon-internal-api/   the TypeScript client — src/, oracle/, tools/, examples/
roon-web/            a small web client poking at the API
docs/                working notes & the decision log (docs/plans/ is the real history)
site/                this docs site (Astro + Starlight), deployed to GitHub Pages
captures/            packet captures used to work out the protocol
```

## Contributing

Help welcome — see the
[contributing guide](https://arthursoares.github.io/roon-api-reverse-engineering/contributing/).
Most contribution is **validation**: confirming
generated methods against a live Core via captures, oracle goldens, or visible effects.

## ⚠️ Stability & safety — read this

This protocol is an **internal interface meant for Roon's own trusted code**, not a public
API. Two consequences worth taking seriously:

- **It will break.** Roon versions the client and Core in lockstep and changes this protocol
  freely, with no backward-compatibility promise. Any Roon update can break this client
  without warning.
- **Misuse can degrade the Core you point it at.** Because it assumes well-behaved callers,
  the protocol isn't hardened for third parties. There are resource-management obligations
  across the connection — releasing handles, tearing down subscriptions, completing callbacks
  — that this client may not get right (it was reverse-engineered, not specified). Getting
  them wrong can leak memory or compute **inside your own Roon Core**. Only point it at a Core
  you own and can restart, and don't run it against anything you can't afford to disrupt.

## Roon's position

I shared this on the Roon community forum, and Roon's CTO
[responded](https://community.roonlabs.com/t/reverse-engineering-the-roon-desktop-clients-local-protocol-typescript-client-docs/321731):
they don't object to interoperability tinkering against your own system, but explicitly
flagged the two risks above — protocol instability and resource-management obligations that
an automated reverse-engineering pass may not have gotten exactly right. Worth reading in full
before you build on this.

## Legal & ethics

Independent **interoperability and learning** experiment. **Not affiliated with, endorsed by,
or supported by Roon Labs.** It works only against a Core you control, speaking a protocol
Roon's own client already uses on your network. The protocol is private and unversioned — it
can break on any Roon update. MIT licensed.
