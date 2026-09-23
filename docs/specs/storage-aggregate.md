# Transactional aggregate storage: first implementation boundary

This package implements a small trusted building block for the [durable execution contract](durable-execution.md), not that entire execution engine. It persists bounded JSON aggregate snapshots and an atomic ordered event history. It does not authenticate callers, authorize actions, dispatch effects, reconcile remote outcomes, own human approval semantics, or implement a durable event-delivery outbox.

The runtime must supply verified scopes and use compare-and-set updates to implement its state-machine invariants. Calling the storage adapter directly from untrusted tools is not permitted. These constraints apply equally to SQLite and PostgreSQL.

## Contract

- Call `initialize()` before use and `close()` when finished. Schema version one is recorded in package-owned metadata; no general migration claim is made yet.
- `create()` atomically inserts version one and its initial events. Unique `(scope, idempotencyKey)` preserves a SHA-256 digest of the original canonical submission, including ID, definition hash, initial state and initial event contents. An identical retry returns the existing current record with `created: false`, even after updates. A changed submission conflicts; comparing against mutated current state would be incorrect.
- Canonical encoding version one uses sorted UTF-16 object keys, ordinary JSON primitive encoding, ordered arrays, and the domain prefix `mayura:aggregate-submission:v1\n`. Non-JSON values, unsafe integer numbers, accessors and unsafe object keys are rejected by core JSON validation. Negative zero serializes as zero. PostgreSQL stores JSON as validated text so its JSONB null-character restriction does not create a cross-adapter behavior difference.
- `update()` checks the expected version, replaces state, increments version and appends events in one transaction. A stale version commits neither state nor events. Idempotent retry after an ambiguous update response requires reading the record and checking a runtime-owned command identity in state; this lower-level method intentionally has no automatic blind retry.
- Additive [scheduled enrollment](scheduled-workflows.md) blocks ordinary `update()` on owned runs with `SCHEDULED_WRITER_REQUIRED`. Its finite atomic commands, not generic replacement-state writes or standalone claims, own those aggregates.
- Events have monotonically increasing per-aggregate sequences starting at one, store-assigned UTC timestamps, a type and JSON object data. `events(scope, id, after)` returns up to 1,000 events; repeat from the last sequence until a short page. Event history is durable data, not a publisher or an implicit authorization check.
- Missing or cross-scope reads return `undefined`; missing/cross-scope event reads return `[]`; missing/cross-scope writes return `NOT_FOUND`. The same ID and idempotency key can exist in different scopes.

Input limits: state one MiB; each event data 64 KiB; at most 1,000 events and one MiB combined event payload per transaction; depth 32 and 100,000 JSON nodes; identifiers are nonempty well-formed Unicode strings of at most 256 UTF-8 bytes without null characters. Unpaired surrogate units are rejected before SQL encoding; valid strings are never normalized or repaired. This identity-only rule does not alter escaped surrogate content in JSON payloads; see [SQL identity integrity](sql-identity-integrity.md). Counters use checked safe integers. Public driver failures are sanitized and do not expose SQL, paths, state or connection secrets.

## Adapter implementation

SQLite is owned by one `worker_threads` worker per adapter instance. The application communicates over a bounded queue of 256 outstanding requests. Synchronous driver transactions never run on the application's event loop. WAL, `synchronous=FULL`, foreign keys and short immediate write transactions are enabled. File-backed stores are the durable profile; `:memory:` remains explicitly volatile. The worker thread is an event-loop isolation mechanism, not a hostile-code security sandbox. Multiple adapter instances still serialize against SQLite file locks; this is not a network-filesystem deployment.

PostgreSQL uses a bounded connection pool, scoped composite primary/unique keys, row locks for compare-and-set updates and transactions for snapshot/event atomicity. Bootstrap is serialized with a transaction advisory lock. Schema identifiers accept only lowercase ASCII identifiers of at most 63 characters before interpolation; all application values use SQL parameters. Schema separation is operational organization, not a substitute for verified scope authorization.

For this small adapter, reviewed parameterized SQL is used directly rather than adding Kysely. SQL and locking semantics remain confined to the storage package; this is a narrow technical-proposal refinement, not a change to the public store contract. SQLite/pg dependencies are optional infrastructure packages relative to the base SDK; they must not enter its dependency graph.

## Verification boundary

A shared conformance suite covers original-submission idempotency after mutation, conflicting submissions, scope isolation, version races, ordered atomic events, bounded JSON, close/reopen persistence and schema-identifier rejection. The PostgreSQL integration suite runs only when `MAYURA_TEST_POSTGRES_URL` is set and should be required in release CI; a skipped local integration suite is not PostgreSQL qualification evidence.

The separate scheduled profile now exercises finite fenced jobs, approvals, receipts, output admission, fixed-cost accounting and selected crash boundaries. General durable composition, migrations/backups, reconciliation and operational qualification remain before production readiness. This aggregate interface alone proves no exactly-once external effect guarantee.
