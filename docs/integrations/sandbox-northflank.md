---
title: "Northflank sandboxes"
description: "Run agent commands in Northflank microVM services with @mayurajs/sandbox-northflank: setup, options, lifetimes, limits and errors."
package: "@mayurajs/sandbox-northflank"
vendor: "Northflank"
logo: "northflank"
website: "https://northflank.com"
area: "sandboxes"
---

[Northflank](https://northflank.com/docs/v1/application/sandboxes) runs services in microVMs. `@mayurajs/sandbox-northflank`
makes each sandbox a deployment service in one of your projects and plugs them into
[`mayura/sandbox`](../guides/sandboxes.md), so agents get them through the same `createSandboxes` pool, limits and
tools as the built-in Docker sandboxes. It uses Northflank's JavaScript client, `@northflank/js-client` (pinned at
0.11.0 and installed with the package), and Node streams, so it runs on Node only.

**Northflank services reach the internet**, and this provider has no way to stop them, so it only makes sandboxes with
the network `'all'`.

## Install

```bash
npm install mayura @mayurajs/sandbox-northflank
```

## Credentials

Create an API token in the [Northflank app](https://app.northflank.com) with access to the project sandboxes run in.
For a team token, pass the team as `teamId`. The package reads nothing from the environment: pass the token and
project in yourself, for example from `NORTHFLANK_TOKEN` and `NORTHFLANK_PROJECT_ID`, or pass an `ApiClient` you create
and own as `client`.

## Use it

```ts
import { createSandboxes, sandboxTools } from 'mayura/sandbox';
import { northflankSandboxes } from '@mayurajs/sandbox-northflank';

const sandboxes = createSandboxes(northflankSandboxes({
  token: process.env.NORTHFLANK_TOKEN ?? '',
  projectId: process.env.NORTHFLANK_PROJECT_ID ?? '',
  image: 'ubuntu:24.04',
}), {
  maxSandboxes: 5,
  maxLifetimeMs: 3_600_000,
  network: ['all'], // Northflank services always reach the internet
});

const sandbox = await sandboxes.create({ lifetimeMs: 600_000, network: 'all' });
const result = await sandbox.exec(['uname', '-s']);
console.log(result.exitCode, result.stdout); // 0 "Linux\n"
await sandbox.release();

// Or give an agent tools that work in the sandbox; grant tool:workspace.exec, sandbox:workspace:exec and effect:write.
const tools = sandboxTools(sandbox, { name: 'workspace', exec: true });
```

`createSandboxes` enforces your limits before Northflank is called. See [Sandboxes](../guides/sandboxes.md) for the
pool, per-run sandboxes and every tool.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `token` | required without `client` | A Northflank API token. |
| `client` | none | An `ApiClient` from `@northflank/js-client` you own, instead of `token`. |
| `projectId` | required | The project sandboxes are services in. |
| `teamId` | none | The team that owns the project, for a team token. |
| `image` | required | The image sandboxes run, such as `ubuntu:24.04`. A sandbox's own `image` overrides it. |
| `deploymentPlan` | `nf-compute-20` | The deployment plan, which sets CPU and memory. |
| `workdir` | `/workspace` | The working directory, made when the sandbox starts. |
| `maxLifetimeMs` | 24 hours | The longest lifetime; 1 minute to about 24 days. |

Each sandbox is a deployment service named `mayura-<random>`, with one instance running your image with a process that
only sleeps. Its `env` becomes the service's runtime environment and its `labels` become Northflank tags as
`key-value`, at most 39 characters, with every character other than lowercase letters, digits and `-` made a `-`.
`cpus` and `memoryMiB` fail with `INVALID_INPUT`: choose a `deploymentPlan` instead.

A sandbox is ready once a command runs in it: `create` retries making the working directory until one does, and deletes
the service if that fails.

## Lifetime

**Northflank services have no lifetime of their own.** A release deletes the service, and `createSandboxes` releases
each sandbox when its lifetime ends. A service whose release never comes, because the process holding it died, keeps
running, and costing, until you delete it in Northflank.

## Network and ports

Northflank services reach the internet, so `features.network` is `['all']` only. List `'all'` in the `network` option
of `createSandboxes` and ask for it in `create`; the default `'none'` fails with `INVALID_INPUT` before a service is
made. Domain allowlists, ports and a desktop are not available.

## Commands and files

Commands run through Northflank's exec sessions, with `sh` in their directory. Northflank's exec takes no environment,
so a command's variables, and a tag that marks its processes, are set with `env` on its command line. Standard input is
streamed to the command, and only as much output as you keep (`maxOutputBytes`) is read.

A timeout or cancellation kills every process the command started, found by its tag, and the command's streams close.

Files are read, written, listed and removed through commands in the sandbox, so the image needs a POSIX shell and the
usual tools. Reads stop at the size you allow and fail with `LIMIT_EXCEEDED` beyond it.

## Errors

Failures reach you as a `SandboxError` with a `reason`, mapped from Northflank's answers without Northflank's text:

| `reason` | When |
| --- | --- |
| `authentication` | The token is wrong or lacks access (401, 403). |
| `quota` | Your plan or quota refused the call (402). |
| `rate_limited` | Northflank's rate limits refused the call (429). |
| `gone` | The service no longer exists (404). |
| `unavailable` | Northflank could not be reached, or failed (5xx, or an error with no status). |
| `rejected` | Northflank refused the request for another reason, or the working directory could not be made. |
| `timeout` | A call did not finish in time. |

Configuration mistakes, such as a `projectId` with capitals or a missing `image`, fail with `INVALID_CONFIG` when you
call `northflankSandboxes()`, before anything is sent.

## How it is tested

- Unit tests run the package against a stand-in for Northflank's client that checks the service it creates, each
  command and its input, killing by tag, deletion and error mapping.
- An integration test runs the [sandbox conformance suite](../guides/sandboxes.md#writing-a-provider) against the
  stand-in with each exec session run for real by `docker exec` in a local container.
- It has not passed against a real Northflank account yet: the test account needed a payment method.

## Related

- [Sandboxes](../guides/sandboxes.md): pools, per-run sandboxes, tools and network rules.
- [Railway sandboxes](sandbox-railway.md) and [Fly.io Machines sandboxes](sandbox-fly.md): other providers whose
  sandboxes always reach the internet.
- [Code Mode](../guides/code-mode.md): run model-written programs in a sandbox.
