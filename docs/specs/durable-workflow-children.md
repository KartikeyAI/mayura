# Durable required workflow children

Status: **implementation in progress; not qualified**. The format-4 authoring/manifest contract, fixed scheduler-owned budget profile, atomic root enrollment, root-local execution, one-level child/account admission, exact restartable approval request/resolution, tool preparation/claim/renew/first-start, truthful known/unknown receipt accounting, scheduler completion, successful child/root finalization, required-child join, root/child cancellation and expiry recovery are implemented locally with paired SQL tests. Both selected SQL adapters expose an opt-in `workflowTrees` capability with bounded immutable command and independent response validation. `createWorkflowTreeRuntime` drives finite root-local and required-child graphs across close/reopen, narrowed child authority, verified human approval, fenced dispatch, renewal, output validation, exact joins, recovery and terminal cleanup on SQLite and PostgreSQL. A bounded worker-wide pool executes independent ready root and child branches concurrently and retains a timed-out handler's slot until its actual callback settles. Competing runtime instances fence one root dispatch on both selected databases. Real process-termination fixtures preserve a pending root approval across restart and quarantine a killed in-flight root effect without redispatch. Approved prepared work at either level that expires before first dispatch is atomically cancelled with its shared-ledger reservation on recovery. An isolated nine-package offline SQLite consumer compiles and executes an approval-enabled root-to-child path after close/reopen using packed artifacts only. All 27 capability method families pass valid-response replay and reject unexpected transport fields or mismatched root identities; member/account ownership and root/child cancellation/recovery job membership are independently checked. A managed distributed fleet remains incomplete, so this document does not close a release gate.

## Smallest complete scope

Add an explicitly new format-4 / `scheduled-v3` profile for finite **one-level required workflow children**. A root definition has tool, join and child nodes. Each child definition is a finite tool/join leaf; a child cannot create another child in this first profile. All declared nodes are required. No loops, dynamic agent/model selection, arbitrary spawn callback, detached child, legacy-run adoption, external-target adoption, cross-root joins, compensation or automatic replay are included.

A child is a newly created owned execution with its own narrowed policy, input, output validation, approvals, immutable budget account and ordinary scheduler jobs. It is not an existing independent graph target relabeled as a child. Parent success requires every child to have succeeded with releasable validated output. Child failure, blocking, cancellation or uncertainty cannot satisfy a successful join.

Reuse the existing scheduled worker's actual job/handler/storage capacities, scheduler fences and receipt state machine. Reuse the durable financial reducer and transaction plumbing. Do not create a second per-child runtime, copy the scheduler, or build a parallel budget engine. Existing formats 2/3, `scheduled-v1`/`scheduled-v2`, external waits and the graph coordinator retain their exact contracts.

## Proposed developer-facing shape

Expose the new API through an optional `@mayura/workflows/children` entry point, not through the base SDK. Proposed names:

- `defineWorkflowTree({ id, version, input, output, nodes, result })` creates a genuine immutable definition. Tool/join nodes retain familiar bindings. A child node contains `{ kind: 'child', id, dependsOn?, workflow, input, policy, resources? }` and pins one genuine leaf definition; model-supplied module names or dynamic imports are never resolved.
- Child `policy` is explicit `{ permissions, maxCostMicros, maxCalls, maxOutputBytes, approvalTtlMs }`. No omission silently imports broader ambient grants. Scope and policy version are inherited immutable values, not child arguments.
- `createWorkflowTreeRuntime({ store, scope, permissions, policyVersion, maxCostMicros, maxCalls, definitions, workerId, ...workerBounds })` owns one immutable root/leaf catalog and one shared driver. Proposed finite operations are `submit`, `inspect`, `events`, `runUntilSettled`, `approve`, `cancel`, `recoverExpired` and `close`. There is no `attach`, public arbitrary `spawn`, replacement-state API or implicit polling service.
- `runUntilSettled(rootDefinition, rootId)` performs bounded continuation over that owned tree, including ready children, and returns when terminal or unable to make immediate progress. Waiting parents occupy no execution slot needed by their children. This is not a promise to wait indefinitely for approvals or unknown effects.
- An approval command identifies the root and exact node. Omitting `childId` selects an exact root-local node; supplying `childId` selects only that admitted member. Credentials remain runtime-local; only the verified human identity and exact review digest persist.
- Public snapshots distinguish local run state from inclusive account accounting and expose immutable owned-child references. Metadata inspection does not automatically disclose child input, handler output, credentials or raw receipts.

