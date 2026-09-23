# @mayura/workflows

Experimental finite, schema-driven workflows for Mayura. Define versioned tools/joins once, then explicitly select conservative durable execution, opt-in leased scheduled execution, or approval-free ephemeral agent composition.

```ts
import {
  defineWorkflow,
  createWorkflowRuntime,
  createScheduledWorkflowRuntime,
} from '@mayura/workflows';
import { workflowAsAgent, workflowAsTool } from '@mayura/workflows/ephemeral';
```

Both durable runtimes require an application-owned storage adapter. The scheduled runtime requires atomic `ScheduledWorkflowStore` support and does not silently upgrade conservative runs. Select `@mayura/storage-sqlite` or `@mayura/storage-postgres` for one driver, or `@mayura/storage` for the compatible both-adapter facade. This package installs no SQL driver.

The separate `@mayura/workflows/graphs` entry exports `defineWorkflowGraph` and `createWorkflowGraphRuntime` for explicit format-3 / scheduled-v2 graphs. It adds real wait nodes over already submitted same-scope/policy executions using literal/input target bindings. Waits release worker capacity, survive store close/reopen and yield ordered terminal metadata; no attachment, future references, target payload copying, child ownership or automatic polling is implied. The optional `WorkflowGraphStore` capability leaves existing custom scheduled-v1 adapters unchanged. Legacy definitions and hashes are not migrated.

Scheduled execution admits at most 64 KiB per input/output, uses storage-clock leases and exact approvals, and retains late effect evidence without releasing late output. Unknown started effects are never automatically replayed. Worker shutdown is cooperative, not hard isolation or provider-side cancellation.

The same graphs entry also exports `createWorkflowGraphDiscovery` with the separately optional `WorkflowGraphDiscoveryStore` capability. It returns bounded scope/policy-pinned pages of nonterminal graph metadata, not dispatch authority or readiness guarantees. Cursors count terminal owners too; pages are not a stable snapshot. Applications own their definition registry, page budget and explicit continuation calls. No polling service or projection backfill is added.

`createWorkflowGraphCoordinator` adds explicit registered continuation over that capability: 1–32 trusted definitions and their exact resource plans share one driver across finite, sequential candidate pages. Frozen metadata reports distinguish completed pages from interrupted pages carrying the original retry cursor. Unknown definitions are skipped without dispatch. No submit/approve interface, background polling, fleet ownership or pooled cross-run monetary budget is added.

The opt-in `@mayura/workflows/children` entry exports `defineWorkflowTree` and `createWorkflowTreeRuntime`. Its current `scheduled-v3` profile drives one-level required child workflows through a selected adapter's explicit `workflowTrees` capability, including narrowed authority, fenced dispatch, renewal, close/reopen continuation, exact joins, recovery and terminal accounting. Root-local tools, approval-enabled child tools, nested children and automatic background polling are rejected in this preview.

See the workspace Markdown documentation for complete scheduled/conservative contracts, adoption examples, failure tests and current limitations. This private development build is not an enterprise-qualified release. License and registry namespace remain owner decisions; nothing has been published.
