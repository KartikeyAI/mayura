# Durable execution contract

Status: implementation baseline for the first durable vertical slice, not a claim that every operation is implemented.  
Requirements: F02, F04–F06, F15, F18–F19; G06; V02–V04, V06–V07, V12, V17.  
Governing documents: [development plan](../create-mayura-agentic-framework-plan.md) and [technical proposal](../mayura-technical-proposal.md).

## 1. Boundaries

The durable runtime owns scheduling, typed state transitions and admission. A storage adapter owns atomic transactions and concurrency control. A registered tool handler runs outside those transactions and cannot access a privileged store connection. The adapter contract has identical observable behavior for SQLite and PostgreSQL.

The first slice supports finite acyclic graphs containing `tool`, `approval` and `join` nodes. It deliberately does not persist JavaScript closures, stacks, promises or arbitrary loops. A bounded in-process execution profile is separate: it must never advertise these restart guarantees or silently replace an unavailable durable store.

Current rows are authoritative; append-only events are the inspection/delivery history. Replaying history never invokes a handler. A run can be inspected without a working model, tool or provider connection.

## 2. Serializable graph and identities

A definition has `schemaVersion`, `definitionId`, `definitionVersion`, a content `digest`, an input schema, an output binding/schema, explicit limits and a list of nodes. IDs are unique within the graph. Handler and schema versions are pinned; resume refuses missing or incompatible versions.

| Node | Required persisted fields | Completion rule |
| --- | --- | --- |
| `tool` | Node ID; registered tool ID/version; input bindings; predecessor IDs; declared retry/reconciliation profile | An execution receipt exists and its output has passed the configured admission gate. |
| `approval` | Node ID; target tool-node ID; predecessor IDs; approved human-role policy; timeout | An authorized human grants the exact candidate and the grant remains valid at dispatch. |
| `join` | Node ID; ordered predecessor IDs | All predecessors succeed; output is an ordered array of their admitted outputs. |

Input bindings are a recursive JSON value tree with explicit tagged leaves: `literal`, `runInput` plus a JSON Pointer, or `stepOutput` plus node ID and JSON Pointer. No arbitrary JavaScript expression, prototype traversal or ambient environment lookup is allowed. Reject invalid pointers, unresolved references and values incompatible with the receiving schema before dispatch. Only admitted outputs can supply `stepOutput` values.

The validator rejects cycles, dangling/duplicate IDs, incompatible references, duplicate dependency edges, excessive graph size and approval cycles before persisting a runnable definition. An approval node targeting a tool depends on all nodes needed to resolve that tool's inputs; the tool depends on the approval node. This expansion is recorded in the graph, not added differently after restart. Automatic policy-required approvals use the same durable approval record even without an author-written approval node.

First-slice joins are `all-success` only. A failed, blocked, cancelled, skipped or unresolved predecessor cannot become a successful join. Its downstream nodes receive a typed skipped record with the predecessor identity; unrelated branches may finish unless fail-fast or cancellation prevents new dispatch. Loops, conditional recovery joins and compensation are later explicit graph versions.

Identifiers and deduplication keys:

- `scopeId` comes from verified runtime identity, never directly from a model/tool payload. Every lookup and uniqueness constraint includes scope where applicable.
- `runId` is opaque and immutable. `(scopeId, submissionKey)` is unique. Reusing a key with an identical submission digest returns the existing run; changed content returns `IDEMPOTENCY_CONFLICT` without new work.
- The submission digest covers the pinned definition digest, validated input, requested execution environment, effective owner, limits and policy-relevant configuration. Transport retry fields and server-assigned timestamps are excluded.
- `invocationId` identifies one logical tool node execution and is stable across retries. `attemptId` identifies one dispatch attempt. Reconciliation records refer to the original invocation/attempt.
- Canonical JSON is restricted to null, booleans, strings, finite numbers, arrays and plain JSON objects. Reject undefined, non-finite numbers, bigint, functions and cycles; normalize negative zero. Digest encoding is versioned, uses sorted object keys and UTF-8, and is tested with fixed vectors. A canonicalization-version change requires migration, not silent recomputation.
- Hashes are domain-separated SHA-256, for example `mayura:approval:v1` and `mayura:submission:v1`. An implementation must document its exact canonical encoding before persisting production records.

## 3. Durable records and state types

