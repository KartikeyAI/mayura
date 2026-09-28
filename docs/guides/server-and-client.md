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
(session lookup, JWT verification, a hashed API key) and returns either `null` (401 `AUTH_INVALID`) or an identity:

| Field | Meaning |
| --- | --- |
| `scope` | `{ principalId, projectId }`: who the caller is. Letters, digits, `.`, `_`, `/` and `-`, up to 128 characters each, starting with a letter or digit. |
| `agentIds` | The registered agents this caller may see and run. |
| `capabilities` | What this caller may do (table below). |
| `expiresAtMs` | When this identity stops being valid. Must be in the future. An event stream never outlives it. |

If the callback throws, the request fails with 503 `AUTH_UNAVAILABLE`, and if it takes longer than `requestTimeoutMs`,
with 408 `REQUEST_TIMEOUT`; the error text never reaches the caller. An identity that has expired is 401 `AUTH_EXPIRED`.
An identity Mayura cannot use (an id with other characters, an unknown capability, an extra field) is your
configuration mistake, so it is 500 `IDENTITY_INVALID`, not a bare 401. Identity providers often use subjects such as
`auth0|123` or `user:42`: map them to the allowed characters in your callback, for example with a SHA-256 hex digest of
the subject. Callers cannot choose their scope, agents or permissions: they come only from your callback.

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
| Same request on any replica, with `runRecords` | The same run (200), for as long as the store keeps it. |
| Same request while another replica is still starting it, with `runRecords` | 409 `SUBMISSION_IN_PROGRESS`; retry after `retryAfterMs`. |

