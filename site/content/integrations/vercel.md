---
title: "Deploy Mayura on Vercel"
description: "Run agents and durable workflows on Vercel Functions with Neon PostgreSQL: request-bound runs, workflows advanced by cron, and what we measured on a real deployment."
date: 2026-09-29
tags: Vercel, serverless, PostgreSQL, deployment
---

Vercel Functions start an instance for a request and may freeze or stop it as soon as the response is sent. That
suits Mayura once three things are set up: runs finish inside their request, durable workflows are advanced by
short scheduled invocations, and every instance connects to PostgreSQL through a pooled connection.

This guide walks through that setup and ends with what happened when we ran it on a real Vercel deployment, including
a function stopped by its time limit in the middle of a payment step.

| | Status in Mayura 1.0 |
|---|---|
| Vercel Functions (Node.js runtime) | Supported and tested on Vercel |
| Vercel Cron and Next.js route files | Experimental: same code path, not yet run on Vercel |
| Edge Functions | Planned for Mayura 1.1 |

## How Mayura runs on a function

A long-running server keeps working after it answers: agent runs continue in the process that accepted them, and a
worker process advances workflows. A function can't do either, so Mayura switches both off:

- **Runs finish inside their request.** With `runExecution: 'request'`, `POST /v1/runs` answers `202` only after the
  run has finished and its outcome is stored, so any instance can read it afterwards. See
  [Request-bound runs](../../../docs/guides/server-and-client.md#request-bound-runs).
- **Workflows advance on a schedule.** A cron invocation calls `worker.runOnce({ budgetMs })`, which advances every
  workflow that is due and returns. See [Run once](../../../docs/cli/run.md#run-once).
- **Nothing is lost when an instance dies.** A step that was running when its function was stopped is found by a later
  invocation once its deadline has passed, and settled as unknown (or blocked, if its receipt shows it finished). It
  is never run a second time.

## 1. Create the database

In your Vercel project, add a PostgreSQL database from the Marketplace (we used Neon). Vercel adds its connection
strings to the project's environment. Use the **pooled** one as `DATABASE_URL`: every function instance opens its own
connections, and the provider's pooler keeps the total within the database's limit.

Mayura keeps no session state between transactions, so it works with transaction-mode poolers. Give each instance a
single connection with `pool: { max: 1 }` (see [Storage](../../../docs/guides/storage.md#postgresql)).

## 2. Put Mayura in one module

Everything Mayura needs lives in one module. The routes in the next step only call into it.

```ts
// src/mayura.ts
import { createAgentServer } from 'mayura/server';
import { createAggregateRunRecords } from 'mayura/storage-contracts';
import { createPostgresStore } from 'mayura/storage-postgres';
import { createWorkflowLeadership, createWorkflowWorker } from 'mayura/workflows';
import { createWorkflowLifecycleHost } from 'mayura/workflows/lifecycle';

const store = createPostgresStore({ connectionString: process.env['DATABASE_URL']!, pool: { max: 1 } });
const ready = store.initialize();

const api = createAgentServer({
  publicOrigin: 'https://agents.example.com', mounted: true, agents, authenticate,
  runRecords: createAggregateRunRecords(store),
  runExecution: 'request',
});

/** Answer one request to Mayura's API. */
export async function handle(request: Request): Promise<Response> {
  await ready;
  return api.fetch(request);
}

/** Advance every workflow that is due, then return: for the scheduled invocation. */
export async function advanceWorkflows() {
  await ready;
  const host = createWorkflowLifecycleHost({ store, scope, definitions, permissions, policyVersion: '1', maxCostMicros });
  const leadership = createWorkflowLeadership({ store, scope, role: 'workflows', holderId: crypto.randomUUID() });
  return createWorkflowWorker({ units: [host], leadership }).runOnce({ budgetMs: 50_000 });
}
```

`agents`, `authenticate`, `scope`, `definitions`, `permissions` and `maxCostMicros` are your application's: the
agents you serve with their permissions and limits, how you verify callers, and the workflows the worker advances. The
[Deployment guide](../../../docs/guides/deployment.md#serverless-functions) explains each setting.

## 3. Add the routes

In a Next.js app, one catch-all route serves Mayura's API on the Node.js runtime:

```ts
// app/v1/[...path]/route.ts
import { handle } from '@/src/mayura';

export const runtime = 'nodejs';
export const maxDuration = 300; // seconds: above maxDurationMs plus requestTimeoutMs
export const GET = handle;
export const POST = handle;
```

Without Next.js, a plain Vercel Function file such as `api/mayura.js` that exports `GET` and `POST` and calls
`handle` does the same. That is the setup we tested on Vercel.

**Size the time limit.** The function must outlive the longest run it serves: each agent's `limits.maxDurationMs` plus
the server's `requestTimeoutMs`. Work that takes longer than a function can live belongs in a durable workflow.

## 4. Advance workflows with cron

A cron route calls `advanceWorkflows`. Vercel sends your project's `CRON_SECRET` with every cron invocation, so the
route refuses anything else:

```ts
// app/api/advance-workflows/route.ts
import { advanceWorkflows } from '@/src/mayura';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  if (request.headers.get('authorization') !== `Bearer ${process.env['CRON_SECRET']}`) return new Response('Unauthorized', { status: 401 });
  return Response.json(await advanceWorkflows());
}
```

```json
{ "crons": [{ "path": "/api/advance-workflows", "schedule": "* * * * *" }] }
```

The second block is `vercel.json`. How often cron jobs may run depends on your Vercel plan, and Vercel runs them on
production deployments only.

**Size the budget.** `runOnce({ budgetMs })` stops starting new work when the budget is spent, but a step already
running still finishes. Keep the budget below the function's `maxDuration` by at least your longest tool's
`timeoutMs`. Here: 60 s of function time, a 50 s budget, and tools that time out within 10 s.

## 5. Migrate from your pipeline

Functions never change the database schema on their own. Run `mayura migrate` from CI before you release new functions,
so every instance of the new release finds the schema it expects:

```bash
npx mayura migrate --app dist/src/app.js
```

## What we measured on Vercel

We deployed this setup to a protected Vercel preview with a Neon database on its pooled connection. The model was a
stand-in that takes two seconds, so timings show Mayura's overhead around it.

| Check | Result |
|---|---|
| Request-bound runs | `202` in 2.4 to 2.5 s each, and the next request, on any instance, read the run as succeeded |
| Timer workflow | Waiting after the first two invocations, succeeded on the third, 20 s in (timer set 25 s ahead); every invocation took leadership and completed its sweep |
| Function stopped mid-step | The function hit its 10 s limit (`504`) while a charge step was running. The next invocation left the step alone, because a live process could still have been running it. The step's deadline was 90 s after dispatch (its 30 s tool timeout plus a one-minute margin); the first invocation after that, at 95 s, settled it as unknown. It was never run twice |

"Unknown" means Mayura can't know whether the charge went through, so it stops and asks for reconciliation instead of
paying twice. [Never twice](../research/side-effects-never-twice.md) explains how that works.

## Good to know

- **The first deployment of a new Vercel project goes to production.** If it serves test code, protect it or make it
  refuse requests before you deploy.
- **Callers need a token.** Mayura refuses requests that `authenticate` doesn't accept, which includes calls without an
  `authorization` header.
- **Watch for connection limits.** If you see connection errors under load, check that `DATABASE_URL` is the pooled
  string and `pool.max` is `1`.

## Next steps

- [Deployment](../../../docs/guides/deployment.md): every other target, from containers to Kubernetes.
- [Mayura with Next.js](nextjs.md): serve the API from your app and stream runs into React.
- [Durable workflows](../../../docs/guides/durable-workflows.md): timers, approvals and retries.
