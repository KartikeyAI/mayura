---
title: "Apple container sandboxes"
description: "Run agent commands in lightweight VMs on your Mac with @mayurajs/sandbox-apple-container: setup, options, the host-only network and errors."
package: "@mayurajs/sandbox-apple-container"
vendor: "Apple"
logo: "apple"
website: "https://github.com/apple/container"
area: "sandboxes"
---

[Apple's `container`](https://github.com/apple/container) runs each Linux container in its own lightweight VM on a Mac.
`@mayurajs/sandbox-apple-container` makes each sandbox one such container and plugs them into
[`mayura/sandbox`](../guides/sandboxes.md), so agents get them through the same `createSandboxes` pool, limits and
tools as the built-in Docker sandboxes. It drives the `container` command line as a child process, without a shell,
and has no dependencies. It runs on Node only, on a Mac with macOS 26 on Apple silicon, with `container` installed and
its system service started (`container system start`).

## Install

```bash
npm install mayura @mayurajs/sandbox-apple-container
```

Then pull the images your sandboxes run: **images are never pulled for you.**

```bash
container image pull docker.io/library/python:3.13-slim
```

## Credentials

None: sandboxes run on your Mac. Nothing is read from the environment.

## Use it

```ts
import { createSandboxes, sandboxTools } from 'mayura/sandbox';
import { appleContainerSandboxes } from '@mayurajs/sandbox-apple-container';

const sandboxes = createSandboxes(appleContainerSandboxes({
  image: 'docker.io/library/python:3.13-slim',
  hostOnlyNetwork: 'mayura-offline',
}), {
  maxSandboxes: 4,
  maxLifetimeMs: 3_600_000,
});

const sandbox = await sandboxes.create({ lifetimeMs: 600_000 }); // network 'none': on the host-only network
const result = await sandbox.exec(['python3', '-c', 'print(6 * 7)']);
console.log(result.exitCode, result.stdout); // 0 "42\n"
await sandbox.release();

// Or give an agent tools that work in the sandbox; grant tool:workspace.exec, sandbox:workspace:exec and effect:write.
const tools = sandboxTools(sandbox, { name: 'workspace', exec: true });
```

`createSandboxes` enforces your limits before anything is run. See [Sandboxes](../guides/sandboxes.md) for the pool,
per-run sandboxes and every tool.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `image` | required | The image sandboxes run, such as `docker.io/library/alpine:3.22`. It must be on this Mac already. A sandbox's own `image` overrides it. |
| `cli` | `['container']` | The `container` command line, as program and arguments, for one that is not on the `PATH`. |
| `hostOnlyNetwork` | none | A host-only network for sandboxes created with the network `'none'`. See below. |
| `user` | the image's | The user commands run as, such as `1000:1000`. |
| `workdir` | `/workspace` | The working directory, made when the sandbox starts. |
| `cpus` | 2 | The CPUs each sandbox gets, and the most one may ask for; 1 to 64. |
| `memoryMiB` | 1,024 | The memory each sandbox gets, and the most one may ask for; 64 to 1,048,576. |
| `maxLifetimeMs` | 24 hours | The longest lifetime; 1 s to about 24 days. |

A sandbox may ask for fewer whole `cpus` and less `memoryMiB`, never more. Its `labels` become container labels, beside
`mayura.sandbox=true`. A sandbox whose working directory cannot be made is deleted, and `create` fails.

## Lifetime

Each container runs `sleep` for the sandbox's lifetime, under an init that reaps processes, and is removed when it ends
(`--rm`). A release deletes it sooner (`container delete --force`); one already gone counts as released.

## Network and ports

**Apple's `container` has no network that reaches nothing.** What this provider can enforce depends on
`hostOnlyNetwork`:

- **Without it**, `features.network` is `['all']` only: list `'all'` in the `network` option of `createSandboxes` and
  ask for it in `create`. The default `'none'` fails with `INVALID_INPUT` before anything is run.
- **With it**, sandboxes created with `'none'` go on that host-only network, made with
  `container network create --internal` if it is missing. It reaches no further than this Mac, **but it does reach this
  Mac**: services listening on it are reachable from the sandbox. Sandboxes created with `'all'` use the default
  network.

Domain allowlists, ports and a desktop are not available.

## Commands and files

Commands run with `container exec`, through `sh` in their directory. The sandbox's `env` is written to a file in the
sandbox when it is created, and each command's own `env` to a file that is read and removed before the command starts,
so no value of `env` is ever on a command line on your Mac. Standard input is passed to the command, and only as much output as
you keep (`maxOutputBytes`) is read.

A timeout or cancellation kills every process the command started, found by a tag in their environment, then the
`container exec` process.

Files are read, written, listed and removed through commands in the sandbox, so the image needs a POSIX shell and the
usual tools. Reads stop at the size you allow and fail with `LIMIT_EXCEEDED` beyond it.

## Errors

| Error | When |
| --- | --- |
| `INVALID_CONFIG` | The image is not on this Mac, the `container` command line is not found, or an option is out of range. |
| `INVALID_INPUT` | A sandbox asks for ports, more CPUs or memory than allowed, or a network the provider cannot enforce. |
| `SandboxError` `rejected` | `container` failed to start the sandbox, make the host-only network or the working directory, or a file command failed. |
| `SandboxError` `timeout` | A `container` call did not finish in time. |
| `SandboxError` `unavailable` | The `container` command line could not be run, or failed to delete a sandbox. |

## How it is tested

- Unit tests check the configuration it refuses, the networks it claims, and that ports, extra CPUs or memory, and a
  missing command line are refused before anything runs.
- An integration test runs the [sandbox conformance suite](../guides/sandboxes.md#writing-a-provider) through a
  stand-in `container` that runs the same command lines with Docker, whose flags match, and checks the host-only
  network, that no environment is left behind, and that a failed setup is deleted.
- It has not been run against a real Mac yet: the live check, `scripts/live/sandbox-apple-container.mjs`, needs a Mac
  with macOS 26 on Apple silicon.

## Related

- [Sandboxes](../guides/sandboxes.md): pools, per-run sandboxes, tools and the built-in Docker sandboxes.
- [Fly.io Machines sandboxes](sandbox-fly.md): another provider that cannot keep sandboxes offline.
- [Code Mode](../guides/code-mode.md): run model-written programs in a sandbox.
