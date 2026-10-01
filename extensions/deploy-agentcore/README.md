# @mayurajs/deploy-agentcore

[Amazon Bedrock AgentCore Runtime](https://aws.amazon.com/bedrock/agentcore/) as a `mayura deploy` target. A Mayura
agent behind AgentCore's HTTP contract, as an ARM64 image, released by updating the runtime and waiting until it is
ready.

```bash
npm install --save-dev @mayurajs/deploy-agentcore
mayura deploy init --target agentcore --apply
# Once: create the runtime (aws bedrock-agentcore-control create-agent-runtime) from a first image, then set
# targets.agentcore.region, agentRuntimeId and roleArn in mayura.deploy.json.
mayura deploy --target agentcore              # prints the plan and its digest
mayura deploy --target agentcore --apply --confirm <digest>
```

**Your module** (`src/agentcore.ts`, compiled to `dist/src/agentcore.js`) exports
`invoke(payload, { sessionId, signal })`. It receives each invocation's JSON payload and returns a JSON value, or a
`Response` (an SSE stream, for example), which is passed through:

```ts
import { createRuntime } from 'mayura';
import { assistant } from './assistant.js';

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

**`deploy init` writes:**
- `deploy/agentcore/server.mjs`: the AgentCore HTTP contract on `0.0.0.0:8080`.
  - `POST /invocations` calls `invoke`. Bodies are at most 10 MiB, and errors reach the caller without their text.
  - `GET /ping` answers `HealthyBusy` while invocations run, so AgentCore keeps the session alive.
  - AgentCore authenticates callers (SigV4 or OAuth) before requests reach the container.
- `deploy/agentcore/Dockerfile`: the image that runs the server.
- `deploy/agentcore/migrate.mjs`: for apps with storage.

**A release:**
1. Checks the signed-in account.
2. Builds the image for `linux/arm64` without a provenance attestation, and pushes it.
3. With `migrate: true`, migrates from your machine with the `DATABASE_URL` in your environment.
4. Updates the runtime to the image, with its role, network configuration and environment.
5. Waits until the runtime is `READY`. `UPDATE_FAILED` fails the release.

**Settings** in `mayura.deploy.json` under `targets.agentcore`:
- `region`, `agentRuntimeId` and `roleArn`;
- `network`: `{ "mode": "PUBLIC" }`, or a VPC with its subnets and security groups;
- `environment`: set on every update. Plain configuration only, such as a secret's ARN for your module to read with
  the runtime's role; never secret values.
- `migrate` (`false`);
- `module`.

The AWS CLI uses its own credentials; Mayura reads none. Building ARM64 images on an x86 machine needs Docker's
emulation, which Docker Desktop includes.

See [Deploy with mayura deploy](https://mayurajs.com/docs/cli/deploy/). Apache-2.0.
