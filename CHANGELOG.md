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
- **Production operator API.** `createWorkflowOperatorTransports`, with `lifecycleOperatorTarget`, `graphOperatorTarget` and `treeOperatorTarget`, implements the server's workflow transports over the real runtimes. It provides:
  - a durable, leased command journal (`createWorkflowCommandJournal`), so a command id applies at most once across retries, replicas and restarts;
  - revision checks;
  - views on each run's pinned version;
  - index paging;
  - fleet sweeps and migrations;
  - scope isolation.
  The reference deployment and the console demo use it. Graph and tree discovery gain `cursorAfter`.
- **Property tests for migration.** They cover generated planner cases, plus generated lifecycle and scheduled runs migrated on SQLite, using a seeded in-house generator with no new dependency.
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
- **Finished and unresolved workflow runs for operators.** The lifecycle fleet runtime keeps a bounded settled index (`runtime.settled()`: up to 64 runs per shard, 16,384 per scope). The oldest finished run is dropped first, and a run whose outcome is unknown is kept in preference because it still needs reconciling. `GET /v1/workflow-runs?view=settled`, `client.workflows({ view: 'settled' })`, `mayura workflow-list --settled` and a Finished tab in the console Workflows view list them with their `settledAtMs`. Operator targets gain an optional `settledPage`; graph and tree runs are not in the settled view yet.
- **Guards that rewrite.** A guard can return `{ decision: 'rewrite', value }` as well as allow or block, for example to redact personal data. Agent guards run in declared order, each seeing the previous rewrite, and a rewritten input, output or tool result is validated again against its schema before use; streaming batch guards can rewrite a batch instead of withholding the rest. `pipelineGuard(id, pipeline)` in `@mayura/guardrails` turns any guardrails pipeline (such as `redactPII`) into a rewriting agent guard. Model-backed managed guards and tool-level guards still allow or block, and treat a rewrite as a block.
- **`ToolRefusal`.** A tool with effects can throw `ToolRefusal` to state it refused the call before any external effect: the call is recorded as `not_started`, its outcome is `failed` rather than `outcome_unknown`, nothing is charged and durable runs need no reconciliation. It is ignored once the tool has reported usage. Found by the starters, where "not found" from a write tool otherwise needed reconciliation.
- **Remote OpenAI-compatible providers.** `openAICompatibleChat({ remote: { id, auth } })` reaches an explicit HTTPS Chat Completions endpoint (Groq, Together, Fireworks, Mistral, DeepSeek, OpenRouter, xAI, Azure OpenAI with its `api-key` header and `api-version`, Gemini/Vertex compatibility endpoints) with a bearer or `api-key` credential or a per-request token source, under a provider-named adapter id. The compatible adapter also streams.
- **Streaming.** Agents can opt into streaming one text field of their output in guarded batches (`defineAgent({ stream: { field, guards } })`): each batch passes local guards with cross-batch context before release, the final output is still validated and guarded whole, and buffered output remains the default. Adds `ModelAdapter.stream`, `output.delta`/`output.withheld` run events, `streamedOutput` in the headless store, streaming in the OpenAI Responses and Anthropic Messages adapters, and streaming failover in the router (only before the first released delta). Observers and OTLP export record delta positions and lengths, never text.
- **Provider router.** `createModelRouter` fails over between model adapters in priority order, with a per-route circuit breaker, conservative accounting (unknown-cost attempts are charged their full bound) and continuation that stays with its provider.
- **Starters.** Complete multi-file projects shipped with `@mayura/cli`: `mayura starters` and `mayura init --starter <name>` (plan-first, digest-confirmed replacement, Mayura pinned to the CLI release). They are `approval-workflow`, `support-agent` (with a React chat UI), `research-team` (parallel agents under one durable budget) and `event-automation` (signed webhooks and MCP tools). `pnpm test:starters` builds and tests each one in the workspace, then generates it, installs it offline from packed archives, tests it and boots `migrate`, `serve` and `worker`.
- **Operator console.** A React and shadcn/ui console served same-origin by the agent server (`inspector: true`).
  - Views for workflows, human requests, fleet control, migrations and agent runs.
  - Confirmed, revision-bound operator commands.
  - Tool approvals from the console and the API: a waiting tool step's view carries its approval digest and expiry, and lifecycle runs show the exact tool call it binds (`runtime.approvalRequest`, digest-verified).
  - A strict CSP with a per-response style nonce.
