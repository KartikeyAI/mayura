---
title: "Run Mayura on Cloudflare Workers"
description: "Serve agents from a Cloudflare Worker with runs that finish inside their request, workflows advanced by a Cron Trigger, and storage in D1 or PostgreSQL."
date: 2026-10-12
tags: Cloudflare Workers, D1, edge, deployment
---

*Cloudflare details checked against Cloudflare's Workers, D1 and Hyperdrive documentation on October 12, 2026. Mayura's
makers wrote this guide.*

A Cloudflare Worker starts an isolate for a request, gives it the bindings you configured, and may stop it once the
response is sent. Mayura 1.1 runs there with three changes from a long-running server: runs finish inside their request,
durable workflows are advanced by a Cron Trigger, and storage is opened through a binding for each invocation.

This guide builds that setup with D1 as the store, then shows the PostgreSQL alternative through Hyperdrive. Before you
start, know where it stands:

| | Status in Mayura 1.1 |
|---|---|
| Mayura on workerd, the Workers runtime | Tested in CI without `nodejs_compat`: an agent run with a tool, the server's handler and a durable workflow give the same results as on Node |
| A deployed Worker | **Experimental.** The same code as CI's workerd, but not yet run as a deployment; the setup may change in any release |
| `@mayurajs/storage-d1` | Passes every storage, memory and workflow conformance suite on its own D1 code, and races writers on Cloudflare's D1 in Miniflare; its live check has not yet passed against a real account |
| PostgreSQL through Hyperdrive | Experimental and untested: `pg` needs `nodejs_compat`, which CI's workerd run does not use |