All mutable records carry `version`, `createdAt`, `updatedAt` and scope. Compare-and-set operations require an expected version or active lease token. Timestamps use UTC instants; leases and expiry checks use the storage authority's clock, not caller-supplied time. Deterministic clocks are injectable only in test adapters.

| Record | Essential fields |
| --- | --- |
| Run | ID, root/parent ID, definition digest/version, input reference/digest, submission key/digest, state, waiting reason, owner/environment/policy references, cancellation intent, deadline, limits, result reference. |
| Step | Run/node ID, pinned handler, resolved input reference/digest, state, invocation ID, admitted output reference, execution outcome, disclosure outcome, failure reason. |
| Attempt | Invocation/attempt ID, sequence, job ID, fence, worker, lease expiry, state, dispatch marker, provider operation ID, error classification. |
| Effect intent | Invocation/attempt ID, exact tool/schema/argument/target digests, capability snapshot, policy epoch, approval ID, reservation IDs and effect class. |
| Effect receipt | Invocation/attempt ID, evidence ID, known execution outcome, sanitized operation ID, response/artifact integrity reference, usage, recorded time and provenance. |
| Approval | Request ID, run/node/invocation ID, candidate digest and immutable safe review view, required human roles, state, expiry, decision principal/time, consumed attempt. |
| Budget account | Root account ID, unit/price version, limit, settled amount, reserved amount, optimistic version. |
| Reservation | ID, account/attempt ID, bounded maximum, state, known settled amount, uncertainty flag. |
| Job | ID, scoped run/node, due time, state, worker, lease expiry and monotonically increasing fence. |
| Event / outbox | Event ID, run sequence, event schema/type, correlation/causation, sanitized payload/reference; separate delivery state. |

The following discriminants are wire/storage contracts:

```ts
type RunState =
  | 'queued' | 'running' | 'waiting' | 'paused' | 'cancelling'
  | 'reconciling' | 'succeeded' | 'failed' | 'blocked' | 'cancelled';
type StepState =
  | 'pending' | 'ready' | 'waiting' | 'running' | 'reconciling'
  | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'skipped';
type AttemptState =
  | 'prepared' | 'claimed' | 'dispatching'
  | 'succeeded' | 'failed' | 'cancelled_before_dispatch' | 'outcome_unknown';
type DisclosureState = 'pending' | 'released' | 'withheld' | 'invalid';
type ApprovalState = 'pending' | 'approved' | 'denied' | 'expired' | 'revoked';
type ReservationState = 'reserved' | 'settled' | 'uncertain' | 'released';
```

Terminal run states are `succeeded`, `failed`, `blocked` and `cancelled`. A pending human decision is `waiting`, not terminal `blocked`. `paused` is reversible operator intent; resuming it does not resolve another gate. `reconciling` is non-terminal and suspends dependent dispatch. If reconciliation must terminate, retain `outcome_unknown` evidence and fail with recovery instructions. Unknown results cannot be represented as success or silently discarded by cancellation.

Execution outcome and disclosure outcome are independent. A successful write followed by invalid/withheld output remains a successful effect, while its step is blocked from supplying downstream output. Never classify that write as a retryable handler failure. A run's result preserves all known completed effects and unresolved outcomes even when the overall run fails.

## 4. Transaction operations

The public runtime service authorizes every command before calling the store. The store additionally enforces scope, uniqueness, expected versions, lease checks and state-machine invariants. No public API exposes unrestricted `updateRun`, SQL or user-defined transaction callbacks.

Each operation below is atomic in one adapter transaction. Transactions do not call tools, models, callbacks, credential services, artifact backends or external queues.

