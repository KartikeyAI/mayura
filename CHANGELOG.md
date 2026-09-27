# Changelog

All notable changes to Mayura are recorded here. The format follows Keep a Changelog, and public versions follow Semantic Versioning.

## [Unreleased] — toward 1.0.0

### Added

- **Production operations.**
  - A TLS/proxy production host with liveness and readiness probes, canonical-origin enforcement and HSTS.
  - A durable submission journal.
  - A leadership lease and worker supervisor with bounded drain.
  - CLI `serve`, `worker` and `migrate` commands.
  - An offline-built server/worker container image and compose profile.
  - SQLite online backup and verified restore, and a PostgreSQL dump/restore drill.
- **Workflow control.**
  - Operator pause across workflow formats 2–5.
  - Durable fleet hold with sweep.
  - Authenticated pause and fleet routes, with client, CLI and React bindings.
  - A cross-format definition-version inventory and deploy gate (`inventoryWorkflowVersions`, `assertWorkflowVersionsRetained`).
- **In-place migration of in-flight runs** for every workflow format (aggregate, scheduled, graphs, trees, lifecycle, sagas and loops) on SQLite and PostgreSQL.
  - `defineWorkflowMigration` declarations and a planner that decides what happens to each step from the run's real state.
  - A `migrate` method (with `dryRun`) on every format runtime. Storage re-verifies every migration inside its transaction.
  - Operator pause and resume for sagas, loops and scheduled workflows.
  - `createWorkflowMigrationCatalog`, `createWorkflowMigrationService` and `pinnedDefinitionHash` for hosts.
  - Server migration routes behind a new `workflows:migrate` capability, and the client methods `workflowMigrations`, `planWorkflowMigration` and `migrateWorkflow`.
  - `compositeFleetTarget` for fleet sweeps over sagas and loops.
- **Lifecycle hook catalog.** All 25 plan lifecycle points are served:
  - `defineHook` accepts 16 agent stages, including observers with `mandatory` fail-closed semantics.
  - New `step.*` and `delegate.*` run events.
  - Fail-closed context-build, memory-write and `onRetry` hooks.
  - `createWorkflowHookRelay` gives durable at-least-once workflow callbacks.
- **Native memory.**
  - `createNativeMemory` over a new `memory` storage capability on SQLite and PostgreSQL.
  - In-database BM25, exact/IVF semantic and hybrid search.
  - Graph edges and traversal, and supersession.
  - Streamed import/export, with the compact-profile migration path.
  - A content-free change feed.
  - `hashingEmbedder` (local) and `openAIEmbeddings` (hosted, sensitivity-gated).
- **Context and speculation.**
  - `createContextCache`, with admission-key caching, invalidation, change-feed following and prefetch.
  - `runtime.speculate`, for verified isolated branches under the shared budget.
- **Operator console.** A React and shadcn/ui console served same-origin by the agent server (`inspector: true`).
  - Views for workflows, human requests, fleet control, migrations and agent runs.
  - Confirmed, revision-bound operator commands.
  - A strict CSP with a per-response style nonce.
- **Platform.** Node.js 22 LTS support alongside 24.
- **Release engineering.**
  - Secret scan, CycloneDX SBOM, a tag-gated release workflow with npm provenance, and Dependabot.
  - The `upgrade:compat` cross-version resume check.
  - The `api:report` public-surface gate and the `perf` suite for the plan §21.3 targets.
  - A threat model, and a stable API, support and deprecation policy.

### Changed

- Saga and loop statuses gain `paused`. Graph and tree discovery candidates can have status `paused`: coordinators skip them with the outcome reason `paused`, and `graphFleetTarget` and `treeFleetTarget` take `{ includePaused }` so inventories count them. Exhaustive switches over these unions need a `paused` case.
- `graphFleetTarget` and `treeFleetTarget` cap discovery pages at 32, the discovery bound. Larger inventory pages previously failed.
- Workflow migration ids are limited to letters, digits, `.`, `_` and `-`, so they are safe in URLs.
- Every workspace entry point is classified stable (47 application-facing plus 3 trusted-host entry points) against the 1.0.0 target. The package version changes at the release cut.
- The run event stream adds `step.started`, `step.completed`, `delegate.started` and `delegate.completed`; hook events accept all agent stages. Strict clients built on earlier previews must accept these event types.
- `MemoryEntry` includes the `superseded` state produced by native memory.

## [0.1.0-dev.0] - 2026-09-24

- Initial development-preview baseline. No API is stable and no production support commitment is made.