Proposed optional storage capability: `WorkflowTreeAggregateStore.workflowTrees`. Its strict methods retain the scheduled finite controls, replacing submission with format-4 enrollment and adding `admitChild` and `joinChild`. Method inputs are snapshotted before any asynchronous initialization or transport. Replies are independently validated against the requested profile, root, member, account, policy and definition identities. A custom adapter is never silently treated as child-capable because it exposes legacy scheduled methods.

Pinned foundation choices: the optional entry point is `@mayura/workflows/children`; the genuine factory is `defineWorkflowTree`; persisted manifests are format 4 in the `mayura:workflow-tree:v1` hash domain; child leaves are genuine legacy tool/join workflows; and scheduler accounting uses fixed owner `workflow-tree-v1` in `mayura_workflow_tree_budgets` / `mayura_workflow_tree_budget_events`. The public `host-v1` codec, tables and constructor remain unchanged.

The storage write key must include the member policy pin and immutable tree identity, conceptually `{ scope, rootId, rootPolicyHash, id, policyHash, expectedVersion, commandId }`. Caller-provided root/account references are assertions to verify against stored ownership, not authority to move an existing member into a different tree. The exact exported type names and whether the redundant root pins are public or internally derived remain an API decision below.

## Authority invariants

1. Root and child share the exact principal/project scope. A child cannot change scope, policy version, root identity, parent identity, definition, resource plan or account after admission.
2. Every explicitly requested child permission must belong to the parent's canonical permission set. Reject widening; do not silently discard requested grants and pretend the requested configuration was admitted. Effective child permissions are an immutable subset and are the permissions supplied to its broker, not the driver's root permissions.
3. Child cost and call ceilings are no greater than the root's ceilings. Child output limit and approval TTL are no greater than the root's corresponding limits. These are shared ceilings, not prepaid allocations; a child fork does not reserve money or promise future capacity.
4. Tool grants, capabilities, effect grants and approval-required flags continue to be checked at each child prepare/start. Admission of a child is not approval of its effects. The child cannot strip its own pinned tool approval requirements. No imported credential or prior parent/tool approval authorizes a different child candidate.
5. Approval candidates bind the child run, node, validated input, narrowed policy, exact owner/account binding and storage-time expiry. Storage rechecks expiry and root/member cancellation after lock waits. Root cancellation invalidates descendant admission even if a child's previously granted approval has not expired.
6. Every broker invocation uses the member's policy/output bound and its exact registered executable definition. One genuine definition can execute under distinct admitted policies; a definition-only cache is not sufficient authority. Cache only fully owned immutable compilation material, keyed with the applicable policy/resource identity where relevant.
7. Persisted hashes attest declared metadata, not executable handler/schema/guard bytes. Trusted hosts still own catalog deployment, authentication, credentials and callback correctness. The capability does not protect against privileged direct SQL or unsupported old binaries.

The current scheduled policy has no run-wide deadline. This slice must not claim inherited descendant deadlines or reinterpret a job lease as a tree deadline. Adding such deadlines is a separately specified extension.

## Ownership and atomic admission

Root submission commits the root aggregate, profile-3 owner, immutable root membership, scheduler-owned root budget and creation events in one transaction. It must never return an owned runnable root without its ledger, or create a ledger first in an independently committed host operation.

For a dependency-ready child node, runtime schema validation occurs outside SQL transactions. `admitChild` then performs one finite transaction:

1. Resolve and lock the tree root before locking the parent; revalidate all immutable bindings after the lock.
2. Recheck root/parent nonterminal status, budget admission, parent version, dependency success, the declared child plan and exact validated input candidate.
3. Derive the child run, account and submission identities from the root/parent/node in dedicated hash domains. Enforce unique `(scope, parentRunId, nodeId)`, unique child membership and one account-to-member mapping.
4. Fork the child financial account and create the child's format-4 aggregate, narrowed owner and immutable membership together. Mark the parent node as waiting for that exact required child and append its admission event in the same commit.

An exact retry acknowledges the original child and current state. Different input, definition, policy, resource plan, parent, account or root conflicts without partial creation. Rejected admission burns no child identity or budget capacity. No legacy aggregate, independent root, host ledger account or caller-selected preexisting run can be adopted. No placeholder child may become executable before all ownership and accounting rows are committed.

The root manifest/catalog pins child leaf metadata, resource plans and policy-narrowing configuration. Storage must validate these pins independently of runtime lookup. Child input transformation is trusted runtime work, as with existing tool schemas; the transaction must bind the transformed candidate to the current source binding/version rather than rerunning arbitrary schema code under locks. Its exact digest material needs a dedicated contract test before implementation.

