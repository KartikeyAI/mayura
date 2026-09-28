---
title: "Runtime"
description: "Create a runtime, submit agents, watch their events, cancel them and read their outcome, costs and evidence."
---

A runtime runs agents. You create it with `createRuntime`, telling it what runs may do (permissions), who they act for
(scope) and how far they may go (limits). Then you `submit` an agent with its input and get a handle to the run. One
runtime can run many agents and many runs at once; usually you create one per process, or one per request when
permissions or scope differ per user.

## Submit a run

```ts
import { createRuntime } from 'mayura';

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: { allow: ['model:openai.responses', 'tool:orders.lookup', 'effect:read'] },
  scope: { principalId: 'customer-42', projectId: 'shop' },
  limits: { maxCostMicros: 100_000, maxDurationMs: 30_000 },
});

try {
  const run = runtime.submit(supportAgent, { input: { message: 'Where is order A-1001?' } });

  for await (const event of run.observe()) {
    console.log(event.sequence, event.type, event.metadata);
  }

  const outcome = await run.result();
  if (outcome.status === 'succeeded') console.log(outcome.output);
  else console.error(outcome.status, outcome.error.code, outcome.error.message);

  console.log(runtime.inspect(run).budget); // { spentMicros, reservedMicros, calls }
} finally {
  await runtime.close();
}
```

## Options

| Option | Default | What it is |
| --- | --- | --- |
| `profile` | required | Must be `'ephemeral'`. Anything else throws `UNSUPPORTED_PROFILE`. |
| `permissions` | `{ allow: [] }` | What runs may use. Nothing is allowed by default. See [Permissions](./permissions.md). |
| `scope` | `{ principalId: 'local', projectId: 'default' }` | Who runs act for. Tools, guards and hooks receive it. |
| `limits` | see below | Ceilings for every run. |

`ephemeral` means the runtime keeps everything in memory. Runs, events and costs are lost when the process exits, and
a run interrupted by a crash is not resumed. For work that must survive restarts, use
[durable workflows](../guides/durable-workflows.md).

`scope.principalId` and `scope.projectId` must start with a letter or digit and may contain letters, digits, `.`,
`_`, `/` and `-`, up to 128 characters. Use an internal user id, not an email address.

## Limits

Each submitted run gets its own counters and its own cost budget, checked against these limits. `maxConcurrentRuns`
and `maxConcurrentOperations` also apply to the runtime as a whole. Child runs count against their parent's limits.

| Limit | Default | What it bounds |
| --- | --- | --- |
| `maxSteps` | `16` | Model turns in one run. Reaching it fails the run with `LIMIT_EXCEEDED`. |
| `maxModelCalls` | `16` | Model calls, including model-backed guards. |
| `maxToolCalls` | `64` | Tool calls. `0` is allowed. |
| `maxHookCalls` | `128` | Lifecycle hook calls. |
| `maxDurationMs` | `60000` | Wall-clock time for the run. |
| `maxInputBytes` | `1048576` | Size of the submitted input and of each tool input. |
| `maxOutputBytes` | `1048576` | Size of the final output and of each tool output. |
| `maxContextBytes` | `2097152` | Size of the conversation sent to the model, without media. |
| `maxMediaBytes` | `20971520` | All images and PDFs in one run, with the input and from tools. See [Vision](../guides/vision.md). |
| `maxOutputTokens` | `4096` | Output tokens the model may generate per call. |
| `maxCostMicros` | `0` | Total cost of the run, in micros. See [Costs and budgets](./costs-and-budgets.md). |
| `maxEventRetention` | `256` | Events kept in memory per run for `observe()`. |
| `maxConcurrentRuns` | `32` | Top-level runs in progress at once. |
| `maxDescendantRuns` | `64` | Child runs one run may start, counting their children. |
| `maxDepth` | `8` | How deep child runs may nest. |
| `maxConcurrentOperations` | `32` | Model calls, tool calls, validations and guards in progress at once. |

Every limit except `maxCostMicros` and `maxToolCalls` must be a positive integer. An unknown limit name throws
`INVALID_CONFIG`.

`maxCostMicros` defaults to 0, so a paid model is refused until you set it. Only free models (for example the
scripted test model, whose calls cost 0) work without it.

