# Durable workflow lifecycle nodes

Use `mayura/workflows/lifecycle` when a workflow must stop for a typed human response or an absolute time and later continue from persisted state.

```ts
import { createWorkflowLifecycleRuntime, defineWorkflowLifecycle } from 'mayura/workflows/lifecycle';

const workflow = defineWorkflowLifecycle({
  id: 'release-review',
  version: '1',
  input,
  output,
  nodes: [
    {
      kind: 'human',
      id: 'review',
      request: {
        kind: 'correction',
        schemaId: 'release/review-response',
        schemaDigest: pinnedSchemaDigest,
        prompt: 'Review the release proposal.',
        response: reviewResponseSchema,
        subjectDigest: { kind: 'input', path: ['proposalDigest'] },
        deadlineAtMs: { kind: 'input', path: ['reviewBy'] },
      },
    },
    {
      kind: 'timer',
      id: 'publishAt',
      dependsOn: ['review'],
      fireAtMs: { kind: 'input', path: ['publishAt'] },
    },
  ],
  result: { kind: 'step', stepId: 'review', path: [] },
});

const runtime = createWorkflowLifecycleRuntime({
  store,
  scope,
  permissions,
  policyVersion: '1',
  maxCostMicros: 10_000,
  verifyHuman,
});

const submitted = await runtime.submit(workflow, { input: request, idempotencyKey: request.id });
const waiting = await runtime.runUntilSettled(workflow, submitted.id);
```

Use `runtime.humanRequest(workflow, runId, nodeId)` to reconstruct digest-verified display metadata. For the built-in authenticated server, create a `createWorkflowLifecycleHumanTransport` controller, register each active run, and pass `controller.transport` as the server's `humanRequests` option. The controller exposes opaque route IDs and translates the already verified server actor into the runtime's trusted-host response boundary. Registration is in memory and must be rebuilt after restart until durable fleet discovery is configured.

Submit a response with the exact request digest, stable command ID and schema input. Then call `runUntilSettled` again. Repeating the exact response command is idempotent; a different response conflicts.

`nextWakeAtMs` is the earliest persisted human deadline or timer due time. A host scheduler should call `runUntilSettled` at or after that time. The runtime starts no background timers and retains no callback or worker while waiting. After a process restart, reopen the same store, recreate the runtime with the identical definition and policy, and continue by run ID.

For a fleet, use `createWorkflowLifecycleFleetRuntime` instead. Its `scan` method returns finite scoped pages of active runs; `runPage([workflow], { cursor })` advances running or due executions and defers future waits. Continue with `page.nextCursor` until it is `null`, then begin a new sweep from `null` on the next host-scheduled interval. Definitions absent from the supplied catalog are reported and never executed.

## Optional steps and variable-width parallel work

Any node can declare `when`: a binding over the input or one of its dependencies' outputs. The node runs only when
the binding resolves to a value other than `null` or `false`; a path that does not resolve counts as `null`. Otherwise
the step is `bypassed`: it is never admitted, reserves and costs nothing, and its dependents continue, seeing its
output as `null`. The condition is decided once, when the step's dependencies are satisfied.

```ts
{ kind: 'tool', id: 'legal-review', tool: review, dependsOn: ['classify'],
  input: { kind: 'step', stepId: 'classify', path: ['contract'] },
  when: { kind: 'step', stepId: 'classify', path: ['needsLegalReview'] } },
```

`fanOut` builds variable-width parallel work up to a fixed maximum. It turns an array into one slot per item plus a
join that collects them:

```ts
import { defineWorkflowLifecycle, fanOut } from 'mayura/workflows/lifecycle';

nodes: [
  { kind: 'tool', id: 'plan', tool: plan, input: { kind: 'input', path: [] } },
  // research.1 .. research.4 run `investigate` on plan.assignments[0..3]; slots without an item are bypassed.
  ...fanOut({ id: 'research', items: { stepId: 'plan', path: ['assignments'] }, max: 4, tool: investigate }),
  // The join `research` outputs one entry per slot, in order, with null for a bypassed slot.
  { kind: 'tool', id: 'write', tool: write, dependsOn: ['research'], input: { kind: 'step', stepId: 'research', path: [] } },
],
```

Slots whose items exist start together in one wave, and each is admitted against the run budget separately, so a
plan with two items reserves two ceilings, not four. The graph is still fixed when the definition is built: `max`
(at most 64) is part of the definition, and a longer array is not an error, but its extra items are ignored. Split
the work in the step that produces the array if it can exceed `max`. Operator views show a bypassed step as
`skipped`. A migration that changes a bypassed step's condition resets it, so the condition is decided again.

The conservative driver records an effect as dispatching before executing it. If the process dies after dispatch, use `recoverAbandoned` only after operator reconciliation; it never redispatches an uncertain effect automatically.
