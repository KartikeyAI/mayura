---
title: "Fly.io Machines sandboxes"
description: "Run agent commands in Fly.io Machines with @mayurajs/sandbox-fly: setup, options, why the network is always on, limits and errors."
package: "@mayurajs/sandbox-fly"
vendor: "Fly.io"
logo: "fly"
website: "https://fly.io"
area: "sandboxes"
---

[Fly.io Machines](https://fly.io/docs/machines/) are Firecracker VMs in a Fly app. `@mayurajs/sandbox-fly` makes each
sandbox a Machine in one of your apps and plugs them into [`mayura/sandbox`](../guides/sandboxes.md), so agents get
them through the same `createSandboxes` pool, limits and tools as the built-in Docker sandboxes. It talks to the
Machines API with `fetch`: no Fly SDK, no other dependencies, and it runs on every runtime Mayura runs on.

**Fly Machines reach the internet, and Fly cannot stop them.** This provider cannot keep a sandbox offline, so it only
makes sandboxes with the network `'all'`. Choose another provider where a sandbox must be offline.

## Install

```bash
npm install mayura @mayurajs/sandbox-fly
```

## Credentials

Create the app sandboxes run in first, then a deploy token for it, with Fly's command line:

```bash
fly apps create my-sandboxes
fly tokens create deploy --app my-sandboxes
```

You can also manage apps and tokens in the [Fly.io dashboard](https://fly.io/dashboard). A token starting with
`FlyV1 ` is sent as it is; any other is sent as a bearer token. The package reads nothing from the environment: pass
the token and app in yourself, for example from `FLY_API_TOKEN` and `FLY_APP`.

## Use it

```ts
import { createSandboxes, sandboxTools } from 'mayura/sandbox';
import { flySandboxes } from '@mayurajs/sandbox-fly';

const sandboxes = createSandboxes(flySandboxes({
  token: process.env.FLY_API_TOKEN ?? '',
  app: 'my-sandboxes',
  image: 'docker.io/library/node:24-slim',
}), {
  maxSandboxes: 5,
  maxLifetimeMs: 3_600_000,
  network: ['all'], // Fly Machines always reach the internet
});

const sandbox = await sandboxes.create({ lifetimeMs: 600_000, network: 'all' });
const result = await sandbox.exec(['node', '-e', 'console.log(6 * 7)']);
console.log(result.exitCode, result.stdout); // 0 "42\n"
await sandbox.release();

// Or give an agent tools that work in the sandbox; grant tool:workspace.exec, sandbox:workspace:exec and effect:write.
const tools = sandboxTools(sandbox, { name: 'workspace', exec: true });
```

`createSandboxes` enforces your limits before Fly is called. See [Sandboxes](../guides/sandboxes.md) for the pool,
per-run sandboxes and every tool.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `token` | required | A Fly.io API token for the app. |
| `app` | required | The Fly app sandboxes are Machines of. Create it first. |
| `image` | required | The image Machines run, such as `docker.io/library/alpine:3.22`. A sandbox's own `image` overrides it. |
| `region` | Fly's choice | The region, as a Fly region code such as `iad`. |
| `cpuKind` | `shared` | `shared` or `performance` CPUs. |
| `workdir` | `/workspace` | The working directory, made when the sandbox starts. |
| `maxLifetimeMs` | 24 hours | The longest lifetime; 1 s to about 24 days. |
| `apiUrl` | `https://api.machines.dev` | The Machines API. |
| `fetch` | `globalThis.fetch` | For tests and proxies. |

The image needs a POSIX shell, `sleep`, `setsid`, `base64`, `stat`, `head` and `tail`, as Alpine, Debian and most
language images have. A sandbox's `cpus` are whole (1 by default) and its `memoryMiB` a multiple of 256 (1,024 by
default); anything else fails with `INVALID_INPUT`. Its `env` becomes the Machine's environment and its `labels` the
Machine's metadata.

## Lifetime

A Machine's only process sleeps out the sandbox's lifetime, and the Machine is set to destroy itself when that process
ends, with no restarts. A release destroys it sooner. `create` waits until Fly reports the Machine started and makes the
working directory; a Machine that does not start, or whose working directory cannot be made, is destroyed.

## Network and ports

Fly Machines always reach the internet, so `features.network` is `['all']` only. List `'all'` in the `network` option
of `createSandboxes` and ask for it in `create`; the default `'none'` fails with `INVALID_INPUT` before a Machine is
made, rather than giving you an online sandbox you expected to be offline. Domain allowlists are not available.

No ports are served: Machines in an app share its address.

## Commands and files

Fly's exec runs a command for at most 60 seconds and answers with text, so this package builds on
[`commandSandboxBackend`](../guides/sandboxes.md#writing-a-provider):

- Each command starts in the background, in a session of its own, so it may run longer than one exec. It is polled to
  its end, with its output in files in the sandbox.
- Output and files move as base64, 1 MiB at a time. At most 1 MiB of each output stream is read back, or less when you
  keep less (`maxOutputBytes`).
- Standard input is passed to the command through a file.
- A timeout or cancellation kills every process the command started, found by a tag in their environment.

Large files take one exec call per MiB.

## Errors

Failures reach you as a `SandboxError` with a `reason`, mapped from Fly's answers without Fly's text:

| `reason` | When |
| --- | --- |
| `authentication` | The token is wrong or lacks access to the app (401, 403). |
| `quota` | Your plan or quota refused the call (402). |
| `rate_limited` | Fly's rate limits refused the call (429). |
| `gone` | The Machine no longer exists, for example after its lifetime ended (404, 410). |
| `timeout` | Fly gave up on a call (408, 504). |
| `unavailable` | Fly could not be reached, or failed (5xx). |
| `rejected` | Fly refused the request for another reason, including a missing app when creating, or a working directory that could not be made. |
| `invalid_response` | Fly's reply was not what its API promises. |

Configuration mistakes, such as an app name with capitals or a `region` that is not a Fly region code, fail with
`INVALID_CONFIG` when you call `flySandboxes()`, before anything is sent.

## How it is tested

- Unit tests run the package against a fake Machines API that checks every request: the Machine's configuration, its
  self-destruction, the token's form and the destruction of a Machine that does not start.
- An integration test runs the [sandbox conformance suite](../guides/sandboxes.md#writing-a-provider) against a
  stand-in Machines API whose Machines are local Docker containers, so the package's shell scripts run for real.
- It has not been run against a real Fly.io account yet.

## Related

- [Sandboxes](../guides/sandboxes.md): pools, per-run sandboxes, tools and network rules.
- [Amazon Bedrock AgentCore sandboxes](sandbox-agentcore.md): another provider built on `commandSandboxBackend`.
- [E2B sandboxes](sandbox-e2b.md): a provider that can keep sandboxes offline.
