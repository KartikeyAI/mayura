# WorkStream: durable signal and wait foundation

Status: experimental, scoped SQLite/PostgreSQL aggregate implementation. This is the signal/wait subset of F18, not a complete scheduler, timer service or V04 qualification.

## Contract before implementation

`createWorkStream({store, scope, streamId})` creates a trusted application-side handle. The caller initializes and owns the store. `initialize()` creates or reopens a versioned stream. A stream is a bounded durable journal of named signals plus registered waits, all in one compare-and-set aggregate. Verified principal/project identity is configured by the application, never taken from a signal payload.

- `signal({id, name, value})` writes a signal once. Retrying an identical ID/name/value returns the existing signal; changing any content conflicts. Signals are broadcast, not destructively consumed.
- `register({id, mode, conditions})` persists an `all` or `any` wait and returns its snapshot immediately. Each condition has a unique ID, signal name and optional exclusive `after` signal sequence. The earliest matching signal wins for each condition. For `any`, the lowest signal sequence wins; declared condition order breaks ties.
- Registration and signal insertion atomically resolve all newly satisfied waits. An event arriving before registration is observed unless its sequence is explicitly excluded. Repeating the identical registration returns the current snapshot; changing a definition under the same ID conflicts.
- `inspect(id)` is read-only. `cancel(id)` transitions only a waiting record. A completion/cancellation race is decided by the successful storage compare-and-set; neither terminal result is later overwritten.
- `signals({after,limit})` returns a bounded ordered page with the next cursor. Signals are retained for the stream lifetime; no silent truncation or implicit gaps.
- `events(after)` returns metadata-only inspection history. No raw signal payload enters audit events.

Wait states are `waiting`, `succeeded` and `cancelled`. Completed waits hold immutable match references and values. An `any` wait has no remaining live subscriptions after completion: matching is performed against the persisted waiting state, not per-branch promises. `all` conditions may match the same broadcast signal when their names/cursors permit it.

There is no background worker, held transaction, live Promise or retained model request while waiting. An application can exit after registration and reopen the stream in another process. Cross-worker notifications, workflow graph wait nodes, timers/deadlines, child handles, UI streaming and retained-history compaction are later explicit capabilities. Do not implement a long-lived server request by busy-polling `inspect`.

## Bounds and trust

Initial limits: 256 signals, 128 waits, 32 conditions per wait, 4 KiB per signal value and 1 MiB total aggregate state. Limit exhaustion fails before mutation; completed records are not silently evicted. This intentionally prioritizes atomic correctness over large-volume throughput. A future normalized/indexed storage revision and migration must precede claims of unbounded production scale.

CAS retries are bounded to 32 and apply only to pure state transitions, never external effects. An uncertain storage response can be retried with the same stable command ID. Public errors omit driver messages and rejected content. Returned records are immutable bounded JSON. Unsupported or corrupt stored formats fail closed.

The configured store and direct caller are trusted. This package is not authentication, encryption-at-rest, a signal approval service or a policy bypass: exposing commands to an agent, HTTP client or MCP client requires normal scoped authentication and tool admission. Only already admitted data should be stored or disclosed. Payloads can remain in database pages/backups; this slice makes no secure-erasure promise.

## Required evidence

Identical SQLite/PostgreSQL tests must cover event-before-registration, identical/conflicting retries, restart, scope separation, concurrent registration/signal delivery, deterministic all/any matching, cancellation/completion races, immutable results, safe errors, bounds and zero effects from inspection. These tests qualify this subset only; V04 remains open for timers, nested execution waits, reconnect/gaps and subscription delivery.
