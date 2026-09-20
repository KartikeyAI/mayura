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

The basic SDK requires no Docker, native database, server or hosted account. Storage adapters are separate packages. Docker is used only for integration testing/deployment profiles that select it.

## Current development slices

- Typed agents and tools, bounded parallel tool batches, and [required child agents](docs/how-to/agent-orchestration.md) with shared authority, budgets and cancellation.
- [Workflow-as-tool composition](docs/how-to/workflow-composition.md) for explicit approval-free ephemeral graphs, without installing database drivers.
- Optional SQL-backed workflows, approvals, signals, memory/context foundations and a [standalone leased job ledger](docs/specs/leased-scheduler.md). Explicit [scheduled workflows](docs/scheduled-workflows.md) couple claims, approvals, fixed costs and workflow transitions atomically.
- Local processors and [metered auxiliary guardrails](docs/specs/auxiliary-guardrails.md), including explicit moderation and protected-segment language processing.
- An authenticated Fetch API, browser-safe client and optional [loopback-only Hono/Node host](docs/how-to/local-server.md). This is not production or durable multi-host serving.
- Optional [native metadata observability](docs/specs/native-observability.md) with bounded history, explicit gaps and isolated sinks; it is not mandatory durable audit.

The integrated local checkpoint passes 1,367 tests, strict types, and isolated offline base/client/host/workflow/managed-guard installs. This is Windows x64 / Node 24.14.1 evidence, not enterprise qualification; the [status ledger](docs/development-status.md) keeps every full release gate open.

## Documentation

Start with the [quickstart](docs/quickstart.md), [documentation index](docs/README.md), and [architecture](docs/adr/0001-foundation.md).

Mayura's open-source distribution is confirmed. Until the owner selects the exact license and namespace, all workspace packages are private; this checkout is not represented as an already licensed public release.
