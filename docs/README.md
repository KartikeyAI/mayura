# Mayura documentation

Mayura is an independent, Apache-2.0 TypeScript agent development framework. All finite V01–V22 acceptance gates are closed; this checkout remains a **development preview**, not a production qualification or published package release.

## Authority and navigation

- [Governing development plan](create-mayura-agentic-framework-plan.md) — requirements F01–F29, guardrails G01–G11 and verification V01–V22.
- [Technical proposal](mayura-technical-proposal.md) — proposed technology boundaries.
- [Quickstart](quickstart.md) — credential-free first agent and progressive adoption.
- [Bounded helper battery](how-to/helpers.md) — explicit configuration, retries, cancellation, cleanup, pagination, artifact transfer, redacted logging and budget-aware concurrency.
- [CLI and eight starter templates](how-to/cli-and-templates.md) — plan-first initialization, static catalog validation and credential-free runnable starters.
- [First-agent API](specs/first-agent-api.md) — public developer journey.
- [Child-agent how-to](how-to/agent-orchestration.md) and [orchestration contract](specs/agent-orchestration.md) — direct children and agents as tools, with shared authority/accounting.
- [Workflow composition how-to](how-to/workflow-composition.md) and [ephemeral contract](specs/ephemeral-workflow-composition.md) — driver-free finite graphs through the same execution boundary.
- [Durable execution](specs/durable-execution.md) — storage and recovery contract.
- [Storage aggregates](specs/storage-aggregate.md) — transactional persistence building block.
- [Driver-free storage contracts](adr/0005-driver-free-storage-contracts.md) — custom adapter interfaces without installing reference database drivers.
- [Choose a storage installation](how-to/storage-installation.md) and [package boundary decision](adr/0006-isolated-sql-installations.md) — selected SQLite/PostgreSQL adapters with one shared engine and a compatible both-adapter facade.
- [Standalone leased scheduler](specs/leased-scheduler.md) — expiring claims, fences and resource quarantine for separate jobs.
- [Scheduled workflows](scheduled-workflows.md), [atomic contract](specs/scheduled-workflows.md) and [paired SQL tests](testing-scheduled-workflows.md) — opt-in workflow/job/budget ownership without automatic legacy migration.
- [External-effect reconciliation](specs/external-effect-reconciliation.md) — trusted exact-attempt attestation and atomic cost refinement without output release or replay.
- [Initial durable engine](adr/0002-initial-durable-engine.md) — implemented subset and recovery limitations.
- [Tool batches](specs/tool-batches.md) — dependency-aware bounded parallel execution.
- [Processors and guardrails](specs/processors.md) — immutable content and disclosure barriers.
- [No-default-phone-home boundary](specs/no-default-phone-home.md) — executable import and source checks for local-only packages.
- [OTLP/HTTP JSON logs](specs/otlp-http-json-logs.md) — explicit bounded metadata export with no ambient destination or credentials.
- [Local artifact boundary](specs/local-artifacts.md) — scoped staged promotion, integrity-checked content and safe attachment disclosure.
- [Auxiliary model guardrails](specs/auxiliary-guardrails.md) — metered evaluation, moderation and source-preserving language processing.
- [Runtime-managed moderation](how-to/managed-guardrails.md) — definition-only authoring with actual run ownership, protected output-check capacity and bounded callbacks.
- [Required lifecycle hooks](how-to/lifecycle-hooks.md) and [acceptance contract](specs/lifecycle-hooks.md) — control-only checks with mediated read/pure-tool actions, retained callback capacity and truthful output evidence.
- [Shared budgets](how-to/shared-budgets.md) — atomic future-call reservations and genuine single-use tickets; [managed guardrail integration](specs/runtime-managed-guardrails.md) has a separate acceptance contract.
- [Durable financial budgets](how-to/durable-budgets.md) and [ledger contract](specs/durable-budget-ledger.md) — restartable shared ceilings, exact evidence and subtree held cleanup; a standalone host primitive, not automatic workflow or child execution accounting.
- [Model provider contract](specs/model-provider-contract.md) — optional adapter and private protocol state.
- [WorkStream](specs/workstream.md) — durable scoped signals and wait registration.
- [Authenticated webhook triggers](specs/webhook-triggers.md) and [integration guide](how-to/webhook-triggers.md) — driver-free HMAC ingress, durable deduplication and conservative recovery.
- [Execution completion waits](how-to/execution-completion-waits.md) and [transaction contract](specs/execution-completion-waits.md) — finite metadata joins over existing scheduled workflows, with restart and explicit unknown outcomes.
- [Durable graph waits](how-to/workflow-graph-waits.md) and [format-3 contract](specs/workflow-graph-waits.md) — explicit in-graph suspension over already submitted runs without holding worker capacity.
- [Graph discovery guide](how-to/workflow-graph-discovery.md) and [discovery contract](specs/workflow-graph-discovery.md) — finite indexed candidate pages after restart, with explicit non-snapshot semantics and no automatic dispatch.
- [Registered graph coordinator](how-to/workflow-graph-coordinator.md) and [contract](specs/workflow-graph-coordinator.md) — finite continuation through one shared driver, with explicit catalogs and partial-page retry metadata; not a worker fleet.
- [Durable required children](how-to/workflow-tree-children.md) and [contract](specs/durable-workflow-children.md) — explicit narrowed one-level child ownership, close/reopen continuation, verified approvals and exact joins.
- [Durable workflow lifecycle guide](how-to/workflow-lifecycle.md) and [format-5 contract](specs/workflow-lifecycle-format5.md) — versioned human/timer suspension with typed idempotent responses and restart-safe wake evidence.
- [Lifecycle fleet discovery](specs/workflow-lifecycle-fleet.md) — durable sharded active-run indexing, finite cursors and catalog-bound due-wake coordination over any aggregate adapter.
- [Durable workflow sagas](specs/workflow-sagas.md) and [saga guide](how-to/workflow-sagas.md) — stable format-5 child identities and restart-safe reverse compensation.
- [Durable bounded loops](specs/workflow-loops.md) and [loop guide](how-to/workflow-loops.md) — finite lifecycle iteration with explicit condition and limit outcomes.
- [Hosted lifecycle coordinator](specs/hosted-lifecycle-coordinator.md) and [hosting guide](how-to/host-lifecycle-coordinator.md) — explicitly started bounded fleet sweeps, backoff and graceful drain.
- [Composite workflow fleet](specs/composite-workflow-fleet.md) and [hosting guide](how-to/host-composite-workflows.md) — restart-safe saga/loop parent discovery and hosted continuation.
- [Native memory](specs/native-memory.md) — canonical records and deletion semantics.
- [Workflow definition versions](how-to/workflow-versions.md) — pinned digests, side-by-side retention, the cross-format version inventory and the deploy gate.
- [Local inspector](how-to/inspector.md) — opt-in, read-only, same-origin inspector UI over the authenticated read APIs.
- [Stable API and support policy](api-stability.md) — stable entry points, the API report gate, SemVer, deprecation and support windows.
- [Performance report](performance.md) — plan §21.3 targets measured on declared hardware (`pnpm perf`).
- [Native context](specs/native-context.md) — current evidence and required continuity.
- [HTTP transport/client](specs/http-agent-transport.md) — scoped authentication, idempotent commands and metadata SSE.
- [Headless UI bindings](specs/headless-ui-bindings.md) and [framework integration guide](how-to/headless-ui.md) — browser-safe explicit run stores and human-request presentation metadata.
- [React bindings](specs/react-bindings.md) and [React integration guide](how-to/react-bindings.md) — optional inert hooks over caller-owned headless stores.
- [Durable workflow UI projection](specs/workflow-ui-projection.md) and [integration guide](how-to/workflow-ui-projection.md) — strict content-free DAGs for formats 2–5.
- [Authenticated workflow view transport](specs/workflow-view-transport.md) and [browser guide](how-to/workflow-view-transport.md) — capability-scoped, bounded durable DAG reads through the server/client boundary.
- [Authenticated workflow controls](specs/workflow-control-transport.md) and [control guide](how-to/workflow-controls.md) — explicit revision/digest-bound cancellation and approval with adapter-owned durable idempotency.
- [Authenticated workflow index](specs/workflow-index-transport.md) and [listing guide](how-to/workflow-index.md) — bounded content-free authorized summaries with explicit opaque pagination.
- [Authenticated workflow signals](specs/workflow-signal-transport.md) and [delivery guide](how-to/workflow-signals.md) — revision-bound bounded signal delivery through a separate least-authority adapter.
- [Authenticated workflow continuation](specs/workflow-resume-transport.md) and [resume guide](how-to/workflow-resume.md) — revision-bound continuation that cannot force an unresolved gate.
- [Pause console example](../examples/pause-console/README.md) — live local operator UI for per-run pause and fleet hold, used for the pause-control qualification.
- [Fleet-wide pause](specs/fleet-pause.md) and [fleet control guide](how-to/fleet-control.md) — durable per-scope hold honored by hosts and coordinators, a ledger-backed sweep that pauses discoverable runs and resumes only the ones it paused, and an authenticated `workflows:fleet` transport for server, browser and CLI.
- [Storage operations](how-to/storage-operations.md) — schema version policy, `mayura migrate`, SQLite online backup/verified restore, PostgreSQL dump/restore and restore drills.
- [Native memory](how-to/native-memory.md) and [spec](specs/native-memory-v1.md) — table-backed memory with BM25, IVF semantic and hybrid search, graph relationships, import/export, context cache invalidation and speculation.
- [Lifecycle hook catalog](specs/lifecycle-hook-catalog.md) — all 25 lifecycle points: agent control/observer hooks, context/memory/retry hooks and durable workflow hook delivery.
- [Container deployment guide](how-to/production-deployment.md) — offline-built server/worker image, compose smoke test, probes and graceful drain on SIGTERM.
- [Production server host](specs/production-server.md) — explicit public binding, HTTPS origin, in-process or proxy TLS, host check, probes, HSTS and durable submission idempotency.
- [Threat model](threat-model.md) — assets, trust boundaries, threats, controls with evidence, and residual risks.
- [v1 release plan](v1-release-plan.md) — the working checklist for Mayura v1.
- [Workers and leadership](specs/workers.md) — durable leadership lease and a worker supervisor for hosts and coordinators with fail-safe stop, readiness and drain handover.
- [Bounded worker draining](specs/worker-draining.md) — graceful `drain` for every workflow runtime, coordinator and host: no new wave or claim, admitted effects settle within a deadline, interrupted work is reported.
- [Durable operator pause](specs/workflow-operator-pause.md) and [pause guide](how-to/workflow-pause.md) — quiescent pause/resume for durable formats 2–5 with restart persistence, claim fencing, tree-wide root fencing, fleet deferral, an authenticated revision-bound pause command and no wait bypass.
- [React reference components](specs/react-components.md) and [component guide](how-to/react-components.md) — optional unstyled semantic run, workflow and human-request views.
- [Human response forms](specs/human-response-forms.md) and [form guide](how-to/human-response-forms.md) — finite schema-driven, request/digest-bound browser validation and an explicit React form.
- [Local-server how-to](how-to/local-server.md), [Node host contract](specs/node-local-host.md) and [host-adapter decision](adr/0004-http-protocol-before-host-adapter.md) — optional loopback-only Hono hosting.
- [Native observability](specs/native-observability.md) — bounded metadata subscriptions, uncertain coverage, counters and optional isolated delivery.
- [Docker tests](testing-docker.md) — disposable PostgreSQL fixture.
- [Docker promotion attestations](specs/code-mode-docker-promotion.md) — Ed25519 verification of an exact fresh clean-scan promotion statement.
- [Crash-recovery testing](testing-process-recovery.md) — forced process termination evidence.
- [Packed consumer validation](dx-validation.md) — public imports, types and source navigation.
- [Optional-package qualification](specs/optional-package-qualification.md) — isolated offline browser, local host/observer and driver-free workflow installations.
- [Selected-storage qualification](specs/storage-package-qualification.md) — actual SQLite-only, PostgreSQL-only, compatibility and workflow-tree SQLite archives, native worker proof and declaration-file isolation.
- [Technology qualification](technology-qualification.md) — exact pins and verified environments.
- [Foundation architecture](adr/0001-foundation.md) — implementation boundaries and admission policy.
- [Development status](development-status.md) — verified deliveries and remaining gates.
- [Release gate closure ledger](release-gate-closure.md) — auditable V01–V22 evidence, blockers and closure order.

