---
title: "Railway deploy target"
description: "Deploy a Mayura app to Railway with @mayurajs/deploy-railway: server and worker services from config-as-code files, each migrating first."
package: "@mayurajs/deploy-railway"
vendor: "Railway"
logo: "railway"
website: "https://railway.com"
area: "deploy"
---

[Railway](https://railway.com) builds and runs services from your repository. `@mayurajs/deploy-railway` adds
`railway` as a target for [`mayura deploy`](../cli/deploy.md): `deploy init` writes one Railway config-as-code file per
service, a server and a workflow worker, each building from the `Dockerfile` and migrating storage before it goes
live, and each release runs the Railway CLI, signed in as you. The package has no dependencies besides `mayura`. It runs
inside the `mayura` CLI on Node.js 22 or 24, on your machine or in CI.

## Install

```bash
npm install mayura
npm install --save-dev @mayurajs/deploy-railway
```

`mayura deploy` loads the target from the project's own `node_modules`, so a dev dependency is enough. You also need
the [Railway CLI](https://docs.railway.com/guides/cli) on your `PATH`.

## Credentials

Mayura reads no credentials. The Railway CLI uses its own login (`railway login`), or `RAILWAY_TOKEN` in CI; a
project token comes from your Railway project's settings. The login needs access to the linked project and both
services.

## Use it

Link the directory to your Railway project once, write the files, and point each service at its file:

```bash
railway link
mayura deploy init --target railway --apply   # writes deploy/railway/server.json and worker.json
```

**Once per service**, in the service's settings, set its config-as-code path: `/deploy/railway/server.json` for the
server and `/deploy/railway/worker.json` for the worker. Add PostgreSQL to the project, and give both services
`DATABASE_URL` and the app's variables.

```json
{
  "format": "mayura.deploy.v1",
  "name": "refunds",
  "targets": {
    "railway": { "serverService": "refunds-server", "workerService": "refunds-worker" }
  }
}
```

```bash
mayura deploy --target railway --tag v42                              # prints the plan and its digest
mayura deploy --target railway --tag v42 --apply --confirm <digest>
```

Your app module is the one the [deployment guide](../guides/deployment.md#the-application-module) describes. The
server listens on Railway's `PORT`.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `serverService` | `<name>-server` | The Railway service that runs the server. |
| `workerService` | `<name>-worker` | The Railway service that runs the worker; it must differ from the server's. |
| `environment` | the linked one | The Railway environment to deploy to (`--environment`). |

Service and environment names are letters, digits, spaces, `_`, `.` and `-`, up to 63 characters. Any other key under
`targets.railway` is refused.

## Files it writes

| File | Contents |
| --- | --- |
| `Dockerfile`, `.dockerignore` | The image both services build. |
| `deploy/railway/server.json` | Dockerfile builder, start command `node node_modules/mayura/lib/cli/dist/bin.js serve --app <app>`, the migration as `preDeployCommand`, a `/readyz` health check with a 300-second timeout, restart on failure up to 10 times. |
| `deploy/railway/worker.json` | The same, with `worker --app <app> --probe-host 0.0.0.0 --probe-port 9090` and no health check. |
| `mayura.deploy.json` | Only when the project has none. |

Railway's start and pre-deploy commands replace the image's entry point, so they name the `mayura` CLI in full. Both
services migrate before they go live; migrations take a lock, so whichever runs first does the work.

## A release

| Step | Command | What it does |
| --- | --- | --- |
| `check-project` | `railway status` | Stops the release if the CLI is not logged in or the directory is not linked. |
| `deploy-server` | `railway up --ci --service <server> [--environment <env>] --message "mayura deploy <tag>"` | Uploads and builds the server; its migration runs before it goes live. |
| `deploy-worker` | the same for `<worker>` | Runs only if the server's deploy succeeded. |

`--ci` returns once the build is done and Railway finishes the rollout; a failed build or migration fails the step. A
run stops at the first failing step. The tag is used only in the deploy message, since Railway builds from your
directory.

## Secrets and environment

Set `DATABASE_URL` and the app's variables on both services in Railway. `env` in `mayura.deploy.json` is not used by
this target, and no value ever appears in a plan.

## What it never does

- Create services, add PostgreSQL, or set the services' config paths and variables: you do those once in Railway.
- Read credentials, or run a shell: each step is `railway` with its arguments as planned.
- Overwrite the service files or the `Dockerfile` without the digest of the file plan that shows the change.

## Errors

Failures are `MayuraError`s with a `code`; the CLI prints the code and message and exits with 1.

| `code` | When |
| --- | --- |
| `INVALID_CONFIG` | A setting is malformed or unknown; `serverService` and `workerService` are the same. |
| `NOT_FOUND` | `deploy/railway/server.json` or `worker.json` is missing: run `deploy init` first. `railway` is not on your `PATH`. |
| `PERMISSION_DENIED` | `--confirm` is not the digest of the plan. |
| `INVALID_INPUT` | On Windows, when `railway` is a `.cmd` script and an argument holds a character cmd.exe would interpret. |
| `TOOL_FAILED` | `railway` could not be started. |

A step that exits non-zero fails the run, skips the rest, and the CLI exits with 1.

## How it is tested

- Unit tests write the files into a temporary project and compare both config-as-code files in full.
- They plan releases with default and custom service and environment names and compare every step's arguments, refuse
  malformed settings and a release before `deploy init`, and run a plan with a fake runner in place of the Railway CLI
  to check that a failed server deploy never releases the worker.
- The package has not yet deployed to a real Railway account.

## Related

- [Deploy with mayura deploy](../cli/deploy.md): plans, digests and `mayura.deploy.json`.
- [Deployment](../guides/deployment.md#platforms-with-process-types): web and worker processes with a pre-deploy
  migration.
- [Render deploy target](deploy-render.md): the same shape as a Render Blueprint.
- [Railway sandboxes](sandbox-railway.md): Railway as a sandbox provider.
