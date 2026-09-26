# Mayura

An independent TypeScript framework for building agents, typed tools and durable workflows.

**Development preview — not production-qualified.** No package is published and no public API is stable. Mayura is Apache-2.0 licensed; the currently qualified platforms are intentionally narrow. See [development status](docs/development-status.md) and the [support matrix](docs/support-matrix.md).

## Developing this checkout

Mayura supports Node.js 22 LTS (>= 22.12.0) and 24 (>= 24.14.1); the maintainer workspace uses Node.js 24.14.1 and pnpm 10.17.1. Consumer applications will not need this workspace build system.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm example
```

The basic SDK requires no Docker, native database, server or hosted account. [Select SQLite or PostgreSQL explicitly](docs/how-to/storage-installation.md); existing `@mayura/storage` imports remain a both-adapter compatibility option. Docker is used only for integration testing/deployment profiles that select it.

## Current development slices

- Typed agents and tools, bounded process-local tool DAGs with exact predecessor-output references, and [required child agents](docs/how-to/agent-orchestration.md) with shared authority, budgets and cancellation.
- [Workflow-as-tool composition](docs/how-to/workflow-composition.md) for explicit approval-free ephemeral graphs, without installing database drivers.
- Optional SQL-backed workflows, approvals, signals, memory/context foundations and a [standalone leased job ledger](docs/specs/leased-scheduler.md). Explicit [scheduled workflows](docs/scheduled-workflows.md) couple claims, approvals, fixed costs and workflow transitions atomically.
- [Durable completion waits](docs/how-to/execution-completion-waits.md) over existing scheduled workflows, without keeping a worker or callback alive while waiting.
- [Versioned workflow graph waits](docs/how-to/workflow-graph-waits.md) with immutable existing-run targets, explicit resumption and metadata-only results before downstream tools or approvals.
- [Finite graph discovery](docs/how-to/workflow-graph-discovery.md) for finding unfinished persisted graphs after restart, with bounded examined-owner pages and explicit application-owned continuation.
- [Registered graph continuation](docs/how-to/workflow-graph-coordinator.md) through one shared driver, with finite pages, exact per-definition resource plans and safe partial-page retry reports.
- [Durable shared budgets](docs/how-to/durable-budgets.md) for trusted hosts, with atomic financial/call reservations, unknown-cost retention and committed overrun evidence. Existing workflows are not automatically enrolled.
- Local processors and [metered auxiliary guardrails](docs/specs/auxiliary-guardrails.md), including explicit moderation and protected-segment language processing.
- [Required lifecycle hooks](docs/how-to/lifecycle-hooks.md) with immutable proposals, mediated read/pure-tool actions, shared limits and output withholding.
- An authenticated Fetch API, browser-safe client and optional [loopback-only Hono/Node host](docs/how-to/local-server.md). This is not production or durable multi-host serving.
- Authenticated, revision-bound [workflow signal delivery](docs/specs/workflow-signal-transport.md) across server, browser client and Node CLI, with application-owned durable journaling.
- Optional [native metadata observability](docs/specs/native-observability.md) with bounded history, explicit gaps and isolated sinks, plus a separate experimental [OTLP/HTTP JSON log exporter](docs/specs/otlp-http-json-logs.md); neither is mandatory durable audit.
- Optional [local artifact storage](docs/specs/local-artifacts.md) with scoped content addressing, staged promotion, integrity-checked reads, bounded attachment disclosure and staging cleanup.

The retained verification history includes a clean 2,525-test two-process checkpoint with PostgreSQL and live Docker, later focused slices, packed-consumer profiles, cross-platform base installation checks and exact V01–V22 evidence. Passing those finite gates does not qualify untested production environments; see the [status ledger](docs/development-status.md) and [closure ledger](docs/release-gate-closure.md).

## Documentation

Start with the [quickstart](docs/quickstart.md), [documentation index](docs/README.md), and [architecture](docs/adr/0001-foundation.md).

Mayura is open source under Apache-2.0. Workspace manifests remain private as a publication safety control; the controlled release process creates reviewed public artifacts only after registry/repository ownership and provenance are verified.
