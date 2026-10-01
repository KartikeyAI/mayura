# @mayurajs/deploy-aws-lambda

[AWS Lambda](https://aws.amazon.com/lambda/) as a `mayura deploy` target. One container image serves three
functions: the API behind a function URL, the workflows function that EventBridge Scheduler invokes every minute,
and a migration function that each release runs before anything else is updated. Lambda support in Mayura is
experimental (see [Serverless functions](https://mayurajs.com/docs/guides/deployment/#serverless-functions)).

```bash
npm install --save-dev @mayurajs/deploy-aws-lambda
mayura deploy init --target aws-lambda --apply
mayura deploy --target aws-lambda             # prints the plan and its digest
mayura deploy --target aws-lambda --apply --confirm <digest>
```

**Your module.** Write the serverless module the deployment guide describes (`src/mayura.ts`, with request-bound runs
and `pool: { max: 1 }`), and add a migration to it:

```ts
export async function migrate() { await ready; return { schemaVersion: 1 }; }
```

**`deploy init` writes:**
- `deploy/aws-lambda/Dockerfile`: built on AWS's Lambda Node.js base image in both stages, so native modules match
  Amazon Linux;
- `api.mjs`, `workflows.mjs` and `migrate.mjs`: three handlers that call `handle`, `advanceWorkflows` and `migrate`
  from your compiled module (`dist/src/mayura.js` by default).

**Once, before the first release**, create the three functions from the image:
- `<name>-api` with the image command `deploy/aws-lambda/api.handler`, a function URL and a timeout above your agents'
  `maxDurationMs`;
- `<name>-workflows` with `deploy/aws-lambda/workflows.handler`, a 60-second timeout and an EventBridge Scheduler rule
  every minute;
- `<name>-migrate` with `deploy/aws-lambda/migrate.handler` and a timeout of up to 900 seconds.

Give them their environment (`DATABASE_URL` and the app's variables, for example from Secrets Manager) and, for a
private database, the VPC.

**A release:**
1. Checks the signed-in account.
2. Builds the image for one platform (`linux/amd64`, or `arm64`) without a provenance attestation, which Lambda would
   refuse, and pushes it.
3. Points `<name>-migrate` at the image, waits for the update, invokes it, and requires that it reports no function
   error.
4. Only then updates `<name>-api` and `<name>-workflows`, waiting for each.

Each step's output is checked: an unexpected answer stops the release.

**Settings** in `mayura.deploy.json` under `targets.aws-lambda`:
- `region`;
- `nodeVersion` (22 or 24);
- `architecture` (`x86_64` or `arm64`);
- `module`.

The AWS CLI uses its own credentials; Mayura reads none.

See [Deploy with mayura deploy](https://mayurajs.com/docs/cli/deploy/). Apache-2.0.
