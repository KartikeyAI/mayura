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

## Documentation

Start with the [quickstart](docs/quickstart.md), [documentation index](docs/README.md), and [architecture](docs/adr/0001-foundation.md).

Mayura's open-source distribution is confirmed. Until the owner selects the exact license and namespace, all workspace packages are private; this checkout is not represented as an already licensed public release.
