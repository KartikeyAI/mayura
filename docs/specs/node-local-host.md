# Local Node host adapter

Status: implemented experimental loopback-only adapter, verified with 20 real socket tests. See [HTTP protocol](http-agent-transport.md).

`listenAgentServer({ agents, authenticate, allowedOrigins?, limits?, hostname?, port?, shutdownGraceMs? })` starts the same authenticated Fetch server using Hono and its Node adapter. The address defaults to `127.0.0.1` and an OS-assigned port. Only literal `127.0.0.1` and `::1` are accepted; DNS names and public/wildcard binds are rejected. The returned `origin` is derived from the actual bound socket, not request headers, forwarded headers or caller-provided metadata.

Hono 4.13.9 and `@hono/node-server` 2.1.1 are exact optional-package dependencies (registry versions checked during this slice). The base SDK and browser client do not install them. No static-file, proxy, WebSocket or arbitrary route facility is exposed. The adapter does not alter global Request/Response constructors. See the upstream [Node adapter](https://github.com/honojs/node-server) and [Hono Node guide](https://hono.dev/docs/getting-started/nodejs).

The host sets explicit header/request/keepalive/socket limits, rejects upgrades, and delegates every ordinary request to the authenticated protocol. Shutdown stops new admissions, closes observations, requests runtime cancellation, and ends remaining HTTP connections after a bounded grace interval; it cannot kill trusted JavaScript callbacks or retract external effects. Raw handler/adapter errors are never sent to clients.

Real loopback-socket tests exercise authentication, run submission/result, SSE, host/origin rejection, oversized bodies/headers, hanging authentication, bind conflicts and bounded shutdown, including half-open peers after a rejected upgrade. No public port, remote deployment, paid model or production TLS qualification is involved. This implements a local developer host, not the durable multi-user server release gate.
