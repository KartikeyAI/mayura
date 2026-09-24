# Mayura documentation

Mayura is an independent, open-source TypeScript agent development framework. Development is authorized; this checkout is **pre-release**, not enterprise-qualified or ready for publication.

## Authority and navigation

- [Governing development plan](create-mayura-agentic-framework-plan.md) — requirements F01–F29, guardrails G01–G11 and verification V01–V22.
- [Technical proposal](mayura-technical-proposal.md) — proposed technology boundaries.
- [Quickstart](quickstart.md) — credential-free first agent and progressive adoption.
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
- [Execution completion waits](how-to/execution-completion-waits.md) and [transaction contract](specs/execution-completion-waits.md) — finite metadata joins over existing scheduled workflows, with restart and explicit unknown outcomes.
- [Durable graph waits](how-to/workflow-graph-waits.md) and [format-3 contract](specs/workflow-graph-waits.md) — explicit in-graph suspension over already submitted runs without holding worker capacity.
- [Graph discovery guide](how-to/workflow-graph-discovery.md) and [discovery contract](specs/workflow-graph-discovery.md) — finite indexed candidate pages after restart, with explicit non-snapshot semantics and no automatic dispatch.
- [Registered graph coordinator](how-to/workflow-graph-coordinator.md) and [contract](specs/workflow-graph-coordinator.md) — finite continuation through one shared driver, with explicit catalogs and partial-page retry metadata; not a worker fleet.
- [Durable required children](how-to/workflow-tree-children.md) and [contract](specs/durable-workflow-children.md) — explicit narrowed one-level child ownership, close/reopen continuation, verified approvals and exact joins.
- [Native memory](specs/native-memory.md) — canonical records and deletion semantics.
- [Native context](specs/native-context.md) — current evidence and required continuity.
- [HTTP transport/client](specs/http-agent-transport.md) — scoped authentication, idempotent commands and metadata SSE.
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

Documentation is versioned alongside code. A design document does not establish an implemented guarantee. The status and release-gate ledgers plus executable tests determine what this checkout actually supports. V02–V03 and V07–V12 are closed by direct acceptance evidence; V01, V04–V06 and V13–V22 remain open.

Next-slice design: [durable required workflow children](specs/durable-workflow-children.md) remains planned, not implemented. [SQL identity integrity](specs/sql-identity-integrity.md) specifies lossless identifier validation without payload normalization or a persisted-data migration.

## Distribution

The owner selected open-source distribution. The exact license and registry namespace have not been selected, so packages remain private and publication is blocked until those decisions are made. This does not block local development or tests. No archived repository or remote is changed.
