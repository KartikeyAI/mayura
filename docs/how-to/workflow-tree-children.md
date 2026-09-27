# Durable required workflow children

Install `mayura/workflows`, `mayura/tools` and one selected storage adapter. Import the opt-in API from `mayura/workflows/children`:

```ts
import { defineTool } from 'mayura/tools';
import { defineWorkflow } from 'mayura/workflows';
import { createWorkflowTreeCoordinator, createWorkflowTreeRuntime, defineWorkflowTree } from 'mayura/workflows/children';
import { createSqliteStore } from 'mayura/storage-sqlite';
```

Define each child as a genuine finite workflow, then embed it in a genuine tree with explicit narrowed permissions, cost/call limits, output size, approval TTL and resource plan. Create the runtime with the parent authority and a stable worker identity. `maxConcurrentJobs` (default 4, maximum 32) is one shared execution bound across every root and child driven by that runtime; timed-out handlers retain their slot until the actual callback settles. `maxConcurrentRuns` defaults to 16 and is capped at 128. Supply `verifyHuman` when a root or child tool declares `approval: true`. `submit` persists the root; `runUntilSettled` admits, fences, executes, validates and joins each required child. It returns a waiting snapshot before an approval-protected dispatch. Read the exact digest from the corresponding snapshot, pass the exact identities to `approve`, then continue with `runUntilSettled`. Credentials stay local to the verifier; only its bounded verified identity is persisted. `inspect`, `events`, `recoverExpired`, `cancel` and `close` remain explicit operations.

Run the self-contained close/reopen example after building:

```sh
node examples/workflow-tree-children.mjs
```

Expected result:

```json
{"status":"succeeded","output":42,"toolExecutions":2,"approvalsVerified":2,"rootAccountClosed":true}
```

This preview supports root-local tool/join nodes plus one-level required child workflows containing tool/join nodes, including exact approval-enabled candidates at either level. Omit `childId` when approving a root-local tool; include the exact admitted child ID for a child approval. It rejects nested children and undeclared authority instead of silently changing profiles. `close` stops local driving; it does not imply durable cancellation. Started effects with uncertain outcomes are quarantined and never automatically replayed. Use verified application scope, genuine definitions and a selected adapter's explicit `workflowTrees` capability.

For a trusted worker fleet, register genuine definitions explicitly and process finite discovery pages:

```ts
const coordinator = createWorkflowTreeCoordinator({
  store,
  definitions: [tree],
  scope,
  permissions,
  policyVersion: 'policy-1',
  maxCostMicros: 10_000,
  maxCalls: 16,
  workerId: 'worker-a',
});

const report = await coordinator.runPage({ limit: 16 });
await coordinator.close();
```

Discovery returns metadata hints only. Unknown definition hashes are reported and skipped, approvals remain waiting for an explicit verified human action, and callers advance `nextCursor` themselves. There is no automatic background polling or authority inferred from persisted metadata.
