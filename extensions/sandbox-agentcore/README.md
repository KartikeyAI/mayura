# @mayurajs/sandbox-agentcore

[Amazon Bedrock AgentCore Code Interpreter](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-tool.html)
sessions as sandboxes for `mayura/sandbox`: a microVM per session, through the official AWS SDK
(`@aws-sdk/client-bedrock-agentcore`).

```bash
npm install mayura @mayurajs/sandbox-agentcore
```

```ts
import { createSandboxes } from 'mayura/sandbox';
import { agentCoreSandboxes } from '@mayurajs/sandbox-agentcore';

const sandboxes = createSandboxes(agentCoreSandboxes({ region: 'us-east-1', credentials }), { maxSandboxes: 5, maxLifetimeMs: 3_600_000 });
const sandbox = await sandboxes.create({ lifetimeMs: 900_000 });
const result = await sandbox.exec(['python3', '-c', 'print(6 * 7)']);
await sandbox.release();
```

- `region` and `credentials` (or a function returning them, or a `client` you own) are options: nothing is read
  from the environment, AWS config files or instance metadata. Requests go through `fetch`. IAM needs
  `bedrock-agentcore:StartCodeInterpreterSession`, `InvokeCodeInterpreter` and `StopCodeInterpreterSession`.
- Sessions start on AWS's own Code Interpreter, `aws.codeinterpreter.v1`, or the one in `codeInterpreter`; a
  sandbox's `image` names another. A session lives for the sandbox's lifetime (at most 8 hours), and release stops it.
- `network` states what the Code Interpreter's network mode, set when it was created, lets sessions reach: `'none'`
  (the default) for the sandbox mode, which reaches only S3, or `'all'` for the public mode. Mayura cannot change it
  per session, so sandboxes are created only with that network.
- Commands run through AgentCore's `executeCommand`: in the background, polled to their end, with output read back
  in base64 and bounded. AgentCore takes no standard input or environment per command, so both travel as files, and
  files are written in pieces that fit in a command line (`maxCommandBytes`, 60,000 by default): large files take many
  calls. A timeout or cancellation stops every process the command started.
- No ports, desktop, labels, CPUs or memory: sessions have fixed resources.

See the [sandbox guide](https://mayurajs.com/docs/guides/sandboxes/). Apache-2.0.
