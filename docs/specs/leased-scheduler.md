# Leased scheduler: first storage vertical slice

Status: experimental standalone storage implementation, 2026-09-20. **Integrated workflow fencing and full V03 qualification are not claimed.**

Later additive slice: [scheduled workflows](scheduled-workflows.md) now implement explicit atomic workflow ownership using this ledger. The standalone operations documented here remain distinct: obtaining an ordinary scheduler claim does not enroll a workflow. Full V03 qualification remains open.

Governing requirements: [durable execution §§4–7](durable-execution.md), [aggregate storage](storage-aggregate.md), [plan V02/V03/V12](../create-mayura-agentic-framework-plan.md), and [current workflow boundary](../adr/0002-initial-durable-engine.md).

## 1. Decision and bounded delivery

Add an optional, trusted `SchedulerStore` capability to the existing SQLite storage-owner/PostgreSQL adapter implementation. Reuse its driver, bounded connection/IPC ownership, JSON validation, safe errors and transaction helpers. Do not implement leases by composing public `AggregateStore.read/update`: that interface has neither storage-clock predicates nor cross-record transactions.

The first delivery is a **standalone durable job ledger**: stable reservation, due-time selection, exclusive expiring claim, monotonic fence, dispatch marker, independent effect evidence/output completion, explicit resource exclusion, cancellation and conservative recovery. It is suitable for proving the storage lifecycle with a controlled handler fixture. It does not silently wrap the existing workflow driver and declare its writes fenced.

“Reserve a job” means reserve its stable logical identity and bounded intent, **not reserve money**. Workflow budgets remain the existing aggregate account; atomic job/budget integration is a required subsequent opt-in integration, described in §8. No new financial ledger, external queue, dependency, timer service, distributed worker service, automatic effect retry, provider reconciliation adapter or output-guard implementation is introduced by this slice.

Existing `AggregateStore` exports and existing workflow format-2 records remain readable and operational in their conservative profile. Creating the additive scheduler tables must not rewrite them or their original submission digest. Storage qualification of this ledger is only partial V03 evidence until workflow writes/admission use the same fence and cross-worker resource contract.

## 2. Minimal trusted interface

All identities are bounded strings; all times/counters are checked safe integers. `scope` is the opaque identity key derived by the trusted application, not a handler argument. Return values are immutable JSON snapshots. The application owns adapter lifecycle; the scheduler facade shares it and does not close a caller-owned store independently.

```ts
type JobState = 'ready' | 'leased' | 'started'
  | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'outcome_unknown';

interface JobKey { scope: string; jobId: string }
interface Claim extends JobKey {
  workerId: string;
  fence: number;             // strictly increasing ownership generation
  leaseUntilMs: number;      // informative; never accepted as authority from a caller
}
interface JobReservation extends JobKey {
  reservationKey: string;    // unique within scope
  runId: string;             // opaque correlation, not an authorization grant
  nodeId: string;
  invocationId: string;      // stable logical effect identity
  definitionHash: string;
  candidateHash: string;     // exact already-validated execution intent
  intent: JsonObject;        // references/safe metadata, not credentials or raw rejected data
  resourceKeys: readonly string[];
  delayMs: number;           // store computes dueAt; retries do not recompute it
  deadlineAfterMs?: number;  // fixed at first reservation, never extended by retry
}
interface JobRecord extends JobKey {
  runId: string; nodeId: string; invocationId: string;
  definitionHash: string; candidateHash: string; intent: JsonObject;
  resourceKeys: readonly string[];
  state: JobState; version: number; fence: number;
  workerId: string | null;
  dueAtMs: number; deadlineAtMs: number | null;
  leaseUntilMs: number | null; startedAtMs: number | null;
  leaseRevoked: boolean;      // sticky for this fence; reset only by a new claim generation
  cancelRequested: boolean;
  receipt: ExecutionReceipt | null;
  output: JsonValue | null;  // only a successful complete operation may disclose it
}
interface ReceiptCommand extends JobKey {
  fence: number;
  evidenceId: string;        // exact-content deduplication per attempt generation
  receipt: ExecutionReceipt;
}

interface SchedulerStore {
  initialize(): Promise<void>;
  reserve(command: JobReservation): Promise<{ job: JobRecord; created: boolean }>;
  read(key: JobKey): Promise<JobRecord | undefined>;
  claim(command: {
    scope: string; workerId: string; limit: number; leaseMs: number;
  }): Promise<readonly { job: JobRecord; claim: Claim }[]>;
  renew(command: { claim: Claim; leaseMs: number }): Promise<Claim>;
  start(command: {
    claim: Claim; candidateHash: string;
  }): Promise<{ status: 'started'; job: JobRecord } | { status: 'already_started'; job: JobRecord }>;
  recordReceipt(command: ReceiptCommand): Promise<{
    disposition: 'current' | 'late' | 'conflicting'; job: JobRecord;
  }>;
  receipts(command: JobKey & { fence: number }): Promise<readonly {
    evidenceId: string; receipt: ExecutionReceipt;
    disposition: 'current' | 'late' | 'conflicting'; recordedAtMs: number;
  }[]>;                       // at most 16 persisted evidence records for this generation
  complete(command: {
    claim: Claim; commandId: string; evidenceId: string;
    outcome: 'succeeded' | 'failed' | 'blocked';
    output: JsonValue | null;
  }): Promise<JobRecord>;
  cancel(command: JobKey & { commandId: string }): Promise<JobRecord>;
  recover(command: { scope: string; limit: number }): Promise<readonly JobRecord[]>;
  events(command: { scope: string; runId: string; after?: number; limit?: number }):
    Promise<readonly StoredEvent[]>;
}
```

