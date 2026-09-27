# Project a durable workflow for a UI

On the trusted server, inspect the durable runtime and match its snapshot to the registered pinned definition. Send only a content-free view containing node identities, kinds, dependencies and current statuses. Never send raw storage state, workflow inputs/outputs, receipts, approval values or policies.

In browser code, deeply freeze the validated transport record and project it:

```ts
import { createWorkflowGraphProjection, type WorkflowViewInput } from 'mayura/client/workflows';

const input: WorkflowViewInput = Object.freeze({
  format: 4,
  definitionId: 'deployment',
  definitionVersion: '1',
  runId,
  revision,
  status: 'running',
  nodes: Object.freeze([
    Object.freeze({ id: 'prepare', kind: 'tool', dependsOn: Object.freeze([]) }),
    Object.freeze({ id: 'worker', kind: 'child', dependsOn: Object.freeze(['prepare']) }),
  ]),
  steps: Object.freeze([
    Object.freeze({ id: 'prepare', kind: 'tool', status: 'succeeded' }),
    Object.freeze({ id: 'worker', kind: 'child', status: 'dispatching', childRunId }),
  ]),
});

const graph = createWorkflowGraphProjection(input);
```

Render IDs through framework text interpolation. Treat `ready` and progress counts as presentation facts only. Execute approval, cancellation and recovery through separately authenticated commands against the authoritative durable runtime.
