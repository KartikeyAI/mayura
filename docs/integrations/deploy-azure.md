---
title: "Azure Container Apps deploy target"
description: "Deploy a Mayura app to Azure Container Apps with @mayurajs/deploy-azure: a migration job run to success, then the server and worker apps."
package: "@mayurajs/deploy-azure"
vendor: "Azure Container Apps"
logo: "azure"
website: "https://azure.microsoft.com/products/container-apps"
area: "deploy"
---

[Azure Container Apps](https://azure.microsoft.com/products/container-apps) runs containers as apps and jobs.
`@mayurajs/deploy-azure` adds `azure` as a target for [`mayura deploy`](../cli/deploy.md): each release builds one
image, runs the migration job to success, then updates the server and the worker apps and waits until each new
revision is running, all with `az`, signed in as you. The package has no dependencies besides `mayura`. It runs inside
the `mayura` CLI on Node.js 22 or 24, on your machine or in CI.

## Install

```bash
npm install mayura
npm install --save-dev @mayurajs/deploy-azure
```

`mayura deploy` loads the target from the project's own `node_modules`, so a dev dependency is enough. You also need
the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) with its `containerapp` extension on your
`PATH`, and Docker for `build: "local"`.

## Credentials

Mayura reads no credentials. `az` uses its own sign-in: `az login` on your machine, or a service principal in CI (the
repository's `.env.example` uses `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` and
`AZURE_SUBSCRIPTION_ID`). Manage them in the [Azure portal](https://portal.azure.com).

The signed-in identity must be able to read the subscription, run `az acr build` on the registry (or push to it with
Docker), and update and start the container apps and the job in the resource group.

## Use it

```json
{
  "format": "mayura.deploy.v1",
  "name": "refunds",
  "image": "acmeregistry.azurecr.io/refunds",
  "targets": {
    "azure": { "resourceGroup": "agents-prod", "subscription": "3f2504e0-4f89-11d3-9a0c-0305e82c3301" }
  }
}
```

```bash
mayura deploy init --target azure --apply   # writes Dockerfile and .dockerignore
```

**Once, before the first release**, create the Container Apps environment, the two apps and the job from the image.
Each runs the image's `mayura` entry point with its own arguments and the same environment:

| Resource | Arguments | Setup |
| --- | --- | --- |
| `<name>-server` | `serve --app dist/app.js` | Ingress on port 8080, `/livez` and `/readyz` probes, at least one replica, since agent runs continue after a response. |
| `<name>-worker` | `worker --app dist/app.js --probe-host 0.0.0.0 --probe-port 9090` | No ingress, one replica or more. |
| `<name>-migrate` | `migrate --app dist/app.js` | A job with a manual trigger and no retries. |

Use your project's `app` path in place of `dist/app.js`. Then release:

```bash
mayura deploy --target azure --tag v42                              # prints the plan and its digest
mayura deploy --target azure --tag v42 --apply --confirm <digest>
```

Your app module is the one the [deployment guide](../guides/deployment.md#the-application-module) describes.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `resourceGroup` | none | The resource group of the apps and the job; a release needs it. Letters, digits, `_`, `-` and `.`, not ending in `.`. |
| `subscription` | the CLI's current one | A subscription id, passed as `--subscription` to every step. |
| `build` | `acr` | `acr` builds in Azure Container Registry with `az acr build`; `local` builds with your Docker and pushes. |
| `registry` | from the image | The registry's name for `acr` builds; taken from an `<registry>.azurecr.io` image by default. |
| `migrationTimeoutSeconds` | 1800 | How long a release waits for the migration, from 60 to 3600. |
| `revisionTimeoutSeconds` | 600 | How long it waits for each new revision, from 60 to 3600. |

Azure also allows parentheses in resource group names; this target refuses them, because cmd.exe runs `az` on Windows
and would interpret them. Any other key under `targets.azure` is refused.

## Files it writes

`Dockerfile` and `.dockerignore`: the image every role runs, with the `mayura` CLI as its entry point (plus
`mayura.deploy.json` when the project has none). The apps and the job are yours; a release changes only their image.

## A release

| Step | Command | Output it must print |
| --- | --- | --- |
| `check-account` | `az account show --query id` | A subscription id. |
| `build-image` | `az acr build --registry <registry> --image <repository>:<tag> .` | Or `docker build` and `docker push` with `build: "local"`. |
| `migrate-image` | `az containerapp job update --name <name>-migrate --image <image>:<tag>` | The job's name. |
| `migrate` | `az containerapp job start --name <name>-migrate` | An execution name, kept for the next step. |
| `migrate-wait` | `az containerapp job execution show --job-execution-name <execution> --query properties.status` | `Succeeded`. While `Running`, `Processing` or `Pending`, it asks again every 5 seconds until `migrationTimeoutSeconds`. |
| `update-server` | `az containerapp update --name <name>-server --image <image>:<tag> --query properties.latestRevisionName` | The new revision's name. |
| `server-ready` | `az containerapp revision show --revision <revision> --query properties.runningState` | `Running` or `RunningAtMaxScale`. While `Activating`, `Processing` or `Provisioning`, it asks again every 5 seconds until `revisionTimeoutSeconds`. |
| `update-worker`, `worker-ready` | the same for `<name>-worker` | |

Every app and job step passes `--resource-group` and, when set, `--subscription`, with `--output tsv`; the account
check and the ACR build pass `--subscription` too. A failed migration stops
the release before any app changes, and a revision that ends `Failed` or `Degraded`, or any other unexpected answer,
stops it too.

## Secrets and environment

Give the apps and the job their environment in Azure: secrets as `secretref:` variables, or Key Vault references. A
release only changes the image, so your variables and secrets are kept. `env` in `mayura.deploy.json` is not used by
this target, and no value ever appears in a plan.

## What it never does

- Create the environment, the apps, the job, the registry or the secrets.
- Read credentials, or run a shell: each step is `az` or `docker` with its arguments as planned.
- Update the apps after a migration that did not succeed.

## Errors

Failures are `MayuraError`s with a `code`; the CLI prints the code and message and exits with 1.

| `code` | When |
| --- | --- |
| `INVALID_CONFIG` | A setting is malformed or unknown; a release without `resourceGroup` or an `image`; an `acr` build with neither `registry` nor an `<registry>.azurecr.io` image. |
| `NOT_FOUND` | The `Dockerfile` is missing: run `deploy init` first. `az` or `docker` is not on your `PATH`. |
| `PERMISSION_DENIED` | `--confirm` is not the digest of the plan. |
| `INVALID_INPUT` | On Windows, `az` is a `.cmd` script that runs through cmd.exe, and an argument holds a character cmd.exe would interpret. This target's arguments contain none. |
| `TOOL_FAILED` | A tool could not be started. |

A step that exits non-zero, or whose output does not match, fails the run, skips the rest, and the CLI exits with 1.

## How it is tested

- A fake `az` answers each step from a script, one answer per call: `Running` then `Succeeded` for the migration,
  `Activating` then `Running` for a revision. The tests check the order of steps, the ACR build arguments, that the
  execution and revision names reach the polling steps, and that no argument holds a character cmd.exe would
  interpret.
- With the fake answering `Failed`, an error message or nothing, the release fails at that step and never updates the
  apps after a failed migration. Local builds, a subscription, the poll counts for custom timeouts, and malformed
  settings are covered too.
- The package has not yet deployed to a real Azure subscription.

## Related

- [Deploy with mayura deploy](../cli/deploy.md): plans, digests, output checks and `mayura.deploy.json`.
- [Deployment](../guides/deployment.md#managed-container-platforms): Azure Container Apps among the managed container
  platforms.
- [Google Cloud Run deploy target](deploy-cloudrun.md): the same shape on Google Cloud.
