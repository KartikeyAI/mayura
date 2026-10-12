---
title: "Google Cloud Run deploy target"
description: "Deploy a Mayura app to Google Cloud Run with @mayurajs/deploy-cloudrun: a migration job, then the server and an always-on worker."
package: "@mayurajs/deploy-cloudrun"
vendor: "Google Cloud Run"
logo: "google-cloud"
website: "https://cloud.google.com/run"
area: "deploy"
---

[Google Cloud Run](https://cloud.google.com/run) runs containers as services and jobs. `@mayurajs/deploy-cloudrun`
adds `cloudrun` as a target for [`mayura deploy`](../cli/deploy.md): each release builds one image, runs the migration
as a Cloud Run job to completion, then deploys the server and an always-on internal worker as services, all with
`gcloud`, signed in as you. Secrets come from Secret Manager. The package has no dependencies besides `mayura`. It runs
inside the `mayura` CLI on Node.js 22 or 24, on your machine or in CI.

This is the [managed container](../guides/deployment.md#managed-container-platforms) setup, with CPU always allocated.
It is not the experimental request-bound setup the deployment guide describes for
[Cloud Run as a serverless function](../guides/deployment.md#google-cloud-run-experimental).

## Install

```bash
npm install mayura
npm install --save-dev @mayurajs/deploy-cloudrun
```

`mayura deploy` loads the target from the project's own `node_modules`, so a dev dependency is enough. You also need
the [gcloud CLI](https://cloud.google.com/sdk/docs/install) on your `PATH`, and Docker for `build: "local"`.

## Credentials

Mayura reads no credentials. `gcloud` uses its own login: `gcloud auth login` on your machine, or a service account in
CI (the repository's `.env.example` uses `GOOGLE_APPLICATION_CREDENTIALS` and `GOOGLE_CLOUD_PROJECT`). Manage service
accounts and keys in the [Google Cloud console](https://console.cloud.google.com/apis/credentials).

The signed-in identity must be able to read the project, submit Cloud Build builds (the default build), push to the
Artifact Registry repository, deploy and run Cloud Run jobs, deploy Cloud Run services, and act as the service account
the services run as. That service account must be able to read the secrets.

## Use it

Store each secret in Secret Manager, named like its variable (`DATABASE_URL`, `OPENAI_API_KEY`), then configure the
target:

```json
{
  "format": "mayura.deploy.v1",
  "name": "refunds",
  "image": "us-central1-docker.pkg.dev/acme-prod/apps/refunds",
  "env": ["OPENAI_API_KEY", "MAYURA_OPERATOR_TOKEN_SHA256"],
  "targets": {
    "cloudrun": {
      "project": "acme-prod",
      "region": "us-central1",
      "secrets": { "OPENAI_API_KEY": "openai-key:3" },
      "serviceAccount": "refunds-run@acme-prod.iam.gserviceaccount.com"
    }
  }
}
```

```bash
mayura deploy init --target cloudrun --apply                          # writes Dockerfile and .dockerignore
mayura deploy --target cloudrun --tag v42                              # prints the plan and its digest
mayura deploy --target cloudrun --tag v42 --apply --confirm <digest>
```

Your app module is the one the [deployment guide](../guides/deployment.md#the-application-module) describes. The first
release creates the job and both services; later releases update them.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `project` | none | The Google Cloud project id; a release needs it. |
| `region` | `us-central1` | The Cloud Run region. |
| `build` | `cloud-build` | `cloud-build` builds with `gcloud builds submit`; `local` builds with your Docker and pushes. |
| `secrets` | see below | Extra or different Secret Manager references, as `{ "NAME": "secret:version" }`, with `version` a number or `latest`. |
| `cloudSqlInstance` | none | A Cloud SQL instance (`project:region:instance`), connected through the Cloud SQL connector. |
| `serviceAccount` | Cloud Run's default | The service account the job and services run as. |
| `public` | `true` | Lets anyone call the server (`--allow-unauthenticated`); the server authenticates requests itself. `false` keeps it private. |
| `serverMinInstances` | 1 | The server's minimum instances, from 1 to 100. |
| `workerInstances` | 1 | The worker's instances (minimum and maximum), from 1 to 100. |

Any other key under `targets.cloudrun` is refused.

## Files it writes

`Dockerfile` and `.dockerignore`: the image every role runs, with the `mayura` CLI as its entry point (plus
`mayura.deploy.json` when the project has none). The job and services are described entirely by the release's
`gcloud` arguments, which the plan shows.

## A release

| Step | Command | What it does |
| --- | --- | --- |
| `check-project` | `gcloud projects describe <project> --format=none` | Stops the release if gcloud is not logged in or cannot reach the project. |
| `build-image` | `gcloud builds submit --project <project> --tag=<image>:<tag> --quiet .` | Or `docker build` and `docker push` with `build: "local"`. |
| `migrate` | `gcloud run jobs deploy <name>-migrate … --args=migrate,--app,<app> --max-retries=0 --task-timeout=1800s --execute-now --wait` | Updates the job to the image, runs it, and waits. A failed migration stops the release. |
| `deploy-server` | `gcloud run deploy <name>-server … --args=serve,--app,<app>` | Port 8080, `--no-cpu-throttling`, `--min-instances`, a one-hour request timeout for streams, a `/readyz` startup probe. |
| `deploy-worker` | `gcloud run deploy <name>-worker … --args=worker,…,--probe-port,9090` | Port 9090, `--no-cpu-throttling`, min and max instances `workerInstances`, `--ingress=internal`, never public, a `/readyz` startup probe. |

Every `gcloud run` step passes `--project`, `--region`, `--image=<image>:<tag>`, `--set-secrets`, and
`--set-cloudsql-instances` and `--service-account` when you set them. CPU stays allocated and instances stay warm on both
services, because agent runs continue after a response and workflows need a running worker. A run stops at the first
failing step.

## Secrets and environment

`DATABASE_URL` and every name in `env` read a Secret Manager secret of the same name at `latest`, passed with
`--set-secrets`. `secrets` overrides those references or adds others, such as `{ "OPENAI_API_KEY": "openai-key:3" }`.
Only secret names and versions appear in a plan, never values.

## What it never does

- Create secrets, the Artifact Registry repository, the service account or the Cloud SQL instance.
- Read credentials, or run a shell: each step is `gcloud` or `docker` with its arguments as planned.
- Deploy the server or the worker after a failed migration.

## Errors

Failures are `MayuraError`s with a `code`; the CLI prints the code and message and exits with 1.

| `code` | When |
| --- | --- |
| `INVALID_CONFIG` | A setting is malformed or unknown; a release without `project`, or without an `image`. |
| `NOT_FOUND` | The `Dockerfile` is missing: run `deploy init` first. `gcloud` or `docker` is not on your `PATH`. |
| `PERMISSION_DENIED` | `--confirm` is not the digest of the plan. |
| `INVALID_INPUT` | On Windows, gcloud is a `.cmd` script that runs through cmd.exe, and an argument holds a character cmd.exe would interpret. This target's arguments contain none. |
| `TOOL_FAILED` | A tool could not be started. |

A step that exits non-zero fails the run, skips the rest, and the CLI exits with 1.

## How it is tested

- Unit tests plan releases in a temporary project and compare every step's arguments for the default setup and for a
  local build with mapped secrets, Cloud SQL, a service account, a private server and more instances.
- They check that no argument holds a character cmd.exe would interpret, refuse malformed settings and a release
  without a project or image, and run a plan with a fake runner in place of gcloud to check that a failed migration
  never deploys the server or the worker.
- The package has not yet deployed to a real Google Cloud project.

## Related

- [Deploy with mayura deploy](../cli/deploy.md): plans, digests and `mayura.deploy.json`.
- [Deployment](../guides/deployment.md#managed-container-platforms): Cloud Run among the managed container platforms.
- [Azure Container Apps deploy target](deploy-azure.md) and [Amazon ECS deploy target](deploy-aws-ecs.md): the same
  shape on other clouds.
