# Web recovery and state cleanup plan

The audited failures share one cause: the web layer treats session-scoped data
as process-lifetime state. The cleanup keeps the existing controls and wire
protocol, but makes each state transition explicit and testable.

1. Lock connection recovery with regressions for concurrent callers, failed
   recovery, terminal close, stale close callbacks, and truthful current-health
   state. Replace the cached singleton variables with a small injected client
   pool that creates a fresh `RoonClient` after a terminal close while
   preserving the SDK's existing close callback.
2. Lock favorite rendering and interaction with regressions for an initially
   favorited album, a successful unfavorite, a failed favorite, and duplicate
   clicks while a request is pending. Read `Album::IsFavorite` from the graph,
   represent missing state as unknown, and update every matching control only
   after the server result is known.
3. Lock search request state with regressions for out-of-order responses,
   short/empty input, repeated terms, and current result identities. Route the
   backend through the SDK's `UnifiedSearch` helper, map only the result kinds it
   returns, and correlate browser requests with monotonically increasing ids.

No SDK production files, generated APIs, safety confirmations, or dependencies
will change. The legacy exported `Arg.refList` cleanup remains outside this web
work.

## Review follow-up

The first recovery pass replaced the dead backend client, but did not invalidate
the browser's object ids. The follow-up makes the Core session an explicit part
of every entity-bearing exchange.

1. Add a monotonically increasing generation to the client pool. Close a
   candidate whose `connect()` rejects, retain identity guards around its late
   close callback, and expose an atomic `{ client, generation }` session read.
2. Include the generation in snapshots, library/search responses, and browser
   entity commands. Reject commands before dispatch when their generation does
   not match the current session, so an old album, zone, or endpoint id never
   reaches a replacement `RoonClient`.
3. Reset all browser entity and pending-favorite state when the WebSocket closes
   or a different Core generation arrives. Reconnect by requesting a fresh
   snapshot and reloading the library; re-run only the current valid search.
4. Extend regressions through the real app event wiring with a small injected
   browser fixture: verify disconnect clears pending favorites, generation
   changes remove old controls, and stale results/actions cannot cross sessions.
5. Keep request-id isolation around SDK search results. Cover concurrent and
   repeated same-query responses as distinct returned identity sets; the SDK
   owns callback-root membership and list decoding.

No Core calls, SDK production edits, workflow edits, dependencies, or changes to
the existing confirmation gates are part of this follow-up.
