---
title: "Amazon ECS deploy target"
description: "Deploy a Mayura app to Amazon ECS on Fargate with @mayurajs/deploy-aws-ecs: task definitions, a checked migration task, then the services."
package: "@mayurajs/deploy-aws-ecs"
vendor: "Amazon ECS"
logo: "aws"
website: "https://aws.amazon.com/ecs/"
area: "deploy"
---

[Amazon ECS](https://aws.amazon.com/ecs/) on Fargate runs containers without servers to manage.
`@mayurajs/deploy-aws-ecs` adds `aws-ecs` as a target for [`mayura deploy`](../cli/deploy.md): each release registers
the server and worker task definitions at the release's image, runs the migration as a one-off task and checks its
exit code, then rolls out both services and waits until they are stable, all with the AWS CLI, signed in as you.
Secrets come from Secrets Manager or SSM Parameter Store. The package has no dependencies besides `mayura`. It runs
inside the `mayura` CLI on Node.js 22 or 24, on your machine or in CI.

## Install

```bash
npm install mayura
npm install --save-dev @mayurajs/deploy-aws-ecs
```

`mayura deploy` loads the target from the project's own `node_modules`, so a dev dependency is enough. You also need
[AWS CLI v2](https://aws.amazon.com/cli/) and Docker on your `PATH`. On Windows, use the AWS CLI's `aws.exe`: the
arguments carry JSON, which a `.cmd` wrapper could not take through cmd.exe.

## Credentials

Mayura reads no credentials. The AWS CLI uses its own: profiles, SSO or roles (the repository's `.env.example` uses
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_REGION`). Manage access in the
[IAM console](https://console.aws.amazon.com/iam/).

The signed-in identity calls `sts:GetCallerIdentity`, `ecs:RegisterTaskDefinition`, `ecs:RunTask`,
`ecs:DescribeTasks`, `ecs:UpdateService` and `ecs:DescribeServices`, needs `iam:PassRole` for the execution and task
roles, and must push to the ECR repository. Log Docker in to ECR yourself:
`aws ecr get-login-password | docker login --username AWS --password-stdin <registry>`.

## Use it

Describe the account in `mayura.deploy.json`. `image` is an ECR repository:

```json
{
  "format": "mayura.deploy.v1",
  "name": "refunds",
  "image": "123456789012.dkr.ecr.eu-west-1.amazonaws.com/refunds",
  "env": ["OPENAI_API_KEY"],
  "targets": {
    "aws-ecs": {
      "region": "eu-west-1",
      "cluster": "agents",
      "subnets": ["subnet-0abc1234def567890"],
      "securityGroups": ["sg-0abc1234def567890"],
      "executionRoleArn": "arn:aws:iam::123456789012:role/refunds-execution",
      "secretPrefix": "arn:aws:secretsmanager:eu-west-1:123456789012:secret:refunds/"
    }
  }
}
```

```bash
mayura deploy init --target aws-ecs --apply   # writes deploy/aws-ecs/server-task.json and worker-task.json
```

**Once, before the first release**, create two services in the cluster: `<name>-server` behind your load balancer, with
its health check on `/readyz` port 8080, and `<name>-worker` with no load balancer. Then release:

```bash
mayura deploy --target aws-ecs --tag v42                              # prints the plan and its digest
mayura deploy --target aws-ecs --tag v42 --apply --confirm <digest>
```

Your app module is the one the [deployment guide](../guides/deployment.md#the-application-module) describes.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `region` | required | The AWS region, such as `eu-west-1`. |
| `cluster` | required | The ECS cluster name. |
| `subnets` | required | 1 to 16 subnet ids (`subnet-…`) the migration task runs in. |
| `securityGroups` | required | 1 to 16 security group ids (`sg-…`) for the migration task. |
| `assignPublicIp` | `false` | Whether the migration task gets a public IP. |
| `executionRoleArn` | required | The role ECS uses to pull the image, read secrets and write logs. |
| `taskRoleArn` | none | The role your app runs as, when it calls AWS. |
| `cpu` | `"512"` | Fargate CPU units: `"256"`, `"512"`, `"1024"`, `"2048"`, `"4096"`, `"8192"` or `"16384"`. |
| `memory` | `"1024"` | Fargate memory in MiB, as a string, from 512 to 122880. |
| `secrets` | `{}` | `{ "NAME": "<Secrets Manager or SSM parameter ARN>" }`. |
| `secretPrefix` | none | The start of an ARN that each name is appended to, such as `arn:aws:secretsmanager:…:secret:refunds/`. |

Any other key under `targets.aws-ecs` is refused. The settings are checked at `deploy init`, since the task definitions
are written from them.

## Files it writes

| File | Contents |
| --- | --- |
| `Dockerfile`, `.dockerignore` | The image every role runs, with the `mayura` CLI as its entry point. |
| `deploy/aws-ecs/server-task.json` | Family `<name>-server`, Fargate, `awsvpc`, your CPU, memory and roles; one container `app` running `serve --app <app>` on port 8080. |
| `deploy/aws-ecs/worker-task.json` | Family `<name>-worker`; the container runs `worker --app <app> --probe-host 0.0.0.0 --probe-port 9090` on port 9090. |
| `mayura.deploy.json` | Only when the project has none. |

Each container has the image placeholder `mayura-app-image`, `stopTimeout: 45`, the secrets by ARN, a `wget` health
check on `/readyz`, and `awslogs` logging to `/ecs/<name>` with the role as stream prefix. The task definitions are yours
to edit (resources, logging, sidecars); keep the placeholder and each file's `family`.

## A release

| Step | Command | Output it must print |
| --- | --- | --- |
| `check-account` | `aws sts get-caller-identity` | A 12-digit account id. |
| `build-image`, `push-image` | `docker build`, `docker push` | |
| `register-server`, `register-worker` | `aws ecs register-task-definition --cli-input-json <file at the release's image>` | A task definition ARN, kept for later steps. |
| `migrate` | `aws ecs run-task --launch-type FARGATE --task-definition <server ARN> --overrides <migrate command>` | A task ARN. |
| `migrate-wait` | `aws ecs wait tasks-stopped --tasks <task ARN>` | |
| `migrate-check` | `aws ecs describe-tasks … --query tasks[0].containers[0].exitCode` | `0`. ECS reports a stopped task the same way whether or not it succeeded, so the exit code decides. |
| `roll-out-server`, `roll-out-worker` | `aws ecs update-service --service <name>-<role> --task-definition <ARN>` | The service's name. |
| `wait-stable` | `aws ecs wait services-stable --services <name>-server <name>-worker` | |

The migration runs as the server's new revision with its command overridden to `migrate --app <app>`, in your
subnets and security groups, started by `mayura-deploy`. Any unexpected output, such as an error message where an ARN
belongs, fails its step, so nothing rolls out after a failed or unclear migration.

## Secrets and environment

`DATABASE_URL` and every name in `env` come from Secrets Manager or SSM Parameter Store, by ARN, through the task
definitions' `secrets`. Each name takes its ARN from `secrets`, or else from `secretPrefix` followed by the name. A
name with neither is refused, and so is a value that is not such an ARN, so a secret's value can never end up in a
task definition. Only ARNs appear in a plan.

## What it never does

- Create the cluster, the services, the load balancer, the roles, the secrets or the ECR repository.
- Read credentials, or run a shell: each step is `aws` or `docker` with its arguments as planned.
- Roll out after a migration that did not exit with 0.

## Errors

Failures are `MayuraError`s with a `code`; the CLI prints the code and message and exits with 1.

| `code` | When |
| --- | --- |
| `INVALID_CONFIG` | A setting is malformed, missing or unknown; a variable has no secret; a release without an `image`; a task definition file is not JSON, lost the `mayura-app-image` placeholder, or changed its `family`. |
| `NOT_FOUND` | A task definition file is missing: run `deploy init` first. `aws` or `docker` is not on your `PATH`. |
| `PERMISSION_DENIED` | `--confirm` is not the digest of the plan, for example because a task definition file changed. |
| `INVALID_INPUT` | On Windows, `aws` is a `.cmd` wrapper: the JSON arguments hold `"`, which cmd.exe would interpret. Use `aws.exe`. |
| `TOOL_FAILED` | A tool could not be started. |

A step that exits non-zero, or whose output does not match, fails the run, skips the rest, and the CLI exits with 1.

## How it is tested

- Unit tests write the task definitions into a temporary project and check their family, Fargate settings, roles,
  commands, ports, secrets by ARN, health checks and logging.
- A fake AWS CLI answers each step with the output a successful release prints. The tests check the order of steps,
  that the registered definition carries the release's image, and that the run passes the captured ARNs on to
  `run-task`, the waits and `update-service`.
- With the fake CLI printing a non-zero exit code, `None`, an error message or nothing, the release fails at that step
  and never rolls out. Edited task definitions without the placeholder or family, and malformed settings, are refused.
- The package has not yet deployed to a real AWS account.

## Related

- [Deploy with mayura deploy](../cli/deploy.md): plans, digests, output checks and `mayura.deploy.json`.
- [Deployment](../guides/deployment.md#managed-container-platforms): ECS on Fargate among the managed container
  platforms.
- [AWS Lambda deploy target](deploy-aws-lambda.md): the serverless setup on AWS.
