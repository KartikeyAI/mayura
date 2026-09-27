# Durable execution-completion waits

Status: implemented bounded completion-join slice; current verification is recorded in the [release ledger](../development-status.md). Authority: the governing framework plan's WorkStream/workflow requirements, [WorkStream signals](workstream.md) and [scheduled workflows](scheduled-workflows.md). This is not graph suspension, durable children or full V04/V05 qualification.

## 1. Scope and public use

Implement metadata-only `all` joins over **already submitted scheduled-v1 workflow runs or scheduled-v2 graphs**, in the same configured database, verified principal/project scope and pinned policy. The graph extension uses the same exact reference/fact format, with separately versioned source state. Completion means terminal, not necessarily successful: `succeeded`, `failed`, `blocked`, `cancelled`, and `outcome_unknown` all satisfy a target. Waiting/approval/running states do not. Unknown outcomes remain unknown and are never retried by this feature.

```ts
const target = await worker.reference(run.id);
const stream = createExecutionWorkStream({
  store, scope, policyHash: target.policyHash, streamId: 'deployment-joins',
});
await stream.initialize();
await stream.register({ id: 'join.release', targets: [target] });
// After other workers run, this finite control command resolves ready waits and returns.
await stream.drainReady({ limit: 16 });
const wait = await stream.inspect('join.release');
```

`createExecutionWorkStream` is a new `mayura/workstream/executions` export. Existing signal format 1 and workflow format 2 remain unchanged. Extend `ScheduledWorkflowRuntime` with `reference(id)` using its existing exact scoped/policy-checked inspection. A reference is immutable data, **not an authorization capability** or proof that a different configured database is the same logical backend.

```ts
type ExecutionRef = {
  kind: 'scheduled-workflow'; runId: string;
  definitionHash: string; policyHash: string;
};
type ExecutionCompletion = {
  reference: ExecutionRef;
  outcome: 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'outcome_unknown';
  sourceVersion: number;
  sourceEventSequence: number;
};
type ExecutionWaitSnapshot = {
  id: string; version: number; definitionHash: string;
  status: 'waiting' | 'resolved' | 'cancelled';
  targets: readonly ExecutionRef[];
  observations: readonly ExecutionCompletion[];
};
```

References use exact lower-case SHA-256 hex run/definition/policy identities. Wait/stream IDs use the existing simple bounded 128-character identifier syntax. Require 1–32 targets, no duplicate run IDs, and preserve declared target order. Wait definition digest covers format, configured scope/stream/policy, ID and ordered references. `observations` is empty unless resolved, then has exactly one pinned terminal fact per target in declared order. Outputs, errors, inputs, prompts and receipts are never copied into this metadata result. Read authorized workflow output/evidence separately.

Public facade methods: `initialize()`, `register({id,targets})`, `inspect(id)`, `cancel(id)`, `drainReady({limit?})`, `events(after?)`, and `close()`. Defaults: drain limit 16, maximum 32; 128 lifetime waits per stream, never silently evicted. Events page at most 1,000 records. Initial wait state is version 1 even if registered immediately resolved; a later resolution/cancellation advances it to 2. Identical registration returns its current terminal/waiting snapshot without another event; changed ordered content under the same ID conflicts. Unknown wait inspection returns undefined; cancelling unknown wait fails NOT_FOUND. Cancellation never cancels target workflows. Closing the facade stops new commands and returns without closing caller-owned storage or cancelling persisted waits.

No per-wait Promise, handler, execution permit, lease, polling loop or SQL transaction survives a command. Applications explicitly invoke finite drains; notifications/control workers are future drivers of the same durable readiness predicate, not claimed as implemented now. Bound custom-store calls with configurable `storageTimeoutMs` (default 10,000, max 30,000) and `maxPendingStorageOperations` (default 64, max 1,024), retaining pending-call capacity until the actual Promise settles. A timeout means an uncertain command acknowledgment, not rollback; retry register with identical identity and inspect after uncertain drain/cancel.

## 2. Driver-free capability contract

Add `ExecutionWaitStore` and `ExecutionWaitAggregateStore extends ScheduledWorkflowAggregateStore` in storage-contracts. The latter adds `.executionWaits`; do not require this property on existing custom scheduled/aggregate interfaces. SQL factory return types expose the extended capability, but normal SDK/runtime consumers gain no database dependency.

All storage commands are finite plain-data records; scope is the existing `mayura:scope:v1` digest. No application callback, schema validator, user clock, generic replacement JSON or cross-run mutation enters SQL. Storage methods:

```ts
initialize(): Promise<void>;
open({ scope, streamId, policyHash }): Promise<void>;
materialize({ scope, reference }): Promise<ExecutionCompletion | undefined>;
register({ scope, streamId, policyHash, id, targets }): Promise<ExecutionWaitSnapshot>;
inspect({ scope, streamId, policyHash, id }): Promise<ExecutionWaitSnapshot | undefined>;
cancel({ scope, streamId, policyHash, id }): Promise<ExecutionWaitSnapshot>;
drainReady({ scope, streamId, policyHash, limit }): Promise<readonly ExecutionWaitSnapshot[]>;
events({ scope, streamId, policyHash, after }): Promise<readonly StoredEvent[]>;
```

`materialize` is explicit idempotent maintenance: fully load/validate the enrolled target under its normal scheduled locks, reject wrong definition/policy/missing/unenrolled references, and insert a fact if it is terminal. It returns undefined for a valid existing nonterminal target. `register` performs this bounded target validation/materialization for every target **before** its wait transaction, so old terminal records are supported without weakening live reference checks. Validating/materializing a target never executes a handler or changes workflow aggregate version/history. Reads (`inspect`/`events`) never materialize or resolve anything.

