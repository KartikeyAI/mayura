---
title: "Sagas and loops"
description: "Compose durable workflows into sagas that undo finished steps when a later one fails, and into loops that repeat until a condition is met."
---

A single [durable workflow](durable-workflows.md) runs a fixed graph once. Two composites build on it:

- A **saga** (`mayura/workflows/sagas`) runs durable workflows one after another. If one fails, it runs the
  compensation workflows of the steps that already succeeded, in reverse order: release the stock, refund the card.
- A **loop** (`mayura/workflows/loops`) runs one durable workflow repeatedly, feeding each result into the next
  iteration, until a condition in the output turns false or a fixed maximum is reached: poll a job until it is done,
  revise a draft until it passes review.

Both are durable: their progress is stored, they survive restarts, and each step is an ordinary lifecycle workflow run
with its own approvals, human requests and timers.

## A saga

This saga reserves stock and then charges the customer. If the charge fails, the reservation is released.

```ts
import { defineTool, type AnyTool } from 'mayura';
import { createSqliteStore } from 'mayura/storage-sqlite';
import { defineWorkflowLifecycle } from 'mayura/workflows/lifecycle';
import { createWorkflowSagaRuntime, defineWorkflowSaga } from 'mayura/workflows/sagas';
import { z } from 'zod';

const order = z.object({ orderId: z.string(), amountCents: z.number().int() });
const reservation = z.object({ orderId: z.string(), amountCents: z.number().int(), reservationId: z.string() });

const reserveTool = defineTool({
  id: 'stock.reserve', version: '1', description: 'Reserve stock.', input: order, output: reservation,
  effects: 'write', capabilities: ['stock:write'],
  execute: async request => ({ ...request, reservationId: `res_${request.orderId}` }),
});
const releaseTool = defineTool({
  id: 'stock.release', version: '1', description: 'Release a reservation.', input: reservation, output: z.null(),
  effects: 'write', capabilities: ['stock:write'],
  execute: async () => null,
});
const chargeTool = defineTool({
  id: 'payments.charge', version: '1', description: 'Charge the customer.', input: reservation,
  output: z.object({ chargeId: z.string() }), effects: 'write', capabilities: ['payments:charge'],
  execute: async request => ({ chargeId: `ch_${request.orderId}` }),
});

// Each saga step is a durable workflow. Here each one simply runs one tool.
const oneStep = (id: string, tool: AnyTool) => defineWorkflowLifecycle({
  id, version: '1', input: tool.input, output: tool.output,
  nodes: [{ kind: 'tool', id: 'run', tool, input: { kind: 'input', path: [] } }],
  result: { kind: 'step', stepId: 'run', path: [] },
});

const placeOrder = defineWorkflowSaga({
  id: 'orders.place', version: '1', input: order, output: z.object({ chargeId: z.string() }),
  steps: [
    {
      id: 'reserve', forward: oneStep('reserve', reserveTool), input: { kind: 'input', path: [] },
      // Runs only if a later step fails. It may read its own forward step's output.
      compensation: { workflow: oneStep('release', releaseTool), input: { kind: 'step', stepId: 'reserve', path: [] } },
    },
    { id: 'charge', forward: oneStep('charge', chargeTool), input: { kind: 'step', stepId: 'reserve', path: [] } },
  ],
  result: { kind: 'step', stepId: 'charge', path: [] },
});

const store = createSqliteStore({ filename: ':memory:' });
await store.initialize();
const sagas = createWorkflowSagaRuntime({
  store,
  scope: { principalId: 'orders-service', projectId: 'shop' },
  permissions: { allow: ['tool:stock.reserve', 'tool:stock.release', 'tool:payments.charge', 'stock:write', 'payments:charge', 'effect:write'] },
  policyVersion: '1',
  maxCostMicros: 0,
});

const run = await sagas.submit(placeOrder, { input: { orderId: 'o-7', amountCents: 2_500 }, idempotencyKey: 'o-7' });
const settled = await sagas.runUntilSettled(placeOrder, run.id);
console.log(settled.status, settled.output); // succeeded { chargeId: 'ch_o-7' }

sagas.close();
await store.close();
```

The runtime options are the same as for a [lifecycle runtime](durable-workflows.md): the permissions must cover every
tool in every forward and compensation workflow.

## How a saga runs

1. Forward steps run in order. Each one starts a child lifecycle run and waits for it to finish.
2. A step's `input` binding reads the saga input or the output of an earlier step.
3. If a child run ends in anything but `succeeded` (failed, blocked, cancelled or `outcome_unknown`), the saga skips
   the remaining forward steps and runs the compensation of each earlier successful step, newest first.
4. The saga ends with one of these statuses:

| Status | Meaning |
|---|---|
| `succeeded` | Every forward step succeeded; `output` holds the result. |
| `compensated` | A step failed and every compensation succeeded. |
| `compensation_failed` | A compensation did not succeed. Treat this as an incident: the rollback is incomplete. |
| `failed` | A step failed and there was nothing to compensate, or the input or result was invalid. |
| `cancelled` | Cancelled with `cancel(runId)`, which also cancels the active child run. |

