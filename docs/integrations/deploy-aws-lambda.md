---
title: "AWS Lambda deploy target"
description: "Deploy a Mayura app to AWS Lambda with @mayurajs/deploy-aws-lambda: one container image, a checked migration, then the API and workflows."
package: "@mayurajs/deploy-aws-lambda"
vendor: "AWS Lambda"
logo: "aws"
website: "https://aws.amazon.com/lambda/"
area: "deploy"
---

[AWS Lambda](https://aws.amazon.com/lambda/) runs functions that may be frozen as soon as they respond.
`@mayurajs/deploy-aws-lambda` adds `aws-lambda` as a target for [`mayura deploy`](../cli/deploy.md). One container
image serves three functions: the API behind a function URL, a workflows function that EventBridge Scheduler invokes
every minute, and a migration function that each release runs and checks before anything else is updated. Releases
run the AWS CLI and Docker, signed in as you. The package has no dependencies besides `mayura`. It runs inside the
`mayura` CLI on Node.js 22 or 24, on your machine or in CI.

Mayura on Lambda is **experimental**: it follows the rules in
[Serverless functions](../guides/deployment.md#serverless-functions) and passes the same local tests, but has not yet
run on Lambda, and its setup may change in any release.

## Install

```bash
npm install mayura
npm install --save-dev @mayurajs/deploy-aws-lambda
```

`mayura deploy` loads the target from the project's own `node_modules`, so a dev dependency is enough. You also need the
[AWS CLI](https://aws.amazon.com/cli/) and Docker on your `PATH`; building `arm64` images on an x86 machine needs
Docker's emulation.

## Credentials

Mayura reads no credentials. The AWS CLI uses its own: profiles, SSO or roles (the repository's `.env.example` uses
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_REGION`). Manage access in the
[IAM console](https://console.aws.amazon.com/iam/).

The signed-in identity calls `sts:GetCallerIdentity`, `lambda:UpdateFunctionCode` and `lambda:InvokeFunction`, reads the
three functions for `aws lambda wait function-updated-v2`, and must push to the ECR repository. Log Docker in to ECR
yourself.

## Use it

Your serverless module, compiled to `dist/src/mayura.js` by default, exports `handle(request)`,
`advanceWorkflows()` and `migrate()`. It is the module the deployment guide describes, with request-bound runs and a
pool of one connection, plus a migration:

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

/** The API function: one request to Mayura's API. */
export async function handle(request: Request): Promise<Response> {
  await ready;
  return api.fetch(request);
}

/** The workflows function: advance everything that is due within the budget, then return. */
export async function advanceWorkflows(budgetMs = 50_000) {
  await ready;
  const host = createWorkflowLifecycleHost({ store, scope, definitions, permissions, policyVersion: '1', maxCostMicros });
  const leadership = createWorkflowLeadership({ store, scope, role: 'workflows', holderId: crypto.randomUUID() });
  return createWorkflowWorker({ units: [host], leadership }).runOnce({ budgetMs });
}

/** The migration function, which every release invokes first. */
export async function migrate() {
  await ready;
  return { schemaVersion: 1 };
}
```

```json
{
  "format": "mayura.deploy.v1",
  "name": "refunds",
  "image": "123456789012.dkr.ecr.eu-west-1.amazonaws.com/refunds",
  "targets": { "aws-lambda": { "region": "eu-west-1", "architecture": "arm64" } }
}
```

```bash
mayura deploy init --target aws-lambda --apply   # writes the Lambda Dockerfile and three handlers
```

**Once, before the first release**, build and push an image and create three functions from it, each with its image
command:

| Function | Image command | Setup |
| --- | --- | --- |
| `<name>-api` | `deploy/aws-lambda/api.handler` | A function URL, and a timeout above your agents' `maxDurationMs` plus the server's `requestTimeoutMs`. |
| `<name>-workflows` | `deploy/aws-lambda/workflows.handler` | A 60-second timeout, and an EventBridge Scheduler schedule every minute. |
| `<name>-migrate` | `deploy/aws-lambda/migrate.handler` | A timeout of up to 900 seconds. |

Give them `DATABASE_URL` and the app's variables, and the VPC for a private database. Then release:

```bash
mayura deploy --target aws-lambda --tag v42                              # prints the plan and its digest
mayura deploy --target aws-lambda --tag v42 --apply --confirm <digest>
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `region` | none | The AWS region; a release needs it. |
| `nodeVersion` | 22 | The Lambda Node.js base image: 22 or 24. |
| `architecture` | `x86_64` | `x86_64` builds for `linux/amd64`, `arm64` for `linux/arm64`. Match the functions' architecture. |
| `module` | `mayura.js` next to the app module | The compiled serverless module, such as `dist/src/mayura.js`. |

Any other key under `targets.aws-lambda` is refused.

## Files it writes

| File | Contents |
| --- | --- |
| `deploy/aws-lambda/Dockerfile` | Both stages on `public.ecr.aws/lambda/nodejs:<nodeVersion>`, so native modules match Amazon Linux. It compiles your TypeScript, keeps production dependencies, and copies `dist` and the handlers. |
| `deploy/aws-lambda/api.mjs` | Turns a function URL event into a `Request` for `handle` (method, headers, query, base64 body) and the `Response` back. |
| `deploy/aws-lambda/workflows.mjs` | Calls `advanceWorkflows()`. |
| `deploy/aws-lambda/migrate.mjs` | Calls `migrate()`. |
| `.dockerignore` | Keeps `.env`, local data and SQLite files out of the image. |

The handlers import your module from `module`. A buffered Lambda response delivers event streams only when they end;
runs are request-bound, so a run's result is ready when its submission returns.

## A release

| Step | Command | Output it must print |
| --- | --- | --- |
| `check-account` | `aws sts get-caller-identity` | A 12-digit account id. |
| `build-image` | `docker build --file deploy/aws-lambda/Dockerfile --platform linux/<arch> --provenance=false --tag <image>:<tag> .` | |
| `push-image` | `docker push <image>:<tag>` | |
| `update-migrate`, `wait-migrate` | `aws lambda update-function-code --function-name <name>-migrate --image-uri …`, then `aws lambda wait function-updated-v2` | The function's name. |
| `migrate` | `aws lambda invoke --function-name <name>-migrate --cli-read-timeout 900 --query FunctionError` | `None`: the migration reported no function error. |
| `update-api`, `wait-api` | the same for `<name>-api` | The function's name. |
| `update-workflows`, `wait-workflows` | the same for `<name>-workflows` | The function's name. |

The image is a single-platform manifest without a provenance attestation, which Lambda would refuse. The migration's
own result is discarded; only whether it threw counts. Any unexpected output fails its step, so the API and workflows
functions are updated only after a successful migration.

## Secrets and environment

You give the functions their environment in Lambda, for example from Secrets Manager. `env` in `mayura.deploy.json` is
not used by this target, and no value ever appears in a plan.

## What it never does

- Create the functions, the function URL, the schedule, the roles or the ECR repository.
- Read credentials, or run a shell: each step is `aws` or `docker` with its arguments as planned.
- Update the API or workflows functions after a failed migration.

## Errors

Failures are `MayuraError`s with a `code`; the CLI prints the code and message and exits with 1.

| `code` | When |
| --- | --- |
| `INVALID_CONFIG` | A setting is malformed or unknown; a release without `region` or without an `image`. |
| `NOT_FOUND` | The Dockerfile or a handler is missing: run `deploy init` first. `aws` or `docker` is not on your `PATH`. |
| `PERMISSION_DENIED` | `--confirm` is not the digest of the plan. |
| `TOOL_FAILED` | A tool could not be started. |

A step that exits non-zero, or whose output does not match, fails the run, skips the rest, and the CLI exits with 1.

## How it is tested

- Unit tests write the files into a temporary project and check the base image in both stages and each handler's
  import. They load the generated `api.mjs` against a stub module and check that a function URL event with a base64
  body becomes the right `Request`, and the `Response` the right result.
- A fake AWS CLI answers each step with the output a successful release prints; the tests check the build and update
  arguments and that the plan succeeds. With the fake printing a function error, an error message or nothing, the
  release fails at that step and never updates the API.
- Releases without a region or image, and malformed settings, are refused.
- The package has not yet deployed to a real AWS account.

## Related

- [Deployment](../guides/deployment.md#aws-lambda-experimental): Lambda handlers, request-bound runs and scheduled
  workflows.
- [Deploy with mayura deploy](../cli/deploy.md): plans, digests, output checks and `mayura.deploy.json`.
- [Amazon ECS deploy target](deploy-aws-ecs.md): long-running containers on AWS.
- [Amazon Bedrock AgentCore deploy target](deploy-agentcore.md): one agent behind AgentCore Runtime.
