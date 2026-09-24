# Durable workflow lifecycle nodes

Use `@mayura/workflows/lifecycle` when a workflow must stop for a typed human response or an absolute time and later continue from persisted state.

```ts
import { createWorkflowLifecycleRuntime, defineWorkflowLifecycle } from '@mayura/workflows/lifecycle';

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

The conservative driver records an effect as dispatching before executing it. If the process dies after dispatch, use `recoverAbandoned` only after operator reconciliation; it never redispatches an uncertain effect automatically.