Without [run records](#several-server-replicas), runs started over HTTP live in the memory of the server that started
them. A finished run stays readable for `runRetentionMs` (10 minutes by default), and a restart forgets it. Without a
journal, a retry after a restart would start a second run. Pass `submissionJournal: createAggregateSubmissionJournal(store)`
(from `mayura/storage-contracts`) to record every key in storage, so such a retry is refused instead. For work that
must survive restarts, submit a [durable workflow](durable-workflows.md) from your own route instead.

The client never retries anything by itself. Commands on durable workflows use the same idea with a `commandId` and
the run's `revision`: a retried command id never applies twice, and a stale revision gets 409.

## Streaming run events

`run.events()` reads the run's server-sent events stream: one frame per run event, with the event's sequence as the
SSE `id` and its type as the SSE `event`. Events are metadata only: step, model, tool, hook and delegate starts and
completions, the final `run.completed`, and `output.delta` text for agents that stream an output field (see
[Streaming](streaming.md)). Prompts, tool inputs and tool outputs are never in the stream.

One HTTP stream does not last forever: the server ends it after `streamDurationMs` (30 seconds by default) or when the
caller's identity expires, and networks and proxies cut connections. `run.events()` handles this for you. It follows
the run until its `run.completed` event, reconnecting from the last sequence it delivered, so you see every event once
and in order:

```ts
import { createClient } from 'mayura/client';

const client = createClient({ baseUrl: 'https://agents.example.com', token: () => sessionToken() });
const run = client.run(runId);
for await (const event of run.events({ onReconnect: ({ code }) => { if (code) showReconnecting(code); } })) render(event);
// The loop ends after run.completed; read the result now.
```

- Connecting is bounded by `requestTimeoutMs`, but an open stream is not: while the run is quiet the server sends a
  keep-alive comment every `streamHeartbeatMs` (15 seconds), and the client reconnects only when nothing at all
  arrives for `eventIdleTimeoutMs` (45 seconds).
- A stream the server ends normally resumes at once. A failed one (network, timeout, a busy or restarting server, 429,
  502, 503, 504) is retried with backoff from `reconnectDelayMs` (250 ms, doubling up to 10 seconds, or the server's
  `retryAfterMs`), at most `maxReconnectAttempts` (8) times in a row, then `events()` throws the last error.
- A final answer, such as `RUN_NOT_FOUND`, `CAPABILITY_REQUIRED` or a stream that breaks the protocol, is thrown at once.
  An expired identity is retried, because your `token` callback may return a fresh token.
- `onReconnect({ attempt, after, delayMs, code })` is called before each reconnect; `code` is null when the server
  simply ended the stream. Pass `reconnect: false` to read a single connection.

The server keeps the latest 256 events per run (the agent's `limits.maxEventRetention`). A reader that falls further
behind, or reconnects after the server dropped older events, gets one `events.gap` event covering what it missed; read
`run.inspect()` for the current state. In the browser, the [headless run store](react.md) shows this as its
`reconnecting` state.

`run.result(schema)` returns `undefined` while the run is running, then the outcome validated against your schema:
`{ status: 'succeeded', output }` or a failed status with an error `code`. `run.cancel()` requests cancellation.

## Browser origins

A page served from the API's own `publicOrigin` is same-origin and is always allowed. A browser page on another origin
needs its exact origin in `allowedOrigins` (for example `['https://app.example.com']`). The server answers preflights
for `GET` and `POST` with the `Authorization`, `Content-Type` and `Idempotency-Key` headers (others get 403
`PREFLIGHT_DENIED`), exposes `Retry-After` to allowed origins, and refuses any other origin with 403 `ORIGIN_DENIED`.
CORS is not authentication: every call still needs a token.

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

- It answers only requests whose `Host` header matches `publicOrigin` (others get 421 `MISDIRECTED_REQUEST`), so a TLS
  proxy in front must forward the original `Host`. If your proxy rewrites `Host`, list its IP addresses in
  `trustedProxies`: a request from one of them is accepted when its `X-Forwarded-Host` names the public host. That
  header only decides acceptance; the destination is always `publicOrigin`, so no header can redirect a request.
  Probes skip this check, so orchestrators can reach pods directly.
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

By default the request URL's origin must equal `publicOrigin` (otherwise 400 `INVALID_DESTINATION`). Frameworks behind
a reverse proxy often see an internal URL such as `http://app:3000/v1/runs`. When only your proxy or framework can route
requests to this handler, set `mounted: true`: the server then takes `publicOrigin` as the destination and uses only
the request's path and query. It never reads `Host` or `X-Forwarded-*` headers, so a client cannot change the
destination. Keep the handler at the root of the URL space (strip any prefix before calling `fetch`), because the API
paths start at `/v1/`.

```ts
import { createAgentServer } from 'mayura/server';

const api = createAgentServer({ publicOrigin: 'https://agents.example.com', mounted: true, agents, authenticate });
```

`publicOrigin` must be `https://` unless it is a loopback address. Call `close()` on shutdown.

## Several server replicas

Pass `runRecords` to run several server replicas for agent runs. Every replica that shares the store can then read a
run, stream its events, wait for it and cancel it, whichever replica started it:

```ts
import { createAggregateRunRecords } from 'mayura/storage-contracts';
import { createPostgresStore } from 'mayura/storage-postgres';
import { listenProductionServer } from 'mayura/server-node';

const store = createPostgresStore({ connectionString: process.env['DATABASE_URL']! });
await store.initialize();

const server = await listenProductionServer({
  agents, authenticate, publicOrigin: 'https://agents.example.com', hostname: '0.0.0.0', port: 8080,
  tls: { terminatedBy: 'proxy' },
  runRecords: createAggregateRunRecords(store),
});
```

How it works:

- A run executes on the replica that accepted it, which is its owner. The owner records the run's snapshot (status,
  budget, tool receipts), its metadata events and finally its outcome, and renews a lease every third of `runLeaseMs`
  (30 seconds).
- Any other replica answers `GET /v1/runs/:id` and `run.result()` from the record, and streams the recorded events,
  polling every `runRecordPollMs` (500 ms). A cancel sent to any replica is stored as a request that the owner acts on
  within about `runRecordPollMs`.
- Submission keys are claimed in the store, so a retry that reaches another replica gets the same run (200), a
  different payload gets 409 `IDEMPOTENCY_CONFLICT`, and a key another replica is still starting gets 409
  `SUBMISSION_IN_PROGRESS`.
- `202` means the run is recorded. If the record cannot be written, the run is cancelled at once and the request fails
  with 503 `RUN_RECORDS_UNAVAILABLE`.

If a replica dies, its runs stop renewing their leases. Once a lease has lapsed (plus up to 5 seconds of allowance for
clock differences between replicas), the next reader settles the run as `outcome_unknown` with the error code
`OUTCOME_UNKNOWN`, and its event stream ends with a `run.completed` event of that status: tools it started may or may
not have run. A run is never silently lost, and its submission key is never run twice. If the old owner comes back and
finds its run settled, it cancels the run. Keep replica clocks synchronized (NTP).

Records hold the run's snapshot, up to 2,048 content-free metadata events (`maxEvents` option of
`createAggregateRunRecords`; later events are summarized as one `events.gap` before `run.completed`, and streamed
`output.delta` text counts as events) and the outcome, including the run's output. They are kept until you remove
them from the store.

## HTTP API

| Route | Capability |
| --- | --- |
| `GET /v1/session` | Any valid token: its scope, agents, capabilities, expiry and the optional APIs it can use (`client.session()`). |
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

## Errors

Every error is JSON with a stable code and a fixed message that says what happened and what to do. Messages never
contain request data, credentials or the text of an exception. Some errors add machine-readable facts:

```json
{ "error": { "code": "CAPABILITY_REQUIRED", "message": "The access token lacks the capability this request needs (see capability).", "capability": "runs:cancel" } }
```