The public WorkStream factory snapshots verified Scope and policyHash; target payloads cannot override either. Direct storage users are trusted hosts. Wrong scope, policy or immutable identity fails closed, without raw driver/configuration data in errors. Returned custom-adapter data also receives exact bounded structural/context validation before public disclosure; TypeScript alone is not that boundary.

## 3. SQL facts, waits and journal

Use separate versioned tables, never ordinary public aggregate replacement updates:

- `mayura_execution_completions`: one immutable terminal fact per `(scope, run_id)`, pinned definition/policy/outcome, observed source version/event sequence, bounded canonical data and integrity digest. Foreign key to scheduled owner identity.
- `mayura_execution_streams`: `(scope, stream_id)`, pinned policy, format 1, bounded wait count and event head. This row serializes same-stream control writes, including the lifetime capacity check.
- `mayura_execution_waits`: `(scope, stream_id, wait_id)`, version/status/registration sequence/definition digest plus canonical bounded snapshot.
- `mayura_execution_wait_targets`: ordered target index, with exact stored reference identities checked against the snapshot and matching terminal facts. No payloads.
- `mayura_execution_wait_events`: stream sequence/type/time and metadata-only `{waitId}` (stream-created metadata may be empty). Registered/resolved/cancelled history is atomic with state; no-op retries/drains append nothing.

Validate all redundant columns, digests, reference ordering/counts and result invariants before returning data or performing transitions. Each wait snapshot is at most 64 KiB; a drain return is bounded to 32 snapshots with an explicit aggregate transport limit. A stream has at most 257 journal entries (created plus up to two events for each of 128 waits). Multiple streams remain an explicitly host-managed storage/retention concern, not a claim of global tenant quotas or automatic erasure. SQL parameters carry all application values; only validated adapter prefixes are interpolated.

Exact journal types are `stream.created`, `wait.registered`, `wait.resolved` and `wait.cancelled`. An immediately resolved registration writes both registered/resolved events atomically while remaining snapshot version 1. Journal reads also cross-check bounded wait snapshots, so a terminal label contradicted by stored wait state fails closed. The 3 MiB drain transport bound includes array framing.

Scheduled workflow initialization creates the completion-fact table. Centralize terminal publication in `ScheduledWorkflowDatabase.save`: after validating/writing the aggregate and owned-job projection, insert/verify its fact **in the same transaction**, covering failure, blocked, cancellation, recovery and final success. If a fact already exists, identity/outcome must agree and its observed counters cannot exceed the current source counters; never overwrite its original observation. Late receipts/known charges may advance source evidence, not a terminal outcome or resolved join.

For existing terminal records, explicit materialization records the currently validated **observed source version**, not a fabricated first-terminal timestamp/version. New records/current writers publish automatically; old concurrent binaries that do not publish facts are not a supported mixed-writer deployment. No automatic replay, migration of arbitrary formats or repair of corrupt facts occurs.

## 4. Atomicity and lock order

Target publication retains current aggregate → jobs → resources order, followed by its completion fact. It never locks a wait or stream. Materialization follows the same target-only order and commits before any wait transaction.

Wait commands lock the stream row first, then operate only on that stream's bounded wait/index/event rows and read immutable completion facts. They never acquire a target's mutable aggregate/job/resource lock. Registration identity and capacity checks happen under the stream lock. PostgreSQL may use a scoped advisory identity lock when creating a stream before its row exists; SQLite's owning writer transaction serializes the equivalent operation. No cross-stream locks or callback waits are introduced.

`drainReady` selects only waiting entries whose **every** indexed target has a matching durable completion fact, ordered by registration sequence, up to the supplied limit. Readiness is a durable predicate, not a notification edge. Cancel versus resolve has one winner under the stream lock; terminal waits never change. Recheck selected snapshot/index/fact integrity before committing. A corrupt selected projection fails the transaction instead of silently resolving a partial result.

Race/recovery guarantees:

- Completion before registration is immediately observable; concurrent completion either resolves registration or leaves a durable ready candidate for the next finite drain.
- A crash publishes target state and fact together or neither. A crash resolves a wait and journals it together or neither.
- Lost register acknowledgments use the same immutable ID/content; lost drain acknowledgments are recovered by inspect. Returned drain pages are not promised to be replayed after an uncertain response.
- Cancelled waits leave targets untouched. Completed target `outcome_unknown` remains an explicit terminal observation requiring independent reconciliation.
- Repeated unchanged drains/inspection perform no version/event writes and retain no execution slots.

Privileged database writers can consistently forge all copies; integrity checks detect covered malformed/redundant-state corruption, not malicious administrators or every disk failure.

## 5. Qualification and exclusions

Write failure tests before implementation. Shared real SQLite/PostgreSQL cases cover all five terminal outcomes, references to existing running/approval states, pre-completion registration, reverse ordering, simultaneous completion/registration, scope/policy/definition mismatch, unsupported/malformed references, duplicate/conflicting IDs, whole-target-list validation before wait mutation, restart, idempotent fact materialization, late receipts, cancel/resolve races, two drainers, deterministic finite pages, lifetime caps, no-op event heads, exact immutable metadata and corrupt redundant projections. Add actual process-kill checkpoints proving atomic publication/resolution recovery, plus custom-adapter timeout/lifetime and forged-response rejection tests. Public packed declarations and a credential-free close/reopen example remain required.

Workflow format 2 still admits only tool/join nodes. The separately reviewed [format-3 graph contract](workflow-graph-waits.md) adds explicit wait nodes and parent-owned atomic registration/resolution without changing this stream format. Durable child ownership, propagated cancellation/shared descendant budgets, `any`/timers/future references, notification delivery and full enterprise operation/scale qualification remain unimplemented.
