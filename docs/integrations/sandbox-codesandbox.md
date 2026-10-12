---
title: "CodeSandbox sandboxes"
description: "Run agent commands in private CodeSandbox microVMs with @mayurajs/sandbox-codesandbox: setup, options, lifetimes, port URLs and errors."
package: "@mayurajs/sandbox-codesandbox"
vendor: "CodeSandbox"
logo: "codesandbox"
website: "https://codesandbox.io"
area: "sandboxes"
---

[CodeSandbox](https://codesandbox.io/docs/sdk) (part of Together) runs sandboxes as Firecracker microVMs forked from a
template. `@mayurajs/sandbox-codesandbox` plugs them into [`mayura/sandbox`](../guides/sandboxes.md), so agents get
CodeSandbox VMs through the same `createSandboxes` pool, limits and tools as the built-in Docker sandboxes. It uses the
CodeSandbox SDK, `@codesandbox/sdk`, which you install yourself, and runs on Node only.

**CodeSandbox VMs reach the internet**, and this provider has no way to stop them, so it only makes sandboxes with the
network `'all'`.

## Install

```bash
npm install mayura @mayurajs/sandbox-codesandbox @codesandbox/sdk
```

The SDK (`@codesandbox/sdk` 2.4.2 or a later 2.x) is an optional peer, loaded the first time a sandbox is created. It
brings its command line's dependencies, some of which declare no licence, so Mayura does not install it for you.
Without it, creating a sandbox with an `apiKey` fails with `INVALID_CONFIG`. The package types the SDK by its shape,
so the SDK's own types never reach yours.

## Credentials

Create an API key on the [CodeSandbox API page](https://codesandbox.io/t/api). It needs CodeSandbox's VM scopes: a key
without them fails with `authentication` when a sandbox's VM starts. The package reads nothing from the
environment: pass the key in yourself, for example from `CSB_API_KEY`, or pass a `CodeSandbox` from the SDK you create
and own as `sdk`.

## Use it

```ts
import { createSandboxes, sandboxTools } from 'mayura/sandbox';
import { codeSandboxSandboxes } from '@mayurajs/sandbox-codesandbox';

const sandboxes = createSandboxes(codeSandboxSandboxes({ apiKey: process.env.CSB_API_KEY ?? '', vmTier: 'Small' }), {
  maxSandboxes: 5,
  maxLifetimeMs: 3_600_000,
  network: ['all'], // CodeSandbox VMs always reach the internet
});

const sandbox = await sandboxes.create({ lifetimeMs: 600_000, network: 'all', ports: [3000] });
const result = await sandbox.exec(['node', '-e', 'console.log(6 * 7)']);
console.log(result.exitCode, result.stdout); // 0 "42\n"
console.log(await sandbox.url(3000)); // carries a host token: treat it as a secret
await sandbox.release();

// Or give an agent tools that work in the sandbox; grant tool:workspace.exec, sandbox:workspace:exec and effect:write.
const tools = sandboxTools(sandbox, { name: 'workspace', exec: true });
```

`createSandboxes` enforces your limits before CodeSandbox is called. See [Sandboxes](../guides/sandboxes.md) for the
pool, per-run sandboxes and every tool.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | required without `sdk` | Your CodeSandbox API key. |
| `sdk` | none | A `CodeSandbox` from `@codesandbox/sdk` you own, instead of `apiKey`. |
| `template` | CodeSandbox's universal template | The sandbox id new sandboxes fork from. A sandbox's own `image` overrides it. |
| `vmTier` | your workspace's default | The VM size: `Pico`, `Nano`, `Micro`, `Small`, `Medium`, `Large` or `XLarge`. |
| `workdir` | `/project/sandbox` | The working directory, made when the sandbox starts. |
| `maxLifetimeMs` | 24 hours | The longest lifetime; 1 minute to about 24 days. |

Sandboxes are created **private** (CodeSandbox makes new sandboxes public otherwise). A sandbox's `image` is a template
id. Its `labels` become CodeSandbox tags (`key:value`, at most 10). `cpus` and `memoryMiB` fail with `INVALID_INPUT`:
choose a `vmTier` instead. Its `env` goes with every command.

If CodeSandbox forks a sandbox but its VM fails to start, the fork is deleted, so a failed `create` leaves nothing
behind. A sandbox whose working directory cannot be made is deleted too.

## Lifetime

CodeSandbox has no maximum lifetime. `createSandboxes` deletes each sandbox when its lifetime ends, if `release()` did
not first. As a backstop for a release that never comes, each sandbox hibernates when idle for its lifetime (at least 1
minute, at most a day). A hibernated sandbox is kept, and can cost storage, until you delete it in CodeSandbox.

## Network and ports

CodeSandbox VMs reach the internet, so `features.network` is `['all']` only. List `'all'` in the `network` option of
`createSandboxes` and ask for it in `create`; the default `'none'` fails with `INVALID_INPUT` before a sandbox is made.
Domain allowlists are not available.

`url(port)` gives a URL for one of the sandbox's `ports` with a host token that lasts as long as the sandbox. Anyone
with the URL can open the port, so treat it as a secret.

## Commands and files

CodeSandbox runs commands in a terminal, which joins and changes their output, so each command writes its output to
files in the sandbox, and only as much as you keep (`maxOutputBytes`) is read back. Standard input travels as a file.
The exit code comes from the SDK's error for a command that fails.

A timeout or cancellation kills the command's shell through CodeSandbox, and every process carrying its tag.

Files use the SDK's file system. A read larger than you allow fails with `LIMIT_EXCEEDED` before it is read; a write
makes the missing parent directories. A listing is made in the sandbox and read back from a hidden file under `/tmp`.

## Errors

Failures reach you as a `SandboxError` with a `reason`, mapped from CodeSandbox's answers without its text:

| `reason` | When |
| --- | --- |
| `authentication` | The key is wrong or lacks permission (401, 403), or a VM did not start for a missing scope. |
| `quota` | Your plan or quota refused the call (402). |
| `rate_limited` | CodeSandbox's rate limits refused the call (429). |
| `gone` | The sandbox no longer exists (404). |
| `unavailable` | CodeSandbox could not be reached, or failed (5xx, or an error with no status). |
| `rejected` | CodeSandbox refused the request for another reason. |
| `timeout` | A call did not finish in time. |

Configuration mistakes, such as an unknown `vmTier`, fail with `INVALID_CONFIG` when you call `codeSandboxSandboxes()`,
before anything is sent.

## How it is tested

- Unit tests run the package against a stand-in for the SDK that checks the sandbox's settings (private, template,
  tier, hibernation), each command, killing by tag, host-token URLs, the deletion of a fork that never started, and
  error mapping.
- An integration test runs the [sandbox conformance suite](../guides/sandboxes.md#writing-a-provider) against a
  stand-in whose sandbox is a local Docker container, with commands run as shell lines as CodeSandbox runs them.
- It has not passed against a real CodeSandbox account yet: the test token lacked the VM scopes. The package reports
  missing scopes as `authentication`, and deletes a fork that never started.

## Related

- [Sandboxes](../guides/sandboxes.md): pools, per-run sandboxes, tools and network rules.
- [Railway sandboxes](sandbox-railway.md) and [Northflank sandboxes](sandbox-northflank.md): other providers whose
  sandboxes always reach the internet.
- [E2B sandboxes](sandbox-e2b.md): a provider that can keep sandboxes offline.
