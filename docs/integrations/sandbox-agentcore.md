---
title: "Amazon Bedrock AgentCore sandboxes"
description: "Run agent commands in AgentCore Code Interpreter sessions with @mayurajs/sandbox-agentcore: IAM, options, network modes, limits and errors."
package: "@mayurajs/sandbox-agentcore"
vendor: "AWS"
logo: "aws"
website: "https://aws.amazon.com"
area: "sandboxes"
---

[Amazon Bedrock AgentCore Code Interpreter](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-tool.html)
runs each session in a microVM. `@mayurajs/sandbox-agentcore` makes each sandbox a Code Interpreter session and plugs
them into [`mayura/sandbox`](../guides/sandboxes.md), so agents get them through the same `createSandboxes` pool,
limits and tools as the built-in Docker sandboxes. It uses the official AWS SDK, `@aws-sdk/client-bedrock-agentcore`
(pinned at 3.1141.0 and installed with the package), with its requests sent through `fetch`.

## Install

```bash
npm install mayura @mayurajs/sandbox-agentcore
```

## Credentials

Pass AWS credentials and a region, a function that returns fresh credentials (for example from your own STS call), or a
`BedrockAgentCoreClient` you create and own. Nothing is read from the environment, AWS config files or instance
metadata: pass the values in yourself, for example from `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_SESSION_TOKEN` and `AWS_REGION`.

Create the credentials in the [IAM console](https://console.aws.amazon.com/iam/). They need these actions on the Code
Interpreters you use:

- `bedrock-agentcore:StartCodeInterpreterSession`
- `bedrock-agentcore:InvokeCodeInterpreter`
- `bedrock-agentcore:StopCodeInterpreterSession`

## Use it

```ts
import { createSandboxes, sandboxTools } from 'mayura/sandbox';
import { agentCoreSandboxes } from '@mayurajs/sandbox-agentcore';

const sandboxes = createSandboxes(agentCoreSandboxes({
  region: process.env.AWS_REGION ?? 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
  },
}), {
  maxSandboxes: 5,
  maxLifetimeMs: 3_600_000,
});

const sandbox = await sandboxes.create({ lifetimeMs: 900_000 });
const result = await sandbox.exec(['python3', '-c', 'print(6 * 7)']);
console.log(result.exitCode, result.stdout); // 0 "42\n"
await sandbox.release();

// Or give an agent tools that work in the sandbox; grant tool:workspace.exec, sandbox:workspace:exec and effect:write.
const tools = sandboxTools(sandbox, { name: 'workspace', exec: true });
```

`agentCoreClient({ region, credentials, fetch })`, also exported, builds the same client on its own, configured only
from what you pass.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `region` | required with `credentials` | The AWS region, such as `us-east-1`. |
| `credentials` | required without `client` | `accessKeyId`, `secretAccessKey` and optionally `sessionToken`, or a function returning them. |
| `client` | none | A `BedrockAgentCoreClient` you own, instead of `region` and `credentials`. It is never destroyed here. |
| `codeInterpreter` | `aws.codeinterpreter.v1` | The Code Interpreter sessions start on. A sandbox's own `image` names another. |
| `network` | `'none'` | What the Code Interpreter's network mode lets sessions reach: `'none'` or `'all'`. See below. |
| `workdir` | `/tmp/workspace` | The working directory, made when the session starts. |
| `maxLifetimeMs` | 8 hours | The longest lifetime: 1 s to 8 hours, AWS's most. |
| `maxCommandBytes` | 60,000 | The most bytes of a command line AgentCore takes, used to size pieces of files; at least 8 KiB. |
| `fetch` | `globalThis.fetch` | For tests and proxies, with `region` and `credentials`. |

A sandbox's lifetime becomes the session's timeout, and a release stops the session. Sessions have fixed resources:
`cpus` or `memoryMiB` fail with `INVALID_INPUT`. Labels are not sent to AWS. Sessions have no environment of their own,
so the sandbox's `env` goes with every command.

## Network and ports

A Code Interpreter's network mode is set when it is created, and Mayura cannot change it per session. The `network`
option says which mode yours has, and sandboxes are created only with that network:

- **`'none'`** for the sandbox mode, which AWS's own `aws.codeinterpreter.v1` uses: sessions reach only S3.
- **`'all'`** for the public mode, on a Code Interpreter you created with it. List `'all'` in the `network` option of
  `createSandboxes` and ask for it in `create`.

Asking for any other network fails with `INVALID_INPUT` before a session starts. Domain allowlists, ports and a desktop
are not available.

## Commands and files

AgentCore's `executeCommand` runs a short shell command line and answers with text, so this package builds on
[`commandSandboxBackend`](../guides/sandboxes.md#writing-a-provider):

- Each command starts in the background and is polled to its end, with its output in files in the session.
- At most 1 MiB of each output stream is read back, as base64, or less when you keep less (`maxOutputBytes`).
- AgentCore takes no standard input or environment per command, so both travel as files.
- Files are written in pieces that fit in one command line (`maxCommandBytes`), so large files and large standard input
  take many calls. Files are read 1 MiB at a time.
- A timeout or cancellation kills every process the command started, found by a tag in their environment.

The Code Interpreter needs a POSIX shell, `setsid`, `base64`, `stat`, `head` and `tail`.

## Errors

Failures reach you as a `SandboxError` with a `reason`, mapped from AWS's errors without AWS's text:

| `reason` | When |
| --- | --- |
| `authentication` | AWS refused the credentials (`AccessDeniedException`, `UnauthorizedException`). |
| `rate_limited` | AWS throttled the call (`ThrottlingException`). |
| `quota` | A service quota was reached (`ServiceQuotaExceededException`). |
| `gone` | The session no longer exists, for example after its lifetime ended (`ResourceNotFoundException`). |
| `unavailable` | AWS could not be reached, or failed (`InternalServerException`). |
| `rejected` | AWS refused the request (`ValidationException`, `ConflictException`), a command came back as an error, or the working directory could not be made. |
| `invalid_response` | AWS's reply, or an error it sent, was not what its API promises. |

Configuration mistakes, such as a missing region or credentials, fail with `INVALID_CONFIG` when you call
`agentCoreSandboxes()`, before anything is sent. A session whose working directory cannot be made is stopped.

## How it is tested

- Unit tests run the package through the real AWS SDK against a fake AgentCore API that answers in AWS's event-stream
  format: they check the signed requests, the session's settings, errors from replies and from within the stream, and
  that sessions are stopped.
- An integration test runs each `executeCommand` line for real with `sh` in a local Docker container: arguments,
  standard input, files in pieces, and stopping a command at its timeout.
- It has not been run against a real AWS account yet.

## Related

- [Sandboxes](../guides/sandboxes.md): pools, per-run sandboxes, tools and network rules.
- [Fly.io Machines sandboxes](sandbox-fly.md): another provider built on `commandSandboxBackend`.
- [Code Mode](../guides/code-mode.md): run model-written programs in a sandbox.