These are application-side semantic methods, not tools exposed to generated code. `initialize()` initializes only this capability using the already shared backend lifecycle. It is not permission to migrate an unsupported existing scheduler version. Adapter factories may expose a separate scheduler facade/subpath; they must not add a native storage dependency to the base SDK.

`claim` intentionally has **no dispatch permit**. A worker is permitted to invoke its one handler only after its own `start` call returned `status:'started'` with confirmed commit. `already_started`, an ambiguous response, or inspecting a started row is never permission to call a handler. A lost start acknowledgement can sacrifice availability; it cannot justify duplicate execution. A runtime must consume its successful start result only once locally.

Read operations do not invoke handlers or renew leases. There is no generic job replacement, user transaction callback, public SQL handle or caller-controlled clock argument.

Reservation and command digests reuse aggregate canonical JSON version 1 with distinct prefixes `mayura:scheduler-reservation:v1\n` and `mayura:scheduler-command:v1\n`. Hash normalized semantic inputs; exclude store-assigned timestamps and the informational `Claim.leaseUntilMs`. Include scope, operation, job/attempt identities, candidate and complete/cancel payload where applicable. An omitted optional deadline stays absent in this encoding; explicit null is not accepted. Bounded stored receipt contents are compared through canonical JSON equality, without an additional retained hash. Receipt/control commands use explicit validated fields, not enumerable caller extras. Receipt insertion accepts only `disclosure:'withheld'`; completion is the separate release operation.

## 3. Tables and invariants

Use a separate scheduler schema-version record, initially version 1, so aggregate schema version 1 and workflow state format 2 are not spuriously bumped. SQLite table names below are database-local; PostgreSQL uses the same validated schema identifier rule as its current adapter. Parameterize every application value.

| Table | Keys and minimum persisted data |
| --- | --- |
| `mayura_scheduler_jobs` | PK `(scope,job_id)`; unique `(scope,reservation_key)` and `(scope,invocation_id)`; original canonical reservation digest; normalized queue/version columns plus one bounded authoritative JSON document containing `JobRecord`, original reservation, observed clock floor, claim generations, evidence and successful command journal. Read validation compares queue columns and reservation identity with that document. |
| `mayura_scheduler_requests` | PK `(scope,job_id,resource_key)`; immutable requested resources, FK to the job. This lets SQL skip resource-blocked jobs before the bounded candidate scan, preventing quarantined jobs at the front from hiding unrelated eligible work. |
| `mayura_scheduler_resources` | PK `(scope,resource_key)`; owning `(job_id,fence)`; `held` or `quarantined`; FK to the job. Transition checks enforce the generation stored inside the job. Resource names are exact identities, not inferred filesystem path aliases. |
| `mayura_scheduler_heads` | PK `(scope,run_id)`; last sequence. Dedicated scheduler history, **not** the existing workflow event sequence. |
| `mayura_scheduler_events` | PK `(scope,run_id,sequence)`; job ID, fence, safe event type/data, store time. FK to event head. No intent, output or raw receipt payload in public audit events. |

