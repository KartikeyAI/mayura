---
title: "Cloudflare sandboxes"
description: "Run agent commands in Cloudflare Sandboxes through your sandbox bridge Worker with @mayurajs/sandbox-cloudflare: setup, options and errors."
package: "@mayurajs/sandbox-cloudflare"
vendor: "Cloudflare"
logo: "cloudflare"
website: "https://www.cloudflare.com"
area: "sandboxes"
---

[Cloudflare Sandboxes](https://developers.cloudflare.com/sandbox/) are containers driven by Durable Objects.
`@mayurajs/sandbox-cloudflare` reaches them through the **sandbox bridge**, Cloudflare's reference Worker that exposes
the Sandbox SDK over HTTP, which you deploy in your own Cloudflare account. It plugs them into
[`mayura/sandbox`](../guides/sandboxes.md), so agents get them through the same `createSandboxes` pool, limits and
tools as the built-in Docker sandboxes. It talks to the bridge with `fetch`, with no dependencies, so it runs on every
runtime Mayura runs on: Node, Bun, Deno, Cloudflare Workers and Vercel Edge.

Only the bridge is supported: using the Sandbox SDK's binding from inside your own Worker is not, yet.

**Cloudflare sandboxes reach the internet**, and the bridge does not say whether its Worker blocks that, so this
provider only makes sandboxes with the network `'all'`.

## Install

```bash
npm install mayura @mayurajs/sandbox-cloudflare
```

## Credentials

Deploy the sandbox bridge Worker in your Cloudflare account, following [Cloudflare's Sandbox docs](https://developers.cloudflare.com/sandbox/),
and give it a `SANDBOX_API_KEY`. Pass that key as `apiKey`, which is sent to the bridge as a bearer token, and the
Worker's URL as `bridgeUrl`. The package reads nothing from the environment: pass both in yourself, for example from
`CF_SANDBOX_API_KEY` and `CF_SANDBOX_BRIDGE_URL`.

## Use it

```ts
import { createSandboxes, sandboxTools } from 'mayura/sandbox';
import { cloudflareSandboxes } from '@mayurajs/sandbox-cloudflare';

const sandboxes = createSandboxes(cloudflareSandboxes({
  bridgeUrl: process.env.CF_SANDBOX_BRIDGE_URL ?? 'https://sandbox-bridge.example.workers.dev',
  apiKey: process.env.CF_SANDBOX_API_KEY ?? '',
}), {
  maxSandboxes: 5,
  maxLifetimeMs: 3_600_000,
  network: ['all'], // Cloudflare sandboxes reach the internet
});

const sandbox = await sandboxes.create({ lifetimeMs: 600_000, network: 'all' });
const result = await sandbox.exec(['python3', '-c', 'print(6 * 7)']);
console.log(result.exitCode, result.stdout); // 0 "42\n"
await sandbox.release();

// Or give an agent tools that work in the sandbox; grant tool:workspace.exec, sandbox:workspace:exec and effect:write.
const tools = sandboxTools(sandbox, { name: 'workspace', exec: true });
```

`createSandboxes` enforces your limits before the bridge is called. See [Sandboxes](../guides/sandboxes.md) for the
pool, per-run sandboxes and every tool.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `bridgeUrl` | required | The URL of your sandbox bridge Worker. It must be `https`, or `localhost` or `127.0.0.1` while you develop the bridge. |
| `apiKey` | required | The bridge's `SANDBOX_API_KEY`. |
| `maxLifetimeMs` | 24 hours | The longest lifetime; 1 s to about 24 days. |
| `fetch` | `globalThis.fetch` | For tests and proxies. |

The image and instance type are set where the bridge is deployed, so a sandbox's `image`, `cpus` and `memoryMiB` fail
with `INVALID_INPUT`. Its labels are not sent. The working directory is `/workspace`. The bridge starts a sandbox's
container on first use, so `create` waits until a command runs in it, and deletes the sandbox if none does.

## Lifetime

The bridge has no lifetime to set. `createSandboxes` deletes each sandbox when its lifetime ends, if `release()` did not
first. Should the release never come, because the process holding it died, the sandbox stays until Cloudflare puts its
idle container to sleep.

## Network and ports

Cloudflare sandboxes reach the internet, so `features.network` is `['all']` only. List `'all'` in the `network` option
of `createSandboxes` and ask for it in `create`; the default `'none'` fails with `INVALID_INPUT` before a sandbox is
made. Domain allowlists, ports and a desktop are not available.

## Commands and files

The bridge's exec takes a command and its directory, but no environment and no standard input. So the sandbox's `env`,
the command's own, and a tag that marks its processes are written to a file that the command reads and removes before
it starts; standard input travels as a file too. Neither is ever on a command line, and both are removed afterwards.
Output streams back as events, and only as much as you keep (`maxOutputBytes`) is held.

A timeout or cancellation kills every process the command started, found by its tag.

The bridge writes files only under `/workspace`, so a write elsewhere is uploaded there and moved into place, making
the missing directories. Reads, listings and removals run as commands, so they reach any path; reads stop at the size
you allow and fail with `LIMIT_EXCEEDED` beyond it.

## Errors

Failures reach you as a `SandboxError` with a `reason`, mapped from the bridge's answers without its text:

| `reason` | When |
| --- | --- |
| `authentication` | The bridge refused the key (401, 403). |
| `quota` | A plan or quota limit refused the call (402). |
| `rate_limited` | The call was rate limited (429). |
| `gone` | The sandbox no longer exists (404, 410). |
| `timeout` | The call timed out (408, 504). |
| `unavailable` | The bridge could not be reached, or failed (5xx). |
| `rejected` | The bridge refused the request for another reason, including a 404 when creating, or reported an error for a command. |
| `invalid_response` | The bridge's reply was not what it promises. |

Configuration mistakes, such as a `bridgeUrl` that is not `https`, fail with `INVALID_CONFIG` when you call
`cloudflareSandboxes()`, before anything is sent.

## How it is tested

- Unit tests run the package against a fake bridge that answers in its wire formats and checks every request: the key,
  the staged environment and input files, killing by tag, untrusted replies, and deletion.
- An integration test runs the [sandbox conformance suite](../guides/sandboxes.md#writing-a-provider) against a fake
  bridge whose sandbox is a local Docker container.
- It has not been run against a real Cloudflare account yet: the live check, `scripts/live/sandbox-cloudflare.mjs`,
  needs the bridge Worker deployed.

## Related

- [Sandboxes](../guides/sandboxes.md): pools, per-run sandboxes, tools and network rules.
- [E2B sandboxes](sandbox-e2b.md) and [Vercel Sandbox](sandbox-vercel.md): other providers that run on every runtime.
- [Code Mode](../guides/code-mode.md): run model-written programs in a sandbox.
