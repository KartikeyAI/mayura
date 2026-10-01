---
title: "Sandboxes"
description: "Isolated Linux machines for agents to run commands and handle files in, on Docker or a hosted provider, with no network unless allowed and permission-gated tools."
---

`mayura/sandbox` gives an agent an isolated Linux machine: it runs commands, reads and writes files and, on some
providers, serves ports or shows a desktop. Docker on your own machine is built in (`mayura/sandbox/docker`); hosted
providers come as `@mayurajs/sandbox-*` packages. Every sandbox has a lifetime, and none reaches the network unless
you allow it.

```ts
import { createSandboxes } from 'mayura/sandbox';
import { dockerSandboxes } from 'mayura/sandbox/docker';

const sandboxes = createSandboxes(dockerSandboxes({ image: 'node:24-slim' }), {
  maxSandboxes: 4,
  maxLifetimeMs: 30 * 60_000,
});

const sandbox = await sandboxes.create({ lifetimeMs: 10 * 60_000 });
try {
  await sandbox.writeFile('index.js', 'console.log(6 * 7)');
  const result = await sandbox.exec(['node', 'index.js']);
  console.log(result.exitCode, result.stdout); // 0 '42\n'
} finally {
  await sandbox.release();
}
```

This is not [Code Mode](code-mode.md), which runs one model-written JavaScript program against your tools. A sandbox
is a whole machine for an agent to work in: installing packages, running tests, building things.

## Limits

`createSandboxes(provider, options)` holds every sandbox from a provider to the same limits.

