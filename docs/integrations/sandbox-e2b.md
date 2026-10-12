---
title: "E2B sandboxes"
description: "Run agent commands in E2B's Firecracker microVMs with @mayurajs/sandbox-e2b: setup, options, network rules, limits and errors."
package: "@mayurajs/sandbox-e2b"
vendor: "E2B"
logo: "e2b"
website: "https://e2b.dev"
area: "sandboxes"
---

[E2B](https://e2b.dev) runs each sandbox as a Firecracker microVM started from a template. `@mayurajs/sandbox-e2b`
plugs E2B into [`mayura/sandbox`](../guides/sandboxes.md), so agents get E2B machines through the same
`createSandboxes` pool, limits and tools as the built-in Docker sandboxes. It talks to E2B's HTTP APIs with `fetch`:
no E2B SDK, no other dependencies, and it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/sandbox-e2b
```

## Credentials

Create an API key in the [E2B dashboard](https://e2b.dev/dashboard) under **API Keys**. The package reads nothing from
the environment: pass the key in yourself, for example from `E2B_API_KEY`.

## Use it

```ts
import { createSandboxes, sandboxTools } from 'mayura/sandbox';
import { e2bSandboxes } from '@mayurajs/sandbox-e2b';

const sandboxes = createSandboxes(e2bSandboxes({ apiKey: process.env.E2B_API_KEY ?? '' }), {
  maxSandboxes: 5,
  maxLifetimeMs: 3_600_000,
});

const sandbox = await sandboxes.create({ lifetimeMs: 600_000, network: 'none' });
const result = await sandbox.exec(['python3', '-c', 'print(6 * 7)']);
console.log(result.exitCode, result.stdout); // 0 "42\n"
await sandbox.release();

// Or give an agent tools that work in the sandbox; grant tool:workspace.exec, sandbox:workspace:exec and effect:write.
const tools = sandboxTools(sandbox, { name: 'workspace', exec: true });
```

`createSandboxes` enforces your limits (how many sandboxes, how long each lives, which networks it may ask for) before
E2B is called. See [Sandboxes](../guides/sandboxes.md) for the pool, per-run sandboxes and every tool.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | required | Your E2B API key. |
| `template` | `base` | The template sandboxes start from. A sandbox's own `image` overrides it. |
| `workdir` | `/home/user` | The working directory: the template user's home. |
| `maxLifetimeMs` | 1 hour | The longest lifetime your plan allows: 1 hour on Hobby, up to 24 hours on Pro. |
| `apiUrl` | `https://api.e2b.app` | E2B's control API. |
| `domain` | `e2b.app` | The domain sandboxes are served on. |
| `fetch` | `globalThis.fetch` | For tests and proxies. |

A sandbox's `image` is an E2B template id or alias. Its lifetime becomes E2B's timeout, after which E2B ends the
sandbox; sandboxes are never paused.

## Network and ports

- **`'none'`** turns internet access off.
- **`'all'`** turns it on.
- **`{ allow: [domains] }`** allows those domains and denies everything else. E2B matches domains on ports 80 (by the
  `Host` header) and 443 (by TLS SNI) only, so other ports reach nothing.

Ports you list when creating a sandbox are served publicly at `https://<port>-<sandbox id>.e2b.app`. Without ports,
nothing is public.

## Commands and files

Commands run through `sh` inside the sandbox. A timeout or cancellation sends `SIGKILL` to the command and to every
process it started. Files move through E2B's file API: reads stop at the size you allow and fail with
`LIMIT_EXCEEDED` beyond it, so a large file never fills your process's memory.

## Errors

Failures reach you as a `SandboxError` with a `reason`, mapped from E2B's answers:

| `reason` | When |
| --- | --- |
| `authentication` | The key is wrong or lacks permission. |
| `rate_limited` | E2B's rate limits or concurrency limits refused the call. |
| `quota` | The sandbox's disk is full. |
| `gone` | The sandbox no longer exists, for example after its lifetime ended. |
| `timeout` | E2B gave up on a call. |
| `unavailable` | E2B could not be reached. |
| `rejected` | E2B refused the request for another reason. |
| `invalid_response` | E2B's reply was not what its API promises. |

Configuration mistakes, such as a template name with spaces or a lifetime over 24 hours, fail with `INVALID_CONFIG`
when you call `e2bSandboxes()`, before anything is sent.

## How it is tested

- Unit tests run the package against a fake E2B API that checks every request.
- The [sandbox conformance suite](../guides/sandboxes.md#writing-a-provider) runs against real E2B sandboxes with
  `scripts/live/sandbox-e2b.mjs`: all 16 cases passed on October 6, 2026.

## Related

- [Sandboxes](../guides/sandboxes.md): pools, per-run sandboxes, tools and network rules.
- [E2B Desktop](sandbox-e2b-desktop.md): E2B sandboxes with a desktop agents can see and use.
- [Code Mode](../guides/code-mode.md): run model-written programs in a sandbox.