Documentation is versioned alongside code. A design document does not establish an implemented guarantee. The status and release-gate ledgers plus executable tests determine what this checkout actually supports. All 22 finite acceptance scenarios are closed with bounded claims recorded in the ledger.

Current implementation focus: M3's declared preview is complete through [workflow lifecycle format 5](specs/workflow-lifecycle-format5.md), [durable workflow sagas](specs/workflow-sagas.md), [bounded loops](specs/workflow-loops.md), hosted lifecycle coordination and composite-parent continuation. M8 now includes [authenticated webhook triggers](specs/webhook-triggers.md), [headless UI bindings](specs/headless-ui-bindings.md), optional [React hooks](specs/react-bindings.md), strict [durable workflow UI projections](specs/workflow-ui-projection.md) with [authenticated read transport](specs/workflow-view-transport.md), [authorized workflow listing](specs/workflow-index-transport.md), [explicit workflow controls and command state](specs/workflow-control-transport.md), [bounded workflow signals](specs/workflow-signal-transport.md), [safe continuation requests](specs/workflow-resume-transport.md), the [format-2–5 operator-pause foundation](specs/workflow-operator-pause.md), [React reference components](specs/react-components.md) and [typed human-response forms](specs/human-response-forms.md); live UI qualification and broader durable operational administration remain in progress. [SQL identity integrity](specs/sql-identity-integrity.md) specifies lossless identifier validation without payload normalization or a persisted-data migration.

## Distribution

Mayura is licensed under Apache-2.0. Source package manifests remain private to prevent accidental publication; the controlled release process stages inspected public artifacts. Registry and repository ownership must be verified before first publication. No archived repository or remote is changed.
