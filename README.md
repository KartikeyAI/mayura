# Mayura

An independent TypeScript framework for building agents, typed tools and durable workflows.

**Development preview — not enterprise-qualified.** No package is published. Public API, license and supported platforms are not yet stable. See [development status](docs/development-status.md) for tested capabilities and remaining release gates.

## Developing this checkout

Use Node.js 24.14.1 and pnpm 10.17.1 for the currently qualified local environment. Consumer applications will not need this workspace build system.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm example
```

The basic SDK requires no Docker, native database, server or hosted account. [Select SQLite or PostgreSQL explicitly](docs/how-to/storage-installation.md); existing `@mayura/storage` imports remain a both-adapter compatibility option. Docker is used only for integration testing/deployment profiles that select it.

## Current development slices

- Typed agents and tools, bounded parallel tool batches, and [required child agents](docs/how-to/agent-orchestration.md) with shared authority, budgets and cancellation.
- [Workflow-as-tool composition](docs/how-to/workflow-composition.md) for explicit approval-free ephemeral graphs, without installing database drivers.
- Optional SQL-backed workflows, approvals, signals, memory/context foundations and a [standalone leased job ledger](docs/specs/leased-scheduler.md). Explicit [scheduled workflows](docs/scheduled-workflows.md) couple claims, approvals, fixed costs and workflow transitions atomically.
- [Durable completion waits](docs/how-to/execution-completion-waits.md) over existing scheduled workflows, without keeping a worker or callback alive while waiting.
- [Versioned workflow graph waits](docs/how-to/workflow-graph-waits.md) with immutable existing-run targets, explicit resumption and metadata-only results before downstream tools or approvals.
- [Finite graph discovery](docs/how-to/workflow-graph-discovery.md) for finding unfinished persisted graphs after restart, with bounded examined-owner pages and explicit application-owned continuation.
- Local processors and [metered auxiliary guardrails](docs/specs/auxiliary-guardrails.md), including explicit moderation and protected-segment language processing.
- [Required lifecycle hooks](docs/how-to/lifecycle-hooks.md) with immutable proposals, mediated read/pure-tool actions, shared limits and output withholding.
- An authenticated Fetch API, browser-safe client and optional [loopback-only Hono/Node host](docs/how-to/local-server.md). This is not production or durable multi-host serving.
- Optional [native metadata observability](docs/specs/native-observability.md) with bounded history, explicit gaps and isolated sinks; it is not mandatory durable audit.

The integrated local checkpoint passes 2,134 tests with two test processes, strict types, ten credential-free examples and isolated offline base/client/host/workflow/managed-guard-and-hook/completion-wait/graph/selected-SQL installs. This is Windows x64 / Node 24.14.1 evidence, not enterprise qualification; the [status ledger](docs/development-status.md) keeps every full release gate open.

## Documentation

Start with the [quickstart](docs/quickstart.md), [documentation index](docs/README.md), and [architecture](docs/adr/0001-foundation.md).

Mayura's open-source distribution is confirmed. Until the owner selects the exact license and namespace, all workspace packages are private; this checkout is not represented as an already licensed public release.