| Field | Present on | Meaning |
| --- | --- | --- |
| `retryAfterMs` | Codes worth retrying (429s and the `*_UNAVAILABLE` 503s) | Wait at least this long. Also sent as a `Retry-After` header. |
| `capability` | `CAPABILITY_REQUIRED` | The capability the token lacks. |
| `option` | `NOT_ENABLED` | The server option that turns the API on. |
| `limitBytes` | `BODY_TOO_LARGE` | The body size limit. |
| `currentRevision` | `WORKFLOW_CONFLICT` | The run's revision now, when the token has `workflows:read`. |

`MIGRATION_REFUSED` also carries the refusing `plan` next to `error`.

In `mayura/client`, a failed request throws `ClientError` with the server's `code`, the HTTP `status`, the server's
`message`, `retryAfterMs` and these facts in `details`. The client passes through only the codes below (and only a short
printable message); any other error answer, such as a proxy's error page, is `HTTP_ERROR` with its status. Failures
around HTTP have their own codes: `TIMEOUT` (`requestTimeoutMs` passed, or a stream stayed silent), `ABORTED` (your
signal), `TRANSPORT_FAILED` (the network), `REDIRECT_DENIED`, `INVALID_RESPONSE` (a reply of the wrong shape), and for
streams `INVALID_STREAM`, `TRUNCATED_STREAM` and `STREAM_LIMIT`.

```ts
import { ClientError } from 'mayura/client';

try {
  await client.submit('support.assistant', input, { idempotencyKey });
} catch (error) {
  if (error instanceof ClientError && error.code === 'IDEMPOTENCY_CONFLICT') idempotencyKey = crypto.randomUUID();
  else if (error instanceof ClientError && error.retryAfterMs !== undefined) await sleep(error.retryAfterMs);
  else throw error;
}
```

