---
title: Getting started
description: Point the experiment at your own Roon Core and read the live object graph.
sidebar:
  order: 1
---

`roon-internal-api` is the TypeScript side of this experiment. It lives in the
[`roon-internal-api/`](https://github.com/arthursoares/roon-api-reverse-engineering/tree/main/roon-internal-api)
directory of the repo. It's **not published to npm** — use it from a clone. Expect rough
edges; this is a proof-of-concept.

## Install

```bash
git clone https://github.com/arthursoares/roon-api-reverse-engineering
cd roon-api-reverse-engineering/roon-internal-api
npm install
npx tsc --noEmit   # type-check
npx jest           # the small test suite
```

## What you need from your own Core

Two values identify *your* Core. They aren't secrets (there's no auth here), but they're
specific to your install, so supply your own rather than copying mine:

| Value | What it is | How to find it |
|-------|-----------|----------------|
| `host` | Core IP / hostname | Roon → Settings → About, or your router |
| `serverBrokerId` | 16-byte Core id (hex) | read it off a capture of the handshake — see [Contributing](/contributing/#finding-your-core-details) |

:::tip
Keep them in env vars, not in code. The demo reads `ROON_HOST` and
`ROON_SERVER_BROKER_ID`, so you don't accidentally commit your own details.
`ROON_BROKER_ID` remains a legacy alias for the demo only; use the server-specific name in new
scripts.
:::

## Connect and read

The `RoonClient` facade is the front door. A minimal, read-only program:

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
    console.log('Zone oid:', roon.zoneByName('Living Room')?.toString());

    const album = roon.findByTitle('AlbumLite', 'Kind of Blue');
    console.log(album ? `found, oid=${album.oid}` : 'not loaded');
  } finally {
    roon.close();
  }
}

main().catch(console.error);
```

Run the included version with both variables set:

```bash
ROON_HOST=192.168.1.50 ROON_SERVER_BROKER_ID=0123456789abcdef0123456789abcdef \
  npx ts-node examples/demo.ts
```

On `connect()` the client does the handshake, resolves the root service, and starts
ingesting the streaming object graph — so zones, devices, now-playing, and loaded library
content are queryable via the helpers below. How reliable this is beyond my own setup, I
genuinely don't know.

## Core helpers on `RoonClient`

| Method | Purpose |
|--------|---------|
| `connect()` / `close()` | open / close the session |
| `serviceOid(name)` | object id of a singleton service (`'Library'`, `'Transport'`…) |
| `zoneByName(name)` / `endpointByName(name)` | resolve a zone / endpoint oid |
| `findByTitle(type, title)` | find a loaded object by title (e.g. `'AlbumLite'`) |
| `titleOf(obj)` | best-effort display title of an object |
| `call(service, method, params, args, oid?)` | low-level escape hatch to any method |
| `structArg(typeName, fields)` | build a by-val struct argument |

For doing things — favorites, playback, edits, search — see [Recipes](/api/recipes/). For
the full generated method surface, see [the generated API](/api/recipes/#the-full-generated-api).

:::caution[This drives your real system]
Anything that produces audio or edits your library is a real action against your live Core.
The examples target a single test zone and gate audio behind explicit calls. Don't auto-run
destructive methods (`Destroy*`, `ClearMetadataEdits`, deletes) — see the
[contributing guide](/contributing/#safety).
:::