- **Platform.** Node.js 22 LTS support alongside 24.
- **Release engineering.**
  - Secret scan, CycloneDX SBOM, a tag-gated release workflow with npm provenance, and Dependabot.
  - The `upgrade:compat` cross-version resume check.
  - The `api:report` public-surface gate and the `perf` suite for the plan §21.3 targets.
  - A threat model, and a stable API, support and deprecation policy.

### Fixed

- Smaller fixes found while building the starters:
  - `RuntimeLimits.maxToolCalls` accepts 0 for agents without tools.
  - Native memory used before `store.memory.initialize()` reports that call as an `INVALID_CONFIG` error, instead of a generic storage failure.
  - A webhook delivery id reused with a different body raises the documented `MayuraError('CONFLICT')`, not a raw storage error.
  - `validatedEnvironment` errors name the environment variables that failed validation (never their values); the error code is unchanged.
  - The MCP adapter accepts the `_meta` field that the MCP specification allows on tool results.
  - The `agentAsDurableWorkflow` permissions comment no longer claims an intersection with outer authority.
- Durable workflow budgets (format-2 workflows and lifecycle workflows) charged every completed tool step its declared ceiling and ignored the usage the tool reported with `context.reportUsage`. They now charge the reported usage, capped at the reservation; a tool that reports nothing is still charged its declared cost, and reported unknown usage still keeps the whole reservation until reconciled. Found by the research-team starter.
- The agent server never released finished runs or per-principal runtimes, so a long-running server answered `429` after `maxRuns` runs or `maxRuntimes` principals until restarted. Finished runs are now kept for `limits.runRetentionMs` (default 10 minutes); a run whose outcome was read may be released early under pressure; runtimes close when unused; and a same-key retry of a released run gets `410 RUN_EXPIRED` from a bounded tombstone instead of starting a second run.
- A strict TypeScript host could not pass `createWorkflowOperatorTransports` to the server: view node kinds, step statuses and fleet results were typed too loosely. They now use the server's record types, and `@mayura/server-node` re-exports `ServerIdentity`.
- A scheduled run whose approval expired before its step was admitted retried the refused preparation until it failed with a contention error. The driver now requests a fresh review, and the run waits for a human again.
- The migration planner could accept a settled tool step whose tool changed. The migrated state then failed validation. Such a plan is now refused, with the reason.
- CI on Linux and macOS:
  - The template check re-packed the native TypeScript compiler without its execute bit.
  - The SBOM script could not find a globally installed pnpm.
  - The Docker adapter tests used a Windows-only absolute path.
  - Two process-recovery tests could race a child that had already exited.

### Changed

- Saga and loop statuses gain `paused`. Graph and tree discovery candidates can have status `paused`: coordinators skip them with the outcome reason `paused`, and `graphFleetTarget` and `treeFleetTarget` take `{ includePaused }` so inventories count them. Exhaustive switches over these unions need a `paused` case.
- `graphFleetTarget` and `treeFleetTarget` cap discovery pages at 32, the discovery bound. Larger inventory pages previously failed.
- Workflow migration ids are limited to letters, digits, `.`, `_` and `-`, so they are safe in URLs.
- Every workspace entry point is classified stable (47 application-facing plus 3 trusted-host entry points) against the 1.0.0 target. The package version changes at the release cut.
- The run event stream adds `step.started`, `step.completed`, `delegate.started` and `delegate.completed`; hook events accept all agent stages. Strict clients built on earlier previews must accept these event types.
- `MemoryEntry` includes the `superseded` state produced by native memory.

## [0.1.0-dev.0] - 2026-09-24

- Initial development-preview baseline. No API is stable and no production support commitment is made.