| Option | Notes |
| --- | --- |
| `maxSandboxes` | Required. The most sandboxes alive at once, counting those being created; more fail with `LIMIT_EXCEEDED`. |
| `maxLifetimeMs` | Required. The longest lifetime a sandbox may be given; at most the provider's. |
| `network` | The network kinds sandboxes may be given: `['none']` by default. See [Network](#network). |
| `execTimeoutMs` | How long a command runs when the caller does not say; 60 s by default. |
| `maxExecTimeoutMs` | The longest a caller may let a command run; 30 minutes by default. |
| `maxOutputBytes` | The most bytes of stdout, and of stderr, kept from one command; 1 MiB by default. More is dropped and `truncated` is set. |
| `maxFileBytes` | The largest file read or written, and the most standard input; 16 MiB by default. Files are held in memory. |
| `callTimeoutMs` | How long any other provider call may take; 120 s by default. |
| `labels` | Labels given to every sandbox, to find them in the provider's console. |

`sandboxes.close()` releases every sandbox still alive and refuses new ones.

## A sandbox

`sandboxes.create(options)` takes `lifetimeMs` (required), and optionally `network`, `env` (variables every command
sees), `ports`, `cpus`, `memoryMiB`, `image` (the provider's image or template) and `labels`. The provider ends the
sandbox when its lifetime is over, if `release()` did not end it first; after that every call fails with a
`SandboxError` whose `reason` is `gone`.

| Method | Notes |
| --- | --- |
| `exec(command, options)` | Runs `command`, a list of arguments with the program first: `['npm', 'test']`, or `['sh', '-c', 'npm install && npm test']` for a shell. Options: `cwd`, `env`, `stdin` (text or bytes), `timeoutMs`, `signal`. |
| `readFile(path)` | The file's bytes, or undefined when there is none. `maxBytes` refuses larger files. |
| `writeFile(path, data)` | Writes text or bytes, creating directories and replacing any file there. |
| `listFiles(path)` | The directory's entries (`name`, `type`, `size`, `modified`), or undefined when there is none. |
| `removeFile(path)` | Removes a file; a directory with what is in it needs `recursive: true`. |
| `url(port)` | The URL serving one of the `ports` the sandbox was created with. |
| `desktop` | On providers with a desktop: `screenshot`, `click`, `move`, `scroll`, `type`, `key`, `size` and `viewUrl`. |
| `release()` | Ends the sandbox. Releasing again does nothing. |

Paths are absolute, or relative to the sandbox's `workdir`. `exec` resolves with the exit code, `stdout` and `stderr`
as text, `truncated` and `durationMs`. A command still running at its timeout is stopped, with every process it
started, and resolves with `timedOut: true` and no exit code. Cancelling with `signal` stops it too, and fails with
`CANCELLED`.

```ts
import { createSandboxes } from 'mayura/sandbox';
import { dockerSandboxes } from 'mayura/sandbox/docker';

const sandboxes = createSandboxes(dockerSandboxes({ image: 'node:24-slim' }), { maxSandboxes: 1, maxLifetimeMs: 600_000 });
const sandbox = await sandboxes.create({ lifetimeMs: 600_000, env: { NODE_ENV: 'test' } });

const tests = await sandbox.exec(['npm', 'test'], { cwd: 'app', timeoutMs: 120_000 });
if (tests.timedOut) console.log('The tests took too long.');
else if (tests.exitCode !== 0) console.log(tests.stderr);
await sandbox.release();
```

What each provider supports beyond commands and files is in `sandbox.features`: `stdin`, `ports`, `desktop`, and
the `network` kinds it can enforce. Asking for something a provider does not support fails with `INVALID_INPUT`
before anything is created.

## Network

A sandbox reaches nothing by default. Its `network` is one of:

- `'none'`: no network at all. The default.
- `'all'`: the internet, and serving `ports`.
- `{ allow: ['registry.npmjs.org', '*.github.com'] }`: only these domains, on providers that filter by domain.

Each kind other than `'none'` must be listed in the `network` option of `createSandboxes`; asking for one that is
not fails with `PERMISSION_DENIED`. So permission to reach the network is given once, where the sandboxes are set up,
never by whoever creates a sandbox.

```ts
import { createSandboxes } from 'mayura/sandbox';
import { dockerSandboxes } from 'mayura/sandbox/docker';

const sandboxes = createSandboxes(dockerSandboxes({ image: 'node:24-slim' }), {
  maxSandboxes: 2, maxLifetimeMs: 600_000, network: ['none', 'all'],
});
const server = await sandboxes.create({ lifetimeMs: 600_000, network: 'all', ports: [3000] });
await server.exec(['sh', '-c', 'npx serve -l 3000 . >/dev/null 2>&1 &']);
console.log(await server.url(3000));
```

## Tools for agents

`sandboxTools(sandbox, { name })` makes tools that let an agent work in a sandbox. Only reading is on by default;
each further power is enabled by its own option and needs its own permission.

| Tool | Option | Permission | Does |
| --- | --- | --- | --- |
| `<name>.read` | always | `sandbox:<name>:read` | Reads a file: text as text, other bytes as base64, in parts. |
| `<name>.list` | always | `sandbox:<name>:read` | Lists a directory. |
| `<name>.exec` | `exec: true` | `sandbox:<name>:exec` | Runs a shell command with `sh -c`. |
| `<name>.write`, `<name>.remove` | `write: true` | `sandbox:<name>:write` | Writes and removes files. |
| `<name>.url` | `ports: true` | `sandbox:<name>:ports` | Gives the URL of a port the sandbox serves. |
| `<name>.screenshot`, `.click`, `.scroll`, `.type`, `.key` | `desktop: true` | `sandbox:<name>:desktop` | Sees and uses the desktop. |

Other options: `execTimeoutMs` (5 minutes by default), `execCostMicros` (what one command costs against the run's
budget; 0 by default), `maxOutputBytes` (32 KiB of each stream returned to the model, the middle of longer output
left out), `maxReadBytes` and `maxWriteBytes`.

Most agents need a sandbox of their own for each run, so one run's files never reach another. `sandboxPerRun`
creates the run's sandbox the first time one of its tools needs it; release it when the run ends, from an
`onFinally` [lifecycle hook](lifecycle-hooks.md):

```ts
import { defineHook } from 'mayura';
import { createSandboxes, sandboxPerRun, sandboxTools } from 'mayura/sandbox';
import { dockerSandboxes } from 'mayura/sandbox/docker';

const sandboxes = createSandboxes(dockerSandboxes({ image: 'node:24-slim' }), { maxSandboxes: 8, maxLifetimeMs: 3_600_000 });
const perRun = sandboxPerRun(sandboxes, ({ runId }) => ({ lifetimeMs: 3_600_000, labels: { run: runId } }));

const tools = sandboxTools(perRun.source, { name: 'workspace', exec: true, write: true });
const releaseSandbox = defineHook({
  id: 'sandbox.release', version: '1', stage: 'onFinally',
  handler: async (_event, context) => { await perRun.release(context.runId); },
});
```

Grant the run `tool:workspace.exec` and `sandbox:workspace:exec` (and the same for each other tool), as for any
[tool](../concepts/tools.md).

## Docker

`dockerSandboxes(options)` from `mayura/sandbox/docker` runs each sandbox as a container on this machine. It runs on
Node, and needs Docker. Each container is locked down:

- no network unless `'all'` was allowed and asked for, and then ports published on `127.0.0.1` only;
- every Linux capability dropped, and no privilege escalation (`no-new-privileges`);
- a non-root user (`1000:1000` by default);
- the image's file system read-only, with an in-memory working directory and `/tmp`;
- bounded CPUs, memory (with no swap) and processes;
- removed when released, and when its lifetime is over.

Images are never pulled: a sandbox with an image that is not on the machine fails with `INVALID_CONFIG`. An image
needs a POSIX shell, `sleep` and the usual tools, from BusyBox or coreutils, as Alpine, Debian and most language
images have. Environment variables reach commands through a file inside the container, so their values are not in
the container's configuration or on the host's command lines.

| Option | Notes |
| --- | --- |
| `image` | Required. The image sandboxes run, such as `alpine:3.22` or `node:24-slim`. |
| `engine` | `'cli'` (the default) runs the `docker` CLI; `'api'` talks to the Docker Engine API on its local socket. |
| `docker` | The `docker` CLI's path; `docker` on the PATH by default. |
| `host` | For the API: `unix:///var/run/docker.sock` or `npipe:////./pipe/docker_engine`. `DOCKER_HOST`, or the usual sockets, by default. Remote hosts are refused. |
| `user` | Numeric `uid:gid`; `1000:1000` by default. |
| `workdir` | The working directory; `/workspace` by default. |
| `workspaceMiB`, `tmpMiB` | The sizes of the working directory (1,024 MiB) and `/tmp` (256 MiB). They count toward memory. |
| `cpus`, `memoryMiB`, `pids` | What each sandbox gets: 1 CPU, 1,024 MiB and 256 processes by default. A sandbox may ask for less. |
| `readOnlyRoot` | Keep the image's file system read-only; true by default. |
| `maxLifetimeMs` | The longest lifetime; 24 hours by default. |

## Writing a provider

A provider implements `SandboxProvider`: its `id`, `features`, `workdir` and `maxLifetimeMs`, and `create`, which
resolves with a `SandboxBackend`. `createSandboxes` checks every path, size and option before calling the provider,
and everything the provider returns before the caller sees it. A provider maps failures to `SandboxError` (use
`sandboxHttpFailure(status)` for HTTP statuses) without the provider's own text, and stops a command and everything it
started when `exec`'s signal aborts.

`sandboxConformance` from `mayura/sandbox/testing` runs the contract against a real sandbox:

```ts
import { describe, expect, it } from 'vitest';
import { createSandboxes } from 'mayura/sandbox';
import { dockerSandboxes } from 'mayura/sandbox/docker';
import { sandboxConformance } from 'mayura/sandbox/testing';

describe('my sandbox provider', async () => {
  const sandboxes = createSandboxes(dockerSandboxes({ image: 'alpine:3.22' }), { maxSandboxes: 1, maxLifetimeMs: 600_000 });
  const sandbox = await sandboxes.create({ lifetimeMs: 600_000 });
  for (const test of sandboxConformance) it(test.name, async () => { expect(await test.run({ sandbox })).toBe('passed'); });
});
```
