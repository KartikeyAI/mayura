---
title: "DigitalOcean App Platform deploy target"
description: "Deploy a Mayura app to DigitalOcean App Platform with @mayurajs/deploy-digitalocean: server, worker, pre-deploy migration and PostgreSQL."
package: "@mayurajs/deploy-digitalocean"
vendor: "DigitalOcean App Platform"
logo: "digitalocean"
website: "https://www.digitalocean.com/products/app-platform"
area: "deploy"
---

[DigitalOcean App Platform](https://www.digitalocean.com/products/app-platform) runs apps from an app spec.
`@mayurajs/deploy-digitalocean` adds `digitalocean` as a target for [`mayura deploy`](../cli/deploy.md): `deploy init`
writes an app spec with the server as a service, a worker, the migration as a pre-deploy job and PostgreSQL, all from
one image in DigitalOcean Container Registry. Each release pushes the image to the app's tag and starts a deployment
with `doctl`, signed in as you, then waits until it is live. The package has no dependencies besides `mayura`. It runs
inside the `mayura` CLI on Node.js 22 or 24, on your machine or in CI.

## Install

```bash
npm install mayura
npm install --save-dev @mayurajs/deploy-digitalocean
```

`mayura deploy` loads the target from the project's own `node_modules`, so a dev dependency is enough. You also need
[doctl](https://docs.digitalocean.com/reference/doctl/how-to/install/) and Docker on your `PATH`.

## Credentials

Mayura reads no credentials. `doctl` uses its own token: create a personal access token in the
[DigitalOcean control panel](https://cloud.digitalocean.com/account/api/tokens) and give it to `doctl auth init`. It
needs to read the app, create deployments and push to the registry. Log Docker in to the registry once with
`doctl registry login`.

## Use it

`image` is a repository in DigitalOcean Container Registry:

```json
{
  "format": "mayura.deploy.v1",
  "name": "refunds",
  "image": "registry.digitalocean.com/acme/refunds",
  "targets": { "digitalocean": { "region": "fra" } }
}
```

```bash
mayura deploy init --target digitalocean --apply   # writes .do/app.yaml and deploy/digitalocean/Dockerfile
doctl registry login                                # once
doctl apps create --spec .do/app.yaml               # once; then set targets.digitalocean.appId
```

Add `appId` from `doctl apps create` to `targets.digitalocean`, and the app's secret variables in the control panel.
Then release:

```bash
mayura deploy --target digitalocean --tag v42                              # prints the plan and its digest
mayura deploy --target digitalocean --tag v42 --apply --confirm <digest>
```

Your app module is the one the [deployment guide](../guides/deployment.md#the-application-module) describes.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `appId` | none | The app's id from `doctl apps create` or the control panel; a release needs it. |
| `channel` | `release` | The image tag the app runs. Each release pushes to it, then deploys. |
| `region` | `nyc` | The app's region slug, such as `fra`. |
| `instanceSize` | `apps-s-1vcpu-1gb` | The instance size of each component. |
| `serverInstances` | 1 | The server's instance count, from 1 to 250. |
| `databaseCluster` | none | A managed PostgreSQL cluster to attach; without it, the app gets a development database. |
| `timeoutSeconds` | 1800 | How long a release waits for the deployment, from 60 to 3600. |

Any other key under `targets.digitalocean` is refused.

## Files it writes

| File | Contents |
| --- | --- |
| `.do/app.yaml` | The app spec: name, region, the `server` service, a `worker`, a `migrate` job of kind `PRE_DEPLOY`, and the `db` database. |
| `deploy/digitalocean/Dockerfile` | The image without an entry point, so the spec's commands run as written. |
| `.dockerignore` | Keeps `.env`, local data and SQLite files out of the image. |
| `mayura.deploy.json` | Only when the project has none. |

Every component runs the image from DOCR on the `channel` tag, with `DATABASE_URL` set to `${db.DATABASE_URL}` at run
time and the full command `node node_modules/mayura/lib/cli/dist/bin.js <role> --app <app>`. The server has
`http_port` 8080, `serverInstances` instances and a `/readyz` health check; the worker runs with
`--probe-host 0.0.0.0 --probe-port 9090`. The database is `production: false`, or `production: true` on your
`databaseCluster`.

## A release

| Step | Command | Output it must print |
| --- | --- | --- |
| `check-app` | `doctl apps get <appId> --format ID --no-header` | The app's id. |
| `build-image` | `docker build --file deploy/digitalocean/Dockerfile --tag <image>:<tag> --tag <image>:<channel> .` | |
| `push-image` | `docker push <image>:<tag>` | |
| `push-channel` | `docker push <image>:<channel>` | |
| `deploy` | `doctl apps create-deployment <appId> --format ID --no-header` | A deployment id, kept for the next step. |
| `deploy-wait` | `doctl apps get-deployment <appId> <deployment> --format Phase --no-header` | `ACTIVE`. While `PENDING_BUILD`, `BUILDING`, `PENDING_DEPLOY`, `DEPLOYING` or `UNKNOWN`, it asks again every 10 seconds until `timeoutSeconds`. |

The pre-deploy job migrates first, so a failed migration ends the deployment in `ERROR`, nothing new goes live, and
the release fails. `ERROR`, `CANCELED` or any other answer fails the step.

## Secrets and environment

Add the app's secret variables in the control panel. Releases deploy the image on its tag and never replace the app
spec, so your variables are kept. To change the spec itself, edit `.do/app.yaml` and run
`doctl apps update <id> --spec .do/app.yaml` yourself, with the encrypted values `doctl apps spec get` gives you. `env`
in `mayura.deploy.json` is not used by this target, and no value ever appears in a plan.

## What it never does

- Create or update the app spec, the registry or the database cluster.
- Read credentials, or run a shell: each step is `doctl` or `docker` with its arguments as planned.
- Bring a release live after a failed migration: App Platform ends that deployment in `ERROR`.

## Errors

Failures are `MayuraError`s with a `code`; the CLI prints the code and message and exits with 1.

| `code` | When |
| --- | --- |
| `INVALID_CONFIG` | A setting is malformed or unknown; a release without `appId`; an `image` that is not `registry.digitalocean.com/<registry>/<repository>`. |
| `NOT_FOUND` | `.do/app.yaml` or the Dockerfile is missing: run `deploy init` first. `doctl` or `docker` is not on your `PATH`. |
| `PERMISSION_DENIED` | `--confirm` is not the digest of the plan. |
| `TOOL_FAILED` | A tool could not be started. |

A step that exits non-zero, or whose output does not match, fails the run, skips the rest, and the CLI exits with 1.

## How it is tested

- Unit tests write the files into a temporary project and check the app spec line by line (DOCR image and tag,
  pre-deploy job, full commands, health check, database) and that the Dockerfile has no entry point.
- A fake `doctl` answers each step from a script, such as `BUILDING` then `ACTIVE`. The tests compare every step's
  arguments, check that the deployment id reaches the polling step, and that `ERROR`, `CANCELED`, an unreachable app
  or a missing deployment id fail the release.
- Releases without an app id or with an image outside DOCR, and malformed settings, are refused.
- The package has not yet deployed to a real DigitalOcean account.

## Related

- [Deploy with mayura deploy](../cli/deploy.md): plans, digests, output checks and `mayura.deploy.json`.
- [Deployment](../guides/deployment.md#platforms-with-process-types): services, workers and a pre-deploy migration.
- [Render deploy target](deploy-render.md): a similar spec-based platform.
