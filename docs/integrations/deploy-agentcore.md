---
title: "Amazon Bedrock AgentCore deploy target"
description: "Deploy a Mayura agent to Amazon Bedrock AgentCore Runtime with @mayurajs/deploy-agentcore: an ARM64 image serving its HTTP contract."
package: "@mayurajs/deploy-agentcore"
vendor: "Amazon Bedrock AgentCore"
logo: "aws"
website: "https://aws.amazon.com/bedrock/agentcore/"
area: "deploy"
---

[Amazon Bedrock AgentCore Runtime](https://aws.amazon.com/bedrock/agentcore/) hosts agents as containers and
authenticates their callers. `@mayurajs/deploy-agentcore` adds `agentcore` as a target for
[`mayura deploy`](../cli/deploy.md): `deploy init` writes a small server for AgentCore's HTTP contract that calls an
`invoke` function you export, and each release builds an ARM64 image, updates the runtime to it and waits until it is
ready, with the AWS CLI and Docker, signed in as you. The package has no dependencies besides `mayura`. It runs inside
the `mayura` CLI on Node.js 22 or 24, on your machine or in CI; the generated server runs on Node.js in the image.

Unlike the other targets, this one runs one module's `invoke` per request rather than `mayura serve` and
`mayura worker`. Each invocation is request-bound: it finishes inside its request.

## Install

```bash
npm install mayura
npm install --save-dev @mayurajs/deploy-agentcore
```

`mayura deploy` loads the target from the project's own `node_modules`, so a dev dependency is enough. You also need
[AWS CLI v2](https://aws.amazon.com/cli/) and Docker on your `PATH`. Building ARM64 images on an x86 machine needs
Docker's emulation, which Docker Desktop includes. On Windows, use the AWS CLI's `aws.exe`: the arguments carry JSON,
which a `.cmd` wrapper could not take through cmd.exe.

## Credentials

Mayura reads no credentials. The AWS CLI uses its own: profiles, SSO or roles (the repository's `.env.example` uses
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_REGION`). Manage access in the
[IAM console](https://console.aws.amazon.com/iam/).

The signed-in identity calls `sts:GetCallerIdentity` and AgentCore's `UpdateAgentRuntime` and `GetAgentRuntime`, needs
`iam:PassRole` for the runtime's role, and must push to the ECR repository. Log Docker in to ECR yourself. Callers of
the runtime authenticate with AgentCore (SigV4 or OAuth) before requests reach the container.

## Use it

Your module, `src/agentcore.ts` compiled to `dist/src/agentcore.js` by default, exports
`invoke(payload, { sessionId, signal })`. It receives each invocation's JSON payload and returns a JSON value, or a
`Response` (an SSE stream, for example), which is passed through:

```ts
// src/agentcore.ts
import { createRuntime } from 'mayura';
import { assistant } from './assistant.js'; // your agent

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: { allow: ['model:openai.responses'] },
  scope: { principalId: 'agentcore', projectId: 'refunds' },
  limits: { maxCostMicros: 100_000, maxDurationMs: 300_000 },
});

export async function invoke(payload: { readonly question: string }, context: { readonly sessionId?: string; readonly signal: AbortSignal }) {
  const run = runtime.submit(assistant, { input: payload });
  context.signal.addEventListener('abort', () => run.cancel(), { once: true }); // the caller went away
  return run.result();
}
```

With `migrate: true`, the module also exports `migrate()`, as the [deployment guide](../guides/deployment.md) shows.

```bash
mayura deploy init --target agentcore --apply   # writes deploy/agentcore/
```

**Once:** push a first image and create the runtime from it with
`aws bedrock-agentcore-control create-agent-runtime`. Then set its region, id and role:

```json
{
  "format": "mayura.deploy.v1",
  "name": "refunds",
  "image": "123456789012.dkr.ecr.us-east-1.amazonaws.com/refunds-agent",
  "targets": {
    "agentcore": {
      "region": "us-east-1",
      "agentRuntimeId": "refunds_agent-A1B2C3D4E5",
      "roleArn": "arn:aws:iam::123456789012:role/refunds-agentcore",
      "environment": { "DATABASE_SECRET_ARN": "arn:aws:secretsmanager:us-east-1:123456789012:secret:refunds/db" }
    }
  }
}
```

```bash
npm run build                                                           # the plan does not compile your code
mayura deploy --target agentcore --tag v42                              # prints the plan and its digest
mayura deploy --target agentcore --tag v42 --apply --confirm <digest>
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `region` | none | The AWS region; a release needs it. |
| `agentRuntimeId` | none | The runtime's id (`name-XXXXXXXXXX`) from `create-agent-runtime`; a release needs it. |
| `roleArn` | none | The IAM role the runtime runs as; AgentCore requires it on every update, so a release needs it. |
| `network` | `{ "mode": "PUBLIC" }` | Or `{ "mode": "VPC", "subnets": [...], "securityGroups": [...] }`, 1 to 16 of each. |
| `environment` | `{}` | The runtime's environment variables, set on every update: up to 50, each value at most 4,096 characters. |
| `migrate` | `false` | Migrate storage from your machine before the update. |
| `module` | `agentcore.js` next to the app module | The compiled module that exports `invoke` (and `migrate`). |

Any other key under `targets.agentcore` is refused.

## Files it writes

| File | Contents |
| --- | --- |
| `deploy/agentcore/server.mjs` | AgentCore's HTTP contract on `0.0.0.0:8080` (or `PORT`). |
| `deploy/agentcore/Dockerfile` | Compiles your TypeScript, keeps production dependencies, and runs `node deploy/agentcore/server.mjs` as an unprivileged user on port 8080. |
| `deploy/agentcore/migrate.mjs` | Calls your module's `migrate()` and prints its report. |
| `.dockerignore` | Keeps `.env`, local data and SQLite files out of the image. |

The server:

- `POST /invocations` parses the JSON body (at most 10 MiB) and calls `invoke` with the session id from
  `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`. A JSON result is sent as JSON; a `Response` is streamed through.
- `GET /ping` answers `Healthy`, or `HealthyBusy` while invocations run, so AgentCore keeps the session alive.
- If the caller disconnects, `signal` aborts.
- Answers `400` for invalid JSON, `413` for a body over 10 MiB, `404` for any other path, and `500`
  `{"error":"invocation_failed"}` when `invoke` throws. The error's text stays in the container's logs.
- Closes on `SIGTERM`.

## A release

| Step | Command | Output it must print |
| --- | --- | --- |
| `check-account` | `aws sts get-caller-identity` | A 12-digit account id. |
| `build-image` | `docker build --file deploy/agentcore/Dockerfile --platform linux/arm64 --provenance=false --tag <image>:<tag> .` | |
| `push-image` | `docker push <image>:<tag>` | |
| `migrate` | `node deploy/agentcore/migrate.mjs` | Only with `migrate: true`. |
| `update-runtime` | `aws bedrock-agentcore-control update-agent-runtime` with the image, role, network, `HTTP` protocol and environment | `UPDATING` or `READY`. |
| `runtime-ready` | `aws bedrock-agentcore-control get-agent-runtime --query status` | `READY`. While `UPDATING`, it asks again every 5 seconds, up to 120 times. |

AgentCore runs ARM64 containers, so the image is a single-platform ARM64 manifest without an attestation. Any other
status, such as `UPDATE_FAILED`, fails the release. The `migrate` step runs your compiled module on your machine, so
build before you release.

## Secrets and environment

- `environment` is set on the runtime with every update and appears in the plan. Keep it to plain configuration, such
  as a secret's ARN for your module to read with the runtime's role; never secret values.
- The `migrate` step uses the `DATABASE_URL` in your own environment; Mayura never reads it, your module does.
- `env` in `mayura.deploy.json` is not used by this target.

## What it never does

- Create the runtime, its role, the ECR repository or your secrets.
- Read credentials, or run a shell: each step is `aws`, `docker` or `node` with its arguments as planned.
- Return your module's error text to a caller.

## Errors

Failures are `MayuraError`s with a `code`; the CLI prints the code and message and exits with 1.

| `code` | When |
| --- | --- |
| `INVALID_CONFIG` | A setting is malformed or unknown; a release without `region`, `agentRuntimeId` and `roleArn`, or without an `image`. |
| `NOT_FOUND` | A file under `deploy/agentcore/` is missing: run `deploy init` first. A tool is not on your `PATH`. |
| `PERMISSION_DENIED` | `--confirm` is not the digest of the plan. |
| `INVALID_INPUT` | On Windows, `aws` is a `.cmd` wrapper: the JSON arguments hold `"`, which cmd.exe would interpret. Use `aws.exe`. |
| `TOOL_FAILED` | A tool could not be started. |

A step that exits non-zero, or whose output does not match, fails the run, skips the rest, and the CLI exits with 1.

## How it is tested

- Unit tests start the generated server against a stub module and check the contract: `/invocations` calls `invoke`
  with the session id, `/ping` reports `HealthyBusy` during a slow invocation, a `Response` streams through, and bad
  JSON, unknown paths, oversized bodies and a throwing module get their status codes without the module's error text.
- A fake AWS CLI answers each step, including `UPDATING` before `READY`; the tests check the image, role, network and
  environment arguments, the migration step in a VPC setup, and that `UPDATE_FAILED` or an error message fails the
  release. Releases without the runtime, role or image, and malformed settings, are refused.
- The package has not yet deployed to a real AWS account.

## Related

- [Deploy with mayura deploy](../cli/deploy.md): plans, digests, output checks and `mayura.deploy.json`.
- [Agents](../concepts/agent.md): the runtime and runs your `invoke` uses.
- [AgentCore sandboxes](sandbox-agentcore.md): AgentCore's code interpreter as a sandbox provider.
- [AWS Lambda deploy target](deploy-aws-lambda.md): the whole app as Lambda functions.