| Store operation | Atomic behavior |
| --- | --- |
| `submitRun(command)` | Verify submission-key uniqueness; create run/steps, root budget account, initial jobs and events/outbox; or return identical existing submission. |
| `readRun(scope, runId)` | Return a consistent snapshot containing state, redacted step outcomes, waiting requests and budget summary. |
| `claimJobs(scope, worker, limit, leaseDuration)` | Claim eligible due jobs with increasing fence and storage-generated expiry. Return immutable claim tokens. |
| `renewClaim(claim, leaseDuration)` | Extend only a still-current, unexpired claim; return `STALE_CLAIM` otherwise. |
| `requestApproval(command)` | Persist the immutable candidate, suspend its step, release scheduler capacity, append request event; deduplicate the same candidate. |
| `resolveApproval(command)` | Check authorized human identity/roles, expected pending version, digest, expiry and cancellation; persist one decision plus wakeup event/job. Identical repeat is acknowledged; conflicting repeat fails. |
| `prepareAttempt(command)` | Check current candidate/policy references and valid grant; reserve all bounded costs atomically; create intent/attempt/dispatch job and event. A reservation failure commits no partial intent. |
| `beginDispatch(claim, admission)` | Recheck active fence, current policy epoch, candidate/grant digest, cancellation/deadline, budget and resource ownership; consume the exact grant use; record `dispatching` before returning permission to call the handler. |
| `recordReceipt(command)` | Insert deduplicated evidence and settle known usage; mark execution outcome only if claim is current. Late stale-attempt evidence is retained for reconciliation but cannot advance the current step. |
| `releaseOutput(command)` | Verify receipt identity, exact content/verdict/policy versions; persist released/withheld/invalid status, advance eligible dependencies, update run projection and append events/outbox. |
| `recordAttemptFailure(command)` | Persist sanitized known failure or unknown outcome; keep/reconcile uncertain reservations; schedule a retry only when the declared safety contract proves it admissible. |
| `reconcileAttempt(command)` | Attach authoritative reconciliation evidence; resolve unknown state/usage and schedule only safe continuation; do not invent a successful receipt. |
| `cancelRun(command)` | Persist cancellation, stop new dispatch, cancel undispatched work/grants, wake active workers, preserve in-flight/unknown effects; finish only when outcome accounting is truthful. |
| `recoverExpiredClaims(scope, limit)` | Requeue work that never crossed dispatch; move expired dispatched attempts to reconciliation; never blindly redispatch an uncertain write. |
| `readEvents(scope, runId, afterSequence, limit)` | Return authorized ordered durable events and cursor metadata; retained-history gaps produce an explicit snapshot/gap response. |
| `claimOutbox` / `ackOutbox` | Lease redacted event deliveries and acknowledge with expected fence; duplicate delivery is permitted, duplicate effects are not. |

These are semantic operations; a first implementation may group them behind a transaction-command union. It may not weaken their boundaries. Read methods use bounded pagination. All commands have a stable request ID for idempotent network retries where a response may be lost.

## 5. Approval and dispatch protocol

The immutable approval candidate covers scope, run/invocation, pinned tool and schema versions, processed arguments, resolved resource targets, code/artifact digests when relevant, execution environment, credential identity (never secret value), effective policy epoch, expiry and allowed invocation count. First-slice grants allow one exact logical invocation. Permission to retry a proven-safe idempotent attempt does not grant a different logical operation.

Only the authenticated human control plane resolves approvals. A `principalKind: human` string supplied by a handler is not authentication. Tests use an explicit trusted fixture identity adapter. Approval does not override a current hard denial. Any relevant mutation creates a new candidate and requires new review.

The complete dispatch sequence is:

1. Resolve and validate inputs; run declared transforms, required checks and capability/resource policy. Persist the finalized candidate digest.
2. Persist required approval and return the worker slot while waiting. No database lock, handler process or model call remains alive solely for approval.
3. After decision, revalidate current policy, scope, candidate and cancellation. Atomically prepare intent and bounded reservations.
4. Claim dispatch; the broker loads current authority and invokes `beginDispatch`. The returned dispatch permit is bound to the attempt/fence and cannot authorize another tool.
5. Invoke the handler outside the transaction with immutable arguments, an abort signal and scoped broker context. Supply the stable invocation key to a provider only if its adapter declares a compatible idempotency contract.
6. Persist sanitized receipt/usage first. Validate and guard output separately; then admit permitted output and advance dependencies.

There is an unavoidable interval between committing `dispatching` and the remote system receiving a request. A crash anywhere after that marker creates an uncertain outcome unless external evidence proves otherwise. Fencing prevents obsolete workers from changing current state and stale broker admission; it cannot retract an already transmitted external request. Environments demanding stronger execution exclusion require a qualified effect adapter with provider-side fencing/idempotency or equivalent reconciliation.

## 6. Budgets, concurrency and time

Limits include graph nodes, active workers, attempts, wall-clock deadline, input/output bytes, events retained per policy and metered usage. Initial authored graphs are finite. Reject missing maxima for operations that require a bounded cost guarantee; do not invent zero-cost fallback for unknown pricing.

