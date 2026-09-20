# ADR 0002: Conservative first durable engine

Status: accepted for implementation, 2026-09-20. Requirements: F02, F19; partial V02, V06, V07, V12, V18.

The first workflow package implements an acyclic graph of tool steps and joins over a scoped compare-and-set aggregate store. A tool step may request a human approval before its execution; this is the compact authoring form of the approval dependency in the durable specification. SQL state and events update atomically. Full job leases, durable timers, delivery outbox, external workers and all general workflow operations remain subsequent work.

## Exact slice boundaries

- A registered definition contains stable ID/version, input/output Standard Schemas, nodes with explicit dependencies, input bindings and an output binding. Bindings are `{kind:'literal',value}`, `{kind:'input',path: string[]}`, or `{kind:'step',stepId,path:string[]}`. A binding selects a complete JSON value; callers can use a pure preparatory tool when constructing objects from several values. No evaluation of strings or prototype traversal.
- Limits cap graph size, steps, input/output bytes and fixed tool costs. This slice does not dispatch models inside workflow steps unless registered as a separately bounded trusted tool.
- Submission pins a canonical digest of definition identity, tool versions, graph and resolved input. Tool/schema implementations remain registered trusted code; versioning requires deployment discipline and is not inferred from JavaScript closure source. No automatic version migration.
- Dispatch uses a CAS transition from pending/approved to dispatching, records the stable call ID and fixed cost reservation, then invokes the same broker as ordinary tools. The claim is an exclusive durable state, not a renewable worker lease. Multiple callers cannot claim it twice.
- A tool's trusted receipt persistence hook records the actual execution outcome before output validation. If the process dies after receipt persistence, the known effect remains; absent a durably admitted output, downstream work is blocked until an explicit future recovery facility. Never repeat the write to regenerate output.
- Process restart automatically continues pending work and approval requests. An already dispatching step is not automatically reclaimed. A trusted operator explicitly calls recovery after establishing abandonment; it changes uncertain work to unknown and invalidates old state advancement. Late receipts remain evidence. This conservative slice does not claim automatic lease recovery or universal exactly-once execution.
- Human approval uses an injected trusted identity verifier, exact candidate digest, a configured policy version and expiry. A client-provided `human` flag does not authenticate anyone. Approval never overrides denied capabilities; changed policy/grants require fresh review.
- No generated host-code support is implied. Cooperative cancellation stops new dispatch, while in-flight outcomes remain uncertain until receipts establish them.

## Exit evidence

The current experimental persisted workflow format is **2**. It records step kinds and requires successful/released receipts for completed tool steps. It rejects format 1 rather than guessing a migration for missing evidence. This change precedes any published release; existing development data needs explicit inspection/migration before reuse. Tests use fresh isolated records.

Approval targets and submission input/key are snapshotted before asynchronous callbacks. Definitions are immutable and package-branded. Receipt merging preserves known completion over stale cancelled/unknown snapshots. Closing a runtime stops admissions/public operations and requests cancellation; an already-dispatched receipt callback can still persist evidence while the separately owned store remains open. Closing storage or killing the process can prevent that, leaving reconciliation necessary. No late output is automatically released.

Same-store suites on SQLite/PostgreSQL: scoped idempotency, two branches plus join, exact human review, fresh runtime continuing persisted approval, conflicting approval, shared budget, successful receipt with invalid output, concurrent dispatch exclusion and abandoned work marked unknown without replay. Separate process-kill tests and store failure injection remain required before completing V02. These are narrower guarantees than the full durable specification and must be labeled accordingly.
