# WorkStream: durable signal and wait foundation

Status: experimental, scoped SQLite/PostgreSQL aggregate implementation. The bounded WorkStream race contract is V04-qualified; this package is not a background timer service.

## Contract before implementation

`createWorkStream({store, scope, streamId})` creates a trusted application-side handle. The caller initializes and owns the store. `initialize()` creates or reopens a versioned stream. A stream is a bounded durable journal of named signals plus registered waits, all in one compare-and-set aggregate. Verified principal/project identity is configured by the application, never taken from a signal payload.

- `signal({id, name, value})` writes a signal once. Retrying an identical ID/name/value returns the existing signal; changing any content conflicts. Signals are broadcast, not destructively consumed.
- `register({id, mode, conditions, deadlineAtMs?})` persists an `all` or `any` wait and returns its snapshot immediately. Each condition has a unique ID, signal name and optional exclusive `after` signal sequence. The earliest matching signal wins for each condition. For `any`, the lowest signal sequence wins; declared condition order breaks ties. A deadline is an absolute Unix epoch millisecond value retained with the wait.
- Registration and signal insertion atomically resolve all newly satisfied waits. An event arriving before registration is observed unless its sequence is explicitly excluded. Repeating the identical registration returns the current snapshot; changing a definition under the same ID conflicts.
- `inspect(id)` is read-only. `cancel(id)` transitions only a waiting record. `sweepDeadlines({limit})` uses the configured trusted host clock and atomically transitions due waits. Completion, cancellation and deadline races are decided by the successful storage compare-and-set; no terminal result is later overwritten. Applications must schedule bounded sweeps; WorkStream does not create a hidden process or timer.
- `signals({after,limit})` returns a bounded ordered page with the next cursor. Signals are retained for the stream lifetime; no silent truncation or implicit gaps.
- `events(after)` returns metadata-only inspection history. No raw signal payload enters audit events.

Wait states are `waiting`, `succeeded`, `cancelled` and `timed_out`. Completed waits hold immutable match references and values. An `any` wait has no remaining live subscriptions after completion: matching is performed against the persisted waiting state, not per-branch promises. Terminal transitions emit metadata-only `wait.subscriptions.disposed` evidence for losing or abandoned conditions. `all` conditions may match the same broadcast signal when their names/cursors permit it.

There is no background worker, held transaction, live Promise or retained model request while waiting. An application can exit after registration and reopen the stream in another process; persisted deadlines remain eligible for the next bounded sweep. Cross-worker notifications, workflow graph wait nodes, child handles, UI streaming and retained-history compaction are separate capabilities. Do not implement a long-lived server request by busy-polling `inspect`.

## Bounds and trust

Initial limits: 256 signals, 128 waits, 32 conditions per wait, 4 KiB per signal value and 1 MiB total aggregate state. Limit exhaustion fails before mutation; completed records are not silently evicted. This intentionally prioritizes atomic correctness over large-volume throughput. A future normalized/indexed storage revision and migration must precede claims of unbounded production scale.

CAS retries are bounded to 32 and apply only to pure state transitions, never external effects. An uncertain storage response can be retried with the same stable command ID. Public errors omit driver messages and rejected content. Returned records are immutable bounded JSON. Unsupported or corrupt stored formats fail closed.

The configured store and direct caller are trusted. This package is not authentication, encryption-at-rest, a signal approval service or a policy bypass: exposing commands to an agent, HTTP client or MCP client requires normal scoped authentication and tool admission. Only already admitted data should be stored or disclosed. Payloads can remain in database pages/backups; this slice makes no secure-erasure promise.

## Required evidence

Identical SQLite/PostgreSQL tests cover event-before-registration, identical/conflicting retries, restart-safe deadlines, scope separation, concurrent registration/signal delivery, deterministic all/any matching, explicit losing-subscription disposal, cancellation/completion/deadline races, immutable results, safe errors, bounds and zero effects from inspection. Signal cursors are exclusive and the bounded journal never silently truncates retained signals; runtime event observation separately emits explicit gap records when a retained event window is crossed. The paired `V04` fixture and runtime cursor-gap fixtures qualify the mandatory WorkStream race gate only.
