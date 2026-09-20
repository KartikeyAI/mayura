# ADR 0004: qualify the HTTP protocol before the host adapter

Status: accepted for the experimental ephemeral transport slice.

The technical proposal retains Hono with its Node adapter for production self-hosted serving. The first step was a Fetch Request/Response protocol facade over the existing runtime with mandatory authentication, ownership checks, idempotency and bounded observation. This permits deterministic transport/client tests without opening ports or coupling the core to a router.

The next experimental step is now implemented in optional `@mayura/server-node`: Hono 4.13.8 with `@hono/node-server` 2.1.1 hosts that same protocol on literal loopback only. Its origin comes from the bound socket; authentication stays mandatory. Explicit request/header/socket limits, upgrade rejection and bounded connection shutdown are exercised through local socket tests. Neither the base SDK nor the browser client imports these host dependencies, and the adapter does not replace global Request/Response constructors.

This does not replace the Hono recommendation with a custom general-purpose router or establish production serving. No public bind, TLS termination, reverse-proxy defaults, durable shared workers, restart-safe HTTP idempotency or UI layer is introduced. These remain separate qualification requirements; all enterprise gates, including V16, stay open. The local adapter is included in the integrated checkpoint and isolated packed HTTP/SSE fixture recorded in the development-status ledger.

See the [local host contract](../specs/node-local-host.md), official [Hono Node guide](https://hono.dev/docs/getting-started/nodejs), [Node adapter](https://github.com/honojs/node-server) and [Node HTTP server documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/http.html).