The implementation refinement keeps attempts, receipts and command records in the job's one-MiB validated JSON document rather than three additional tables. A generation stores worker, claim/lease/start times, end reason and at most 16 evidence records; only one generation may ever have a start marker. Evidence keys are unique per generation, command IDs per job. Successful command entries retain the command digest, committed version, operation (`complete`/`cancel`), and completion outcome (null for cancellation). Journal versions are strictly increasing and unique; completed-started states and cancellation flags require matching journal evidence. A retry returns the current terminal snapshot without reapplying the command. This is not an unbounded event-sourced JSON log, and it requires no JSON operators or adapter-specific JSONB behavior. Queue lookup and actual resource exclusion remain normalized SQL operations.

Foreign keys and checks enforce positive versions, nonnegative safe counters/times, enumerated states and nullability of ownership fields. TypeScript validation additionally rejects invalid JSON, mismatched receipt call/tool identities and impossible state combinations before writing **and** after reading. Original due/deadline intervals must agree with reservation creation and the observed clock floor; a failed completion requires a known failed receipt. Receipt identity is pinned in reservation intent through explicit `toolId` and `callId` fields; the store validates these required fields rather than guessing from an arbitrary payload. Resource keys are canonicalized, sorted and deduplicated before the reservation digest is computed.

Job loading takes the relevant row lock even for inspection, so the JSON, request projection and actual resource holds are checked against one coherent transition. Held/quarantined resources must exactly match the job generation and state. Claim selection also excludes resources requested by other leased/started/unknown jobs, independently of the hold row, and indexes that lookup by `(scope, resource_key, job_id)`. This conservative redundant check prevents accidental hold-row loss from admitting overlapping work. It is not tamper-proof storage or protection against a privileged actor rewriting every copy. Public event reads validate their exact type/data allowlists and canonical timestamps; corrupt payloads are never copied into audit output.

Create partial indexes for due ready jobs `(scope,due_at_ms,job_id) WHERE state='ready'`, expired ownership `(scope,lease_until_ms,job_id) WHERE state IN ('leased','started')`, and deadlines `(scope,deadline_at_ms,job_id) WHERE state IN ('ready','leased','started')`. Index FK lookups used during job/resource/receipt inspection. PostgreSQL claim queries use a bounded, ordered `FOR UPDATE SKIP LOCKED` selection; skip-locking is a queue optimization, not authorization or a replacement for state predicates.

No rows are silently evicted. Job/attempt/receipt history retention requires an explicit later policy; initial hard caps fail before mutation. Suggested qualification limits: 128 jobs selected/scanned per claim/recovery pass, 32 returned claims, 32 resources per job, 128 claim generations per job, 16 evidence records per generation, 64 successful control commands per job, 4 KiB intent, 64 KiB output, 256-byte IDs and 1,000 events per read. Public immutable reply snapshots allow up to 8 MiB / 300,000 JSON nodes so valid bounded event/recovery pages are not rejected merely for exceeding the default single-value JSON limit. Counters have overflow checks independent of SQL integer capacity. The amount of retained history across jobs is not claimed to be globally bounded.

## 4. Storage time and transaction order

Lease duration is configurable within 1–300 seconds for the first qualification profile. A renewal is `now + leaseMs`, capped by the job's original deadline; it is not an extension of an old caller-provided expiry. Delays/deadlines are bounded to 30 days initially, and a supplied deadline must fall strictly after the due time. These are scheduler qualification limits, not full-workflow lifetime limits.

Every authority-changing operation samples time **after acquiring its relevant job locks**. PostgreSQL uses a millisecond conversion of `clock_timestamp()` from that connection, not `transaction_timestamp()` captured before a lock wait. SQLite obtains UTC milliseconds from SQL on the dedicated storage-owner connection, for example combining `strftime('%s','now')` with the fractional milliseconds in `strftime('%f','now')`; the exact expression gets an adapter conformance test. Neither implementation uses the caller's `Date.now()` for admission.

