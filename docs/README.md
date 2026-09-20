# Mayura documentation

Mayura is an independent, open-source TypeScript agent development framework. Development is authorized; this checkout is **pre-release**, not enterprise-qualified or ready for publication.

## Authority and navigation

- [Governing development plan](create-mayura-agentic-framework-plan.md) — requirements F01–F29, guardrails G01–G11 and verification V01–V22.
- [Technical proposal](mayura-technical-proposal.md) — proposed technology boundaries.
- [Quickstart](quickstart.md) — credential-free first agent and progressive adoption.
- [First-agent API](specs/first-agent-api.md) — public developer journey.
- [Durable execution](specs/durable-execution.md) — storage and recovery contract.
- [Storage aggregates](specs/storage-aggregate.md) — transactional persistence building block.
- [Initial durable engine](adr/0002-initial-durable-engine.md) — implemented subset and recovery limitations.
- [Tool batches](specs/tool-batches.md) — dependency-aware bounded parallel execution.
- [Processors and guardrails](specs/processors.md) — immutable content and disclosure barriers.
- [Model provider contract](specs/model-provider-contract.md) — optional adapter and private protocol state.
- [WorkStream](specs/workstream.md) — durable scoped signals and wait registration.
- [Native memory](specs/native-memory.md) — canonical records and deletion semantics.
- [Native context](specs/native-context.md) — current evidence and required continuity.
- [Docker tests](testing-docker.md) — disposable PostgreSQL fixture.
- [Crash-recovery testing](testing-process-recovery.md) — forced process termination evidence.
- [Packed consumer validation](dx-validation.md) — public imports, types and source navigation.
- [Technology qualification](technology-qualification.md) — exact pins and verified environments.
- [Foundation architecture](adr/0001-foundation.md) — implementation boundaries and admission policy.
- [Development status](development-status.md) — verified deliveries and remaining gates.

Documentation is versioned alongside code. A design document does not establish an implemented guarantee. The status ledger and executable tests determine what this checkout actually supports.

## Distribution

The owner selected open-source distribution. The exact license and registry namespace have not been selected, so packages remain private and publication is blocked until those decisions are made. This does not block local development or tests. No archived repository or remote is changed.
