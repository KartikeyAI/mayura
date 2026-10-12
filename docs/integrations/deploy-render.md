---
title: "Render deploy target"
description: "Deploy a Mayura app to Render with @mayurajs/deploy-render: a Blueprint with a web service, a background worker and PostgreSQL."
package: "@mayurajs/deploy-render"
vendor: "Render"
logo: "render"
website: "https://render.com"
area: "deploy"
---

[Render](https://render.com) builds and runs services from your repository. `@mayurajs/deploy-render` adds `render` as
a target for [`mayura deploy`](../cli/deploy.md): `deploy init` writes a Blueprint (`render.yaml`) with the server as a
web service, a background worker and PostgreSQL, and each release runs the Render CLI, signed in as you, to deploy
both services and wait for them. The package has no dependencies besides `mayura`. It runs inside the `mayura` CLI on
Node.js 22 or 24, on your machine or in CI.

## Install

```bash
npm install mayura
npm install --save-dev @mayurajs/deploy-render
```

`mayura deploy` loads the target from the project's own `node_modules`, so a dev dependency is enough. You also need
the [Render CLI](https://render.com/docs/cli) on your `PATH`.

## Credentials

Mayura reads no credentials. The Render CLI uses its own login (`render login`), or `RENDER_API_KEY` in CI; create an
API key in your Render [account settings](https://dashboard.render.com/u/settings). The login needs access to the
workspace that holds both services.

## Use it

```bash
mayura deploy init --target render --apply   # writes render.yaml and deploy/render/Dockerfile; commit and push them
```

**Once:** in the Render dashboard, choose **New > Blueprint** for the repository and enter the secret values it asks
for. Then copy both services' ids (`srv-…`) into `mayura.deploy.json`:

```json
{
  "format": "mayura.deploy.v1",
  "name": "refunds",
  "env": ["OPENAI_API_KEY", "MAYURA_OPERATOR_TOKEN_SHA256"],
  "targets": {
    "render": {
      "region": "frankfurt",
      "serverServiceId": "srv-d1abcdefgh2345678901",
      "workerServiceId": "srv-d9zyxwvut8765432109"
    }
  }
}
```

Render deploys from your repository, so push before each release:

```bash
mayura deploy --target render --tag v42                              # prints the plan and its digest
mayura deploy --target render --tag v42 --apply --confirm <digest>
```

Your app module is the one the [deployment guide](../guides/deployment.md#the-application-module) describes.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `region` | `oregon` | The Render region of both services and the database. |
| `plan` | `starter` | The services' instance type. Pre-deploy commands need a paid instance type. |
| `databasePlan` | `basic-256mb` | The PostgreSQL instance type. |
| `autoDeploy` | `off` | `off` (releases go through `mayura deploy`), `commit`, or `checksPass`. |
| `serverServiceId` | none | The web service's id (`srv-…`); a release needs it. |
| `workerServiceId` | none | The worker's id (`srv-…`); a release needs it, and it must differ from the server's. |

Region and instance types are lowercase slugs. Any other key under `targets.render` is refused.

## Files it writes

| File | Contents |
| --- | --- |
| `render.yaml` | The Blueprint: a `web` service `<name>-server`, a `worker` service `<name>-worker`, and a database `<name>-db`. |
| `deploy/render/Dockerfile` | The image without an entry point, so Render's commands run as written. |
| `.dockerignore` | Keeps `.env`, local data and SQLite files out of the image. |
| `mayura.deploy.json` | Only when the project has none. |

Both services use `runtime: docker`, the `deploy/render/Dockerfile`, `autoDeployTrigger` from your setting, and
`preDeployCommand: node node_modules/mayura/lib/cli/dist/bin.js migrate --app <app>`. The server runs `serve` with
`healthCheckPath: /readyz` and `PORT` set to the server's port; the worker runs `worker --app <app> --probe-host 0.0.0.0
--probe-port 9090`. Both services migrate before they go live; migrations take a lock, so whichever runs first does the
work, and a failed migration fails that deploy.

## A release

| Step | Command | What it does |
| --- | --- | --- |
| `validate` | `render blueprints validate render.yaml` | Checks the Blueprint with Render. |
| `deploy-server` | `render deploys create <serverServiceId> --wait --confirm --output text` | Deploys the server and waits; its migration runs first. |
| `deploy-worker` | the same for `<workerServiceId>` | Runs only if the server's deploy succeeded. |

A run stops at the first failing step. The tag is not passed to Render, which deploys what is in your repository.

## Secrets and environment

`DATABASE_URL` comes from the Blueprint's database (`fromDatabase`, `connectionString`). Every other name in `env` is
declared on both services with `sync: false`: Render asks for its value when you create the Blueprint, so values never
reach your repository. No value ever appears in a plan.

## What it never does

- Create the Blueprint or its services: you do that once in the dashboard.
- Push your commits: Render deploys from the repository, so push yourself.
- Read credentials, or run a shell: each step is `render` with its arguments as planned.
- Overwrite `render.yaml` or the Dockerfile without the digest of the file plan that shows the change.

## Errors

Failures are `MayuraError`s with a `code`; the CLI prints the code and message and exits with 1.

| `code` | When |
| --- | --- |
| `INVALID_CONFIG` | A setting is malformed or unknown; both service ids are the same; a release without `serverServiceId` and `workerServiceId`. |
| `NOT_FOUND` | `render.yaml` or `deploy/render/Dockerfile` is missing: run `deploy init` first. `render` is not on your `PATH`. |
| `PERMISSION_DENIED` | `--confirm` is not the digest of the plan. |
| `TOOL_FAILED` | `render` could not be started. |

A step that exits non-zero fails the run, skips the rest, and the CLI exits with 1.

## How it is tested

- Unit tests write the files into a temporary project and check the Blueprint line by line (services, commands, health
  check, database, `sync: false` secrets, no tabs) and that the Dockerfile has no entry point.
- They compare every step of a planned release, refuse a release without service ids or before `deploy init`, refuse
  malformed settings, and run a plan with a fake runner in place of the Render CLI to check that a failed server
  deploy never deploys the worker.
- The package has not yet deployed to a real Render account.

## Related

- [Deploy with mayura deploy](../cli/deploy.md): plans, digests and `mayura.deploy.json`.
- [Deployment](../guides/deployment.md#platforms-with-process-types): web and worker processes with a pre-deploy
  migration.
- [Railway deploy target](deploy-railway.md): the same shape on Railway.
