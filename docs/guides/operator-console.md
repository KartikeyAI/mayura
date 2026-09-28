---
title: "Operator console"
description: "A built-in web console for operators: health, agents and tools, workflow runs, approvals, human requests, fleet control and migrations."
---

The operator console is a web page that the Mayura server can serve at `/inspector`. Operators open it in a browser,
paste an access token, and can then see and steer what the server exposes: its health, agents and tools, durable
workflow runs, pending approvals and human requests, the fleet hold, and workflow migrations.

The console is not a separate service. It is a static page built into `mayura/server` that calls the same
authenticated HTTP API your clients use, so it can only see and do what the operator's token allows. It is off by
default.

## Turn it on

Pass `inspector: true` to the server. It works the same with `listenAgentServer`, `listenProductionServer` and
`createAgentServer`:

```ts
import { listenAgentServer } from 'mayura/server-node';
import { createWorkflowCommandJournal, createWorkflowOperatorTransports, lifecycleOperatorTarget } from 'mayura/workflows';

// Optional: let the console list and steer durable workflow runs in this scope.
const operator = createWorkflowOperatorTransports({
  store,
  scope,
  journal: createWorkflowCommandJournal({ store, scope }),
  fleet,
  targets: [lifecycleOperatorTarget({ runtime, store, scope, definitions })],
});

const server = await listenAgentServer({
  inspector: true,
  agents,
  authenticate,
  ...operator,
});
console.log(`${server.origin}/inspector`);
```

Open the printed URL, paste a token that your `authenticate` callback accepts, and choose **Connect**. Any accepted
token connects: the console reads what the token may do (`GET /v1/session`) and lists only the views it can use, so a
token with just `workflows:read` sees the workflow views and nothing else. Buttons for commands the token may not send
are not shown.

To try it without writing anything, run the demo from a clone of the Mayura repository. It starts a server with a
SQLite workflow fleet, fleet control and a reviewed migration, and prints the URL and a one-time token:

```bash
node examples/inspector.mjs
```

The demo is [examples/inspector.mjs](https://github.com/KartikeyAI/mayura/blob/main/examples/inspector.mjs).
Every starter project also enables the console.

## What it shows

| View | Shows | Actions | Capabilities |
| --- | --- | --- | --- |
| Overview | Readiness checks, agents, and tools with their effects and required capabilities | None | `operations:read` or `runs:read` |
| Workflows | Active runs, or finished runs and runs whose outcome is unknown; each run's step graph and pending approvals with the exact tool call | Pause, resume, cancel, approve | `workflows:read`, `workflows:control` |
| Human requests | Requests waiting for a person | Answer with a JSON value | `humans:read`, `humans:respond` |
| Fleet control | Whether the fleet is held | Hold, release, pause and resume sweeps | `workflows:read`, `workflows:fleet` |
| Migrations | Migrations offered for a run, and a dry-run plan of each | Apply a migration to a paused run | `workflows:read`, `workflows:migrate` |
| Agent runs | One run's status, budget and live event stream, looked up by run id | Cancel | `runs:read`, `runs:cancel` |

A view is listed only when the server has the matching option. Workflow views need the operator transports shown above
(see [Workflow operations](workflow-operations.md)), and human requests need a `humanRequests` transport (see
[Approvals and human input](approvals-and-human-input.md)). A token that fits no view gets a message saying so.
Errors show the server's message and code, for example `WORKFLOW_CONFLICT`.

Every command asks for confirmation first. It is sent with the run's current revision and a fresh command id, so if
the run changed since the page loaded (another operator acted, or a worker moved it on), the server answers with a
conflict instead of acting on stale state.

Like every API caller, the console sees only its own scope. The Agent runs view finds runs submitted under the
operator's scope: while the server holds them in memory (10 minutes after they finish, by default), or on any replica
when the server has [run records](server-and-client.md#several-server-replicas). Its event stream reconnects by itself
until the run completes. It cannot read other users' runs, for example a customer's chat.

## Access control

The console has no users or roles of its own. Access comes entirely from the identity your `authenticate` callback
returns for the pasted token. Give operators their own tokens, separate from your app's users, with only the
capabilities they need. The starters do it like this: the configuration holds only SHA-256 digests of operator tokens,
and every operator identity lasts one minute, so the console re-sends the token with each request.

```ts
import { createHash, timingSafeEqual } from 'node:crypto';
import type { ServerIdentity } from 'mayura/server-node';

const operatorDigests = (process.env.MAYURA_OPERATOR_TOKEN_SHA256 ?? '').split(',').filter(Boolean);

export async function authenticate({ token }: { readonly token: string }): Promise<ServerIdentity | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const supplied = createHash('sha256').update(token).digest();
  let matched = false;
  for (const digest of operatorDigests) matched = timingSafeEqual(supplied, Buffer.from(digest, 'hex')) || matched;
  if (!matched) return null;
  return {
    scope: { principalId: 'ops', projectId: 'orders' },
    agentIds: ['orders.assistant'],
    capabilities: ['runs:read', 'operations:read', 'workflows:read', 'workflows:control'],
    expiresAtMs: Date.now() + 60_000,
  };
}
```

Listing several digests lets you rotate a token without downtime. Grant `workflows:fleet` and `workflows:migrate`
only to the few people who should stop every worker or change running workflows.

## How it stays safe

- The page and its script and style files contain no data. They are served only for `GET /inspector`,
  `/inspector/app.js` and `/inspector/app.css` without a query string.
- The token stays in the page's memory. It is never written to storage, cookies or the URL, and **Forget token**
  clears it. Reloading the page signs out.
- Every value is rendered as text. Responses carry a strict Content Security Policy (same-origin scripts only, no
  framing), `no-store` caching, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`.
- The page calls the API from the server's own origin, which the server always accepts. Other browser origins still
  need `allowedOrigins`.

In production, serve the console from the same HTTPS origin as the API, behind `listenProductionServer`. If you do not
want it on a public endpoint, leave `inspector` off there and run a separate internal server with it on, pointed at
the same storage.

## Good to know

- The console reads and steers; it does not edit agents, tools or workflow definitions, and it keeps no history of its
  own. What it shows comes from your server and storage at the moment you look.
- Human request answers are typed as raw JSON. For people outside your operations team, build a form with
  [React and UI bindings](react.md) instead.
- The same actions are available from the CLI (see [CLI operations](../cli/operations.md)) and from `mayura/client`.

## Related

- [Server and client](server-and-client.md)
- [Workflow operations](workflow-operations.md)
- [Approvals and human input](approvals-and-human-input.md)
- [Deployment](deployment.md)
