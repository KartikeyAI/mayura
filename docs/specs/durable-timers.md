# Durable timer WorkStreams

Status: implemented experimental driver-free profile with shared SQLite/PostgreSQL conformance. Workflow graph timer nodes, a fleet scheduler and notifications remain separate work.

## Contract

`createTimerWorkStream` is exported by `@mayura/workstream/timers`. The application supplies an aggregate store, verified scope, dedicated stream ID and trusted synchronized clock. `initialize` creates or reopens one finite timer journal. It starts no interval, timeout, worker, network request or background process.

`schedule({id,dueAtMs,payload?})` persists one immutable absolute-time definition. An exact retry returns the current snapshot; changing time or payload under the same ID conflicts. Payload is bounded safe correlation data, not instructions, authentication, approval or execution authority.

`sweepDue({limit})` samples the trusted clock once, then atomically transitions at most 256 eligible scheduled timers. Selection is deterministic by due time and code-point ID. Each result persists its observed firing time and emits metadata-only evidence. Repeated and competing sweeps cannot fire a timer twice. Applications explicitly invoke finite sweeps from their own scheduler; no worker slot, JavaScript promise or transaction is held between them.

`cancel(id)` competes through the same aggregate compare-and-set transition. The first committed cancellation or firing is terminal; a later command returns that terminal fact and never overwrites it. `inspect`, bounded ID-keyset `list` and event cursors are read-only. Reopening on another process observes the same records.

## Boundaries

The profile retains at most 256 timers in a 1 MiB aggregate; each optional payload is at most 2 KiB. Records are not silently evicted. A future normalized format and explicit migration are required for high-volume or recurring scheduling.

Storage scope is isolation, not authentication. The application must authorize schedule/cancel/sweep commands before calling this trusted-host API. The host clock must be synchronized; Mayura rejects invalid clock values but cannot prove time correctness. Firing records readiness only—it does not dispatch a tool, resume a workflow, grant permission or imply an external effect occurred.

Recurring schedules, calendar rules, clock-source consensus, notification delivery, automatic workflow continuation and distributed fleet ownership are outside this slice. Applications should use stable commands and inspect after an uncertain storage acknowledgement.

## Evidence

The identical SQLite/PostgreSQL suite covers exact retries, changed definitions, due ordering and limits, restart, cancellation/firing races, terminal cancellation, pagination, scope separation, invalid input/clock behavior, contention, uncertain acknowledgement and corrupted-state rejection. An isolated offline packed consumer proves the subpath with a custom aggregate adapter and no SQL/runtime packages.
