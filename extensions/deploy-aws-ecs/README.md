# @mayurajs/deploy-aws-ecs

[Amazon ECS on Fargate](https://aws.amazon.com/ecs/) as a `mayura deploy` target, with the AWS CLI. A release
registers the server and worker task definitions at the release's image, runs the migration as a one-off task and
checks its exit code, then rolls out both services and waits for them to be stable.

```bash
npm install --save-dev @mayurajs/deploy-aws-ecs
```

First, describe the account in `mayura.deploy.json`. `image` is an ECR repository:

```json
{
  "format": "mayura.deploy.v1",
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
mayura deploy --target aws-ecs                # prints the plan and its digest
mayura deploy --target aws-ecs --apply --confirm <digest>
```

**Once, before the first release:** create the `<name>-server` service (behind your load balancer, health check
`/readyz` on port 8080) and the `<name>-worker` service in the cluster. Log Docker in to ECR:
`aws ecr get-login-password | docker login --username AWS --password-stdin <registry>`.

A release:

1. Checks the signed-in account with `aws sts get-caller-identity`.
2. Builds and pushes the image.
3. Registers both task definitions at the release's image.
4. Migrates:
   1. `run-task` with the server's new revision and a `migrate` command;
   2. waits until the task stops;
   3. requires its exit code to be `0`, because ECS reports a stopped task the same way whether or not it succeeded.
5. Updates both services to the new revisions.
6. Waits until both are stable.

Each step's output is checked: an unexpected answer from the CLI stops the release before anything rolls out.

**Secrets.** `DATABASE_URL` and every name in `env` come from Secrets Manager or SSM Parameter Store, by ARN. Map
names in `secrets`, or give a `secretPrefix` that each name is appended to. A name with neither is refused.

**Settings** in `mayura.deploy.json` under `targets.aws-ecs`:
- `region`, `cluster`, `subnets` and `securityGroups`;
- `assignPublicIp` (`false`);
- `executionRoleArn` and `taskRoleArn`;
- `cpu` (`"512"`) and `memory` (`"1024"`);
- `secrets` and `secretPrefix`.

The task definition files are yours to edit (resources, logging, sidecars). Keep the image placeholder
`mayura-app-image` and each file's `family`.

The AWS CLI uses its own credentials (profiles, SSO, roles); Mayura reads none. Use AWS CLI v2 (`aws.exe` on
Windows): arguments carry JSON, which a `.cmd` wrapper could not take.

See [Deploy with mayura deploy](https://mayurajs.com/docs/cli/deploy/). Apache-2.0.
