---
title: "Cloudflare deploy target"
description: "Deploy a Mayura app to Cloudflare with @mayurajs/deploy-cloudflare: the app in Containers, or the serverless module on Workers."
package: "@mayurajs/deploy-cloudflare"
vendor: "Cloudflare"
logo: "cloudflare"
website: "https://www.cloudflare.com"
area: "deploy"
---

[Cloudflare](https://www.cloudflare.com) runs code on its network as Workers, and containers next to them.
`@mayurajs/deploy-cloudflare` adds `cloudflare` as a target for [`mayura deploy`](../cli/deploy.md), deployed with
`wrangler`, signed in as you, in two forms:

- **Containers** (the default) run your app module as on any container platform: server containers behind a Worker,
  and a worker container kept awake by a cron trigger.
- **Workers** run the serverless module at the edge, with request-bound runs and a cron trigger that advances
  workflows.

The package has no dependencies besides `mayura`. It runs inside the `mayura` CLI on Node.js 22 or 24, on your machine
or in CI. Mayura on deployed Workers is **experimental**: it runs the same code as CI's workerd but has not yet run as a
deployment (see [Edge runtimes](../guides/deployment.md#edge-runtimes)).

## Install

```bash
npm install mayura
npm install --save-dev @mayurajs/deploy-cloudflare wrangler
npm install @cloudflare/containers    # Containers only: the generated Worker imports it
```

`mayura deploy` loads the target from the project's own `node_modules`, so a dev dependency is enough. A release runs
`wrangler`, and for Containers `npm` and `node`, from your `PATH`; Containers also need Docker for `wrangler` to build
the images.

## Credentials

Mayura reads no credentials. `wrangler` uses its own login (`wrangler login`), or `CLOUDFLARE_API_TOKEN` in CI, as in
the repository's `.env.example` (with `CLOUDFLARE_ACCOUNT_ID`). Create a token in your
[Cloudflare profile](https://dash.cloudflare.com/profile/api-tokens) with permission to edit Workers, and Containers if
you use them.

## Use it

### Containers

Your app module is the one the [deployment guide](../guides/deployment.md#the-application-module) describes. Store
`DATABASE_URL` and each name in `env` as Worker secrets:

```json
{
  "format": "mayura.deploy.v1",
  "name": "refunds",
  "env": ["OPENAI_API_KEY", "MAYURA_OPERATOR_TOKEN_SHA256"],
  "targets": { "cloudflare": { "maxInstances": 3 } }
}
```

```bash
wrangler secret put DATABASE_URL        # and each variable in env
mayura deploy init --target cloudflare --apply
mayura deploy --target cloudflare --tag v42                                  # prints the plan and its digest
DATABASE_URL=… mayura deploy --target cloudflare --tag v42 --apply --confirm <digest>
```

### Workers

Set `runtime` to `workers`. Your serverless module, `src/mayura.ts` by default, exports `handle(request, env)` and
`advanceWorkflows(budgetMs, env)`; `env` carries bindings such as D1 or Hyperdrive. Storage initializes itself on
first use, under the schema lock. With D1:

```ts
// src/mayura.ts
import { createAgentServer } from 'mayura/server';
import { createAggregateRunRecords } from 'mayura/storage-contracts';
import { createWorkflowLeadership, createWorkflowWorker } from 'mayura/workflows';
import { createWorkflowLifecycleHost } from 'mayura/workflows/lifecycle';
import { createD1Store, type D1Database } from '@mayurajs/storage-d1';

interface Env { readonly DB: D1Database }

function open(env: Env) {
  const store = createD1Store({ database: env.DB });
  return { store, ready: store.initialize() };
}

/** deploy/cloudflare/worker.ts calls this for every request. */
export async function handle(request: Request, env: Env): Promise<Response> {
  const { store, ready } = open(env);
  await ready;
  const api = createAgentServer({
    publicOrigin: 'https://agents.example.com', mounted: true, agents, authenticate,
    runRecords: createAggregateRunRecords(store),
    runExecution: 'request',
  });
  return api.fetch(request);
}

/** The cron trigger calls this every minute with a 20-second budget. */
export async function advanceWorkflows(budgetMs: number, env: Env) {
  const { store, ready } = open(env);
  await ready;
  const host = createWorkflowLifecycleHost({ store, scope, definitions, permissions, policyVersion: '1', maxCostMicros });
  const leadership = createWorkflowLeadership({ store, scope, role: 'workflows', holderId: crypto.randomUUID() });
  return createWorkflowWorker({ units: [host], leadership }).runOnce({ budgetMs });
}
```

```json
{
  "format": "mayura.deploy.v1",
  "name": "refunds",
  "targets": { "cloudflare": { "runtime": "workers", "name": "refunds-edge" } }
}
```

```bash
mayura deploy init --target cloudflare --apply   # writes wrangler.jsonc and deploy/cloudflare/worker.ts
mayura deploy --target cloudflare --tag v42
mayura deploy --target cloudflare --tag v42 --apply --confirm <digest>
```

Add your D1 binding (here `DB`) to `wrangler.jsonc` before you release.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `runtime` | `containers` | `containers` or `workers`. |
| `name` | the project `name` | The Worker's name: lowercase letters, digits and hyphens. |
| `maxInstances` | 3 | Containers: the most server containers requests are spread across, from 1 to 100. |
| `module` | `src/mayura.ts` | Workers: the serverless module (`.ts`, `.js` or `.mjs`) that `worker.ts` imports. |
| `cron` | `true` | A cron trigger every minute: it advances workflows (Workers) or keeps the worker container awake (Containers). |

Any other key under `targets.cloudflare` is refused.

## Files it writes

**Containers:**

| File | Contents |
| --- | --- |
| `Dockerfile`, `.dockerignore` | The server's image, with the `mayura` CLI as its entry point. |
| `deploy/cloudflare/worker.Dockerfile` | The same build, whose command is `worker --app <app> --probe-host 0.0.0.0 --probe-port 9090`. |
| `wrangler.jsonc` | Two Durable-Object-backed container classes, `MayuraServer` (up to `maxInstances`) and `MayuraWorker` (one), their bindings `SERVER` and `WORKER`, and with `cron` a trigger every minute. |
| `deploy/cloudflare/worker.js` | The Worker in front of the containers. |

The Worker sends `/v1/*` to a server container picked at random among `maxInstances` and answers anything else with
`404`. It passes `DATABASE_URL` and each name in `env`, and only those, from its secrets to both containers, with
`PORT` for the server and `MAYURA_WORKER_ID` for the worker. On the cron trigger, it requests the worker container's
`/readyz`, which starts it if it slept and keeps it awake. Server containers sleep after 10 idle minutes, the worker
container after 5.

**Workers:**

| File | Contents |
| --- | --- |
| `wrangler.jsonc` | `main: deploy/cloudflare/worker.ts`, the `nodejs_compat` flag, and with `cron` a trigger every minute. |
| `deploy/cloudflare/worker.ts` | `fetch` calls `handle(request, env)`; the cron trigger calls `advanceWorkflows(20_000, env)`. |

Both forms set `compatibility_date` to `2026-09-15`. `mayura.deploy.json` is written only when the project has none.

## A release

| Step | Command | What it does |
| --- | --- | --- |
| `check-login` | `wrangler whoami` | Stops the release if wrangler is not logged in. |
| `build` | `npm run build` | Containers only: compiles your app here, for the migration. |
| `migrate` | `node node_modules/mayura/lib/cli/dist/bin.js migrate --app <app>` | Containers only: migrates storage with the `DATABASE_URL` in your environment, since Containers have no pre-deploy step. |
| `deploy` | `wrangler deploy --config wrangler.jsonc` | Containers: builds and pushes the images and updates the Worker and its containers. Workers: bundles your TypeScript and deploys. |

A failed migration stops the release before anything is deployed. The tag is not passed to Cloudflare.

## Secrets and environment

- Store secrets with `wrangler secret put`; a deploy never deletes them. In Containers, the Worker hands
  `DATABASE_URL` and the names in `env` to the containers as environment variables.
- On Workers, your module reads bindings and secrets from `env`.
- The Containers `migrate` step uses the `DATABASE_URL` in your own environment; your app module reads it, Mayura
  doesn't. No value ever appears in a plan.

## What it never does

- Set secrets, create D1 databases or Hyperdrive configs, or add bindings.
- Read credentials, or run a shell: each step is `wrangler`, `npm` or `node` with its arguments as planned.
- Deploy containers after a failed migration.

## Errors

Failures are `MayuraError`s with a `code`; the CLI prints the code and message and exits with 1.

| `code` | When |
| --- | --- |
| `INVALID_CONFIG` | A setting is malformed or unknown; `wrangler.jsonc` was written for the other runtime: run `deploy init` again. |
| `NOT_FOUND` | `wrangler.jsonc` or the Worker file is missing: run `deploy init` first. A tool is not on your `PATH`. |
| `PERMISSION_DENIED` | `--confirm` is not the digest of the plan. |
| `INVALID_INPUT` | On Windows, `wrangler` or `npm` is a `.cmd` script that runs through cmd.exe, and an argument holds a character cmd.exe would interpret. |
| `TOOL_FAILED` | A tool could not be started. |

A step that exits non-zero fails the run, skips the rest, and the CLI exits with 1.

## How it is tested

- Unit tests write the Containers files into a temporary project and check `wrangler.jsonc` and the worker image's
  command. They load the generated Worker against a stub of `@cloudflare/containers` and check that `/v1/*` reaches a
  server container, other paths get `404`, only listed secrets reach the containers, and the cron requests the worker
  container's `/readyz`.
- For Workers, they load the generated `worker.ts` against a stub module and check that `fetch` and the cron pass
  `env` through with a 20-second budget.
- They compare every planned step, check with a fake runner in place of the CLIs that a failed migration never
  deploys, and refuse files written for the other runtime and malformed settings.
- The package has not yet deployed to a real Cloudflare account.

## Related

- [Deployment](../guides/deployment.md#edge-runtimes): Mayura on Workers, storage over allowed connections, and cron
  triggers.
- [Deploy with mayura deploy](../cli/deploy.md): plans, digests and `mayura.deploy.json`.
- [D1 storage](storage-d1.md): keep everything in D1 on Workers.
- [Vercel deploy target](deploy-vercel.md): the serverless module on Vercel Functions.
