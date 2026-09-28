---
title: "Server and client"
description: "Serve agents over authenticated HTTP with mayura/server and mayura/server-node, and call them from browsers or Node with mayura/client."
---

Mayura can put your agents behind an HTTP API so a web app, a mobile backend or another service can start runs, stream
their progress and read the result. Three pieces work together:

- `mayura/server` is the API itself: a Fetch-style handler (`Request` in, `Response` out) with authentication,
  per-caller scopes, idempotent submission and a server-sent events (SSE) stream for each run.
- `mayura/server-node` hosts that handler on a Node.js socket: a loopback server for development, and a production
  server with an HTTPS origin, health probes and graceful shutdown.
- `mayura/client` is a small, browser-safe client for the API. It has no Node imports, so it works in a web bundle.

Use this when something outside your Node process needs to run agents. Inside one process, call the runtime directly.

## A complete example

This serves one agent on `127.0.0.1`, calls it with the client, streams its events and reads the typed result. It runs
offline: the scripted model stands in for a real one.

```ts
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { defineAgent } from 'mayura';
import { createClient } from 'mayura/client';
import { listenAgentServer } from 'mayura/server-node';
import { scriptedModel } from 'mayura/testing';
import { z } from 'zod';

const Answer = z.object({ answer: z.number() });

const agent = defineAgent({
  id: 'demo.answer',
  version: '1',
  instructions: 'Answer the question with a number.',
  input: z.object({ question: z.string() }),
  output: Answer,
  tools: [],
  // A scripted stand-in so this runs offline. Use a real provider in your app.
  model: scriptedModel([{ type: 'final', output: { answer: 42 }, usage: { costMicros: 0 } }]),
});

// Demo credential. In your app, verify your identity provider's tokens here instead.
const secret = randomBytes(32);
const token = secret.toString('hex');

const server = await listenAgentServer({
  agents: [{ agent, permissions: { allow: ['model:scripted'] } }],
  authenticate: async ({ token: supplied }) => {
    const valid = /^[a-f0-9]{64}$/.test(supplied) && timingSafeEqual(Buffer.from(supplied, 'hex'), secret);
    if (!valid) return null;
    return {
      scope: { principalId: 'user-1', projectId: 'demo' },
      agentIds: ['demo.answer'],
      capabilities: ['runs:submit', 'runs:read'],
      expiresAtMs: Date.now() + 60_000,
    };
  },
});

const client = createClient({ baseUrl: server.origin, token: () => token });
const run = await client.submit('demo.answer', { question: 'What is six times seven?' }, { idempotencyKey: 'question-1' });
for await (const event of run.events()) console.log(event.sequence, event.type);
const result = await run.result(Answer);
if (result?.status === 'succeeded') console.log(result.output.answer); // 42
await server.close();
```

Each registered agent carries its own permissions and optional run `limits`. The runtime's default
`limits.maxCostMicros` is 0, so an agent on a paid model needs an explicit cost limit here (see
[Costs and budgets](../concepts/costs-and-budgets.md)).

## Authentication and capabilities

Every API call (except the optional health endpoints) needs an `Authorization: Bearer <token>` header. Mayura does not
parse the token. It calls your `authenticate({ token, signal })` callback, which verifies it however your app does
(session lookup, JWT verification, a hashed API key) and returns either `null` (401) or an identity:

| Field | Meaning |
| --- | --- |
| `scope` | `{ principalId, projectId }`: who the caller is. Letters, digits, `.`, `_`, `/` and `-`, up to 128 characters each. |
| `agentIds` | The registered agents this caller may see and run. |
| `capabilities` | What this caller may do (table below). |
| `expiresAtMs` | When this identity stops being valid. Must be in the future. An event stream never outlives it. |

If the callback throws, the request fails with 503, and if it takes longer than `requestTimeoutMs`, with 408; the
error text never reaches the caller. Callers cannot choose their scope, agents or permissions: they come only from your callback.