If you need a supported target today, run the same agents on [Vercel](vercel.md) or in containers; see
[Deployment](../../../docs/guides/deployment.md#choose-a-target).

## How Mayura runs on a Worker

A long-running Mayura server keeps working after it answers: runs continue in the process that accepted them, and a
separate worker process advances workflows. A Worker can't do either, so both move:

- **Runs finish inside their request.** With `runExecution: 'request'`, `POST /v1/runs` answers `202` only after the run
  has finished and its outcome is stored, so the next request, on any isolate, can read it. See
  [Request-bound runs](../../../docs/guides/server-and-client.md#request-bound-runs).
- **Workflows advance on a schedule.** A Cron Trigger calls `worker.runOnce({ budgetMs })` every minute, which advances
  every workflow that is due and returns. See [Run once](../../../docs/cli/run.md#run-once).
- **Storage is opened per invocation.** Workers don't let one request use I/O objects created in another, and
  bindings arrive with each invocation. So each request and each cron run opens the store from `env` and initializes
  it: on D1 that is one batch that creates Mayura's table if it is missing.

Nothing is lost when an invocation is cut off. A run whose request dies ends as `outcome_unknown` once its lease lapses,
and a workflow step that was running is settled as unknown by a later sweep after its deadline. Neither is run twice.

## 1. Install and create the database

```bash
npm install mayura @mayurajs/storage-d1
npm install --save-dev wrangler
npx wrangler d1 create mayura
```

`wrangler d1 create` prints the database's id. `@mayurajs/storage-d1` has no driver and no dependencies: it calls the
D1 binding your Worker receives, so the binding is the only credential.

## 2. Configure the Worker

The Worker's configuration, `wrangler.toml`, names the entry point, the D1 binding and a Cron Trigger every minute:

```toml
name = "agents"
main = "src/worker.ts"
compatibility_date = "2026-09-15"

[vars]
PUBLIC_ORIGIN = "https://agents.example.com"
OPENAI_MODEL = "gpt-6-luna"

[[d1_databases]]
binding = "DB"
database_name = "mayura"
database_id = "<your database id>"

[triggers]
crons = ["* * * * *"]
```

Store the model key as a secret, never in `[vars]`:

```bash
npx wrangler secret put OPENAI_API_KEY
```

There is no `nodejs_compat` flag here, and there is no need for one: everything this guide uses from Mayura runs
without it, which is how CI tests it. Without it there is also no `process.env`, so configuration comes from the `env`
your handlers receive. Mayura itself never reads the environment; you pass every value in.

## 3. Put Mayura in one module

```ts
// src/mayura.ts
import { defineAgent, z } from 'mayura';
import { createKeyManager, keyAuthenticator } from 'mayura/keys';
import { openAIResponses } from 'mayura/provider-openai';
import { createAgentServer } from 'mayura/server';
import { createAggregateRunRecords } from 'mayura/storage-contracts';
import { createWorkflowLeadership, createWorkflowWorker } from 'mayura/workflows';
import { createWorkflowLifecycleHost } from 'mayura/workflows/lifecycle';
import { createD1Store, type D1Database } from '@mayurajs/storage-d1';

export interface Env {
  readonly DB: D1Database;
  readonly PUBLIC_ORIGIN: string;
  readonly OPENAI_MODEL: string;
  readonly OPENAI_API_KEY: string;
}

// Definitions are plain values, so one set per isolate is fine. Storage is opened per invocation below.
let registered: ReturnType<typeof register> | undefined;
function register(env: Env) {
  const assistant = defineAgent({
    id: 'support.assistant', version: '1',
    instructions: 'Answer the customer in at most three sentences.',
    model: openAIResponses({
      apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL, maxCostMicros: 20_000,
      pricing: { inputMicrosPerMillionTokens: 400_000, outputMicrosPerMillionTokens: 1_600_000 },
    }),
    tools: [], input: z.object({ message: z.string() }), output: z.object({ reply: z.string() }),
  });
  return [{ agent: assistant, permissions: { allow: ['model:openai.responses'] }, limits: { maxCostMicros: 100_000, maxDurationMs: 60_000 } }];
}

async function open(env: Env) {
  const store = createD1Store({ database: env.DB });
  await store.initialize();
  return store;
}

/** Answer one request to Mayura's API. */
export async function handle(request: Request, env: Env): Promise<Response> {
  const store = await open(env);
  const api = createAgentServer({
    publicOrigin: env.PUBLIC_ORIGIN, mounted: true,
    agents: (registered ??= register(env)),
    // API keys issued with createKeyManager live in the same D1 database.
    authenticate: keyAuthenticator(createKeyManager({ store, prefix: 'agents' })),
    runRecords: createAggregateRunRecords(store),
    runExecution: 'request',
  });
  return api.fetch(request);
}

/** Advance every workflow that is due, then return: for the Cron Trigger. */
export async function advanceWorkflows(budgetMs: number, env: Env) {
  const store = await open(env);
  const host = createWorkflowLifecycleHost({ store, scope, definitions, permissions, policyVersion: '1', maxCostMicros });
  const leadership = createWorkflowLeadership({ store, scope, role: 'workflows', holderId: crypto.randomUUID() });
  return createWorkflowWorker({ units: [host], leadership }).runOnce({ budgetMs });
}
```

`scope`, `definitions`, `permissions` and `maxCostMicros` belong to your workflows: the principal and project they run
under, every workflow definition version that still has runs, what their steps may do and what they may spend. The
[refund approval guide](../guides/refund-approval.md) builds one end to end.

Callers present API keys that you issue with `keys.create()` from an admin route or tool of your own, each carrying
the agents and capabilities it grants; see [API keys](../../../docs/guides/authentication.md#api-keys). Any other
`authenticate` callback works the same way, such as one of the
[identity provider packages](../../../docs/guides/authentication.md#identity-provider-packages).

## 4. Add the Worker's entry point

```ts
// src/worker.ts
import { advanceWorkflows, handle, type Env } from './mayura.js';

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
  scheduled: (_controller: unknown, env: Env, context: { waitUntil(work: Promise<unknown>): void }) => {
    context.waitUntil(advanceWorkflows(20_000, env));
  },
};
```

The scheduled handler hands the sweep to `waitUntil`, so the invocation lives until it settles. Keep the `context`
object whole: calling a destructured `waitUntil` fails in the Workers runtime.

The two exports, `handle(request, env)` and `advanceWorkflows(budgetMs, env)`, are the shape
[`@mayurajs/deploy-cloudflare`](../../../docs/integrations/deploy-cloudflare.md) expects. If you deploy with
`mayura deploy`, its Workers form writes an entry point like this one (as `wrangler.jsonc`, with `nodejs_compat` on)
and runs `wrangler deploy` for you. That package hasn't deployed to a real account yet either.

## 5. Try it locally, then deploy

```bash
npx wrangler dev
curl "http://localhost:8787/cdn-cgi/local/scheduled"
```

`wrangler dev` runs the Worker in workerd on your machine, with a local D1 database. The second command fires the
scheduled handler once, so you can watch a workflow sweep without waiting for the minute. When it works:

```bash
npx wrangler d1 execute mayura --remote --command "SELECT 1"
npx wrangler deploy
```

The first command checks that wrangler can reach the remote database. A newly deployed Cron Trigger can take several
minutes to start firing, so give the first sweep time before you conclude something is wrong.

There is no separate migration step on D1 today. `initialize()` creates the one table the store needs when it is
missing, and version 1 is the baseline for Mayura 1.x. A future release that changes the layout ships an
explicit migration, which you'll run as its own step before the new Worker serves traffic; see
[Migrations](../../../docs/guides/storage.md#migrations).

## Size the time limits

A Worker has no wall-clock limit on an HTTP request while the client stays connected, but it does limit CPU time: 30
seconds by default on the Workers Paid plan (up to 5 minutes with `limits.cpu_ms`), and 10 ms on the Free plan. Time
spent waiting on a model or on D1 doesn't count. We haven't measured how much CPU a Mayura run uses on a deployed
Worker, so watch the CPU time in your Worker's metrics before you rely on the Free plan.

- **Requests.** A submission waits up to the agent's `limits.maxDurationMs` plus the server's `requestTimeoutMs`.
  Clients should wait at least that long; with `mayura/client`, set its `requestTimeoutMs` above it.
- **Client disconnects.** When the client goes away, Cloudflare may cancel the request's work. A run cut off this way
  ends as `outcome_unknown` after its 30-second lease, never half-finished and silent. A retry with the same
  idempotency key finds the recorded run instead of starting a second one.
- **Cron sweeps.** A Cron Trigger may run for 15 minutes of wall time, with 30 seconds of CPU for schedules more
  frequent than hourly. `runOnce({ budgetMs })` stops starting new work when its budget is spent, but a step already
  running still finishes, so keep the budget below the limit by at least your longest tool's `timeoutMs`. 20 seconds
  leaves plenty of room.
- **Long work.** Anything that must outlast one request belongs in a [durable workflow](../../../docs/guides/durable-workflows.md):
  its steps run in cron sweeps, and timers and approvals wait in D1 between them.

## What to know about D1

D1 has no interactive transactions: it commits a `batch()` of statements as one SQLite transaction. The store runs
Mayura's state machines as optimistic transactions over it. A transaction reads with plain queries, holds its writes,
then commits one batch that first checks the version of every document it read or locked and fails as a whole if any
changed. A failed check runs the transaction again with fresh reads for up to 30 seconds (`retryForMs`). Two writers of
one record never both succeed.

That has practical consequences:

- **Every call is a round trip**, and a transaction makes several. Place the Worker near its database: Cloudflare's
  [Placement](https://developers.cloudflare.com/workers/configuration/placement/) runs it close to the services it
  calls.
- **Contention on one record means retries, not waiting.** Different records never contend, so a busy fleet of
  independent runs is fine; thousands of writers hammering one record are not.
- **Leases use D1's clock**, measured again every second, so every isolate agrees when a lease ends.
- **Memory search scans a scope's term index** and ranks it in the Worker, so it grows with the records in that scope.

See [D1 storage](../../../docs/integrations/storage-d1.md) for the options and errors, and
[D1 and DynamoDB](../../../docs/guides/storage.md#d1-and-dynamodb) for how the optimistic transactions work.

## PostgreSQL instead of D1

If your data already lives in PostgreSQL, or several platforms share one database, connect through
[Hyperdrive](https://developers.cloudflare.com/hyperdrive/), Cloudflare's connection pooler for Workers. Mayura's
`mayura/storage-postgres` opens its own `pg` pool from a connection string; on a Worker, use
`mayura/storage-postgres/driver` instead, which runs the same store on a pool you create:

```ts
import { Pool } from 'pg';
import { createPostgresStore } from 'mayura/storage-postgres/driver';

export async function openPostgres(env: { readonly HYPERDRIVE: { readonly connectionString: string } }) {
  // One small pool per invocation: Hyperdrive keeps the real connections to the database.
  const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
  const store = createPostgresStore({ driver: pool, schema: 'mayura' });
  await store.initialize();
  return store;
}
```

Use it in place of `open` in the module above. Three things change:

- **Turn on `nodejs_compat`.** `pg` needs it. Add `compatibility_flags = ["nodejs_compat"]` and a `[[hyperdrive]]`
  binding to `wrangler.toml`.
- **Turn off Hyperdrive's query cache.** By default Hyperdrive caches read queries and doesn't invalidate them when you
  write. Mayura reads a record right after another isolate changes it, so create the configuration with
  `npx wrangler hyperdrive create mayura --connection-string="..." --caching-disabled`.
- **Run migrations from your pipeline.** With PostgreSQL, run `mayura migrate` from CI against the direct connection
  before you deploy a release, as on any other target.

Hyperdrive pools in transaction mode and resets session settings between transactions. Mayura fits that: each
operation is one transaction, its timeouts are `SET LOCAL`, and the lock `initialize()` takes is transaction-scoped.
This combination hasn't been tested yet, on workerd or deployed.

## Good to know

- **Secrets stay in Cloudflare.** Set them with `wrangler secret put`; they arrive in `env` like vars. Mayura reads no
  credentials, so nothing leaks in from a developer's shell.
- **Callers need a token.** The server refuses any request `authenticate` doesn't accept, including requests without
  an `authorization` header.
- **Keep every workflow definition version registered** in `definitions` until its runs finish: the cron sweep can only
  advance runs whose definitions it knows.
- **One database per environment.** Bind a separate D1 database to each wrangler environment, so a preview never
  advances production workflows.

## Next steps

- [Deployment: edge runtimes](../../../docs/guides/deployment.md#edge-runtimes): what is tested where.
- [Deploy Mayura on Vercel](vercel.md): the same module shape on Vercel Functions, measured on a real deployment.
- [Never twice](../research/side-effects-never-twice.md): why a step cut off mid-effect is settled as unknown, not
  repeated.
