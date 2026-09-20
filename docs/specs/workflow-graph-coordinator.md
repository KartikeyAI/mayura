# Finite registered graph continuation coordinator

Status: reviewed next-slice design; not implemented or qualified. Builds on [graph discovery](workflow-graph-discovery.md) and [versioned graph waits](workflow-graph-waits.md). It is not durable child orchestration or a background worker fleet.

## Purpose and authority

An application currently repeats a recovery loop: discover one bounded page, resolve each exact definition digest through a trusted registry, and drive the matching run. Provide this as an optional finite coordinator without adding a polling loop, new persisted format or second execution authority. The application explicitly invokes every page and owns its overall time/page budget.

`createWorkflowGraphCoordinator` accepts the existing graph scope, policy and worker identity/lease/job/storage bounds plus 1–32 immutable catalog entries of `{ definition, resources? }`. Omitted resources mean the canonical empty plan. Omit the worker's global `resources`, `verifyHuman` and `maxConcurrentRuns` options: the coordinator performs no approvals and drives only one run at a time. Bound cumulative canonical manifest/resource metadata to 4 MiB, in addition to the existing per-definition limits.

Entries are selected by exact manifest digest, never a model-provided module name or dynamic import. Duplicate digests (including different genuine definitions sharing declared metadata), forged definitions, malformed plans and unexpected options fail before storage callbacks. Missing definitions are reported as skipped metadata and never dispatched. A digest admits exactly one resource plan; multiple plans require separately configured coordinators, not inference from stored state. The existing driver revalidates persisted grants, policy, manifest and resource ownership. The manifest digest does not attest handler/schema/guard implementation bytes; applications explicitly version changed executable definitions.

## Finite API and shared capacity

Expose `runPage({ cursor?, limit? })` and `close()` from the graph entry point. One page uses the discovery contract's 1–32 examined-owner limit and continuation semantics. Only one page call may be active per coordinator; reject overlapping calls instead of building an implicit unbounded queue. Within a page, visit returned candidates sequentially. Parallel tool branches inside a run retain the configured shared job limit. Waiting or otherwise settled candidates release their run-driver slot before the next candidate is considered.

All registered definitions share **one** scheduled driver and its actual active-handler/job/run/storage accounting. Do not create one worker per catalog entry: an uncertain handler from one definition must still occupy capacity while the next definition is considered. The private driver eagerly validates and seeds immutable per-definition enrollments keyed by genuine definition identity; unregistered identities have no fallback. Existing public runtime/resource-plan behavior remains unchanged. Discovery has its own bounded adapter acknowledgement capacity; neither facade may release a timed-out adapter slot before actual settlement. Document those separate storage callback bounds rather than advertising a new combined distributed quota or universal accounting of arbitrary asynchronous schema callbacks.

Return a frozen discriminated metadata-only report. A `completed` page contains `examined`, discovery `nextCursor` and ordered outcomes. An `interrupted` page contains `examined`, the original `retryCursor`, a sanitized stop code and ordered outcomes; it has no advancing `nextCursor`. Every discovered candidate has exactly one outcome: `observed` with exact reference/post-drive version/status, `skipped` with reference and `unregistered_definition`, `failed` with reference and safe code, or `not_attempted` with reference. Reports contain no input, output, receipt, job or raw error details. Completion means the page was processed, not that every run succeeded.

After successful discovery, stop on the first driver failure; preserve earlier observations, report the failed candidate and mark later candidates unattempted. Invalid commands, overlapping calls and discovery failure reject before any candidate dispatch. An interrupted page directs the caller to retry its original cursor or restart a sweep, never skip to the failed page's end cursor. Earlier durable commits remain; local page failure is never permission to replay external effects.

The cursor describes examined owners, not successful continuations. Unknown definitions and still-running/waiting candidates can advance it; registering missing definitions or continuing such runs requires a later explicit sweep from the beginning. Runs can become terminal between discovery and driving. Existing state checks, approvals, CAS, claims, receipt evidence and unknown-outcome handling remain authoritative. No provider retry, reconciliation, lease transfer shortcut or bypass of output validation is added.

These discovered runs remain independent roots. `maxCostMicros` matches each run's existing policy; it is not a shared monetary ceiling for the coordinator or page. Shared local job capacity must not be described as pooled financial authority. An application requiring cross-root accounting needs a separately designed transactional budget boundary.

## Shutdown and non-goals

Close synchronously stops new admissions, aborts local discovery/driver waits and prevents starting the next candidate. Before discovery returns, pending work rejects with `CANCELLED`. After discovery returns, close produces an `interrupted` report preserving prior observations and marking unstarted candidates unattempted. Close waits for logical driver shutdown, not indefinitely pending handlers. It does not cancel persisted runs or independent wait targets and does not close application-owned storage. Preserve existing late receipt handling and uncertain-handler capacity semantics. A process crash may lose the page report; a later explicit sweep rediscovers nonterminal runs, while the existing invocation ledger prevents automatic replay of started effects.

These interruption rules apply only while `runPage()` remains active. Completion is the synchronous publication of its frozen report; a later close never retroactively changes a completed result.

No submission, approval, cancellation or registry mutation is exposed through the coordinator. Applications use their explicit existing APIs for those actions. No stable-snapshot scan, fair fleet scheduling, high-throughput ready index, notification subscription, durable child link, inherited descendant account or cancellation tree is implied.

## Failure-first acceptance

- Genuine bounded catalog admission, duplicate/forged definitions, immutable resource snapshots, unknown definitions and exact policy/resource mismatch rejection before effects.
- One-page admission, read-only metadata reports, terminal-only cursor progress and explicit behavior for a failure after earlier candidates progressed.
- Distinct definitions with distinct resource plans share one job/callback capacity; timed-out handlers retain that capacity until actual settlement.
- Waiting parents do not obstruct a later independent ready candidate at a one-job limit. A cancelled stale hint never dispatches.
- Close during discovery or a drive never starts later candidates, cancels durable runs or closes caller-owned storage. Actual late rejections are observed.
- Paired real SQLite/PostgreSQL restart, competing coordinators, crash between candidates and receipt/approval/accounting preservation.
- Packed driver-free consumer declarations and behavior, selected-store integration, credential-free finite example and unchanged dependency/installation budgets.

Durable children require a separate versioned child-admission/ownership design, narrowed grants, transactional ancestor budget accounts, cancellation lineage, required-child joins and consistent lock order. Existing external wait references must not be relabeled as children. All enterprise release gates remain open.