| Capability | Allows |
| --- | --- |
| `runs:submit` | Starting runs (`POST /v1/runs`). |
| `runs:read` | Reading runs and their event streams, and listing agents. |
| `runs:cancel` | Cancelling a run. |
| `operations:read` | The health report and the tool catalog. |
| `humans:read`, `humans:respond` | Listing waiting human requests and answering them. |
| `workflows:read` | Listing and viewing durable workflow runs, fleet state and migration plans. |
| `workflows:control` | Cancel, approve, signal, pause and resume a workflow run. |
| `workflows:fleet` | Holding and releasing the whole fleet, and pause and resume sweeps. |
| `workflows:migrate` | Applying a reviewed migration to a paused run. |

Give each kind of caller only what it needs. The support-agent starter, for example, gives customers
`runs:submit` and `runs:read`, and gives operators read and workflow capabilities but not `runs:submit`.

## Scopes keep callers apart

The server keys every run by the caller's scope. A caller can read, stream or cancel only runs submitted under its own
scope; anyone else gets 404, as if the run did not exist. Each scope and agent pair gets its own runtime created with
that scope, so tools see the caller in `context.scope` and can use it to load only that caller's data:

```ts
import { defineTool } from 'mayura';
import { z } from 'zod';

export const listOrders = defineTool({
  id: 'orders.list',
  version: '1',
  description: 'List the signed-in customer\'s orders.',
  input: z.object({}),
  output: z.array(z.object({ id: z.string(), status: z.string() })),
  effects: 'read',
  capabilities: [],
  costMicros: 0,
  execute: async (_input, context) => ordersOf(context.scope.principalId),
});
```

## Starting runs idempotently

`client.submit(agentId, input, { idempotencyKey })` sends the key as an `Idempotency-Key` header, and the header is
required. Generate one key per user action (a UUID works) and reuse it only when retrying that same action:

| Retry with the same key | Server answer |
| --- | --- |
| Same agent and input, run still held | The same run (200), never a second one. |
| Different agent or input | 409 `IDEMPOTENCY_CONFLICT`. |
| Same request after the run was released | 410 `RUN_EXPIRED`. |
| Same request after a restart, with `submissionJournal` | 409 `SUBMISSION_OUTCOME_UNKNOWN`. |

Runs started over HTTP live in the server's memory. A finished run stays readable for `runRetentionMs` (10 minutes by
default), and a restart forgets it. Without a journal, a retry after a restart would start a second run. Pass
`submissionJournal: createAggregateSubmissionJournal(store)` (from `mayura/storage-contracts`) to record every key in
storage, so such a retry is refused instead. For work that must survive restarts, submit a
[durable workflow](durable-workflows.md) from your own route instead.

The client never retries anything by itself. Commands on durable workflows use the same idea with a `commandId` and
the run's `revision`: a retried command id never applies twice, and a stale revision gets 409.

## Streaming run events

`run.events()` reads the run's server-sent events stream: one frame per run event, with the event's sequence as the
SSE `id` and its type as the SSE `event`. Events are metadata only: step, model, tool, hook and delegate starts and
completions, the final `run.completed`, and `output.delta` text for agents that stream an output field (see
[Streaming](streaming.md)). Prompts, tool inputs and tool outputs are never in the stream.

A stream ends when the run finishes, and also when `streamDurationMs` passes (30 seconds by default), when the
identity expires, or when the client's `requestTimeoutMs` (30 seconds) passes. Ending the stream does not stop the run.
Reconnect from the last sequence you saw:

```ts
import { ClientError, type RemoteRun } from 'mayura/client';

async function follow(run: RemoteRun): Promise<void> {
  let after = 0;
  for (;;) {
    try {
      for await (const event of run.events({ after })) { after = event.sequence; render(event); }
    } catch (error) {
      if (!(error instanceof ClientError && error.code === 'ABORTED')) throw error;
    }
    if ((await run.inspect()).status !== 'running') return;
  }
}
```

