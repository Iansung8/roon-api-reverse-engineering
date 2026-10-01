# Changelog

## [0.1.1](https://github.com/arthursoares/roon-api-reverse-engineering/releases/tag/v0.1.1) — 2026-10-01

Protocol correctness, reliable Core sessions, and a read-only play-history exporter.
Prepared and adversarially reviewed with Codex.

### Added

- Read-only JSON-lines history export with bounded paging, identity deduplication,
  newest-first ordering, explicit retrieval failures, and page/query cleanup.
  [#18](https://github.com/arthursoares/roon-api-reverse-engineering/pull/18)
- Runnable SDK lint and PR validation for SDK/web tests and builds, documentation,
  and tracked, deterministic generated output.
  [#21](https://github.com/arthursoares/roon-api-reverse-engineering/pull/21),
  [#25](https://github.com/arthursoares/roon-api-reverse-engineering/pull/25)

### Fixed

- Reject pending RPCs promptly on close or failed sends; buffer split/coalesced
  handshake records and reject premature closure. Cancel the handshake watchdog
  once established so healthy idle sessions remain open.
  [#5](https://github.com/arthursoares/roon-api-reverse-engineering/pull/5),
  [#17](https://github.com/arthursoares/roon-api-reverse-engineering/pull/17),
  [#25](https://github.com/arthursoares/roon-api-reverse-engineering/pull/25)
- Use immutable full struct schemas and stable member indexes across handwritten
  and generated calls. Preserve captured `Sooloos.Broker.Api.*` wire names when
  newer DLL metadata uses `Roon.Broker.Api.*`.
  [#19](https://github.com/arthursoares/roon-api-reverse-engineering/pull/19)
- Preserve nullable values with the correct Bool/Sooid/scalar encodings and retain
  pre-serialized nullable scalar Buffer compatibility.
  [#22](https://github.com/arthursoares/roon-api-reverse-engineering/pull/22)
- Correct the exported legacy `Arg.refList` framing to match length-prefixed
  `Arg.collection` reference collections.
  [#23](https://github.com/arthursoares/roon-api-reverse-engineering/pull/23)
- Follow each search callback's ordered memberships, including cached full
  entities. Decode DataList separately from Query and preserve populated objects
  across repeated PUSHSTUB frames, fixing repeated and concurrent searches.
  [#24](https://github.com/arthursoares/roon-api-reverse-engineering/pull/24)
- Recover the web backend with fresh, coalesced clients; reject stale session IDs;
  clear disconnected UI/pending state and ignore late HTTP/search responses.
  Read profile-scoped favorite state and preserve playlist/genre search sections.
  [#25](https://github.com/arthursoares/roon-api-reverse-engineering/pull/25)
- Align onboarding with current exports and validated environment configuration;
  keep the demo read-only and label historical mutation experiments accurately.
  [#20](https://github.com/arthursoares/roon-api-reverse-engineering/pull/20)

### Compatibility

- `Arg.refList` remains exported but is deprecated; its invalid wire bytes are
  intentionally corrected. Prefer explicit `Arg.collection` construction.
- A typename's low-level struct declaration must remain immutable. Incompatible
  reuse and unknown/duplicate generated fields now fail explicitly.
- SDK search keeps its existing default result families. The optional third
  argument includes playlists and genres; the web opts in.
- The demo/history exporter accept `ROON_BROKER_ID` as a legacy alias for
  `ROON_SERVER_BROKER_ID`.

### Validation and limits

- 145 SDK tests and 25 web tests pass, along with SDK lint/build, web
  typecheck/build, deterministic generation, docs build, and hosted CI.
- Read-only validation on Roon 2.73 build 1696 covered a 150-play export,
  repeated/concurrent and named-category search, favorite-state rendering,
  controlled test-client recovery, stale-action rejection, and a usable session
  after more than 23 seconds of idle time. One concurrent read timed out;
  bounded retries passed.
- No live favorite/metadata, playback, volume, power mutation, or Core restart
  was used for validation. Write transitions use mocks and existing protocol
  evidence. Most generated methods remain unverified against a live Core.
- This remains an experimental private-protocol client; broader version and
  streaming-provider compatibility is not established. The offline drift-checker
  proposal remains tracked in
  [#16](https://github.com/arthursoares/roon-api-reverse-engineering/issues/16).

Thanks to **@jnolen** for the contributed close cleanup, handshake buffering,
and original history exporter in
[#5](https://github.com/arthursoares/roon-api-reverse-engineering/pull/5),
[#17](https://github.com/arthursoares/roon-api-reverse-engineering/pull/17), and
[#18](https://github.com/arthursoares/roon-api-reverse-engineering/pull/18).

[Full comparison](https://github.com/arthursoares/roon-api-reverse-engineering/compare/v0.1.0...v0.1.1)

## [0.1.0](https://github.com/arthursoares/roon-api-reverse-engineering/releases/tag/v0.1.0) — 2026-10-01

First experimental baseline at `5a9b561`: internal TCP/remoting client, object
graph, generated wrappers, corrected UnifiedSearch/stable-ID favorites/generated
collections, and MIT license. SDK validation passed 44 tests and the build;
web typecheck/build and documentation build passed. This baseline predates the
issue-fix batch above.
