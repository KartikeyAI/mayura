# Finite graph continuation discovery

Status: implemented and locally qualified on 2026-09-21, Windows x64 / Node 24.14.1. Depends on [versioned graph waits](workflow-graph-waits.md). This is bounded discovery, not a ready queue, worker fleet or durable child ownership. Exact passing evidence, failed-run observations and remaining enterprise gates are in the [development ledger](../development-status.md).

## Purpose and public boundary

An application must be able to find persisted graph runs after losing its process-local run list. Discovery returns currently nonterminal format-3 graph candidates, including runs whose waits resolved before a crash interrupted downstream preparation or finalization. A candidate is neither a readiness promise nor permission to execute. Applications select the registered definition and explicitly call `runUntilSettled`; existing policy, approval, lease, cost and output checks remain authoritative.

Add a separately optional `workflowGraphDiscovery` storage capability. Do not widen existing custom aggregate, scheduled-v1 or graph-store interfaces. Selected SQL factories may advertise a new extended aggregate interface. Expose a separate `createWorkflowGraphDiscovery` facade from `mayura/workflows/graphs`, using the same verified scope and policy configuration/defaults as the graph runtime, but requiring no worker, tool registry or human verifier.

`scan({ cursor?, limit? })` defaults to 16 and accepts 1–32 **examined owner rows** per call. Return a frozen bounded page with `candidates`, `examined` and `nextCursor`. Each candidate contains only its exact execution reference, observed aggregate version and nonterminal status (`running` or `waiting`). Never include input, output, job details, receipts or provider errors. Closing the facade rejects further calls without closing caller-owned storage.

The versioned cursor binds the verified scope, policy hash and last examined run ID. It is plain continuation metadata, not an authentication capability or signed statement. Validate exact fields, context, monotonic ordering, candidate uniqueness/counts and next-cursor consistency for custom-adapter replies. If every examined owner is returned, the next cursor must exactly equal the final candidate ID. Candidate versions and readiness may change immediately after observation. Pending timed-out adapter operations retain bounded admission slots until their actual promises settle. These slots bound actual adapter callbacks, not concurrent callers sharing initialization; applications separately bound their scan requests.

## Authoritative index and finite transactions

Use existing `mayura_workflow_owners` rows, with an index ordered by `(scope, policy_hash, profile, aggregate_id)`: equality predicates precede the run-ID range predicate. Use explicit binary/C collation for the run-ID index, range and ordering so cursor checks match hexadecimal JavaScript lexical ordering independently of database locale. Select only profile 2, with explicit scope/policy, ordered keyset pagination and a hard SQL limit. Do not use OFFSET, an unbounded JSON readiness predicate, or a filtered `LIMIT` that can hide an unbounded candidate scan.

First select at most `limit` owner identities without holding business locks. Then validate each selected parent in its own existing normal parent transaction. Never retain locks across two parents, lock target aggregates, acquire a scope-sequence counter, materialize completion facts, advance state, create jobs or invoke callbacks. Selected corruption or a missing selected owner fails the page closed; it must not be silently skipped as terminal.

Return only parents currently nonterminal after validation, but advance the cursor over **every examined owner**, including terminal rows. If a full candidate page was examined, return its last ID as continuation even when no candidates remain; a subsequent empty page may be required to establish exhaustion. A short owner page ends that sweep. This keeps each command's work explicit and bounded rather than promising a particular number of useful results.

Existing format-3 runs are discoverable through their authoritative ownership rows without a new projection, active flag, data migration or backfill-completeness protocol. Index provisioning itself traverses existing rows; it is explicit capability initialization, with no silently unindexed fallback. PostgreSQL inherits its statement/lock timeouts. SQLite's busy timeout bounds lock acquisition, not CPU time spent building an index; the facade deadline bounds waiting and retains its pending slot but does not interrupt an already-running database operation. Do not describe index creation as constant-time, hard CPU cancellation, online migration or mixed-version qualification.

Initialization also verifies native catalog metadata: exact owner table, nonpartial ordinary index, four ascending expected column keys and the required collation; PostgreSQL additionally requires a live/valid/ready B-tree with matching default operator classes and no extra included/expression keys. An incompatible same-named object is an error, never silently accepted, repaired or dropped. This is startup verification, not continuous protection against an administrator changing schema afterward.

Index existence and compatibility do not force the optimizer to choose it. PostgreSQL's `indcheckxmin` is a snapshot/HOT-chain eligibility condition, not an invalid-index marker; it may remain true on a legitimate usable index after the relevant snapshot horizon passes. PostgreSQL owns that decision. Do not reject the flag unconditionally or promise a physical row-visit/latency bound from SQL `LIMIT`. The command bounds returned owner identities and subsequent parent validations; actual physical planning remains database-owned. See the [PostgreSQL index catalog](https://www.postgresql.org/docs/current/catalog-pg-index.html).

## Deliberate limits

Pages are **not a stable database snapshot**. A new run inserted before the cursor is found only by a later caller-started sweep. Completion between pages can remove a candidate from the returned hints. No background loop, stable-membership sweep, starvation guarantee under continuous writes, retained promise, notification subscription, lease or reservation is added. Applications own their finite sweep budgets and subsequent scheduling.

A complete sweep scales with retained scoped/policy ownership history, including terminal runs. This is a correctness-first recovery aid, not a high-throughput ready index or retention service. Consistently forged or deleted authoritative ownership rows by a privileged database writer cannot be detected by this index; existing selected-parent redundant-state checks remain in effect.

## Failure-first acceptance

- Strict command/page/cursor codecs, custom reply bounds, no accessor execution, exact scope/policy isolation and explicit unsupported-capability failure.
- Paired SQLite/PostgreSQL pages containing only terminal owners, mixed profiles/policies, exactly-full final pages, empty results with continuation and restart from the beginning.
- Existing format-3 rows discoverable after close/reopen and index provisioning; no new projection/backfill assumptions.
- Crash after wait resolution but before downstream preparation/finalization retains a candidate; concurrent cancellation/completion makes hints stale without authorizing dispatch.
- At most the configured number of parent validations per call; no progress/event/version/budget changes and no jobs, leases, callbacks or target mutations.
- Selected corruption fails closed. A locked target cannot block discovery through mutable target-lock acquisition.
- Isolated custom-adapter packed consumer, selected SQL packed capability types/reopen and a credential-free application-owned continuation loop with an explicit page budget.
- Verify actual query plans against a populated disposable fixture; do not force a query plan or infer production throughput from an empty table.

Local evidence comprises 125 added tests, including 56 paired SQL cases, four actual process-kill recoveries and one real PostgreSQL HOT/snapshot regression; isolated offline custom-adapter and selected SQL consumer gates; and the credential-free restart example. The discovery checkpoint's integrated 2,134-test suite passed with two test processes; later totals are in the [development ledger](../development-status.md). This narrower qualification leaves every enterprise release gate open; it does not establish production performance or the full platform matrix.