The server keeps the latest 256 events per run (the agent's `limits.maxEventRetention`). A reader that falls further
behind gets one `events.gap` event covering what it missed; read `run.inspect()` for the current state. In the
browser, the [headless run store](react.md) wraps this loop for you.

`run.result(schema)` returns `undefined` while the run is running, then the outcome validated against your schema:
`{ status: 'succeeded', output }` or a failed status with an error `code`. `run.cancel()` requests cancellation.

## Browser origins

A browser page on another origin needs its exact origin in `allowedOrigins` (for example
`['https://app.example.com']`). The server answers preflights for `GET` and `POST` with the `Authorization`,
`Content-Type` and `Idempotency-Key` headers, and refuses any other origin with 403 `ORIGIN_DENIED`. CORS is not
authentication: every call still needs a token. Browsers also send an `Origin` header on same-origin `POST` requests,
so a page served from the API's own public origin must be listed too, unless the [operator
console](operator-console.md) is enabled (which allows the server's own origin).

The client sends no cookies, follows no redirects and accepts plain `http://` only for `localhost`, `127.0.0.1` and
`[::1]`. The `token` option is a function called before every request, so it can return a refreshed token.

## Hosting on Node

| | `listenAgentServer` | `listenProductionServer` |
| --- | --- | --- |
| Binds | `127.0.0.1` (default) or `::1` only | The `hostname` you give (`0.0.0.0`, `::`, one interface); no default |
| Origin | `http://127.0.0.1:<port>`, from the bound socket | `publicOrigin`, which must be `https://` |
| TLS | None | `tls: { key, cert }` in-process, or `tls: { terminatedBy: 'proxy' }` |
| Probes | None | `GET /livez` and `GET /readyz`, unauthenticated and content-free |
| Shutdown grace | `shutdownGraceMs`, default 5 s | `shutdownGraceMs`, default 30 s |

Use `listenAgentServer` for development and tests (`port` defaults to 0, a free port). It refuses any other address.

`listenProductionServer` is for real deployments:

```ts
import { listenProductionServer } from 'mayura/server-node';

const server = await listenProductionServer({
  agents,
  authenticate,
  publicOrigin: 'https://agents.example.com',
  hostname: '0.0.0.0',
  port: 8080,
  tls: { terminatedBy: 'proxy' },
  readiness: async () => { await store.read('readiness', 'probe'); return true; },
});
```

- It answers only requests whose `Host` header matches `publicOrigin` (others get 421), so a TLS proxy in front must
  forward the original `Host`. Probes skip this check, so orchestrators can reach pods directly.
- `/readyz` calls your `readiness` callback (with a 2-second limit) and fails from the moment shutdown starts.
- Responses carry `Strict-Transport-Security` (`hstsMaxAgeSeconds`, default one year; 0 turns it off).
- `close()` stops accepting, fails readiness, lets in-flight requests finish within the grace period, then closes runs
  and streams. `isAccepting()` reports whether it still takes traffic.
- `maxConnections` defaults to 1,024.

For worker processes that have no HTTP API, `listenProbe({ hostname, port, isLive, isReady })` serves the same
`/livez` and `/readyz` endpoints. `mayura worker --probe-port` uses it for you.

## Mounting the handler yourself

`createAgentServer(options)` from `mayura/server` returns `{ fetch(request), close() }`. Use it to mount the API in an
HTTP framework you already run:

```ts
import { createAgentServer } from 'mayura/server';

const api = createAgentServer({ publicOrigin: 'https://agents.example.com', agents, authenticate });

export async function handle(request: Request): Promise<Response> {
  return api.fetch(request);
}
```

The request URL's origin must equal `publicOrigin` (otherwise 400 `INVALID_DESTINATION`). Behind a proxy, rebuild the
request with the public URL before passing it on. `publicOrigin` must be `https://` unless it is a loopback address.
Call `close()` on shutdown.

## HTTP API

Errors are JSON, `{ "error": { "code": "..." } }`, with no other detail.

| Route | Capability |
| --- | --- |
| `GET /v1/agents` | `runs:read` |
| `POST /v1/runs` | `runs:submit` (body `{ agentId, input }`, `Idempotency-Key` header) |
| `GET /v1/runs/:id`, `GET /v1/runs/:id/events?after=N` | `runs:read` |
| `POST /v1/runs/:id/cancel` | `runs:cancel` |
| `GET /v1/operations/health`, `GET /v1/tools` | `operations:read` |
| `GET /v1/human-requests`, `POST /v1/human-requests/:id/responses` | `humans:read`, `humans:respond` |
| `GET /v1/workflow-runs`, `GET /v1/workflow-runs/:id` | `workflows:read` |
| `POST /v1/workflow-runs/:id/(cancel, approvals, signals, pause, resume)` | `workflows:control` |
| `GET /v1/workflow-fleet`, `POST /v1/workflow-fleet/(hold, release, sweeps/pause, sweeps/resume)` | `workflows:read`, `workflows:fleet` |
| `GET /v1/workflow-runs/:id/migrations`, `GET` and `POST /v1/workflow-runs/:id/migrations/:migrationId` | `workflows:read`, `workflows:migrate` |

The human-request and workflow routes answer 404 until you pass the matching options (`humanRequests`,
`workflowIndex`, `workflowViews`, `workflowControls` and so on). `createWorkflowOperatorTransports` in
`mayura/workflows` builds all the workflow ones; see [Workflow operations](workflow-operations.md).
`healthChecks: [{ id, check }]` adds checks to the health report, and `publicLiveness: true` adds an unauthenticated
`GET /healthz`.

## Operating workflows from a client

The same client lists, views and steers durable workflow runs. `mayura/client/workflows` turns a run view into a
graph with progress counts, and `createWorkflowCommandController` tracks one command at a time for a UI:

```ts
import { createClient } from 'mayura/client';
import { createWorkflowGraphProjection } from 'mayura/client/workflows';

const client = createClient({ baseUrl: 'https://agents.example.com', token: () => operatorToken });

const page = await client.workflows({ limit: 20 });
for (const entry of page.items) {
  const view = await client.workflow(entry.runId);
  const graph = createWorkflowGraphProjection(view);
  console.log(entry.definitionId, entry.status, `${graph.progress.succeeded}/${graph.progress.total}`);
  // Commands name the revision you looked at, and a command id you reuse only to retry this same command.
  if (view.status === 'waiting') await client.pauseWorkflow(view.runId, view.revision, { commandId: crypto.randomUUID() });
}
```

## Server limits

Pass `limits` to cap the server's memory and concurrency. When a limit is reached, requests get 429.

| Limit | Default | Limit | Default |
| --- | --- | --- | --- |
| `maxRuns` | 512 | `maxBodyBytes` | 1 MiB |
| `maxRuntimes` | 128 | `maxResponseBytes` | 4 MiB |
| `maxRequests` | 64 | `requestTimeoutMs` | 10 s |
| `maxStreams` | 64 | `streamDurationMs` | 30 s |
| `maxWorkflowOperations` | 32 | `runRetentionMs` | 10 min |

`maxRuns` counts runs held in memory, finished or not, and `maxRuntimes` counts scope and agent pairs. Under pressure
the server releases finished runs whose result the caller has already read, oldest first. Size these for concurrent
users, not for a day's traffic.

## The application module

`mayura serve`, `mayura worker` and `mayura migrate` load one compiled `.js` or `.mjs` module whose default export
describes your app. Each function is optional; export at least one:

```ts
import { defineMayuraApplication } from 'mayura/cli';

export default defineMayuraApplication({
  // Start the HTTP server, for example with listenProductionServer. Returns { isAccepting(), close() }.
  async server() { return startServer(); },
  // Build the durable worker, for example with createWorkflowWorker. Returns { start(), isReady(), drain() }.
  async worker() { return createWorker(); },
  // Apply storage schema changes before new code serves traffic. Returns a JSON report.
  async migrate() { await store.initialize(); return { schemaVersion: 1 }; },
  // Runs after the server closes or the worker drains.
  async shutdown() { await store.close(); },
});
```

The CLI handles signals and shutdown. [Deployment](deployment.md) walks through a full module.

## Good to know

- Runs submitted over HTTP are in-memory. They survive neither a restart nor a move to another replica, so route a
  caller's reads for a run to the replica that started it, or use durable workflows.
- A `ClientError` has a machine-readable `code` (`HTTP_ERROR`, `ABORTED`, `TRANSPORT_FAILED`, `INVALID_RESPONSE` and
  others) and, for HTTP failures, the `status`. The server's own error code is not passed through.
- The server does not serve static files, WebSockets or a login flow. Serve your web app from your own host or proxy.

## Related

- [React and UI bindings](react.md)
- [Operator console](operator-console.md)
- [Deployment](deployment.md)
- [Workflow operations](workflow-operations.md)
- [CLI: serve, worker and migrate](../cli/run.md)
