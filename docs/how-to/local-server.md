# Run an authenticated local agent server

The optional `mayura/server-node` package serves Mayura's ephemeral runtime on an explicit loopback socket. `mayura/client` talks to it with Fetch, validated JSON and metadata-only SSE. The base SDK does not install a web server.

## Run the example

From an installed development checkout:

```sh
pnpm build
node examples/local-server.mjs
```

The [complete example](../../examples/local-server.mjs) needs no model account, external credential, database or Docker service. It generates a short-lived random token in memory, binds an OS-assigned `127.0.0.1` port, submits a deterministic fixture, observes its events, validates the result and closes the listener. It does not print the token or leave a server running.

Expected output:

```json
{"output":{"answer":42},"observedEvents":4}
```

The scripted model is a consumable test fixture, not an inference model. Create a fresh fixture/server for another example run. Packages are currently experimental development workspaces; this guide does not imply a published or production-qualified release.

## Host your registered agent

Supply an immutable agent definition, fixed execution grants and a trusted authentication callback:

```ts
import { listenAgentServer } from "mayura/server-node";

const server = await listenAgentServer({
  agents: [{ agent, permissions: { allow: ["model:your-model"] } }],
  authenticate: verifyApplicationToken,
  hostname: "127.0.0.1",
  port: 0,
  shutdownGraceMs: 1_000,
});
// Pass server.origin to your explicit client configuration.
// On application shutdown:
await server.close();
```

`agent` and `verifyApplicationToken` are application-owned values, not built-ins. The verifier receives `{token,signal}` and must return either `null` or a verified `{scope:{principalId,projectId},agentIds,capabilities,expiresAtMs}`. Capabilities are `runs:read`, `runs:submit` and `runs:cancel`. Token claims must not be trusted without verification; clients cannot select scope or execution grants.

The example's single generated token and fixed demo identity are not production authentication. Real identity requires issuer/audience/expiry verification, key rotation or a trusted session store, revocation policy and server-side project/agent authorization. Never replace the verifier with an unconditional successful identity. Never embed server execution credentials in a browser bundle or put credentials in a URL. Short stream windows bound authentication age; immediate mid-stream revocation is not provided by this slice.

Only literal `127.0.0.1` and `::1` binds are accepted. Public/wildcard/DNS binds are rejected. The returned origin comes from the bound socket; forwarded headers do not change authority. There is no proxy, static-file or WebSocket facility, and global Web API constructors are not replaced. For browser development on a separate origin, pass an exact `allowedOrigins` allowlist; CORS does not supply authentication.

## Observe without replaying commands

```ts
import { createClient } from "mayura/client";

const client = createClient({ baseUrl: server.origin, token: getAccessToken });
const run = await client.submit(agent.id, input, { idempotencyKey: requestKey });
for await (const event of run.events({ signal })) {
  // Metadata only. On events.gap, refresh authorized state with run.inspect().
}
const result = await run.result(wireOutputSchema);
```

`getAccessToken`, `requestKey`, `signal`, `input` and `wireOutputSchema` are application-provided. Match the validator to the admitted wire output, including any server-side schema transformation. Stream closure is not proof of run success; `result()` returns `undefined` while execution is still running. Reconnect explicitly with `events({after:lastSequence})` and refresh state after a gap. A client observation abort does not cancel the run; call `run.cancel()` explicitly when cancellation is intended.

Commands never retry automatically. If submission delivery is uncertain, any explicit retry must preserve the original scope, key, agent and input. In this ephemeral server, idempotency evidence disappears on restart. Do not automatically replay effects after restart. Terminal receipt evidence distinguishes known effects from released output; cancellation cannot retract a write or kill arbitrary trusted JavaScript.

## Limits and shutdown

The host bounds HTTP headers, requests, sockets and shutdown grace. The protocol separately bounds run/runtime registries, concurrent authentication, streams and JSON bodies. Registries do not silently evict deduplication history; capacity exhaustion requires an explicit application decision. Always call `close()` from your host lifecycle, including startup/task failures after successful creation.

This is local transport qualification only. Durable serving, shared multi-host state, production TLS/reverse-proxy deployment, approval routes, persistent history and a production identity integration remain outside this adapter. See the [local host contract](../specs/node-local-host.md) and [HTTP transport contract](../specs/http-agent-transport.md).
