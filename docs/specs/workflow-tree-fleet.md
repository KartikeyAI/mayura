# Workflow-tree fleet boundary

Status: **implementation in progress; not qualified**. Strict discovery contracts/facades, selected SQLite/PostgreSQL owner scans, a public metadata-only discovery facade and a finite registered-definition coordinator are implemented. Real database tests exclude child/terminal owners, preserve cursor progress, resume registered roots, skip unknown definitions, retain the original page boundary after an interruption and fence competing PostgreSQL coordinators to one dispatch. A real SQLite process kill between observation and continuation resumes once without replay. An isolated packed SQLite consumer compiles the APIs and coordinates a reopened approval wait using installed archives only. Populated query-plan evidence and production fleet qualification remain.

## Objective

Allow multiple trusted Mayura workers to discover and continue nonterminal format-4 roots after restart while preserving the existing scheduler fences, root-locked accounting and explicit application-owned definition catalog. Discovery is metadata only: it never grants authority, guesses a definition, adopts an independent run or dispatches work.

## Public boundary

- A separate optional `workflowTreeDiscovery` storage capability returns finite keyset pages of nonterminal root hints for one exact scope and format-4 policy hash.
- A hint contains only root ID, definition hash, policy hash, aggregate version and `running`/`waiting` status. It contains no input, output, approval candidate, receipt, credential, child data or budget detail.
- Cursors are context-bound metadata, not stable snapshots or capabilities. `limit` bounds examined format-4 owners, including terminal roots and child-owner rows that produce no candidate.
- `createWorkflowTreeCoordinator` accepts a finite genuine definition catalog, captures one selected adapter, uses one shared bounded worker pool and invokes the existing runtime only for catalog matches.
- Unknown definitions are reported and skipped. One failed candidate interrupts the page with the original retry cursor; completed candidates remain idempotent on retry.

## Storage and concurrency

- Selection uses the existing `(scope, policy_hash, profile, aggregate_id)` owner index and releases the page transaction before validating individual roots.
- Every candidate is independently validated through the existing root/member/owner/budget invariants. A selected corrupt or disappearing owner fails the page; it is never silently skipped as terminal.
- Profile 3 child owners and terminal roots count as examined cursor progress but are not candidates.
- Execution authority remains in `claimPreparedRootTool` / `claimPreparedChildTool`; competing workers can observe the same hint but scheduler fencing permits at most one dispatch.
- Discovery performs no writes. Coordinator close stops local admission and waits without cancelling durable roots or closing caller-owned storage.

## Bounds

- Page limit: 1–32 examined owners.
- Catalog: 1–32 definitions and at most 4 MiB of cumulative immutable manifest/resource metadata.
- One active page per coordinator, 1–32 shared tool callbacks and 1–128 active known-root continuations within existing runtime bounds.
- Storage callback acknowledgement and retained timed-out callback limits remain explicit and independent from tool capacity.

## Qualification required

- Strict command/response codecs, hostile custom adapters and wrong-context cursor rejection.
- SQLite/PostgreSQL pages containing root, child and terminal owners; exact binary ordering; close/reopen; populated query-plan evidence; incompatible-index preservation.
- Competing coordinators, unknown definitions, approval waits, partial-page interruption/retry, close during discovery/dispatch and actual process termination between candidate observation and continuation. The implemented suite covers all except the close-during-discovery/dispatch timing matrix.
- Packed driver-free contract/facade consumer plus selected-adapter runtime consumer.
- The complete unchanged regression suite. This document closes no release gate until all evidence is recorded.