| Code | Status | Meaning | What to do |
| --- | --- | --- | --- |
| `AUTH_REQUIRED` | 401 | No `Authorization: Bearer` header. | Send the token. |
| `AUTH_INVALID` | 401 | Your `authenticate` callback returned `null`. | Get a new token. |
| `AUTH_EXPIRED` | 401 | The identity's `expiresAtMs` has passed. | Get a new token; streams retry with a fresh one. |
| `AUTH_UNAVAILABLE` | 503 | The `authenticate` callback threw or failed. | Retry after `retryAfterMs`. |
| `AUTH_LIMIT` | 429 | Too many token checks in progress (`maxRequests`). | Retry after `retryAfterMs`. |
| `IDENTITY_INVALID` | 500 | The callback returned an identity Mayura cannot use. | Fix the callback (see above). |
| `CAPABILITY_REQUIRED` | 403 | The token lacks `capability`. | Use a token with it. |
| `ORIGIN_DENIED` | 403 | A browser origin not in `allowedOrigins`. | Add the origin. |
| `PREFLIGHT_DENIED` | 403 | A CORS preflight for another method or header. | Use `GET`/`POST` and the three allowed headers. |
| `INVALID_DESTINATION` | 400 | The URL origin is not `publicOrigin`. | Call the public origin, or set `mounted: true`. |
| `INVALID_QUERY` | 400 | An unknown or repeated query parameter. | Send only documented parameters. |
| `INVALID_CURSOR` | 400 | A bad `after` or `limit`. | Use a cursor the server returned; `limit` 1 to 100. |
| `INVALID_JSON` | 400 | The body is not UTF-8 JSON. | Send JSON. |
| `INVALID_REQUEST` | 400 | The body has other fields or types; the message names the expected ones. | Fix the body. |
| `IDEMPOTENCY_KEY_REQUIRED` | 400 | `POST /v1/runs` without a valid `Idempotency-Key`. | Send one key per user action. |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | Not `application/json`, or compressed. | Send plain JSON. |
| `BODY_TOO_LARGE` | 413 | Larger than `maxBodyBytes` (`limitBytes`). | Send less. |
| `ROUTE_NOT_FOUND` | 404 | No such route. | Check the path. |
| `METHOD_NOT_ALLOWED` | 405 | The route does not take this method. | Check the method. |
| `NOT_ENABLED` | 404 | The server does not offer this API (`option`). | Configure that option on the server. |
| `AGENT_NOT_FOUND` | 404 | No such agent for this token. | Check the id and the token's `agentIds`. |
| `RUN_NOT_FOUND` | 404 | No such run for this token: another caller's, released after `runRetentionMs`, or on another replica without `runRecords`. | Check the id; configure `runRecords` for replicas. |
| `HUMAN_REQUEST_NOT_FOUND` | 404 | No such human request for this token. | Check the id. |
| `WORKFLOW_RUN_NOT_FOUND` | 404 | No such workflow run for this token. | Check the id. |
| `MIGRATION_NOT_FOUND` | 404 | That migration is not offered for this run. | List the run's migrations. |
| `REQUEST_TIMEOUT` | 408 | The request took longer than `requestTimeoutMs` or was cancelled; it may have taken effect. | Retry with the same key or command id. |
| `IDEMPOTENCY_CONFLICT` | 409 | The key was used for another agent or input. | Use a new key for a new action. |
| `SUBMISSION_IN_PROGRESS` | 409 | Another replica is starting the run for this key. | Retry with the same key after `retryAfterMs`. |
| `SUBMISSION_OUTCOME_UNKNOWN` | 409 | The key's run can no longer be found (a restart); it may have run. | Check your records before using a new key. |
| `RUN_EXPIRED` | 410 | The key's run finished and was released. | Use a new key to run again. |
| `WORKFLOW_CONFLICT` | 409 | The run changed since you read it, or cannot take this command (`currentRevision`). | Read the run again and decide again. |
| `FLEET_CONFLICT` | 409 | A sweep in the wrong hold state. | Hold before a pause sweep, release before a resume sweep. |
| `MIGRATION_REFUSED` | 409 | The migration has blockers (`plan`). | Resolve them and plan again. |
| `REQUEST_LIMIT` | 429 | `maxRequests` requests in flight. | Retry after `retryAfterMs`. |
| `STREAM_LIMIT` | 429 | `maxStreams` streams open. | Retry after `retryAfterMs`. |
| `RUN_LIMIT` | 429 | `maxRuns` runs held. | Retry after `retryAfterMs`. |
| `RUNTIME_LIMIT` | 429 | `maxRuntimes` scope and agent pairs held. | Retry after `retryAfterMs`. |
| `HUMAN_LIMIT` | 429 | `maxHumanOperations` in flight. | Retry after `retryAfterMs`. |
| `WORKFLOW_LIMIT` | 429 | `maxWorkflowOperations` in flight. | Retry after `retryAfterMs`. |
| `SERVER_CLOSED` | 503 | The server is shutting down. | Retry on another replica. |
| `SERVICE_UNAVAILABLE` | 503 | A dependency failed. | Retry after `retryAfterMs`. |
| `SUBMISSION_JOURNAL_UNAVAILABLE` | 503 | The key could not be recorded; no run started. | Retry with the same key. |
| `RUN_RECORDS_UNAVAILABLE` | 503 | Run records could not be read or written; a refused submission was cancelled. | Retry after `retryAfterMs`. |
| `HUMAN_UNAVAILABLE` | 503 | The human request adapter failed. | Retry after `retryAfterMs`. |
| `HUMAN_TRANSPORT_INVALID` | 503 | The human request adapter returned invalid data. | Fix the server's adapter. |
| `WORKFLOW_UNAVAILABLE` | 503 | The workflow adapter failed. | Retry after `retryAfterMs`. |
| `WORKFLOW_TRANSPORT_INVALID` | 503 | The workflow adapter returned invalid data. | Fix the server's adapter. |
| `RESPONSE_TOO_LARGE` | 500 | The answer exceeds `maxResponseBytes`. | Raise the limit or return less. |
| `INTERNAL_ERROR` | 500 | An unexpected server failure; it may have taken effect. | Retry with the same key or command id. |
| `OBSERVATION_FAILED` | stream | A `stream.error` event: the events cannot be followed from that position. | Read the run, then reconnect from a sequence it sent. |
| `HOST_UNAVAILABLE` | 503 | `mayura/server-node` is starting or stopping. | Retry, on another replica if possible. |
| `MISDIRECTED_REQUEST` | 421 | `listenProductionServer` got another `Host`. | Forward the public `Host`, or set `trustedProxies`. |

`RUN_RECORDS_UNAVAILABLE` can also arrive as a `stream.error` event on a stream served from run records; the client
reconnects after it.

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
| `streamHeartbeatMs` | 15 s | `runLeaseMs` (with `runRecords`) | 30 s |
| `runRecordPollMs` (with `runRecords`) | 500 ms | | |

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

- Without `runRecords`, runs submitted over HTTP are in memory: they survive neither a restart nor a move to another
  replica. With it, every replica can answer for them, but a run still executes only on the replica that started it;
  for work that must continue after that replica dies, use durable workflows.
- The client never retries a command by itself; only `events()` reconnects, because reading is safe to repeat.
- The server does not serve static files, WebSockets or a login flow. Serve your web app from your own host or proxy.

## Related

- [React and UI bindings](react.md)
- [Operator console](operator-console.md)
- [Deployment](deployment.md)
- [Workflow operations](workflow-operations.md)
- [CLI: serve, worker and migrate](../cli/run.md)