## The run handle

`runtime.submit(agent, { input })` returns a `RunHandle` right away; the run starts on its own.

| Member | What it does |
| --- | --- |
| `id` | The run's id. |
| `result()` | A promise of the run's outcome. It never rejects for a failed run; check `status`. Call it as often as you like. |
| `observe(options?)` | An async iterable of the run's events. Ends when the run ends. |
| `cancel()` | Asks the run to stop. Safe to call more than once. |

`submit` itself throws only when the run cannot start at all: the input is not plain JSON or is larger than
`maxInputBytes` (`INVALID_INPUT`), `maxConcurrentRuns` runs are in progress (`LIMIT_EXCEEDED`), or the runtime is
closed (`CONFLICT`). Everything after that, including invalid input for the agent's schema, arrives as the outcome.

## Events

Every event has `runId`, a `sequence` number that increases by one, a `timestamp`, a `type` and a small `metadata`
object (ids, counts and statuses, never prompts or secrets).

| Type | When |
| --- | --- |
| `run.started` | The run began. |
| `step.started`, `step.completed` | A model turn began or ended. |
| `model.started`, `model.completed` | A model call began or returned. |
| `tool.started`, `tool.completed` | A tool call began or ended, with its status. |
| `hook.started`, `hook.completed` | A lifecycle hook ran. |
| `delegate.started`, `delegate.completed` | A child run began or ended. |
| `output.delta`, `output.withheld` | A streamed batch of text was released, or streaming stopped. |
| `events.gap` | Older events were dropped before you read them. |
| `run.completed` | The run ended, with its status and cost totals. |

Events are kept in a buffer of `maxEventRetention` entries. If you start observing late, or read slower than the run
writes, the oldest events may be gone; you then get one `events.gap` event with the missing range instead of silence.
Pass `after: sequence` to resume after an event you already saw, and `signal` to stop observing. Observing never
changes the run, and stopping observation does not cancel it.

## Cancel a run

`run.cancel()` stops the run from starting new model calls, tool calls or child runs, and the outcome becomes
`cancelled`. Work already in progress is told through its `AbortSignal`; a tool that already sent a request may still
complete it. In that case the call is `outcome_unknown`, and so is the run. See [Outcomes and errors](./outcomes.md).

When `maxDurationMs` passes, the run is stopped the same way and fails with `TIMEOUT`.

## Inspect a run

`runtime.inspect(handle)` returns a snapshot of a run and its children, while it runs or after:

- `status`: `running` or the final status.
- `budget`: `spentMicros`, `reservedMicros` (cost held for calls in progress or with unknown cost) and `calls`.
- `runs`: the run and every child run, with ids, agent ids and statuses.
- `evidence`: for each tool call, whether it ran (`not_started`, `succeeded`, `failed` or `unknown`) and whether its
  result was released to the model.

## Child runs and speculation

Two methods start runs under a running parent, sharing its budget and limits:

- `runtime.spawn(parent, agent, { input, permissions, limits })` starts a child run. The child gets only the
  permissions you list that the parent also has, and its limits cannot exceed the parent's. The parent needs
  `agent:delegate`. Most apps use `agentAsTool` instead, so the model decides when to delegate.
- `runtime.speculate(parent, { branches, verify })` runs 1 to 8 read-only branches at once and keeps at most one
  result, the first that your `verify` function accepts.

Both are covered in [Child agents](../guides/child-agents.md).

## Close the runtime

`await runtime.close()` stops accepting runs, cancels the runs in progress and waits until each has an outcome.
Call it when your process shuts down, or in a `finally` block in scripts and tests.

## Good to know

- Limits are enforced between steps and at every call. Your own code in tools and hooks is not interrupted by force;
  it must respect `context.signal`.
- A runtime's permissions and scope are fixed when you create it. For per-user authority, create a runtime per user
  or request; it is cheap.
- For a runtime behind HTTP, with authentication and a client, see [Server and client](../guides/server-and-client.md).

## Related

- [Agents](./agent.md)
- [Outcomes and errors](./outcomes.md)
- [Permissions](./permissions.md)
- [Costs and budgets](./costs-and-budgets.md)
- [Observability](../guides/observability.md)
