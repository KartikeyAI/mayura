---
title: "Give agents E2B sandboxes in production"
description: "Move agents from local Docker sandboxes to E2B microVMs: templates, network allow-lists, a sandbox per run, lifetimes, costs, errors and cleanup."
date: 2026-10-12
tags: E2B, sandboxes, agents, production
---

*E2B details checked against E2B's documentation and pricing page on October 12, 2026. Mayura's makers wrote this
guide.*

An agent that writes code needs somewhere to run it. On your machine, Mayura's built-in Docker sandboxes do the job: a
locked-down container per sandbox, no network unless you allow it, removed when you are done. In production you often
cannot or do not want to run Docker next to your app: on a serverless platform there is no Docker daemon, and on a
shared host you may not want untrusted code in containers at all.

[E2B](https://e2b.dev) runs each sandbox as a Firecracker microVM, started from a template, on its own
infrastructure. `@mayurajs/sandbox-e2b` plugs it into `mayura/sandbox`, so the same pool, limits and agent tools work
on both. This guide moves an agent from one to the other and covers what changes.

## What changes, and what doesn't

The code your agent's tools call is the same: `sandbox.exec`, `readFile`, `writeFile`, `listFiles`, `removeFile`,
`url` and `release`, under the same limits from `createSandboxes`. The machine behind it is not.

| | Docker (`mayura/sandbox/docker`) | E2B (`@mayurajs/sandbox-e2b`) |
| --- | --- | --- |
| Where it runs | A container on your machine | A Firecracker microVM at E2B |
| What it starts from | A local image, never pulled | An E2B template, by name or id |
| Working directory | `/workspace` | `/home/user` |
| Network | none, all | none, all, or a domain allow-list (ports 80 and 443) |
| Ports | Published on `127.0.0.1` only | Public at `https://<port>-<sandbox id>.e2b.app` |
| CPU and memory | Per sandbox, from `cpus` and `memoryMiB` | From the template; the package does not send `cpus` or `memoryMiB` |
| Longest lifetime | 24 hours by default | Your plan's: 1 hour on Hobby, 24 hours on Pro |
| Runtimes | Node only | Every runtime Mayura runs on: it uses `fetch` |

Use relative paths in your tools and prompts, and the working directory stops mattering.

## 1. Install and get a key

```bash
npm install mayura @mayurajs/sandbox-e2b
```

Create an API key in the E2B dashboard under **API Keys**. The package reads nothing from the environment; pass the
key in yourself, from `E2B_API_KEY` or your secret store. It has no E2B SDK and no dependency besides `mayura`.

## 2. Choose the provider at startup

Both providers return a `SandboxProvider`, and everything after `createSandboxes` is the same. So choosing between
them is one expression:

```ts
import { createSandboxes, type SandboxProvider } from 'mayura/sandbox';
import { dockerSandboxes } from 'mayura/sandbox/docker';
import { e2bSandboxes } from '@mayurajs/sandbox-e2b';

const e2bKey = process.env['E2B_API_KEY'];
const provider: SandboxProvider = e2bKey
  ? e2bSandboxes({ apiKey: e2bKey, template: 'node-workspace', maxLifetimeMs: 3_600_000 })
  : dockerSandboxes({ image: 'node:24-slim' });

export const sandboxes = createSandboxes(provider, {
  maxSandboxes: 10,
  maxLifetimeMs: 3_600_000,
  network: e2bKey ? ['none', 'allowlist'] : ['none'],
  labels: { app: 'code-helper' },
});
```

`createSandboxes` checks your limits before the provider is called: how many sandboxes may be alive at once
(`LIMIT_EXCEEDED` beyond that), how long each may live, and which kinds of network a sandbox may ask for. Its
`maxLifetimeMs` must not exceed the provider's, or it throws `INVALID_CONFIG` at startup rather than at the first
request.

`mayura/sandbox/docker` is one of the Node-only entry points. If production runs on an edge runtime, import it only
in your development entry point.

## 3. Templates

A template is E2B's equivalent of an image: the file system and processes a sandbox starts with. Without one, the
package uses E2B's `base` template. For anything real, build your own with the tools your agent needs already
installed, so it does not spend its time and budget on `apt-get` or `npm install` in every run.

E2B builds templates with its own tooling: `e2b template init` scaffolds one, and its SDK's `Template` builder
defines the base image, files and start command, built with `Template.build`. The template's name is what you pass to
Mayura, either for every sandbox (`template` on `e2bSandboxes`) or for one (`image` on `sandboxes.create`).

Two things to know about templates:

- **Resources come from the template.** E2B sets vCPUs and memory when the template is built. Mayura's `cpus` and
  `memoryMiB` options are not sent to E2B, so size the template for your heaviest task.
- **Names are checked before anything is sent.** A template name with spaces or other characters E2B does not use
  fails with `INVALID_CONFIG` (or `INVALID_INPUT` for a sandbox's `image`).

## 4. Network allow-lists

A sandbox reaches nothing unless you allow it, on E2B as on Docker. What E2B adds is a third kind of network: a list
of domains.

```ts
const sandbox = await sandboxes.create({
  lifetimeMs: 600_000,
  network: { allow: ['registry.npmjs.org', '*.github.com'] },
});
```

Permission to use the network is given once, where the pool is set up: a sandbox may ask only for kinds listed in
`createSandboxes`' `network` option. That is why the pool above lists `'allowlist'` but not `'all'`: any code path can
create a sandbox that reaches npm and GitHub, and none can create one that reaches everything. Asking for an unlisted
kind fails with `PERMISSION_DENIED`, before E2B is called.

How E2B enforces the list matters for what your agent can do:

- **Only ports 80 and 443 are matched by domain**: plain HTTP by its `Host` header, TLS by SNI. Every other port is
  denied, so `git` over SSH or a database on port 5432 reaches nothing. UDP protocols such as HTTP/3 are not matched by
  domain either.
- **Wildcards work**: `*.github.com` covers every subdomain.
- **DNS is allowed for you.** E2B's documentation says that when any domain is listed, its resolver at 8.8.8.8 is
  allowed so names can be looked up.

On Docker, which has no domain filter, an allow-list fails with `INVALID_INPUT` instead of quietly giving the sandbox
the whole internet. In development, use `'none'` or `'all'` there.

**Ports are public.** Ports you list when creating an E2B sandbox are served at
`https://<port>-<sandbox id>.e2b.app`, reachable by anyone who has that URL. Without `ports`, nothing is served.
On Docker, ports are published on `127.0.0.1` only. If an agent starts a preview server, treat its URL like a secret
link.

## 5. One sandbox per run

Most agents need a sandbox of their own for each run, so one user's files and processes never reach another's.
`sandboxPerRun` creates a run's sandbox the first time one of its tools needs it, and an `onFinally`
[lifecycle hook](../../../docs/guides/lifecycle-hooks.md) releases it when the run ends, whether it succeeded, failed
or was cancelled.

```ts
import { createRuntime, defineAgent, defineHook, z } from 'mayura';
import { sandboxPerRun, sandboxTools } from 'mayura/sandbox';

const perRun = sandboxPerRun(sandboxes, ({ runId }) => ({
  lifetimeMs: 30 * 60_000,
  network: e2bKey ? { allow: ['registry.npmjs.org'] } : 'none', // Docker has no domain filter
  labels: { run: runId },
}));

const workspace = sandboxTools(perRun.source, {
  name: 'workspace', exec: true, write: true,
  execTimeoutMs: 120_000,
  execCostMicros: 2_000, // charge each command against the run's budget
});

const releaseSandbox = defineHook({
  id: 'sandbox.release', version: '1', stage: 'onFinally',
  handler: async (_event, context) => { await perRun.release(context.runId); },
});

const coder = defineAgent({
  id: 'code.helper', version: '1',
  instructions: 'Make the change the task asks for in the workspace, run the tests, and summarize what you did.',
  model,
  tools: workspace,
  hooks: [releaseSandbox],
  input: z.object({ task: z.string().max(4_000) }),
  output: z.object({ summary: z.string() }),
});

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: { allow: [
    'model:openai/gpt-5.1',
    'tool:workspace.read', 'tool:workspace.list', 'sandbox:workspace:read',
    'tool:workspace.exec', 'sandbox:workspace:exec',
    'tool:workspace.write', 'tool:workspace.remove', 'sandbox:workspace:write',
    'effect:read', 'effect:write',
  ] },
  limits: { maxCostMicros: 500_000, maxDurationMs: 20 * 60_000 },
});
```

Every power is granted separately. Reading and listing are always on; running commands (`exec: true`) and changing
files (`write: true`) are options, and each needs its own `tool:` and `sandbox:` permission. Running a command counts
as a write effect, so `effect:write` is needed too. A tool call missing any of them ends `blocked` with
`PERMISSION_DENIED`, and nothing reaches E2B.

The per-run sandbox's lifetime should outlast the run. Here the run may take 20 minutes (`maxDurationMs`), and the
sandbox lives 30. If a tool needs the sandbox after its lifetime is over, the call fails with an error saying the
run's sandbox has ended.

## 6. Lifetimes and your plan

E2B limits how long a sandbox may run: 1 hour on the Hobby plan, 24 hours on Pro. Three settings line up with that:

1. **`e2bSandboxes({ maxLifetimeMs })`** says what your plan allows. It defaults to 1 hour; set it to `86_400_000` on
   Pro. Values above 24 hours fail with `INVALID_CONFIG`.
2. **`createSandboxes({ maxLifetimeMs })`** is your own ceiling, at most the provider's.
3. **`lifetimeMs`** on each sandbox is how long that one lives, at most your ceiling.

A sandbox's lifetime becomes E2B's timeout for it. When it passes, E2B ends the sandbox, and every later call fails
with a `SandboxError` whose `reason` is `gone`. Mayura creates E2B sandboxes with auto-pause off: they are never
paused and resumed, so a sandbox that ends is gone with its files. Work that must outlive a sandbox belongs in your
own storage, or in a [durable workflow](../../../docs/guides/durable-workflows.md) that creates a new sandbox per
step.

## 7. Costs and limits

E2B bills a running sandbox per second, by its vCPUs and memory. On October 12, 2026, its pricing page listed
$0.000014 per vCPU-second and $0.0000045 per GiB-second, with storage free, and a $150 monthly fee on Pro. At those
rates, a 2-vCPU, 2 GiB sandbox costs about $0.000037 a second: roughly $0.07 for 30 minutes, whether or not it runs
anything. That is arithmetic from the published prices, not a measurement; check E2B's page for current figures.

Since a sandbox costs money while it exists, not while it works, the settings that keep costs down are about time:

- **Release as soon as the run ends.** The `onFinally` hook above does it. A sandbox you forget runs until its
  lifetime is over.
- **Keep lifetimes close to what a run needs.** A 30-minute lifetime on a 5-minute task bounds the cost of a leak.
- **Charge commands to the run.** Mayura cannot see E2B's bill, but `execCostMicros` charges a fixed amount per
  command against the run's `maxCostMicros`. Pick a figure from your template's size and typical command time, and an
  agent that loops on failing tests runs out of budget instead of running all day.

Concurrency is limited too: E2B's pricing page lists 20 concurrent sandboxes on Hobby and 100 on Pro. `maxSandboxes`
counts sandboxes in one pool, in one process. With several processes or replicas, keep the sum below your plan's
limit. When E2B refuses a sandbox for its rate or concurrency limits, you get a `SandboxError` with `reason`
`rate_limited`.

## 8. Errors and cleanup

E2B's answers reach your code as a `SandboxError` with a `reason`, and never with E2B's own error text:

| `reason` | When |
| --- | --- |
| `authentication` | The key is wrong or lacks permission. |
| `rate_limited` | E2B's rate or concurrency limits refused the call. |
| `quota` | The sandbox's disk is full. |
| `gone` | The sandbox no longer exists, for example after its lifetime ended. |
| `timeout` | E2B gave up on a call. |
| `unavailable` | E2B could not be reached. |
| `rejected`, `invalid_response` | E2B refused the request for another reason, or answered with something its API does not promise. |

A command that runs past its timeout is not an error: it resolves with `timedOut: true`, after `SIGKILL` has been sent
to it and to every process it started. Cancelling a command through its `signal` stops it the same way and fails with
`CANCELLED`. File reads stop at the size you allow (`LIMIT_EXCEEDED` beyond it), so a large file never fills your
process's memory.

For cleanup, three layers cover each other:

- **Per run**, the `onFinally` hook releases the run's sandbox. Releasing twice does nothing.
- **At shutdown**, `await sandboxes.close()` releases every sandbox the pool still holds and refuses new ones.
- **After a crash**, nothing in your process runs, and E2B ends each sandbox when its lifetime passes. `labels` are
  attached to every sandbox as E2B metadata, so you can find a deployment's or a run's sandboxes when you list them
  with E2B's API.

## How it is tested

Unit tests run the package against a fake E2B API that checks every request. The sandbox conformance suite from
`mayura/sandbox/testing` was run against real E2B sandboxes with `scripts/live/sandbox-e2b.mjs`, and all 16 cases
passed on October 6, 2026. They cover exit codes and output, arguments passed exactly, working directory and
environment, standard input, stopping a command and everything it started at a timeout or on cancellation, and files
of every byte value and size. The same suite runs against Docker, which is what makes the two interchangeable. See
[E2B sandboxes](../../../docs/integrations/sandbox-e2b.md#how-it-is-tested).

## Next steps

- [E2B sandboxes](../../../docs/integrations/sandbox-e2b.md): every option and error.
- [Sandboxes](../../../docs/guides/sandboxes.md): the pool, the tools, Docker and the other providers.
- [Code Mode](../../../docs/guides/code-mode.md): run one model-written program against your tools, without a whole
  machine.

## Sources

- E2B, [Pricing](https://e2b.dev/pricing): plans, session length, concurrent sandboxes and per-second rates.
- E2B, [Sandbox lifecycle](https://docs.e2b.dev/sandbox): timeouts, 1 hour on Hobby and 24 hours on Pro.
- E2B, [Internet access](https://docs.e2b.dev/docs/sandbox/internet-access): `allowOut` and `denyOut`, ports 80
  and 443, wildcards and DNS.
- E2B, [Sandbox templates](https://docs.e2b.dev/docs/sandbox-template): `e2b template init` and the `Template`
  builder.
