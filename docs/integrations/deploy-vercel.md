---
title: "Vercel deploy target"
description: "Deploy a Mayura app to Vercel Functions with @mayurajs/deploy-vercel: the API, workflows advanced by Vercel Cron, storage migrated first."
package: "@mayurajs/deploy-vercel"
vendor: "Vercel"
logo: "vercel"
website: "https://vercel.com"
area: "deploy"
---

[Vercel Functions](https://vercel.com/docs/functions) run short-lived functions that may stop as soon as they respond.
`@mayurajs/deploy-vercel` adds `vercel` as a target for [`mayura deploy`](../cli/deploy.md): `deploy init` writes the
API as one function behind a `/v1` rewrite, a workflows function that Vercel Cron calls every minute, and a migration
script, and each release migrates storage from your machine before it runs `vercel deploy`, signed in as you. The
package has no dependencies besides `mayura`. It runs inside the `mayura` CLI on Node.js 22 or 24, on your machine or
in CI; the functions it writes run on Vercel's Node.js runtime.

The functions follow the [serverless rules](../guides/deployment.md#serverless-functions): runs finish inside their
request, and workflows advance on a schedule. The deployment guide reports this setup, plain Vercel Functions under
`api/`, as tested on Vercel; Vercel Cron is not yet tested there, and this package has not yet deployed to a real
Vercel account.

## Install

```bash
npm install mayura
npm install --save-dev @mayurajs/deploy-vercel
```

`mayura deploy` loads the target from the project's own `node_modules`, so a dev dependency is enough. You also need
the [Vercel CLI](https://vercel.com/docs/cli) and npm on your `PATH`.

## Credentials

Mayura reads no credentials. The Vercel CLI uses its own login (`vercel login`), or a token in CI (the repository's
`.env.example` uses `VERCEL_TOKEN`); create tokens in your [Vercel account settings](https://vercel.com/account/tokens).
The login needs access to the linked project, and to the team you set as `scope`.

## Use it

Your serverless module, compiled to `dist/src/mayura.js` by default, exports `handle(request)`,
`advanceWorkflows(budgetMs)` and `migrate()`, with request-bound runs and a pool of one connection:

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

/** api/mayura.js calls this for every /v1/* request. */
export async function handle(request: Request): Promise<Response> {
  await ready;
  return api.fetch(request);
}

/** api/advance-workflows.js calls this every minute, with a budget under the function's time limit. */
export async function advanceWorkflows(budgetMs: number) {
  await ready;
  const host = createWorkflowLifecycleHost({ store, scope, definitions, permissions, policyVersion: '1', maxCostMicros });
  const leadership = createWorkflowLeadership({ store, scope, role: 'workflows', holderId: crypto.randomUUID() });
  return createWorkflowWorker({ units: [host], leadership }).runOnce({ budgetMs });
}

/** deploy/vercel/migrate.mjs runs this from your machine before each deploy. */
export async function migrate() {
  await ready;
  return { schemaVersion: 1 };
}
```

```bash
vercel link                                   # once
mayura deploy init --target vercel --apply    # writes vercel.json, api/ and deploy/vercel/
```

In the Vercel project's environment variables, set `DATABASE_URL` (your provider's pooled connection string), the app's
variables, and `CRON_SECRET`. Then release, with the same `DATABASE_URL` in your own environment for the migration:

```bash
mayura deploy --target vercel --tag v42                                  # prints the plan and its digest
DATABASE_URL=… mayura deploy --target vercel --tag v42 --apply --confirm <digest>
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `module` | `mayura.js` next to the app module | The compiled serverless module, such as `dist/src/mayura.js`. |
| `scope` | your personal account | The Vercel team slug, passed as `--scope`. |
| `production` | `true` | Deploy to production (`--prod`); `false` deploys a preview. |
| `apiMaxDuration` | 300 | The API function's `maxDuration` in seconds, from 10 to 900. Keep it above your agents' `maxDurationMs`. |
| `advanceMaxDuration` | 60 | The workflows function's `maxDuration` in seconds, from 10 to 900. |
| `cron` | `true` | Add a Vercel Cron job every minute. How often cron may run depends on your plan. |

Any other key under `targets.vercel` is refused.

## Files it writes

| File | Contents |
| --- | --- |
| `vercel.json` | The rewrite of `/v1/:path*` to `/api/mayura?path=:path*`, each function's `maxDuration`, and, with `cron`, a cron at `/api/advance-workflows` on `* * * * *`. |
| `api/mayura.js` | Puts the rewritten path back (`/v1/<path>` with the original query) and calls `handle`. Exports `GET`, `POST` and `DELETE`. |
| `api/advance-workflows.js` | Answers `401` unless the request carries `Authorization: Bearer <CRON_SECRET>`, which Vercel sends with each cron invocation; then calls `advanceWorkflows` with a budget of `advanceMaxDuration` minus 20 seconds (at least 5 seconds), 40 seconds by default. Without `CRON_SECRET` set, it accepts nothing. |
| `deploy/vercel/migrate.mjs` | Calls `migrate()` and prints its report. |
| `mayura.deploy.json` | Only when the project has none. |

## A release

| Step | Command | What it does |
| --- | --- | --- |
| `check-login` | `vercel whoami [--scope <team>]` | Stops the release if the CLI is not logged in. |
| `build` | `npm run build` | Compiles your module here, for the migration. |
| `migrate` | `node deploy/vercel/migrate.mjs` | Migrates storage with the `DATABASE_URL` in your environment. |
| `deploy` | `vercel deploy [--prod] --yes [--scope <team>]` | Deploys and waits; its output must be the deployment's `https://` URL. |

Vercel has no pre-deploy step, so storage is migrated from your machine before the new functions go live. A failed
migration stops the release before anything is deployed. The tag is not passed to Vercel.

## Secrets and environment

- The functions read their environment from the Vercel project; set it there.
- The `migrate` step uses the `DATABASE_URL` in your own environment. Mayura never reads it; your module does.
- `env` in `mayura.deploy.json` is not used by this target, and no value ever appears in a plan.

## What it never does

- Link the project, or set environment variables or `CRON_SECRET`.
- Read credentials, or run a shell: each step is `vercel`, `npm` or `node` with its arguments as planned.
- Deploy after a failed migration.

## Errors

Failures are `MayuraError`s with a `code`; the CLI prints the code and message and exits with 1.

| `code` | When |
| --- | --- |
| `INVALID_CONFIG` | A setting is malformed or unknown. |
| `NOT_FOUND` | `vercel.json`, a function file or the migration script is missing: run `deploy init` first. A tool is not on your `PATH`. |
| `PERMISSION_DENIED` | `--confirm` is not the digest of the plan. |
| `INVALID_INPUT` | On Windows, `vercel` or `npm` is a `.cmd` script that runs through cmd.exe, and an argument holds a character cmd.exe would interpret. |
| `TOOL_FAILED` | A tool could not be started. |

A step that exits non-zero, or a deploy that does not print its URL, fails the run, skips the rest, and the CLI exits
with 1.

## How it is tested

- Unit tests write the files into a temporary project and compare `vercel.json`, with and without cron.
- They load the generated functions against a stub module: `api/mayura.js` restores the path, query and body, and
  `api/advance-workflows.js` refuses calls without the right `CRON_SECRET` and passes a 40-second budget. They run the
  migration script against the stub.
- They compare every step of a planned release, check with a fake runner in place of the CLIs that a failed migration
  never deploys and that a deploy that prints no URL fails, and refuse malformed settings and a release before
  `deploy init`.
- The package has not yet deployed to a real Vercel account.

## Related

- [Deployment](../guides/deployment.md#vercel): the serverless module, request-bound runs and cron-driven workflows.
- [Deploy with mayura deploy](../cli/deploy.md): plans, digests and `mayura.deploy.json`.
- [Cloudflare deploy target](deploy-cloudflare.md): the serverless module on Cloudflare Workers.
- [Vercel Sandbox](sandbox-vercel.md): Vercel as a sandbox provider.