For an existing job, effective time is at least its persisted last-observed clock floor. Persist that floor with a successful transition; never move it backwards. Expiry uses `leaseUntilMs <= now`; renewal/start/completion require `leaseUntilMs > now` **and** no persisted revocation. Observing a newly expired generation during an authority-changing call atomically records its clock floor and sticky `leaseRevoked` flag before returning `STALE_CLAIM`. Return a tagged stale result from the transaction, commit this metadata/event, then raise the safe error; throwing inside and rolling back the observation would permit resurrection after a backwards clock adjustment. Recovery also selects flagged generations even when the wall clock is now earlier than their old expiry. A new claim increments the fence before clearing the flag. A read-only clock sample is not a reusable authorization proof.

This is storage-authority wall time, not a promise of a perfect distributed monotonic clock: clock adjustment can lengthen or shorten availability windows. Host/database time synchronization remains an operational requirement. Fences and permanent started/unknown markers preserve exclusion independently of a later wall-clock correction. Process restart never resets a fence or rewrites due/expiry times from a local monotonic timer.

All write transactions are short; no handler, schema validator, policy callback, HTTP call or model executes inside them. SQLite retains WAL, `synchronous=FULL`, foreign keys, immediate write transactions and bounded busy handling. PostgreSQL uses the existing bounded pool/timeouts and `READ COMMITTED` with explicit locks. Lock order is job keys sorted, then resource keys sorted, then that run's event head; operations must not acquire a job lock after an event-head lock. A claim batch can select candidates once but commits each selected job in its own bounded transaction, so a busy resource cannot roll back unrelated claims. Claim/recovery reads are hints; each per-job transaction rechecks every predicate.

For resource rows, the implementation uses ordered conflict-safe inserts. A committed conflicting holder is skipped; a simultaneous uncommitted insert can wait within the existing five-second lock timeout, failing closed if unavailable. A failed resource claim rolls back all holds for that job. Identical resource ordering applies across claim/release/recovery; no resource-owning transaction later acquires another job lock. The shared suite stresses these races rather than inferring correctness from the index choice.

SQL serialization/deadlock retries may repeat only these pure transactional state transitions, with bounded retry/backoff. They must never retry the handler. Driver/connection errors return safe `STORAGE_UNAVAILABLE`; malformed inputs return `INVALID_INPUT`; changed content/version returns `CONFLICT`; an obsolete/expired ownership token returns `STALE_CLAIM`. A lost commit response remains ambiguous until the same stable command is inspected/retried under the rules below.

## 5. Exact transitions

| Operation | Required atomic behavior |
| --- | --- |
| `reserve` | Validate the complete bounded command. Insert one ready job, fixed store-derived due/deadline, original submission digest and `job.reserved` event. Identical key returns the existing current job even after execution; changed identity/intent/delay/resources conflicts. No resources are held while a delayed job merely waits. |
| `claim` | Select due, noncancelled ready jobs before their deadline. Lock/recheck the job and acquire **all** named resources or skip it. Increment fence and claim count, create attempt, set worker/lease and leased state, append event. Fences start at 1; no token is reused after expiry. Expired jobs are handled by recovery, not silently overwritten during claim. |
| `renew` | Require exact scope/job/worker/fence, leased or started state, unexpired ownership, no cancellation and live deadline. Extend expiry using store time and update resource ownership evidence atomically. An expired claim gets `STALE_CLAIM` even if recovery has not run. An identical transport retry may extend again within the configured bound; it does not create a new fence or authorization. |
| `start` | Under the same ownership/resource checks, compare the exact candidate hash; set started marker and event before returning. A repeat for an already-started **current unexpired** generation returns `already_started`, never a second permit. An expired/recovered/cancelled generation is stale. The store cannot validate an application's external policy service: runtime integration must supply that service's current persisted admission epoch in the same transaction, as §8 requires. |
| `recordReceipt` | Accept only an existing started attempt and exact receipt identities. Identical evidence ID/content is idempotent; changed content conflicts. Store evidence and event atomically. For the current live, noncancelled generation, update its monotonic execution-evidence projection. Current unknown evidence immediately marks the job unresolved and quarantines holds; it need not wait for lease expiry. For expired/cancelled/recovered generations, retain evidence as late; do not release output, turn a terminal job into success, free quarantine or authorize continuation. A different evidence ID contradicting known evidence is retained with `conflicting` disposition without overwriting that projection; if still started, quarantine it and reject completion. A later conflict cannot retract output already disclosed. `receipts` exposes this bounded evidence independently of the current job projection. |
| `complete` | Require current unexpired started claim, no cancellation/deadline violation, all held resource generations, and the specified persisted known evidence. Success requires `execution='succeeded'`; store the caller's already-admitted bounded output and released disclosure. Failure/block require null output and withheld disclosure; a successful effect with blocked output remains a successful receipt. Release resource holds, end attempt/job and append event atomically. The same successful command ID/digest returns the recorded completion after response loss, but confers no new execution authority; a different command using its now-terminal claim is stale. |
| `cancel` | Persist durable cancellation and its stable command result. Ready/leased work becomes cancelled-before-start and releases holds; invalidate ownership in the same transaction. Started work becomes `outcome_unknown`, withholds output and quarantines resource holds. A race with start/complete has one winner under the job lock. Already terminal completed output/evidence is not retroactively erased. Cancellation alone never proves an in-flight effect stopped. |
| `recover` | Select bounded expired/deadline/cancelled work. Ready jobs past their deadline become cancelled without a claim. Expired **leased, never-started** jobs end their attempt, release holds and become ready (or cancelled when deadline/cancellation applies). Expired **started** jobs become `outcome_unknown` and quarantine holds. No started job becomes ready, even if a success receipt exists but output admission did not complete. Append each transition atomically. Repeating recovery is a no-op for terminal records. |

