---
title: "Build a coding agent that writes and runs code in a sandbox"
description: "An agent writes code and tests, runs them in an isolated machine of its own and fixes what fails: Docker on your laptop, E2B in production, nothing allowed by default."
date: 2026-10-12
tags: sandboxes, coding agents, permissions, budgets, testing
---

A model that writes code is far more useful when it can run it. It writes a function, runs the tests, reads the
failure and fixes the function, the same loop a developer goes through. The difficulty is where the code runs. Code a
model wrote is code nobody has reviewed, and running it in your own process, or on the machine that holds your
credentials, is the wrong default.

This guide builds a coding agent that works in a sandbox: an isolated Linux machine of its own for each run, with no
network unless you allow it, a lifetime that ends it, and a separate permission for each thing the agent may do in it.
It runs on Docker on your machine during development and on [E2B](https://e2b.dev) in production, with the same code.

## What you'll build

1. Your application sends the agent a task: "write `slugify(text)` in `slugify.js`, with tests".
2. The agent gets a fresh sandbox the first time it needs one. It writes files, runs `node --test`, reads the output
   and edits until the tests pass, or until its limits stop it.
3. It answers with a summary and the files it wrote.
4. When the run ends, for whatever reason, its sandbox is released.
5. Your application runs the tests again in a fresh sandbox before it uses anything. The agent's own claim that the
   tests passed doesn't count.

## Prerequisites

- Node.js 22.12 or later, or 24.14.1 or later, and `npm install mayura`.
- Docker, with the image pulled once: `docker pull node:24-slim`. Mayura never pulls images itself; a sandbox with
  an image that isn't on the machine fails with `INVALID_CONFIG`.
- A model API key for real runs. The tests in step 7 need none.

## 1. A pool of sandboxes

Every sandbox comes from a pool that holds them all to the same limits:

```ts
import { createSandboxes } from 'mayura/sandbox';
import { dockerSandboxes } from 'mayura/sandbox/docker';

const sandboxes = createSandboxes(dockerSandboxes({ image: 'node:24-slim' }), {
  maxSandboxes: 4,             // at most four alive at once; a fifth fails with LIMIT_EXCEEDED
  maxLifetimeMs: 30 * 60_000,  // no sandbox lives longer than 30 minutes
  maxExecTimeoutMs: 5 * 60_000,
});
```

`maxSandboxes` and `maxLifetimeMs` are required, so the pool can never grow without bound or keep a machine running
forever. `network` is left out, so it defaults to `['none']`: no sandbox from this pool can reach the network,
whatever the code that creates it asks for. Section 9 covers how to change that.

Each Docker sandbox is a locked-down container: no network, every Linux capability dropped, a non-root user, a
read-only root file system with an in-memory working directory, and bounded CPU, memory and processes. The
[Sandboxes guide](../../../docs/guides/sandboxes.md#docker) lists every setting.

## 2. One sandbox per run

Two tasks must never see each other's files, so each run gets its own sandbox. `sandboxPerRun` creates it the first
time one of the run's tools needs it, and a hook releases it when the run ends:

```ts
import { defineHook } from 'mayura';
import { sandboxPerRun, sandboxTools } from 'mayura/sandbox';

const perRun = sandboxPerRun(sandboxes, ({ runId }) => ({ lifetimeMs: 15 * 60_000, labels: { run: runId } }));

const tools = sandboxTools(perRun.source, {
  name: 'workspace',
  exec: true,              // workspace.exec: run shell commands
  write: true,             // workspace.write and workspace.remove
  execTimeoutMs: 120_000,  // no command runs longer than 2 minutes
  execCostMicros: 2_000,   // each command is charged at most $0.002 against the run's budget
});

const releaseWorkspace = defineHook({
  id: 'workspace.release', version: '1', stage: 'onFinally', timeoutMs: 30_000,
  handler: async (_event, context) => { await perRun.release(context.runId); },
});
```

`onFinally` runs once at the very end of every run: succeeded, failed, blocked or cancelled. If the process dies
before it runs, the sandbox still ends with its 15-minute lifetime, because the lifetime is enforced by the provider,
not by your process.

`sandboxTools` gives the agent reading tools by default (`workspace.read` and `workspace.list`). Running commands and
writing files are separate options, off until you turn them on, and each has a permission of its own. An agent that
should only inspect a project gets neither.

`execCostMicros` is what you count one command as costing. On Docker it's your own machine and you may leave it at 0;
on a hosted provider, set it to what a command of `execTimeoutMs` costs at most at your provider's prices, so the run's
budget covers compute as well as model calls.

## 3. The agent

```ts
import { defineAgent, z } from 'mayura';

const task = z.object({ task: z.string().max(4_000) });
const result = z.object({
  summary: z.string().max(2_000),
  files: z.array(z.object({ path: z.string().max(200), content: z.string().max(50_000) })).min(1).max(10),
});

const coder = defineAgent({
  id: 'coder', version: '1', input: task, output: result, tools, model, hooks: [releaseWorkspace],
  instructions: [
    'You write small JavaScript modules and their tests in the workspace sandbox, an isolated Linux machine with Node.js.',
    'Write ES modules with the .js extension, and tests in files ending .test.js that use node:test and node:assert.',
    'Run the tests with workspace.exec and the command "node --test". Read the output, fix the code, and run them again until they pass.',
    'The sandbox has no network: do not try to install packages; use only the Node.js standard library.',
    'Answer with a short summary and the final content of every file you wrote.',
  ].join('\n'),
});
```

The output schema bounds what comes back: at most ten files of 50,000 characters each. An answer in any other shape
is rejected, not passed on. The sandbox ends with the run, so the files travel in the answer.

## 4. Permissions and limits

Nothing in Mayura is allowed by default. The runtime lists every grant the agent needs, and nothing else:

```ts
import { createRuntime } from 'mayura';

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: {
    allow: [
      'model:openai.responses',
      // Read and list files.
      'tool:workspace.read', 'tool:workspace.list', 'sandbox:workspace:read', 'effect:read',
      // Write and remove files.
      'tool:workspace.write', 'tool:workspace.remove', 'sandbox:workspace:write',
      // Run commands.
      'tool:workspace.exec', 'sandbox:workspace:exec', 'effect:write',
    ],
  },
  limits: {
    maxSteps: 24, maxModelCalls: 24, maxToolCalls: 40,
    maxDurationMs: 10 * 60_000,  // the default is 60 seconds, too short for a write-test-fix loop
    maxCostMicros: 600_000,      // at most $0.60 per run, model calls and commands together
  },
});
```

Each tool needs three grants. Running a command, for example, needs `tool:workspace.exec`, which names the tool;
`sandbox:workspace:exec`, the capability the tool declares; and `effect:write`, its effect. Running commands, writing
and removing files have the `write` effect; reading and listing have `read`. Leave any of them out and the run ends
`blocked` with `PERMISSION_DENIED` the moment the model asks for that tool, before it runs.

The limits are the other half. A model that never gets its tests to pass would otherwise loop for as long as you let
it; here it stops after 40 tool calls, 24 model calls, ten minutes or $0.60, whichever comes first. Before every model
call the runtime reserves that call's `maxCostMicros`, and before every command its `execCostMicros`, so the run is
stopped before it would spend past its limit, not after. See
[Costs and budgets](../../../docs/concepts/costs-and-budgets.md).

## 5. The model

The agent takes any model adapter. With OpenAI:

```ts
import { openAIResponses } from 'mayura/provider-openai';

const model = openAIResponses({
  apiKey: process.env.OPENAI_API_KEY!,
  model: process.env.OPENAI_MODEL!,
  maxCostMicros: 40_000, // at most $0.04 per model call
  pricing: { inputMicrosPerMillionTokens: 1_250_000, outputMicrosPerMillionTokens: 10_000_000 }, // your model's prices
});
```

Mayura doesn't look prices up: give your model's current prices, and a per-call ceiling that covers your largest
expected context plus the longest answer. Then 24 calls of at most $0.04 can't exceed the run's $0.60 together with
the commands. See [Model providers](../../../docs/guides/model-providers.md).

## 6. Run it, and check the result yourself

```ts
import type { Sandboxes } from 'mayura/sandbox';

const outcome = await runtime.submit(coder, {
  input: { task: 'Write slugify(text) in slugify.js: lowercase, words joined by "-", only a-z and 0-9 kept. Test it in slugify.test.js.' },
}).result();

if (outcome.status === 'succeeded') {
  const passed = await testsPass(sandboxes, outcome.output.files);
  console.log(outcome.output.summary, passed ? 'Tests pass.' : 'Tests fail: do not use these files.');
} else {
  console.log(outcome.status, outcome.error.code);
}

/** Runs the tests on the returned files in a fresh sandbox, with no model involved. */
async function testsPass(pool: Sandboxes, files: readonly { readonly path: string; readonly content: string }[]): Promise<boolean> {
  const sandbox = await pool.create({ lifetimeMs: 5 * 60_000 });
  try {
    for (const file of files) await sandbox.writeFile(file.path, file.content);
    const tests = await sandbox.exec(['node', '--test'], { timeoutMs: 60_000 });
    return tests.exitCode === 0;
  } finally {
    await sandbox.release();
  }
}
```

The second check is cheap and closes a real gap: the agent's summary is model output. It may say the tests pass when
they don't, or return a different version of a file than the one it last ran. Running the returned files yourself,
with a fixed command, turns the claim into evidence. Run it in a sandbox too: the tests are model-written code as well.

`outcome.status` tells you how a run ended: `succeeded`, or `failed`, `blocked` or `cancelled` with an error code such
as `BUDGET_EXCEEDED` or `LIMIT_EXCEEDED` when a limit stopped it. See [Outcomes](../../../docs/concepts/outcomes.md).

## 7. Test it offline

The tests need no model key: `scriptedModel` from `mayura/testing` plays back the model's answers in order, while the
runtime, tools, permissions, budget and sandbox are all real.

```ts
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRuntime, defineAgent, z } from 'mayura';
import { createSandboxes, sandboxPerRun, sandboxTools } from 'mayura/sandbox';
import { dockerSandboxes } from 'mayura/sandbox/docker';
import { scriptedModel } from 'mayura/testing';

const sandboxes = createSandboxes(dockerSandboxes({ image: 'node:24-slim' }), { maxSandboxes: 2, maxLifetimeMs: 600_000 });
const perRun = sandboxPerRun(sandboxes, { lifetimeMs: 600_000 });
const tools = sandboxTools(perRun.source, { name: 'workspace', exec: true, write: true });
after(() => sandboxes.close()); // releases every sandbox still alive
const grants = ['model:scripted', 'tool:workspace.write', 'sandbox:workspace:write', 'tool:workspace.exec', 'sandbox:workspace:exec', 'effect:write'];

const agent = (model: ReturnType<typeof scriptedModel>) => defineAgent({
  id: 'coder', version: '1', instructions: 'Write and test code.', tools, model,
  input: z.object({ task: z.string() }), output: z.object({ summary: z.string() }),
});

test('writes a file, runs it in the sandbox and reads the output', async () => {
  const model = scriptedModel([
    { type: 'tool_calls', usage: { costMicros: 0 }, calls: [{ id: 'c1', toolId: 'workspace.write', input: { path: 'add.js', text: 'console.log(2 + 3)' } }] },
    { type: 'tool_calls', usage: { costMicros: 0 }, calls: [{ id: 'c2', toolId: 'workspace.exec', input: { command: 'node add.js' } }] },
    request => {
      const last = request.messages.at(-1);
      assert.equal(last?.role, 'tool');
      if (last?.role === 'tool') assert.match(JSON.stringify(last.result), /"stdout":"5\\n"/);
      return { type: 'final', output: { summary: 'Printed 5.' }, usage: { costMicros: 0 } };
    },
  ]);
  const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: grants } });
  const run = runtime.submit(agent(model), { input: { task: 'Print 2 + 3.' } });
  try {
    assert.equal((await run.result()).status, 'succeeded');
  } finally {
    await runtime.close();
    await perRun.release(run.id);
  }
});

test('cannot run commands without the exec grant, and never creates a sandbox', async () => {
  const model = scriptedModel([
    { type: 'tool_calls', usage: { costMicros: 0 }, calls: [{ id: 'c1', toolId: 'workspace.exec', input: { command: 'id' } }] },
  ]);
  const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: grants.filter(grant => grant !== 'sandbox:workspace:exec') } });
  const run = runtime.submit(agent(model), { input: { task: 'Who am I?' } });
  try {
    const outcome = await run.result();
    assert.equal(outcome.status, 'blocked');
    if (outcome.status === 'blocked') assert.equal(outcome.error.code, 'PERMISSION_DENIED');
    assert.ok(!perRun.runs.includes(run.id)); // no sandbox was created for this run
  } finally {
    await runtime.close();
  }
});
```

The first test runs a real container, so it needs Docker and the image, but no network and no key. The second never
touches Docker: the permission check refuses the call before the tool asks for a sandbox, which `perRun.runs`
confirms. Write the same kind of test for each limit you rely on: a scripted model that keeps calling
`workspace.exec` ends `failed` with `LIMIT_EXCEEDED` once it reaches `maxToolCalls`. The
[Testing guide](../../../docs/guides/testing.md) has more patterns.

## 8. Go to production on E2B

Docker sandboxes run on the machine your agent runs on, which is fine on a laptop and a poor fit for a shared server.
In production, swap the provider. [`@mayurajs/sandbox-e2b`](../../../docs/integrations/sandbox-e2b.md) runs each
sandbox as an E2B Firecracker microVM, and everything else in this guide stays the same:

```ts
import { createSandboxes } from 'mayura/sandbox';
import { e2bSandboxes } from '@mayurajs/sandbox-e2b';

const sandboxes = createSandboxes(e2bSandboxes({ apiKey: process.env.E2B_API_KEY ?? '', template: process.env.E2B_TEMPLATE ?? 'base' }), {
  maxSandboxes: 20,
  maxLifetimeMs: 60 * 60_000,
});
```

- **The template is your image.** Use an E2B template with the tools your tasks need (Node.js, for this guide).
- **Lifetimes are E2B timeouts.** A sandbox's `lifetimeMs` becomes E2B's timeout, so a sandbox nobody released still
  ends. E2B's Hobby plan allows an hour, Pro up to 24 hours.
- **Failures keep their shape.** E2B errors arrive as `SandboxError` with a `reason` (`authentication`,
  `rate_limited`, `gone`...), never with E2B's own text.
- **The key comes from you.** The package reads nothing from the environment.

The E2B package passed Mayura's 16-case sandbox conformance suite against real E2B sandboxes on October 6, 2026. Other
providers (Vercel Sandbox, Daytona, Modal and more) plug in the same way; the
[provider table](../../../docs/guides/sandboxes.md#providers) says what each supports.

## 9. When the agent needs the network

With the network off, `npm install` fails, which is often what you want. When tasks need packages, allow only the
registry, in two places:

```ts
import { createSandboxes, sandboxPerRun } from 'mayura/sandbox';
import { e2bSandboxes } from '@mayurajs/sandbox-e2b';

const sandboxes = createSandboxes(e2bSandboxes({ apiKey: process.env.E2B_API_KEY ?? '' }), {
  maxSandboxes: 20, maxLifetimeMs: 3_600_000,
  network: ['none', 'allowlist'], // the pool may hand out sandboxes limited to listed domains
});
const perRun = sandboxPerRun(sandboxes, { lifetimeMs: 900_000, network: { allow: ['registry.npmjs.org'] } });
```

The pool's `network` option is where permission to reach the network is given, once, at setup. A sandbox that asks for
a kind the pool didn't list fails with `PERMISSION_DENIED`. Docker can only do `'none'` or `'all'`; domain lists need a
provider that filters by domain, such as E2B (on ports 80 and 443), Vercel, Daytona or Modal. A provider that can't
keep a sandbox offline refuses the default rather than handing you a sandbox that is online when you expect it offline.

## Sandbox or Code Mode?

Mayura has a second way to run model-written code, [Code Mode](../../../docs/guides/code-mode.md), and the two answer
different questions.

| | Sandbox | Code Mode |
| --- | --- | --- |
| What runs | Any command on a Linux machine: compilers, test runners, package managers | One JavaScript function, `(input, tools) => output` |
| What the code can reach | Its own files, and the network if you allow it | Only the tools you list, each call through your permissions and budget |
| Lifetime | Minutes to hours, across many tool calls | One execution, bounded in CPU time, memory and wall time |
| Good for | Coding agents, data work, building and testing projects | A model combining many tool calls in a loop in one step |

Choose a sandbox when the agent needs a machine: to run tests, use a toolchain or keep files between steps. Choose
Code Mode when the model would otherwise make dozens of tool calls one model step at a time, such as pricing 20
products and adding them up: it writes one short program that calls your tools in a loop, and every call still goes
through your permissions and budget.

## Know the limits

- **The sandbox is the isolation.** Mayura checks permissions, paths, sizes and limits before each call, but what code
  can do inside the machine is up to the provider's isolation: a container on Docker, a microVM on E2B. For code from
  many tenants, prefer a microVM provider.
- **Output is cut.** The agent sees at most 32 KiB of each of stdout and stderr per command, with the middle left out,
  so a test runner's useful summary should be at its start or end.
- **Commands are stopped, not paused.** A command still running at its timeout is killed with everything it started,
  and the result says `timedOut: true`. A server the agent starts must be started with `setsid` to outlive its command.

## Next steps

- [Sandboxes](../../../docs/guides/sandboxes.md): every option, the desktop tools and writing a provider.
- [Code Mode](../../../docs/guides/code-mode.md): programs that call your tools, with approvals in durable workflows.
- [Permissions](../../../docs/concepts/permissions.md) and [Lifecycle hooks](../../../docs/guides/lifecycle-hooks.md).
- [Build a refund agent](refund-approval.md): an agent with real side effects, held for a person's approval.