## Separate scheduler-owned budget boundary

The current financial capability deliberately fixes persisted `owner: 'host-v1'`, including a SQL check constraint and strict public codec. **Do not widen that public owner union or allow its mutation methods to control execution-owned accounts.** Host and scheduler ownership must remain distinguishable even when scope/ID text is identical.

Proposed boundary: a separate internal scheduler-budget table namespace, with a fixed new owner such as `workflow-tree-v1`, managed only by the format-4 integrated writer. Factor the common accounting validator/reducer and root transaction implementation behind internal profile parameters; retain the exact exported host-v1 codec/facade and existing table semantics. No public constructor accepts an arbitrary table name, owner tag, reducer or transaction callback. The new table/owner names must be pinned before schema implementation.

This avoids a silent migration of existing host tables and preserves the standalone API's contract. A host capability cannot inspect or mutate the scheduler ledger by guessing the tree ID. Internal reuse of accounting logic does not mean importing a host-v1 snapshot as execution authority. Initialization, rollback and reopen must validate the exact selected profile; initialization caching cannot outlive a rolled-back schema transaction.

## Universal transaction/lock order

Every integrated path follows this partial order:

`root identity mutex + scheduler-ledger root row -> affected member aggregates in canonical ID order -> affected jobs in canonical ID order -> resources in canonical key order -> event/projection writes`

The root is an immutable identity and budget boundary, not a lock acquired after loading a child. An unlocked membership read is only a root-resolution hint; re-read and verify it after acquiring the root lock. Root/child creation uses identity locks in the same order even before rows exist. SQLite retains its single-writer `BEGIN IMMEDIATE` behavior; this does not claim row-level concurrency there.

This applies to submit/admit/join, inspect of combined run/account state, approval request/verification commit, prepare, claim, **heartbeat/renew**, start, receipt persistence, completion, pre-start abandonment, failure, advance/finalize, explicit cancellation, expiry recovery and any future persistent close operation. Late receipts still enter root-first after cancellation or shutdown. A caller must never combine `scheduled.load()` followed by `durableBudget.inSession()` because the existing loader already acquires aggregate/job/resource locks.

Cross-member controls first collect the finite affected members under the root lock, then acquire all their aggregates before any jobs, and all jobs before resources. Do not loop through the existing fully locking per-run loader and accidentally interleave aggregate/job/resource levels. Reuse its validation/projection logic after splitting the lock acquisition seam.

The current generic aggregate writer and standalone scheduler must continue to reject any enrolled owner, including profile 3. Legacy v1/v2 APIs reject profile 3 before a root-lock lookup; a legacy aggregate-first path must never become aggregate-then-root. Discovery/coordinator and external wait readers retain their exact old-profile filters. Read-only generic inspection is not a dispatch capability. Drain unsupported older adapter binaries during deployment; no mixed-binary upgrade safety is claimed.

All SQL transactions remain short and database-only. Schema validation, human verification, guards, handlers and network/provider calls run outside locks. Independent roots share neither monetary state nor tree mutex; shared explicit resources still obey the scheduler's existing exclusion/quarantine rules.

## Accounting and truthful late evidence

The ledger is the monetary/call authority. Bind each prepared tool job to exactly one immutable reservation under that member's account. Child admission is control work, not a charged tool/model invocation. Do not charge a second wrapper call merely for joining a child.

| Transition | Same-transaction financial action |
| --- | --- |
| Prepare | Reserve one fixed-cost tool ticket and call slot; persist candidate, job, link and held ticket atomically. |
| Claim/renew | No second monetary reservation or call. Fences/resources remain scheduler authority. |
| First start | Start the exact held ticket and job together; one consumed call. Only a fresh acknowledged start permits local dispatch. |
| Unknown receipt/recovery | Preserve the full hold and consumed call; record unknown status without replay. |
| Known succeeded/failed execution | Settle the pinned fixed tool cost once and retain the execution receipt. Handler output cannot supply or change cost. |
| Proven not-started after persistent start | Settle zero only from the scheduler's validated attempt-qualified evidence; the already consumed call remains consumed. Never infer this from a timeout or missing acknowledgement. |
| Never-started cancellation/abandonment | Cancel the held ticket with its owned job; release the future call slot and money. |
| Late known evidence | Settle once even after root/member terminal status; never resurrect output, continuation, released resources or dispatch authority. |

Known fixed costs in this first tool-only profile normally equal the admitted bound. The shared reducer's overrun behavior must nevertheless remain truthful: commit full usage and sticky root blocking, never throw before that evidence commits. Root blocking prevents new child admission/preparation/start throughout the tree; late settlement and held cleanup remain available. No actual provider-cost protocol or post-start refund shortcut is introduced here.

