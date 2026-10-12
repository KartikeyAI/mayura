---
title: "Railway sandboxes"
description: "Run agent commands in Railway Sandboxes with @mayurajs/sandbox-railway: setup, options, the idle timeout, ports, limits and errors."
package: "@mayurajs/sandbox-railway"
vendor: "Railway"
logo: "railway"
website: "https://railway.com"
area: "sandboxes"
---

[Railway Sandboxes](https://docs.railway.com/sandboxes) are Linux VMs on demand in a Railway environment.
`@mayurajs/sandbox-railway` plugs them into [`mayura/sandbox`](../guides/sandboxes.md), so agents get Railway
sandboxes through the same `createSandboxes` pool, limits and tools as the built-in Docker sandboxes. It uses
Railway's TypeScript SDK, `railway`, which you install yourself; the SDK uses Node's built-in modules, so this package
runs on Node.

**Railway sandboxes always have public internet egress.** This provider cannot keep a sandbox offline, so it only
makes sandboxes with the network `'all'`.

## Install

```bash
npm install mayura @mayurajs/sandbox-railway railway
```

Railway's SDK (`railway` 3.12.0 or a later 3.x) is an optional peer, loaded the first time a sandbox is created. It
brings the dependencies of its infrastructure-as-code command line (`graphql`, `tsx` and `esbuild`, which downloads its
binary when it installs), so Mayura does not install it for you. Without it, creating a sandbox fails with
`INVALID_CONFIG`.

## Credentials

Create an account or team API token on your [Railway tokens page](https://railway.com/account/tokens), or use a
project token with `authType: 'project-token'`. Sandboxes are created in the Railway environment you name with
`environmentId`. The package reads nothing from the environment: pass both in yourself, for example from
`RAILWAY_API_TOKEN` and `RAILWAY_ENVIRONMENT_ID`.

## Use it

```ts
import { createSandboxes, sandboxTools } from 'mayura/sandbox';
import { railwaySandboxes } from '@mayurajs/sandbox-railway';

const sandboxes = createSandboxes(railwaySandboxes({
  token: process.env.RAILWAY_API_TOKEN ?? '',
  environmentId: process.env.RAILWAY_ENVIRONMENT_ID ?? '',
}), {
  maxSandboxes: 5,
  maxLifetimeMs: 3_600_000,
  network: ['all'], // Railway sandboxes always reach the internet
});

const sandbox = await sandboxes.create({ lifetimeMs: 600_000, network: 'all' });
const result = await sandbox.exec(['node', '-e', 'console.log(6 * 7)']);
console.log(result.exitCode, result.stdout); // 0 "42\n"
await sandbox.release();

// Or give an agent tools that work in the sandbox; grant tool:workspace.exec, sandbox:workspace:exec and effect:write.
const tools = sandboxTools(sandbox, { name: 'workspace', exec: true });
```

`createSandboxes` enforces your limits before Railway is called. See [Sandboxes](../guides/sandboxes.md) for the pool,
per-run sandboxes and every tool.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `token` | required | A Railway API token, or a project token. |
| `authType` | `bearer` | `bearer` for an account or team API token, `project-token` for a project token. |
| `environmentId` | required | The Railway environment sandboxes are created in. |
| `region` | Railway's default | The region sandboxes run in. |
| `workdir` | `/workspace` | The working directory, made when the sandbox starts. |
| `maxLifetimeMs` | 24 hours | The longest lifetime; 1 minute to about 24 days. |
| `fetch` | the SDK's | For tests and proxies: the fetch Railway's SDK uses. |
| `sandboxApi` | the SDK's `Sandbox` | For tests: a stand-in that makes sandboxes. |

Sandboxes start from Railway's default image. A sandbox's `image`, `cpus` and `memoryMiB` fail with `INVALID_INPUT`; use
a Railway template for a custom image. Its `env` goes to Railway; its labels are not sent. A sandbox whose working
directory cannot be made is destroyed, and `create` fails.

## Lifetime and the idle timeout

Railway has no maximum lifetime, only an idle timeout. `createSandboxes` destroys each sandbox when its lifetime ends,
if `release()` did not first. As a backstop for a release that never comes, each sandbox gets Railway's idle timeout:
its lifetime in minutes, at least 1 and at most 5, the most Railway accepts.

So **Railway stops a sandbox left idle for 5 minutes**, whatever its lifetime, and calls after that fail with `gone`.
Keep a sandbox busy, or create another.

## Network and ports

Railway sandboxes always reach the internet, so `features.network` is `['all']` only. List `'all'` in the `network`
option of `createSandboxes` and ask for it in `create`; the default `'none'` fails with `INVALID_INPUT` before a
sandbox is made. Domain allowlists are not available.

Sandboxes are isolated from your environment's private network, except one created with `ports`: Railway publishes
ports only for sandboxes that join it. `url(port)` then gives the port's Railway domain, `https://<domain>/`.

## Commands and files

Commands run with Railway's exec, through `sh` in their directory, with their environment. Their output goes to files
in the sandbox, of which only as much as you keep (`maxOutputBytes`) is read back, and standard input travels as a file.

A timeout or cancellation kills the command's process group through Railway, and every process carrying its tag.

Files use Railway's file API. Reads stop at the size you allow and fail with `LIMIT_EXCEEDED` beyond it; a write makes
the missing parent directories; removing recursively runs `rm -rf` in the sandbox.

## Errors

Failures reach you as a `SandboxError` with a `reason`, mapped from Railway's errors without Railway's text:

| `reason` | When |
| --- | --- |
| `authentication` | Railway refused the token (`RailwayAuthError`, or 401 and 403). |
| `rate_limited` | Railway's rate limits refused the call (429). |
| `gone` | The sandbox no longer exists, for example after the idle timeout (`SandboxNotFoundError`, `ExecInterruptedError`). |
| `timeout` | Railway gave up on a call (`SandboxTimeoutError`). |
| `unavailable` | Railway could not be reached, or failed (`RailwayConnectionError`, 5xx, or any other error). |
| `rejected` | Railway refused the request (`SandboxFailedError`, `SandboxFilesError`, other API errors), or the working directory could not be made. |

Configuration mistakes, such as an `environmentId` that is not a Railway id, fail with `INVALID_CONFIG` when you call
`railwaySandboxes()`, before anything is sent.

## How it is tested

- Unit tests run the package against a stand-in for Railway's SDK that checks the sandbox's settings (isolation, idle
  timeout, ports), each command, killing through Railway and by tag, and error mapping.
- An integration test runs the [sandbox conformance suite](../guides/sandboxes.md#writing-a-provider) against a
  stand-in whose sandbox is a local Docker container.
- The conformance suite runs against real Railway sandboxes in `scripts/live/sandbox-railway.mjs`: 14 of 14 cases
  passed on October 6, 2026, after a fix. Railway accepts an idle timeout of at most 5 minutes, so an idle Railway
  sandbox stops then.

## Related

- [Sandboxes](../guides/sandboxes.md): pools, per-run sandboxes, tools and network rules.
- [Northflank sandboxes](sandbox-northflank.md) and [CodeSandbox sandboxes](sandbox-codesandbox.md): other providers
  whose sandboxes always reach the internet.
- [Code Mode](../guides/code-mode.md): run model-written programs in a sandbox.
