---
title: "Vercel Sandbox"
description: "Run agent commands in Vercel Sandbox microVMs with @mayurajs/sandbox-vercel: setup, options, network rules, ports, limits and errors."
package: "@mayurajs/sandbox-vercel"
vendor: "Vercel"
logo: "vercel"
website: "https://vercel.com"
area: "sandboxes"
---

[Vercel Sandbox](https://vercel.com/docs/sandbox) runs each sandbox as a Firecracker microVM on Vercel.
`@mayurajs/sandbox-vercel` plugs it into [`mayura/sandbox`](../guides/sandboxes.md), so agents get Vercel machines
through the same `createSandboxes` pool, limits and tools as the built-in Docker sandboxes. It talks to Vercel's REST
API with `fetch`: no Vercel SDK, no other dependencies, and it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/sandbox-vercel
```

## Credentials

Pass one of these as `token`:

- A Vercel access token, created under [Account Settings → Tokens](https://vercel.com/account/tokens), with the
  `projectId` sandboxes belong to and, for a team, its `teamId`.
- The OIDC token of a Vercel deployment (`VERCEL_OIDC_TOKEN`), when your code runs on Vercel.

The package reads nothing from the environment: pass the values in yourself, for example from `VERCEL_TOKEN`,
`VERCEL_TEAM_ID` and `VERCEL_PROJECT_ID`.

## Use it

```ts
import { createSandboxes, sandboxTools } from 'mayura/sandbox';
import { vercelSandboxes } from '@mayurajs/sandbox-vercel';

const teamId = process.env.VERCEL_TEAM_ID;
const sandboxes = createSandboxes(vercelSandboxes({
  token: process.env.VERCEL_TOKEN ?? '',
  projectId: process.env.VERCEL_PROJECT_ID ?? '',
  ...(teamId ? { teamId } : {}),
}), {
  maxSandboxes: 5,
  maxLifetimeMs: 2_700_000,
  network: ['none', 'allowlist'],
});

const sandbox = await sandboxes.create({ lifetimeMs: 600_000, network: { allow: ['registry.npmjs.org'] } });
await sandbox.exec(['npm', 'install', 'left-pad']);
const result = await sandbox.exec(['node', '-e', 'console.log(6 * 7)']);
console.log(result.exitCode, result.stdout); // 0 "42\n"
await sandbox.release();

// Or give an agent tools that work in the sandbox; grant tool:workspace.exec, sandbox:workspace:exec and effect:write.
const tools = sandboxTools(sandbox, { name: 'workspace', exec: true });
```

`createSandboxes` enforces your limits (how many sandboxes, how long each lives, which networks it may ask for) before
Vercel is called. See [Sandboxes](../guides/sandboxes.md) for the pool, per-run sandboxes and every tool.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `token` | required | A Vercel access token, or a deployment's OIDC token. |
| `teamId` | none | The team that owns the sandboxes. |
| `projectId` | none | The project sandboxes belong to; needed with an access token. |
| `runtime` | `node24` | The runtime sandboxes start with: `node22`, `node24`, `node26` or `python3.13`. A sandbox's own `image` overrides it. |
| `region` | Vercel's choice | The region sandboxes run in, such as `iad1`. |
| `maxLifetimeMs` | 45 minutes | The longest lifetime your plan allows: 45 minutes on Hobby, up to 24 hours on Pro and Enterprise. |
| `apiUrl` | `https://api.vercel.com` | Vercel's API. |
| `fetch` | `globalThis.fetch` | For tests and proxies. |

What a sandbox asks for maps to Vercel's terms:

- **`image`** is one of the runtimes above, or else a container image (at most 255 characters).
- **`cpus`** is 1 or an even number up to 64, with 2,048 MiB of memory each. `memoryMiB` alone picks the CPUs that come
  with it; any other memory fails with `INVALID_INPUT`.
- **`labels`** become Vercel tags, at most 5.
- **`lifetimeMs`** becomes Vercel's timeout, after which Vercel stops the sandbox.

The working directory is `/vercel/sandbox`. Sandboxes never persist: they are created with `persistent: false`, and a
release stops the session and deletes the sandbox with its snapshots.

## Network and ports

- **`'none'`** is Vercel's `deny-all` policy.
- **`'all'`** is its `allow-all` policy.
- **`{ allow: [domains] }`** is a custom policy allowing those domains and denying everything else.

Ports you list (at most 15, each from 1024 to 65535) are served at the public URLs Vercel gives the sandbox, which
`url(port)` returns. Without ports, nothing is public.

## Commands and files

Commands run through `/bin/sh` in their directory, and their output streams back as it is written; only as much as
you keep (`maxOutputBytes`) is held. Vercel's API takes no standard input, so `features.stdin` is false and a command
given `stdin` fails with `INVALID_INPUT` before it runs.

A timeout or cancellation kills the command with `SIGKILL` through Vercel's API, then kills every process it started,
found by a tag in their environment.

Reads stream through Vercel's file API and stop at the size you allow, failing with `LIMIT_EXCEEDED` beyond it. A write
sends a gzipped tarball that Vercel extracts at `/`, so the exact path is kept (long and non-ASCII paths included) and
missing directories are made. Listing and removing run small shell scripts in the sandbox.

## Errors

Failures reach you as a `SandboxError` with a `reason`, mapped from Vercel's answers without Vercel's text:

| `reason` | When |
| --- | --- |
| `authentication` | The token is wrong or lacks access (401, 403). |
| `quota` | Your plan or quota refused the call (402). |
| `rate_limited` | Vercel's rate limits refused the call (429). |
| `gone` | The sandbox no longer exists, for example after its lifetime ended (404, 410, or a closed command stream). |
| `timeout` | Vercel gave up on a call (408, 504). |
| `unavailable` | Vercel could not be reached, or failed (5xx). |
| `rejected` | Vercel refused the request for another reason, including a missing project when creating. |
| `invalid_response` | Vercel's reply was not what its API promises. |

Configuration mistakes, such as an unknown `runtime` or a `maxLifetimeMs` over 24 hours, fail with `INVALID_CONFIG`
when you call `vercelSandboxes()`. Ports, CPUs, memory or labels Vercel cannot give fail with `INVALID_INPUT` before
anything is created.

## How it is tested

- Unit tests run the package against a fake Vercel API that answers in Vercel's wire formats: it checks every request,
  splits command streams mid-line as a network would, and unpacks every tarball written.
- The [sandbox conformance suite](../guides/sandboxes.md#writing-a-provider) runs against real Vercel sandboxes, with
  checks of the network and ports, in `scripts/live/sandbox-vercel.mjs`. It passed on October 6, 2026, after a fix:
  Vercel now needs a JSON body on the request that stops a session.

## Related

- [Sandboxes](../guides/sandboxes.md): pools, per-run sandboxes, tools and network rules.
- [E2B sandboxes](sandbox-e2b.md) and [Daytona sandboxes](sandbox-daytona.md): other providers that filter by domain.
- [Code Mode](../guides/code-mode.md): run model-written programs in a sandbox.