Format-2/3 own-job counters cannot be relabeled as inclusive tree accounting. Format 4 must explicitly distinguish (a) local tool projections derived from this run's jobs/receipts, and (b) inclusive ledger account totals derived from owned subtree reservations. A parent's inclusive amount is not added to its child amounts. Combined snapshots carry the ledger version used with the member snapshot, and both projections are checked in the same root-locked transaction. Parent/child control events and ledger events have separate sequences; never splice their sequence numbers together.

Zero-cost tools still consume calls, including known not-started outcomes after committed start. Exact semantic retries consume no additional identity, event, call or hold. Unknown historical tickets retain full reserved money indefinitely. No close, lease expiry, process restart or repeated drain proves zero usage.

## Required-child join and cancellation

`joinChild` accepts no caller-asserted success or arbitrary output. It reads the exact owned child's immutable completion identity and bounded persisted released output under the tree lock, checking root/parent/node/account/definition/policy bindings. Existing completion facts are metadata-only and therefore insufficient by themselves to disclose a child's output. A successful child join copies only already validated released output into the parent node with a pinned source identity/version. Parent bindings consume that released value; they never consume a child receipt or withheld raw output.

The required node remains waiting until a qualifying child completion exists. Success is only `succeeded`; terminal failed/blocked/cancelled/unknown becomes a corresponding nonsuccess parent disposition. A child's uncertain completion remains terminal uncertainty even if late evidence later establishes a known effect. Late cost is not a new successful workflow result.

Parent finalization atomically rechecks every required child binding/join, all local steps and ledger admission state. Root success requires no unresolved reservation anywhere in the tree. Child success requires its own account to have no unresolved reservation; an unrelated sibling hold must not prevent the child from finishing.

Explicit root cancellation and any root terminal nonsuccess close the root account and revoke all owned children in the same bounded control transaction. A child's own cancellation closes only its account, leaves siblings unchanged initially, and prevents parent success; parent failure propagation subsequently closes the remaining required tree. The exact failure outcome precedence is an API/state decision below, not an invitation to report success early.

Never-started descendant jobs/tickets are cancelled and released. Started descendants become uncertain/quarantined unless known evidence already exists; they retain funds, consumed calls and late-evidence admission. Root/member terminal output stays withheld. Known already completed effects remain known effects, not rolled-back actions. A cancelled parent cannot admit another child under a fresh command ID.

Worker `close()` is local shutdown, not persistent tree cancellation: stop new local admissions, abort cooperative waits/handlers, preserve actual pending-capacity accounting and permit independent late evidence writes while caller-owned storage is open. Any persistent close semantics require a separate named command and the same root-first transaction rules.

## Whole-tree bounds and remaining decisions

Proposed initial limits: one root; at most 16 direct children; depth exactly at most one; at most 128 declared executable tool nodes **across the complete root and child plan**; at most 256 total declared nodes including joins/child nodes; the existing 128-node per-definition bound; at most one ticket/bundle per tool node; existing 32 resources per job and 64-KiB member output ceiling. The complete admitted catalog/manifest/resource/narrowing metadata needs one explicitly checked cumulative byte bound before any callback or mutation, proposed 1 MiB. Existing per-aggregate state/output headroom checks still apply independently.

The cumulative tool cap is essential: the financial ledger retains 128 lifetime bundle identities. Per-run 128-node checks alone would admit more promised work than that ledger can retain. With at most 17 accounts and 128 tool bundles/tickets, all financial start/unknown/settle/close suffixes fit the existing financial limits without raising them. A separate proof is required for scheduler journals, member event history, joined output growth and root-wide cancellation/late-receipt metadata. Rejected output must preserve effect/accounting truth.

Before implementation, resolve and pin:

- The factory/type/subpath names and whether leaf definitions use a dedicated genuine format-4 factory or an explicit compiler of genuine tool/join definitions. Reusing executable recipes must not adopt legacy persisted runs or rewrite their digests.
- The exact format-4 manifest, child candidate/submission hash domains, root/member access types, narrowed policy hash domain including `maxCalls`, and strict response codec. Do not extend legacy policy hash material.
- The internal scheduler-owned ledger table names/owner tag and reusable validator/reducer profile seam; public host-v1 acceptance stays exact.
- The authority/catalog key for the shared driver, since its current single captured `policy`, `permissions` and `policyHash` cannot safely execute narrowed children.
- The cumulative metadata byte limit and root/leaf node limits after worst-case retained-evidence tests, without silently increasing established ledger capacity.
- Parent failure precedence when different children become failed/blocked/cancelled/unknown concurrently, and the exact finite `runUntilSettled` report when a child awaits approval or an unresolved effect. Terminal facts must remain monotonic.

