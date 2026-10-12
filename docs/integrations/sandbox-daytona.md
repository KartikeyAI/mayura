---
title: "Daytona sandboxes"
description: "Run agent commands in Daytona sandboxes with @mayurajs/sandbox-daytona: setup, options, network rules, signed port URLs, desktop and errors."
package: "@mayurajs/sandbox-daytona"
vendor: "Daytona"
logo: "daytona"
website: "https://www.daytona.io"
area: "sandboxes"
---

[Daytona](https://www.daytona.io) runs sandboxes started from snapshots. `@mayurajs/sandbox-daytona` plugs Daytona into
[`mayura/sandbox`](../guides/sandboxes.md), so agents get Daytona sandboxes through the same `createSandboxes` pool,
limits and tools as the built-in Docker sandboxes, and, on snapshots that have it, a desktop through Daytona's computer
use. It talks to Daytona's REST and toolbox APIs with `fetch`: no Daytona SDK, no other dependencies, and it runs on
every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/sandbox-daytona
```

## Credentials

Create an API key in the [Daytona dashboard](https://app.daytona.io) under **API Keys**. If the key can act for several
organizations, pass the one to use as `organizationId`. The package reads nothing from the environment: pass the key in
yourself, for example from `DAYTONA_API_KEY`.

## Use it

```ts
import { createSandboxes, sandboxTools } from 'mayura/sandbox';
import { daytonaSandboxes } from '@mayurajs/sandbox-daytona';

const sandboxes = createSandboxes(daytonaSandboxes({ apiKey: process.env.DAYTONA_API_KEY ?? '' }), {
  maxSandboxes: 5,
  maxLifetimeMs: 3_600_000,
  network: ['none', 'all'],
});

const sandbox = await sandboxes.create({ lifetimeMs: 600_000 });
const result = await sandbox.exec(['python3', '-c', 'print(6 * 7)']);
console.log(result.exitCode, result.stdout); // 0 "42\n"
await sandbox.release();

// A server that outlives its command: start it with setsid, and read its signed URL.
const server = await sandboxes.create({ lifetimeMs: 600_000, network: 'all', ports: [8080] });
await server.exec(['sh', '-c', 'setsid nohup python3 -m http.server 8080 >/dev/null 2>&1 < /dev/null &']);
console.log(await server.url(8080));

// Or give an agent tools that work in the sandbox; grant tool:workspace.exec, sandbox:workspace:exec and effect:write.
const tools = sandboxTools(sandbox, { name: 'workspace', exec: true });
```

`createSandboxes` enforces your limits (how many sandboxes, how long each lives, which networks it may ask for) before
Daytona is called. See [Sandboxes](../guides/sandboxes.md) for the pool, per-run sandboxes and every tool.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | required | Your Daytona API key. |
| `organizationId` | none | The organization, when the key can act for several. |
| `snapshot` | Daytona's default | The snapshot sandboxes start from. A sandbox's own `image` overrides it. |
| `target` | Daytona's default | The region, such as `us` or `eu`. |
| `workdir` | `/home/daytona` | The working directory: the default user's home. |
| `desktop` | `false` | Give sandboxes a desktop through Daytona's computer use. The snapshot must have it. |
| `maxLifetimeMs` | 24 hours | The longest lifetime, as your organization allows it; 1 minute to about 24 days. |
| `apiUrl` | `https://app.daytona.io/api` | Daytona's API. |
| `fetch` | `globalThis.fetch` | For tests and proxies. |

A sandbox's `image` is a Daytona snapshot id or name. `cpus` are whole CPUs and `memoryMiB` whole GiB; anything else
fails with `INVALID_INPUT`. Its `env` and `labels` go to Daytona as they are.

## Lifetime

A sandbox's lifetime becomes Daytona's time to live, in whole minutes, after which Daytona destroys it. It is never
stopped for being idle, and is deleted if it stops. `create` waits until Daytona reports the sandbox started; a sandbox
that fails to start is deleted, and `create` fails. A release deletes it.

## Network and ports

- **`'none'`** blocks all network access.
- **`'all'`** allows it.
- **`{ allow: [domains] }`** sets Daytona's domain allowlist, denying everything else.

Sandboxes are never public. `url(port)` gives a signed preview URL for one of the sandbox's `ports`, valid while the
sandbox lives (at least 1 minute, at most 24 hours). The URL carries its own access, so treat it as a secret.

## Commands and files

Each command runs in a toolbox session of its own, in the background, and is polled to its end. Its output goes to files
in the sandbox, and only as much as you keep (`maxOutputBytes`) is read back. Standard input and the command's
environment are uploaded as files (the environment file is read and removed before the command starts), so neither
appears in the command Daytona records.

Daytona ends a command's process group when the command returns. Start a process that must outlive its command, such as
a server, with `setsid nohup … < /dev/null &`, as in the example above.

A timeout or cancellation kills every process the command started, found by a tag in their environment, and returns
what it wrote until then.

Files use Daytona's toolbox file API. Reads stop at the size you allow and fail with `LIMIT_EXCEEDED` beyond it. A
write makes the missing parent directories. Removing a directory without `recursive` checks first that it is empty.

## Desktop

With `desktop: true`, computer use is started when each sandbox is created, and `sandbox.desktop` works through it:

- `screenshot()` returns a PNG or JPEG, with the pointer.
- `click`, `move`, `type` and `key` work as in the [guide](../guides/sandboxes.md#a-sandbox). Keys with `+`, such as
  `ctrl+shift+t`, are sent as a hotkey.
- `scroll` goes up and down only; scrolling sideways (`dx`) fails with `INVALID_INPUT`.
- `size()` is the active display's size.
- `viewUrl()` is a signed noVNC view on port 6080, valid while the sandbox lives. Treat it as a secret.

Without `desktop`, `features.desktop` is false and sandboxes have no `desktop`.

## Errors

Failures reach you as a `SandboxError` with a `reason`, mapped from Daytona's answers without Daytona's text:

| `reason` | When |
| --- | --- |
| `authentication` | The key is wrong or lacks permission (401, 403). |
| `quota` | Your plan or quota refused the call (402). |
| `rate_limited` | Daytona's rate limits refused the call (429). |
| `gone` | The sandbox no longer exists, for example after its lifetime ended (404, 410). |
| `timeout` | Daytona gave up on a call (408, 504). |
| `unavailable` | Daytona could not be reached, or failed (5xx). |
| `rejected` | Daytona refused the request for another reason, including a missing snapshot or organization when creating, or a sandbox that failed to start. |
| `invalid_response` | Daytona's reply was not what its API promises. |

Configuration mistakes, such as an `apiUrl` that is not `https` or a `maxLifetimeMs` under 1 minute, fail with
`INVALID_CONFIG` when you call `daytonaSandboxes()`, before anything is sent.

## How it is tested

- Unit tests run the package against a fake Daytona API that checks every request: the sandbox's settings, each
  command's session and files, bounded output, killing by tag, signed URLs and the computer-use calls.
- The [sandbox conformance suite](../guides/sandboxes.md#writing-a-provider) runs against real Daytona sandboxes, with
  checks of the network and ports, in `scripts/live/sandbox-daytona.mjs`: all 16 cases passed on October 6, 2026.

## Related

- [Sandboxes](../guides/sandboxes.md): pools, per-run sandboxes, tools and network rules.
- [E2B Desktop sandboxes](sandbox-e2b-desktop.md): another provider with a desktop.
- [Vercel Sandbox](sandbox-vercel.md): another provider that filters by domain.
