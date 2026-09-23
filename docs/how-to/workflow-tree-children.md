# Durable required workflow children

Install `@mayura/workflows`, `@mayura/tools` and one selected storage adapter. Import the opt-in API from `@mayura/workflows/children`:

```ts
import { defineTool } from '@mayura/tools';
import { defineWorkflow } from '@mayura/workflows';
import { createWorkflowTreeRuntime, defineWorkflowTree } from '@mayura/workflows/children';
import { createSqliteStore } from '@mayura/storage-sqlite';
```

Define each child as a genuine finite workflow, then embed it in a genuine tree with explicit narrowed permissions, cost/call limits, output size, approval TTL and resource plan. Create the runtime with the parent authority and a stable worker identity. Supply `verifyHuman` when a child tool declares `approval: true`. `submit` persists the root; `runUntilSettled` admits, fences, executes, validates and joins each required child. It returns a waiting snapshot before an approval-protected dispatch. Read the exact digest with `inspectChild`, pass it with the root, child and node identities to `approve`, then continue with `runUntilSettled`. Credentials stay local to the verifier; only its bounded verified identity is persisted. `inspect`, `events`, `recoverExpired`, `cancel` and `close` remain explicit operations.

Run the credential-free close/reopen example after building:

```sh
node examples/workflow-tree-children.mjs
```

Expected result:

```json
{"status":"succeeded","output":42,"toolExecutions":1,"rootAccountClosed":true}
```

This preview supports one-level required child workflows containing tool/join nodes, including exact approval-enabled tool candidates. It rejects root-local tools, nested children and undeclared authority instead of silently changing profiles. `close` stops local driving; it does not imply durable cancellation. Started effects with uncertain outcomes are quarantined and never automatically replayed. Use verified application scope, genuine definitions and a selected adapter's explicit `workflowTrees` capability.
