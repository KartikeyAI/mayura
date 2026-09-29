---
title: "Durable workflows"
description: "Define and run workflows that survive restarts, wait for people and timers, and never repeat a step whose outcome is unknown."
---

A durable workflow is a fixed graph of steps whose progress is stored in a database. Each step is recorded before it
starts and after it finishes, so a run can wait days for an approval or a date, survive a deploy or a crash, and carry
on in another process. Use one when a sequence of tool calls must finish reliably and must not repeat an effect such as
a payment or an email.

Durable workflows live in `mayura/workflows/lifecycle`. If you have not read [Workflows](../concepts/workflows.md)
yet, start there for the vocabulary.

## A complete example

This workflow reserves stock and then sends a confirmation. It runs on SQLite (install `better-sqlite3`).

```ts
import { defineTool, z } from 'mayura';
import { createSqliteStore } from 'mayura/storage-sqlite';
import { createWorkflowLifecycleRuntime, defineWorkflowLifecycle } from 'mayura/workflows/lifecycle';

const order = z.object({ orderId: z.string(), email: z.string() });
const reservation = z.object({ orderId: z.string(), email: z.string(), reservationId: z.string() });

const reserve = defineTool({
  id: 'orders.reserve', version: '1', description: 'Reserve stock for an order.',
  input: order, output: reservation, effects: 'write', capabilities: ['inventory:reserve'],
  execute: async request => ({ ...request, reservationId: `res_${request.orderId}` }),
});
const confirm = defineTool({
  id: 'orders.confirm', version: '1', description: 'Email the customer that the order is reserved.',
  input: reservation, output: z.object({ messageId: z.string() }), effects: 'write', capabilities: ['email:send'],
  execute: async request => ({ messageId: `msg_${request.reservationId}` }),
});

const fulfil = defineWorkflowLifecycle({
  id: 'orders.fulfil',
  version: '1',
  input: order,
  output: z.object({ messageId: z.string() }),
  nodes: [
    { kind: 'tool', id: 'reserve', tool: reserve, input: { kind: 'input', path: [] } },
    { kind: 'tool', id: 'confirm', tool: confirm, dependsOn: ['reserve'], input: { kind: 'step', stepId: 'reserve', path: [] } },
  ],
  result: { kind: 'step', stepId: 'confirm', path: [] },
});

const store = createSqliteStore({ filename: 'workflows.sqlite' });
await store.initialize();

const runtime = createWorkflowLifecycleRuntime({
  store,
  scope: { principalId: 'orders-service', projectId: 'shop' },
  permissions: { allow: ['tool:orders.reserve', 'inventory:reserve', 'tool:orders.confirm', 'email:send', 'effect:write'] },
  policyVersion: '1',
  maxCostMicros: 0,
});

try {
  const run = await runtime.submit(fulfil, { input: { orderId: 'o-1001', email: 'ada@example.com' }, idempotencyKey: 'o-1001' });
  const settled = await runtime.runUntilSettled(fulfil, run.id);
  console.log(settled.status, settled.output); // succeeded { messageId: 'msg_res_o-1001' }
} finally {
  runtime.close();
  await store.close();
}
```

`submit` validates the input and stores a new run. The run id is derived from `idempotencyKey`, so submitting the same
key again returns the same run instead of starting a second one. `runUntilSettled` then advances the run in the calling
process until it finishes, waits or is paused.

## Runtime options

