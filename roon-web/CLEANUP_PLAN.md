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