`failed` completion requires a known failed execution, not a timeout of an effectful handler. A handler exception whose effects are uncertain records unknown and enters recovery/unknown disposition; no fake failed receipt is created. Expiration after a persisted successful receipt still preserves that receipt while blocking absent output admission.

Here a job's `outcome_unknown` means its authorized completion/output disposition is unresolved; its independent effect receipt may already establish successful execution. Never render that known successful effect as failed or unexecuted. Initial recovery remains conservative even for a pure handler: no automatic replay is introduced by this lifecycle slice.

Resource ownership is scoped and generation-bound. An expired pre-start lease may release its holds; the old fence then cannot start. A started/unknown holder quarantines conflicting work indefinitely in this slice. There is deliberately no automatic quarantine clearance or `forceReady` operation. A later authenticated reconciliation command must prove the operation ended and the resource is safe, retain evidence, and still never replay that logical invocation. Operators can inspect safely in the meantime. This conservative availability cost is explicit, not hidden behind “automatic recovery.”

## 6. Retry, cancellation and effect limits

An unacknowledged `claim` can leave capacity occupied until expiry; retrying claim does not redispatch anything because every handler still needs start. An unacknowledged `renew` is harmless to retry while the generation remains live. An unacknowledged `start` must not be treated as a fresh permit; an `already_started` response requires reconciliation/unknown handling. Stable complete/cancel command journals acknowledge a previous successful command without applying it twice. Failed preconditions are not journaled as success.

Workers use cooperative abort signals and renewal deadlines for responsiveness, but only transactional storage predicates decide authority. If renewal fails or becomes uncertain, the worker stops new execution/admission, attempts best-effort abort, and may submit late evidence only. Closing a worker is not proof that its external effect stopped; keep storage available for late receipts where possible.

There is an unavoidable start-commit → external-request interval. The store cannot retract a request already transmitted, and local fencing is not provider-side fencing. A worker that received start before a pause can resume after lease expiry; its marker ensures that no successor automatically executes that logical job, and its stale completion is rejected. Stronger prevention of external requests themselves requires a qualified provider-side fence/idempotency protocol. Do not claim universal exactly-once effects or physical revocation from this ledger.

## 7. Required first-slice evidence

Run the same tests on the actual SQLite worker and PostgreSQL fixture. A test-only storage-owned clock may be deterministically controlled; no production factory accepts a caller clock.

- Concurrent reservations deduplicate original intent after mutation; changed content and cross-scope lookups fail safely.
- Multiple workers contend for one ready job: one claim/fence and at most one fresh start permit; a duplicate start returns no permit.
- Advance the storage clock exactly to expiry: renewal, start and completion reject before recovery; after a new pre-start claim, every old operation stays stale.
- Pause a transaction before it acquires the job lock: authority checks use time sampled after the lock wait, not stale transaction-start time.
- Kill before/after claim, start, receipt and completion commits; missing/ambiguous acknowledgements never trigger an uncertain handler again.
- Expired never-started work is reclaimable. Expired started work is unknown, preserves receipts, retains resource quarantine and cannot be claimed again.
- Two jobs with overlapping resources never start concurrently; reversed resource input order and multiworker claim/recover/cancel contention do not deadlock or partially acquire holds.
- Race cancel with start, receipt and complete; preserve terminal precedence and late evidence, never disclose output from a lost claim.
- Resource-free jobs remain independently claimable when unrelated resources are quarantined. All caps, overflow, disk/connection failure and unsupported format paths fail before unauthorized mutation.
- Reopen the adapter and verify generation/resource/event continuity; inspection/event reads cause zero effects and zero lease renewal.
- Existing aggregate and workflow format-2 conformance continues passing unchanged. These tests do **not** imply integrated workflow fencing.