Accounting uses non-negative safe integers in an explicitly named unit such as `microUSD`, not floating currency. Validate overflow before arithmetic. Currency and price-table versions are pinned to reservations. A shared root account covers parallel steps, descendants and required checking/retry overhead; later child accounts cannot double-count additional spendable credit.

Admission requires `settled + reserved + proposedMaximum <= limit` for every applicable account/dimension in the same transaction. Acquire account/resource locks in a stable order. Settlement replaces reserved maximum with known usage atomically. A provider cost exceeding its declared cap is an observable overrun: record actual usage, stop new dispatch and surface the violation; never truncate the ledger to make the limit appear respected.

Release unused reservation only with evidence that no additional charge can occur. Timeouts, crashes and user cancellation do not prove this. Unknown usage retains its conservative bound as `uncertain`. Reconciliation can release it only with supporting evidence.

Lease expiry uses store time. Every claim has a monotonically increasing fence; renewing a lost claim cannot resurrect it. Cancellation/deadline changes win against new `beginDispatch` operations through transactional state checks. The same race cannot both authorize new dispatch and report that it was cancelled before dispatch.

## 7. Events and storage profiles

Each run has a transactionally incremented event sequence. Unique constraints cover `(scopeId, runId, sequence)` and event ID. State and corresponding event/outbox entry commit together. Outbox delivery is at least once; consumers deduplicate event IDs. Across runs there are causal links, not a claimed global order. Public events never include raw credentials, rejected tool payloads or protected prompts.

SQLite uses one storage-owning process, bounded IPC, WAL, foreign keys and `synchronous=FULL`. Short `BEGIN IMMEDIATE` write transactions serialize state/budget admission; bounded busy retries are explicit. WAL storage is same-host, not a shared network filesystem. Verify the bundled SQLite engine and backup/restore behavior. Execution handlers do not share the privileged driver connection. A provisional direct-process test adapter must be labeled as such until the storage-owner profile is qualified.

PostgreSQL uses pooled connections, short transactions, conditional versions and `FOR UPDATE SKIP LOCKED` job claims. Business rows/account rows are locked in consistent order; uniqueness constraints enforce deduplication. A transaction at `READ COMMITTED` is sufficient only when every relevant invariant is protected by these locks/conditional writes. Serialization/deadlock retry applies to safe transaction bodies, never to external handlers. Database time determines lease expiry. No Redis or external queue is required for correctness.

Artifacts are outside SQL atomicity. Stage content-addressed data, verify integrity, then commit its reference. Missing referenced data blocks dependent disclosure/execution with a recoverable integrity error. Orphan cleanup is scoped and retention-aware. Receipts persist a safe minimal operation summary even when large raw output is unavailable or barred from retention.

## 8. Required crash and conformance evidence

| Injection point / race | Required recovery |
| --- | --- |
| Before submission commit | No run or jobs exist; resubmission creates one. |
| After submission commit, response lost | Identical key returns the existing run; changed input conflicts. |
| After approval request, process killed | Pending request survives; no worker or transaction is retained. |
| Duplicate/concurrent approve or approve versus cancel/expiry | One versioned decision; stale grant never starts new work. |
| After reservation/intent but before dispatch | Recover/reclaim work after lease expiry; no duplicate reservation. |
| After dispatch marker, before/after external request | Unknown until reconciliation or documented idempotency proves safe retry. |
| External effect succeeds, receipt write fails | Stop dependent work; reconcile the effect, never infer failure. |
| Receipt exists, output guard blocks or process dies | Preserve successful effect; retry output admission only, never the write. |
| Old worker reports after lease transfer | Retain late evidence; reject current-state advancement by stale fence. |
| Two workers reserve the final budget units | Only one admitted reservation when combined maxima exceed the limit. |
| Outbox publish succeeds, acknowledgement lost | Duplicate event delivery is safe through event-ID deduplication. |
| Cancel with an in-flight effect | Stop new dispatch; retain completed or unknown outcome and reservation evidence. |
| Store outage/disk-full | Fail closed before unrecorded dispatch; never switch to in-memory execution. |

Both adapters must pass the same suite using public runtime operations and a controlled effect fixture. Add process-termination tests, randomized transition/duplicate-delivery tests, scoped-access tests and a real PostgreSQL container suite. Explicitly test that history inspection performs zero effects. Passing ordinary happy-path tests is not evidence of enterprise readiness; the full governing-plan release gates still apply.