These are narrow API/schema choices, not license, external provider, deployment or user-product decisions. No development-complete or enterprise-qualified claim follows from this planned slice.

## Implementation seams to reuse

- `packages/storage-contracts/src/`: add separate format-4 manifest/state/policy and child capability codecs; reuse strict JSON, receipt and financial invariant helpers. Preserve existing format-2/3 decoders unchanged.
- `packages/storage-sql/src/scheduled-database.ts`: split profile decoding and lock acquisition from the existing scheduled transition engine; add profile-3 ownership/admission/join and financial integration. Keep one scheduler state machine.
- `packages/storage-sql/src/aggregate-session.ts`: extend immutable ownership/root resolution plumbing without weakening generic-writer rejection.
- `packages/storage-sql/src/durable-budget-state.ts` and `durable-budget-database.ts`: factor common accounting/internal profile plumbing; preserve the standalone host facade and schema. Transactions must share the existing session, not nest or separately commit.
- `packages/storage-sql/src/scheduler-database.ts`: retain `inSession`, fences, attempt evidence and resource quarantine; verify every integrated entry is reached only after the new lock boundary.
- `packages/storage-sql/src/execution-completions.ts`: reuse immutable facts for exact required joins; do not upgrade an unknown terminal fact after late receipts.
- `packages/workflows/src/scheduled.ts` and `scheduled-helpers.ts`: refactor captured single-policy assumptions into privately owned per-member authority while preserving one actual capacity pool. Add child preparation/join work without creating per-child drivers.
- Selected SQLite/PostgreSQL adapter and worker facades: expose the new optional capability with exact IPC method/profile validation. Old optional capabilities and compatibility exports stay source-compatible.

New public conformance, paired database, process-kill, packed-consumer and example fixtures accompany the implementation. A static prototype that only forks accounts or inserts child rows is not a complete slice.

## Failure-first acceptance

- Missing capability and wrong profile fail before any schema/handler/human side effect; forged definitions, excess cumulative metadata, recursive/non-leaf children and widened permissions/limits fail before admission.
- Root submit and child admission races/retries, changed candidate content, wrong root/parent/account/policy, legacy adoption and standalone-host ledger mutation attempts. Prove one child/account/link, with no orphan ledger/run/job/event after rollback or process termination.
- Paired real SQLite/PostgreSQL shared sibling cost/call contention, zero-cost tools, account projections and exact hold/settlement. Prove no double charge or retry call and no money released from timeout or unknown outcomes.
- Approval expiry after real lock waits; narrowed grants in every broker invocation; parent cancellation racing child approval/prepare/claim/start/heartbeat; root-first lock order and PostgreSQL unrelated-root progress under contention.
- Every legacy aggregate/scheduler/v1/v2 writer path rejects a profile-3 member before dispatch, including attempted standalone insert/claim/renew/start/receipt/cancel/recover; rejection is rechecked after lock waits.
- Required-success join, exact persisted released output, withheld/malformed child output, transformed input/output once per boundary, wrong completion identity, cross-tree/policy substitution, parent finalize racing child completion/cancel, and sibling outcome precedence.
- Root/child cancellation with held, leased, started, known and unknown work; sticky closure, quarantined resources, truthful late settlement, no new child after terminal parent and no parent success/output resurrection.
- Shared one-job local capacity: waiting parent makes child progress; uncertain child handler still occupies the real slot; distinct narrowed policies/catalog definitions do not accidentally receive separate capacity. Close stops admission without cancelling persisted trees or hiding actual pending callbacks.
- Real process termination after atomic child admission, child prepare/start/receipt/completion, parent join and root cancellation. Reopen through another worker; never replay an uncertain start or adopt a partially owned child.
- Corrupt membership/account/owner projections and missing/changed child/event facts fail closed. Near-limit complete trees can still cancel and record all late evidence within unchanged retention bounds.
- Driver-free positive/negative public types and hostile custom-adapter replies; isolated packed selected-adapter reopen; a credential-free root/child example with approval or cancellation/restart; full unchanged legacy suite and dependency/size budgets.

This is partial planned M2/V03/V05/V12/V18 evidence only. Dynamic durable agents, nested descendant orchestration, durable agent/workflow-as-tool composition, distributed worker services and the remaining enterprise gates stay open.
