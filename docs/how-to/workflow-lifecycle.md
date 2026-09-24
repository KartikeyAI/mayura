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

Use `runtime.humanRequest(workflow, runId, nodeId)` to reconstruct digest-verified display metadata for an authenticated application transport. Submit a response with the exact run ID, node ID, request digest, stable command ID, verified credential and schema input. Then call `runUntilSettled` again. Repeating the exact response command is idempotent; a different response conflicts.

`nextWakeAtMs` is the earliest persisted human deadline or timer due time. A host scheduler should call `runUntilSettled` at or after that time. The runtime starts no background timers and retains no callback or worker while waiting. After a process restart, reopen the same store, recreate the runtime with the identical definition and policy, and continue by run ID.

The conservative driver records an effect as dispatching before executing it. If the process dies after dispatch, use `recoverAbandoned` only after operator reconciliation; it never redispatches an uncertain effect automatically.