| Option | Required | Meaning |
|---|---|---|
| `store` | yes | An initialized store from `mayura/storage-sqlite` or `mayura/storage-postgres`. |
| `scope` | yes | `{ principalId, projectId }`. Runs are stored and looked up per scope. |
| `permissions` | yes | The explicit grants every step needs: `tool:<id>`, each capability the tool declares, and `effect:<kind>` for tools with effects. A step without its grants ends `blocked`. |
| `policyVersion` | yes | A label for this set of settings, recorded with each run. |
| `maxCostMicros` | yes | The cost budget of each run, in micros, shared by all its steps. `0` allows only free tools. |
| `verifyHuman` | for approvals and `respond` | Turns a credential into a verified person. See [Approvals and human input](approvals-and-human-input.md). |
| `approvalTtlMs` | no | How long an approval request stays valid. Default 1 hour. |
| `maxOutputBytes` | no | Largest input, step output or result a run stores. Default 1 MiB. |
| `previousPolicies` | no | The settings of earlier releases (up to 16), so runs they started can finish. See [Changing runtime settings](#changing-runtime-settings). |
| `now` | no | The clock, for tests. Timers and deadlines use it. |

## How a run advances

`runUntilSettled` works in waves. Each wave starts every step whose dependencies are done, runs sibling steps in
parallel, and stores each result. It returns a snapshot when there is nothing left to do right now:

| Status | Meaning |
|---|---|
| `running` | Work remains; call `runUntilSettled` again. |
| `waiting` | Waiting for an approval, a person, a timer or a signal. `nextWakeAtMs` is the earliest deadline or due time. |
| `paused` | An operator paused it. Nothing runs until it is resumed. |
| `succeeded` | Every step is done and `output` holds the validated result. |
| `failed` | A step failed, a human request or signal timed out, or the result did not match the output schema. |
| `blocked` | A step lacked a permission or the run budget could not cover it. |
| `cancelled` | Cancelled with `runtime.cancel(runId)`. |
| `outcome_unknown` | A step with effects may or may not have happened. See [Unknown outcomes](#unknown-outcomes). |

When a step fails or is blocked, the steps that depend on it are skipped and the run ends. There are no automatic
retries. The snapshot also has `steps` (each step's status and output) and `budget` (`spentMicros`, `reservedMicros`
and `maxCostMicros`). `runtime.inspect(runId)` returns the same snapshot without advancing the run, and
`runtime.events(runId)` returns its stored event log.

## Tool steps

Before a tool step runs, the runtime checks its grants and reserves the tool's `costMicros` from the run budget. If the
remaining budget cannot cover it, the step is `blocked`. After the step, the run is charged what the tool reported with
`context.reportUsage`, or its declared cost if it reported nothing.

How a thrown error is recorded depends on the tool's `effects`:

- A `none` or `read` tool that throws simply fails the step: it changed nothing outside, so there is nothing to
  reconcile.
- A `write` or `host` tool that throws is recorded as `unknown`, because it may have acted before failing. The run
  ends `outcome_unknown`.
- Throw `ToolRefusal` (from `mayura`) when the tool decided not to act, for example because the order does not exist.
  The step fails cleanly, its reserved cost is released, and there is nothing to reconcile.

Every step's tool receives a stable `context.callId` (`<runId>/step:<nodeId>`). Pass it, or a business key such as the
order id, to your provider as an idempotency key.

## Agent steps

`agentStep` turns an agent into a tool for a step. Each time the step runs, it runs the agent in its own in-process
runtime with the run's scope, and charges the run what the agent actually spent:

```ts
import { agentStep } from 'mayura/workflows/lifecycle';

const summarize = agentStep(summarizer, {
  id: 'tickets.summarize',              // the workflow grants tool:tickets.summarize
  capabilities: ['tickets:summarize'],  // and each of these
  permissions: ['model:openai.responses'], // what the agent itself may use
  limits: { maxCostMicros: 50_000, maxDurationMs: 60_000 }, // the step reserves 50,000 from the run budget
});

const nodes = [{ kind: 'tool' as const, id: 'summarize', tool: summarize, input: { kind: 'input' as const, path: [] } }];
```

The agent's grants are separate from the workflow's: the workflow grants the step (`tool:tickets.summarize`, its
`capabilities`, and `effect:<kind>` when the agent's tools have effects); the agent gets only `permissions`. The step's
outcome follows the agent's:

| Agent outcome | Step | Charged |
|---|---|---|
| `succeeded` | succeeds with the agent's output | what the agent spent |
| `failed`, `blocked`, `cancelled` | fails; its dependents are skipped | what the agent spent |
| `outcome_unknown` | `unknown`: the run ends `outcome_unknown` and is left for you to reconcile | its ceiling stays reserved |

Cancelling the run or reaching the step's timeout cancels the agent. If the agent's tools can change things (`write`
or `host` effects), the interrupted step is `unknown`, because the agent may have been in the middle of one. The step's
timeout defaults to the agent's `maxDurationMs` plus 15 seconds, so the agent's own limit fires first.

| Option | Meaning |
|---|---|
| `id`, `version`, `description` | The step tool's identity. `version` defaults to the agent's. |
| `permissions` | Grants for the agent's own model and tool calls. |
| `limits` | The agent's runtime limits. `maxCostMicros` is the step's ceiling (0 for a model that costs nothing). |
| `capabilities` | Extra grants the workflow needs to run the step. |
| `input`, `output`, `prepare`, `finish` | Give the step its own schemas: `prepare` turns the step input into the agent input, and `finish` turns the agent output into the step output, or throws to fail the step (for example after checking citations). |
| `onRun` | Called with the agent's run handle, for example to trace it. A function it returns is awaited when the run settles. Neither can fail the step. |
| `timeoutMs` | The step's deadline. |

To build the agent for each run, for example with tools that record what this run read, pass a function instead of
the agent. It then needs `input`, `output`, and `effects`, the strongest effect its tools may have:

```ts
const investigate = agentStep((task: { question: string }) => researcherFor(task.question), {
  id: 'research.investigate', input: taskSchema, output: findingsSchema, effects: 'read',
  permissions: researcherGrants, limits: { maxCostMicros: 20_000 },
});
```

The model loop inside a step is not checkpointed: a crash mid-step does not resume the agent (see
[Restarts and unknown outcomes](#restarts-and-unknown-outcomes)).

## Optional steps

Any step can declare `when`, a binding over the input or one of its dependencies. The step runs only when the value is
something other than `null` or `false`; a path that does not exist counts as `null`. Otherwise the step is bypassed:
it costs nothing, and its dependents continue and see its output as `null`.

```ts
import type { WorkflowLifecycleNode } from 'mayura/workflows/lifecycle';

const legalReviewStep: WorkflowLifecycleNode = {
  kind: 'tool', id: 'legal-review', tool: legalReview, dependsOn: ['classify'],
  input: { kind: 'step', stepId: 'classify', path: ['contract'] },
  when: { kind: 'step', stepId: 'classify', path: ['needsLegalReview'] },
};
```

The condition is decided once, when the step's dependencies are done.

## Parallel slots

`fanOut` runs one tool per item of an array, in parallel, up to a fixed maximum. It creates slots `<id>.1` to
`<id>.<max>` and a join `<id>` that collects them. A slot with no item is bypassed and reserves nothing.

```ts
import { defineWorkflowLifecycle, fanOut } from 'mayura/workflows/lifecycle';

const research = defineWorkflowLifecycle({
  id: 'research', version: '1', input: question, output: report,
  nodes: [
    { kind: 'tool', id: 'plan', tool: plan, input: { kind: 'input', path: [] } },
    // research.1 .. research.4 run `investigate` on plan.assignments[0..3].
    ...fanOut({ id: 'research', items: { stepId: 'plan', path: ['assignments'] }, max: 4, tool: investigate }),
    // The join outputs one entry per slot, in order, with null for a bypassed slot.
    { kind: 'tool', id: 'write', tool: write, dependsOn: ['research'], input: { kind: 'step', stepId: 'research', path: [] } },
  ],
  result: { kind: 'step', stepId: 'write', path: [] },
});
```

`max` is at most 64 and is part of the definition. Items beyond `max` are ignored, so cap the array in the step that
produces it.

## Timers

A `timer` step waits until an absolute time, in milliseconds since the Unix epoch, read from a binding:

```ts
import type { WorkflowLifecycleNode } from 'mayura/workflows/lifecycle';

const sendAt: WorkflowLifecycleNode = { kind: 'timer', id: 'send-at', dependsOn: ['draft'], fireAtMs: { kind: 'input', path: ['sendAtMs'] } };
```

While it waits, the run is `waiting` and holds no memory, timer handle or process. Its output is
`{ fireAtMs, firedAtMs }`. Something must call `runUntilSettled` again at or after `nextWakeAtMs`; in production the
worker host does this for you.

## Waiting for people

Two step types stop a run until a person acts:

- **Approvals.** Add `approval: true` to a tool step. The run waits until someone approves that exact tool call.
- **Human requests.** A `human` step asks a typed question (information, a correction or a choice of plan) and
  continues with the validated answer as the step's output.

```ts
import type { WorkflowLifecycleNode } from 'mayura/workflows/lifecycle';
import { z } from 'mayura';

const review: WorkflowLifecycleNode = {
  kind: 'human', id: 'review', dependsOn: ['draft'],
  request: {
    kind: 'information',
    schemaId: 'posts.review', // with a Zod response, the schema digest is derived from it
    prompt: 'Is this post ready to publish?',
    response: z.object({ publish: z.boolean(), note: z.string().optional() }),
    context: { kind: 'step', stepId: 'draft', path: [] },
    deadlineAtMs: { kind: 'input', path: ['reviewBy'] },
  },
};
```

Responding, verifying who may answer, and the HTTP, CLI and UI surfaces are covered in
[Approvals and human input](approvals-and-human-input.md).

## Signals

A `signal` step waits for an event from another system, such as a payment arriving. The run is `waiting` and holds
nothing while it waits. The signal's payload is validated with `payload` and becomes the step's output, which later
steps bind to like any other output:

```ts
import { defineWorkflowLifecycle } from 'mayura/workflows/lifecycle';
import { z } from 'mayura';

const checkout = defineWorkflowLifecycle({
  id: 'orders.checkout', version: '1', input: order, output: z.object({ messageId: z.string() }),
  nodes: [
    { kind: 'tool', id: 'reserve', tool: reserve, input: { kind: 'input', path: [] } },
    { kind: 'signal', id: 'paid', name: 'payment.received', dependsOn: ['reserve'],
      payload: z.object({ amountCents: z.number().int().positive() }),
      deadlineAtMs: { kind: 'input', path: ['payBy'] } },
    { kind: 'tool', id: 'ship', tool: ship, dependsOn: ['paid'], input: { kind: 'step', stepId: 'paid', path: ['amountCents'] } },
  ],
  result: { kind: 'step', stepId: 'ship', path: [] },
});
```

Deliver a signal from code with the runtime (use the fleet runtime in production, so the worker sees the change):

```ts
await runtime.signal(checkout, {
  id: runId, name: 'payment.received', signalId: 'payment-7731', payload: { amountCents: 4_200 },
});
```

Operators and other services can deliver it over HTTP with `client.signalWorkflow` or `mayura workflow-signal`; see
[Operating workflows](workflow-operations.md#signals). Either way:

- **Idempotent.** `signalId` identifies the signal. Delivering the same id and payload again changes nothing, so a
  sender can retry freely. The same id with another payload, or a second signal for a step that already has one, is
  refused with `CONFLICT`: a signal step takes exactly one signal.
- **Validated.** A payload the schema rejects is refused with `INVALID_INPUT` and the step keeps waiting. An unknown
  signal name is `NOT_FOUND`.
- **Early signals are kept.** A signal that arrives before the step starts (its dependencies are still running) is
  stored with the step and completes it as soon as it starts. If the step is bypassed or the run is cancelled first,
  the signal is dropped with it.
- **Deadlines.** With `deadlineAtMs`, a step with no signal by then is `timed_out`, the run fails, and later signals
  are refused. A kept early signal counts only if it arrived before the deadline.
- `name` defaults to the node id and is unique within a definition. The run continues on its next `runUntilSettled`;
  the worker host does this for you.

To start a new run for each event instead, see [Webhooks](webhooks.md).

## Storage

Durable workflows need an initialized store: `createSqliteStore` from `mayura/storage-sqlite` for a single machine, or
`createPostgresStore` from `mayura/storage-postgres` when several processes share it. Call `store.initialize()` once
at startup. Every process that touches the same runs must use the same store and scope. The runtime never closes the
store; you do. See [Storage](storage.md).

## Workers

In production, one process submits runs and a separate worker advances them. Submit through the fleet runtime, which
keeps an index of active runs, and run a host that sweeps that index:

```ts
import { hostname } from 'node:os';
import { createWorkflowLeadership, createWorkflowWorker } from 'mayura/workflows';
import { createWorkflowLifecycleFleetRuntime, createWorkflowLifecycleHost } from 'mayura/workflows/lifecycle';

const options = { store, scope, permissions: { allow: grants }, policyVersion: '1', maxCostMicros: 500_000 };

// Server side: submit (and approve, respond, pause) through the fleet runtime so workers can find the run.
const runtime = createWorkflowLifecycleFleetRuntime(options);
await runtime.submit(fulfil, { input: request, idempotencyKey: request.orderId });

// Worker side: advance every indexed run on a registered definition, about once a second.
const host = createWorkflowLifecycleHost({ ...options, definitions: [fulfil], intervalMs: 1_000, maxBackoffMs: 30_000 });
const worker = createWorkflowWorker({
  units: [host],
  leadership: createWorkflowLeadership({ store, scope, role: 'orders-worker', holderId: `${hostname()}-${process.pid}` }),
});
worker.start();

// On shutdown: start nothing new, let running steps finish (up to 30 s), then hand over the lease.
await worker.drain({ timeoutMs: 30_000 });
```

- The host runs waiting runs only when they are due, and skips runs whose definition is not in `definitions`.
- Leadership is a durable lease: run as many worker replicas as you like, and one advances the fleet at a time. If the
  leader dies, another takes over when its lease expires (15 s by default).
- In tests, call `host.runOnce()` instead of starting a timer.
- With `defineMayuraApplication` from `mayura/cli`, return the worker from `worker()` and `mayura worker` runs it. See
  [Running in production](../cli/run.md).

## Restarts and unknown outcomes

Every state change is written to the store before the next one begins, so after a restart a new process continues each
run from its last recorded state: waiting steps keep waiting, due timers fire, finished steps are not run again.

The one gap is a step that was running when the process died. Mayura records a step as started before it calls the
tool, so it knows the tool may have acted, but not whether it did. Such a step is never run again automatically; the
run stays unfinished and cannot be paused. After you check the outside system, record the result with
`recoverAbandoned`:

```ts
const snapshot = await runtime.recoverAbandoned(runId);
// The interrupted step is now `unknown` and the run ends `outcome_unknown`.
```

### Unknown outcomes

A run ends `outcome_unknown` when a step with effects may or may not have happened: it threw, timed out, or was cut
off by a crash. Mayura never replays it. Look at the outside system (did the refund go out?), then either finish the
work by hand or submit a new run. Operators find these runs in the settled view of the run list; see
[Operating workflows](workflow-operations.md). The best defence is an idempotent tool: pass a stable key to your
provider so a repeated call is harmless.

## Tracing

`createWorkflowTraceExport` from `mayura/workflows` exports each settled run as one OpenTelemetry trace, with a span per
step. It keeps a durable outbox, so a restarted worker neither loses nor duplicates traces. Add its unit to the worker:

```ts
import { createOtlpHttpJsonTraceExporter } from 'mayura/exporter-otlp';
import { createWorkflowTraceExport, createWorkflowWorker, lifecycleFleetTarget } from 'mayura/workflows';

const exporter = createOtlpHttpJsonTraceExporter({ endpoint: 'https://collector.example/v1/traces', serviceName: 'orders' });
const traces = createWorkflowTraceExport({
  source: host.runtime, store, scope, exportId: 'primary', definitions: [fulfil], sink: exporter.sink,
});
const worker = createWorkflowWorker({ units: [host, traces.unit({ targets: [lifecycleFleetTarget(host.runtime)] })] });

// Where you submit runs, record them so short runs are not missed:
await traces.track(runId);
```

Spans carry names, ids, times, statuses and budget numbers, never inputs, outputs or prompts. See
[Observability](observability.md).

## Changing runtime settings

Every run records the settings it started with: `scope`, `permissions`, `policyVersion`, `maxCostMicros`,
`maxOutputBytes` and `approvalTtlMs`. A runtime continues a run only if those are its own settings or are listed in
`previousPolicies`; any other run stops with `CONFLICT`. So when a release changes a setting, for example to grant a
tool that a new workflow version calls, list the settings the previous release ran with:

```ts
import { createWorkflowLifecycleFleetRuntime, type WorkflowLifecyclePolicy } from 'mayura/workflows/lifecycle';

// Exactly what release 1 passed. Keep it listed until release 1's runs have finished.
const release1: WorkflowLifecyclePolicy = {
  permissions: { allow: ['tool:orders.reserve', 'inventory:reserve', 'effect:write'] },
  policyVersion: '1',
  maxCostMicros: 500_000,
};

const runtime = createWorkflowLifecycleFleetRuntime({
  store,
  scope,
  permissions: { allow: ['tool:orders.reserve', 'inventory:reserve', 'tool:orders.confirm', 'email:send', 'effect:write'] },
  policyVersion: '2',
  maxCostMicros: 500_000,
  previousPolicies: [release1],
});
```

- **A run keeps its own settings until it finishes.** Its steps are checked against the permissions it started with,
  and it keeps its own budget, output limit and approval lifetime. A grant added later is never given to it: a step
  that needs one ends `blocked`. An approval requested before the deploy can still be approved.
- **New runs use the current settings.** A child that a saga or loop starts later uses its parent's settings.
- **To move a run onto the new settings, migrate it** to a new definition version; see
  [Operating workflows](workflow-operations.md). This also works for a run whose settings are no longer listed.
- `maxOutputBytes` and `approvalTtlMs` default as they do for the runtime, so copy exactly what the old release
  passed. Remove an entry once no active run uses it. Sagas, loops, fleet runtimes and hosts take the same option.

## Good to know

- **Use the same settings everywhere.** Give the server and the worker the same options object. When a release
  changes the settings, list the old ones in `previousPolicies`; see
  [Changing runtime settings](#changing-runtime-settings).
- **Never edit a definition that has runs in flight.** Changing any step changes the definition's digest, and runs
  pinned to the old one stop. Add a new `version` instead; see [Operating workflows](workflow-operations.md).
- **Use the fleet runtime everywhere in production.** Approving, responding, signalling or pausing through a plain
  runtime leaves the worker's index stale.
- **Errors.** Every error the runtimes and stores throw is a `MayuraError` with a stable `code`. Reusing an
  idempotency key with other input, another definition version or other runtime settings is `CONFLICT`; resubmit the
  identical request to get the existing run. See [Storage](storage.md#errors).
- **Limits.** At most 128 steps, 32 human steps, 64 timers and 64 signal steps per definition; prompts up to 1 KiB.
- `runUntilSettled` runs steps in the calling process. A plain runtime starts no background timers; waiting runs move
  only when something calls it again.

## Related

- [Workflows](../concepts/workflows.md)
- [Approvals and human input](approvals-and-human-input.md)
- [Sagas and loops](sagas-and-loops.md)
- [Operating workflows](workflow-operations.md)
- [Storage](storage.md)