While a child waits for a person or a timer, the saga is `waiting`; while it undoes work, it is `compensating`. Each
step in `snapshot.steps` shows its status and the ids of its child runs (`forwardRunId`, `compensationRunId`).

A compensation is a separate workflow you write. Mayura runs it; it cannot know what "undo" means for your system.
Make compensations idempotent and tolerant of partial work, because the step they undo may have ended
`outcome_unknown`.

## A loop

A loop repeats one lifecycle workflow, its body. The body's output is the loop's current state: it carries the next
iteration's input and a boolean that says whether to continue.

```ts
import { createWorkflowLoopRuntime, defineWorkflowLoop } from 'mayura/workflows/loops';
import { z } from 'zod';

// `checkJob` is a lifecycle workflow whose output looks like { jobId, pending, result }.
const waitForJob = defineWorkflowLoop({
  id: 'jobs.wait', version: '1',
  input: z.object({ jobId: z.string() }),
  output: z.string(),
  body: checkJob,
  maxIterations: 20,
  initial: { kind: 'input', path: [] },          // input of iteration 1
  next: { kind: 'current', path: [] },           // input of every later iteration: the previous output
  continueWhen: { kind: 'current', path: ['pending'] }, // must be a boolean
  result: { kind: 'current', path: ['result'] },
});

const loops = createWorkflowLoopRuntime({ store, scope, permissions, policyVersion: '1', maxCostMicros: 0 });
const run = await loops.submit(waitForJob, { input: { jobId: 'job-42' }, idempotencyKey: 'job-42' });
const settled = await loops.runUntilSettled(waitForJob, run.id);
```

Loop bindings read `input` (the loop input), `current` (the latest body output) or a `literal`. After each successful
iteration, the loop reads `continueWhen`: `true` starts another iteration, `false` resolves `result` against the output
schema and succeeds. To wait between polls, put a `timer` step in the body.

| Status | Meaning |
|---|---|
| `succeeded` | The condition became `false`; `output` holds the result. |
| `limit_exceeded` | The condition was still `true` after `maxIterations`. This is not a success. |
| `failed` | An iteration did not succeed, the condition was not a boolean, or the result was invalid. |
| `cancelled` | Cancelled with `cancel(runId)`. |

`maxIterations` is between 1 and 1,024. The snapshot shows `iteration`, `current` and the active `childRunId`.

## Budgets

Sagas and loops check their worst case before they start. A saga adds up the declared `costMicros` of every tool in
every forward and compensation workflow; a loop multiplies its body's total by `maxIterations`. If that exceeds the
runtime's `maxCostMicros`, `submit` fails with `LIMIT_EXCEEDED`. What each run actually spends is recorded from its
child runs. See [Costs and budgets](../concepts/costs-and-budgets.md).

## Approvals and waits inside a saga or loop

Human requests, approvals and timers belong to the child lifecycle run. Both runtimes expose that runtime as
`lifecycle`, so you answer the child directly and then continue the parent:

```ts
const waiting = await sagas.runUntilSettled(placeOrder, sagaRunId);
const childId = waiting.steps['charge']?.forwardRunId;
if (childId) {
  const request = await sagas.lifecycle.approvalRequest(chargeWorkflow, childId, 'run');
  if (request) await sagas.lifecycle.approve({ id: childId, nodeId: 'run', digest: request.digest, credential });
}
await sagas.runUntilSettled(placeOrder, sagaRunId);
```

## Running sagas and loops in production

`mayura/workflows/composites` keeps an index of saga and loop runs and a host that advances them after a restart,
like the lifecycle host does for plain workflows. Submit through the host's runtime so the run is indexed:

```ts
import { createWorkflowWorker } from 'mayura/workflows';
import { createWorkflowCompositeHost } from 'mayura/workflows/composites';

const host = createWorkflowCompositeHost({
  store, scope, permissions, policyVersion: '1', maxCostMicros: 0,
  sagaDefinitions: [placeOrder], loopDefinitions: [waitForJob],
  intervalMs: 1_000, maxBackoffMs: 30_000,
});
await host.runtime.submitSaga(placeOrder, { input: { orderId: 'o-8', amountCents: 900 }, idempotencyKey: 'o-8' });

const worker = createWorkflowWorker({ units: [host], leadership });
worker.start();
```

If a submission's acknowledgement is lost, retry with the same idempotency key; it finds the same run. Add a
`createWorkflowLeadership` lease, as in [Durable workflows](durable-workflows.md), before running several replicas.

## Good to know

- A saga is sequential. For parallel work inside one step, use a lifecycle workflow with several branches or
  [`fanOut`](durable-workflows.md) as that step.
- There is no transaction across the saga and its children. Mayura gives each child a deterministic identity, so a
  crash between starting a child and recording it converges on the same child after restart instead of starting a
  second one.
- A saga can be migrated to a new version only while it is still in its forward phase. See
  [Operating workflows](workflow-operations.md).
- Pause and resume work on both composites; a pause stops new children from starting, and a running child keeps its
  own state.

## Related

- [Durable workflows](durable-workflows.md)
- [Workflows](../concepts/workflows.md)
- [Approvals and human input](approvals-and-human-input.md)
- [Operating workflows](workflow-operations.md)
