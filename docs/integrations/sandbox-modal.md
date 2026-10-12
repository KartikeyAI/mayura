---
title: "Modal sandboxes"
description: "Run agent commands in Modal Sandboxes with @mayurajs/sandbox-modal: setup, options, network rules, tunnels, limits and errors."
package: "@mayurajs/sandbox-modal"
vendor: "Modal"
logo: "modal"
website: "https://modal.com"
area: "sandboxes"
---

[Modal Sandboxes](https://modal.com/docs/guide/sandboxes) run containers from any registry image under gVisor, or in a
VM. `@mayurajs/sandbox-modal` plugs them into [`mayura/sandbox`](../guides/sandboxes.md), so agents get Modal
sandboxes through the same `createSandboxes` pool, limits and tools as the built-in Docker sandboxes. It uses Modal's
JavaScript SDK, `modal` (pinned at 0.11.0 and installed with the package), which talks gRPC and brings its own
dependencies (gRPC and protobuf). It runs on Node, Deno and Bun, not on edge runtimes.

## Install

```bash
npm install mayura @mayurajs/sandbox-modal
```

## Credentials

Create a token id and secret in your [Modal settings](https://modal.com/settings/tokens), or with `modal token new`.
Pass them in yourself, for example from `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET`, or pass a `ModalClient` you create
and own. Modal's SDK still reads its own settings (`~/.modal.toml`, and variables such as `MODAL_SERVER_URL` and
`MODAL_ENVIRONMENT`) for anything you do not pass.

## Use it

```ts
import { createSandboxes, sandboxTools } from 'mayura/sandbox';
import { modalSandboxes } from '@mayurajs/sandbox-modal';

const sandboxes = createSandboxes(modalSandboxes({
  tokenId: process.env.MODAL_TOKEN_ID ?? '',
  tokenSecret: process.env.MODAL_TOKEN_SECRET ?? '',
  image: 'python:3.13-slim',
}), {
  maxSandboxes: 5,
  maxLifetimeMs: 3_600_000,
  network: ['none', 'allowlist'],
});

const sandbox = await sandboxes.create({ lifetimeMs: 600_000, network: { allow: ['pypi.org', 'files.pythonhosted.org'] } });
await sandbox.exec(['pip', 'install', 'requests']);
const result = await sandbox.exec(['python', '-c', 'print(6 * 7)']);
console.log(result.exitCode, result.stdout); // 0 "42\n"
await sandbox.release();

// Or give an agent tools that work in the sandbox; grant tool:workspace.exec, sandbox:workspace:exec and effect:write.
const tools = sandboxTools(sandbox, { name: 'workspace', exec: true });
```

`createSandboxes` enforces your limits (how many sandboxes, how long each lives, which networks it may ask for) before
Modal is called. See [Sandboxes](../guides/sandboxes.md) for the pool, per-run sandboxes and every tool.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `tokenId`, `tokenSecret` | required without `client` | Your Modal token. |
| `client` | none | A `ModalClient` from `modal` you own, instead of a token. It is never closed here. |
| `environment` | your default | The Modal environment. |
| `app` | `mayura-sandboxes` | The Modal App sandboxes belong to, created if missing. |
| `image` | required | The registry image sandboxes run, such as `python:3.13-slim`. A sandbox's own `image` overrides it. |
| `workdir` | `/workspace` | The working directory, made when the sandbox starts. |
| `runtime` | Modal's choice | `gvisor`, or `vm` (which can run Docker). |
| `regions` | Modal's choice | The regions sandboxes may run in, such as `['us-east-1']`. |
| `maxLifetimeMs` | 24 hours | The longest lifetime: 1 s to 24 hours, Modal's most. |

A sandbox's `cpus` and `memoryMiB` go to Modal as asked, its `env` becomes the sandbox's environment, and its `labels`
become Modal tags. Its lifetime becomes Modal's timeout, after which Modal ends it; a release terminates it sooner. A
sandbox whose working directory cannot be made is terminated, and `create` fails.

## Network and ports

- **`'none'`** blocks all network access.
- **`'all'`** allows it.
- **`{ allow: [domains] }`** is Modal's outbound domain allowlist, matched on TLS SNI, denying everything else.

Ports you list are served through Modal's encrypted tunnels; `url(port)` gives the tunnel's URL. Without ports,
nothing is served.

## Commands and files

Commands run with Modal's exec in binary mode, through `sh` in their directory, with their environment. Standard input
is passed as given, then closed; a command may stop reading and exit before taking all of it, and its exit code says
how it went. Only as much output as you keep (`maxOutputBytes`) is read.

A timeout or cancellation kills every process the command started, found by a tag in their environment, and the
command's streams close.

Files are read, written, listed and removed through commands in the sandbox, so the image needs a POSIX shell and the
usual tools. Reads stop at the size you allow and fail with `LIMIT_EXCEEDED` beyond it.

## Errors

Failures reach you as a `SandboxError` with a `reason`, mapped from Modal's errors without Modal's text:

| `reason` | When |
| --- | --- |
| `authentication` | Modal refused the token (gRPC `PERMISSION_DENIED` or `UNAUTHENTICATED`). |
| `quota` | Modal's resources were exhausted (`ResourceExhaustedError`). |
| `rate_limited` | Modal refused for rate limits (gRPC `RESOURCE_EXHAUSTED`). |
| `gone` | The sandbox no longer exists, for example after its timeout (`NotFoundError`, `SandboxTimeoutError`, gRPC `NOT_FOUND`). |
| `timeout` | Modal gave up on a call (`TimeoutError`, gRPC `DEADLINE_EXCEEDED`). |
| `unavailable` | Modal could not be reached, or failed (`InternalFailure`, `ClientClosedError`, gRPC `UNAVAILABLE`, or any other error). |
| `rejected` | Modal refused the request (`InvalidError`, `ConflictError`, `AlreadyExistsError`, gRPC `INVALID_ARGUMENT`), or the working directory could not be made. |

Configuration mistakes, such as a missing token or an unknown `runtime`, fail with `INVALID_CONFIG` when you call
`modalSandboxes()`, before anything is sent.

## How it is tested

- Unit tests run the package against a `ModalClient` stand-in that checks the sandbox's settings, each command and its
  input, bounded output, killing by tag, tunnels and error mapping.
- An integration test runs the [sandbox conformance suite](../guides/sandboxes.md#writing-a-provider) against the
  stand-in with each exec run for real by `docker exec` in a local container.
- The conformance suite runs against real Modal sandboxes, with checks of the network and ports, in
  `scripts/live/sandbox-modal.mjs`: all 16 cases passed on October 6, 2026, after a fix. Standard input is now ended
  with `stdin.close()`, as `closeStdin()` never resolves in Modal's SDK 0.11.

## Related

- [Sandboxes](../guides/sandboxes.md): pools, per-run sandboxes, tools and network rules.
- [E2B sandboxes](sandbox-e2b.md) and [Vercel Sandbox](sandbox-vercel.md): other providers that filter by domain.
- [Code Mode](../guides/code-mode.md): run model-written programs in a sandbox.