## 8. Runtime integration strategy, without a backend rewrite

The standalone ledger is not safe to attach to an ordinary format-2 worker merely by obtaining a claim around `runUntilSettled`. Existing `AggregateStore.update` could otherwise let that worker commit after losing the lease, or a legacy driver could bypass the scheduler entirely.

The following small integration contract must be specified and implemented **before** an opt-in scheduled workflow profile is exposed:

1. Add an additive schedule-ownership sidecar keyed by `(scope,aggregate_id)` and the chosen profile version. A transaction attaches only a quiescent run with no dispatching/unknown attempt. Preserve its original format-2 snapshot, ID, submission digest and event history. Never auto-enroll existing runs after a package update; reject attachment when it is unsafe.
2. For an attached run, backend ordinary `AggregateStore.update` must reject mutations with a safe “scheduled writer required” error. A legacy workflow driver fails closed, not unfenced. Reads and idempotent create retries still work. Remove no data during attachment; rollback requires an explicit quiescent migration, not deleting the sidecar.
3. Add internal **finite semantic transaction commands** to the shared backend, not user callbacks: prepare a node's job plus existing aggregate cost reservation; start plus format-2 dispatch marker and approval consumption; record receipt plus known budget settlement; complete plus admitted step output/dependency projection; cancel plus run intent and undispatched-job invalidation. Each checks exact aggregate version, job fence, current persisted policy/candidate/approval expiry and schema invariants under the same locks. No independent lease check followed by public aggregate update is allowed.
4. Reuse the existing workflow pure validators/projectors for these commands, extracted narrowly where needed. The adapter owns atomicity, storage clock and lock/fence predicates; runtime owns schema/guard execution outside transactions. Generic replacement state supplied by an untrusted actor is never a command. Approval expiry for scheduled runs moves to storage time; a precomputed caller-time verdict is not sufficient.
5. Route approval/wait/join control transitions through separately enumerated, scope/version-checked commands that cannot overwrite active attempts, receipts or budget reservations. Otherwise an apparently benign control write becomes a fence bypass. A waiting approval has no job claim or worker held merely for waiting.
6. Use the **existing aggregate event sequence** for integrated state/job transitions in those same transactions. The standalone scheduler event sequence is a different namespace and must never be merged by guessing numeric order. Integration qualifies one sequence source per run and explicit event schema/version.

Keep this an opt-in storage capability and driver profile. A custom adapter implementing only `AggregateStore` remains supported for the conservative driver; requesting scheduled execution from it returns unsupported capability, never a silent volatile/unfenced fallback. No existing format-2 row is destructively converted in the first ledger slice. If additional workflow-state fields later require format 3, provide a separately reviewed migration and fixtures instead of smuggling fields into format 2.

Current exports are additive: both existing adapter factories return `SchedulerAggregateStore`, which extends `AggregateStore` with `.scheduler`. Call the containing store's `initialize()`, then `store.scheduler.initialize()`. `store.close()` closes both capabilities. Both use the existing pool/SQLite owner; the SQLite owner serializes entire asynchronous scheduler requests so aggregate commands cannot interleave inside a scheduler transaction.

The shared suite covers scoped original-intent retries, independent-owner claims, resource exclusion, immutable snapshots, expiry/revocation, cancelled and contradictory evidence, output withholding, stale completion journaling, persisted corruption, store reopen and process termination after claim/start/receipt commits. A real database-lock delay verifies that authority time is sampled after the lock wait. These tests exercise the standalone ledger, not actual provider-side exclusion or every future integrated workflow crash boundary.

Next implementation boundary: review the finite integrated transaction commands. Full V03 remains open until both stale workflow-result commits and conflicting integrated tool resources are tested through public runtime operations.
