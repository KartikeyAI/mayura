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

Scheduled execution admits at most 64 KiB per input/output, uses storage-clock leases and exact approvals, and retains late effect evidence without releasing late output. Trusted tool usage reports settle atomically with their receipts: known cost is charged, unused capacity is released and unresolved cost remains reserved. An optional application-owned `verifyExecution` boundary can authenticate an external provider attestation and atomically refine an unknown attempt to a withheld known receipt plus exact cost; it never resumes the workflow, publishes output, clears quarantine or replays the effect. Unknown started effects are never automatically replayed. Worker shutdown is cooperative, not hard isolation or provider-side cancellation.

`defineExternalEffectVerifier` and `composeExternalEffectVerifiers` provide a dependency-free provider adapter boundary. Each registered verifier owns one exact tool ID/version route and a fixed authority ID; the router validates and snapshots the request, rejects missing/duplicate/forged routes, forwards only the opaque caller credential, and validates a bounded provider attestation before adding the configured authority. It does not implement provider APIs, credential discovery, polling, retries or exactly-once execution.

The same graphs entry also exports `createWorkflowGraphDiscovery` with the separately optional `WorkflowGraphDiscoveryStore` capability. It returns bounded scope/policy-pinned pages of nonterminal graph metadata, not dispatch authority or readiness guarantees. Cursors count terminal owners too; pages are not a stable snapshot. Applications own their definition registry, page budget and explicit continuation calls. No polling service or projection backfill is added.

`createWorkflowGraphCoordinator` adds explicit registered continuation over that capability: 1–32 trusted definitions and their exact resource plans share one driver across finite, sequential candidate pages. Frozen metadata reports distinguish completed pages from interrupted pages carrying the original retry cursor. Unknown definitions are skipped without dispatch. No submit/approve interface, background polling, fleet ownership or pooled cross-run monetary budget is added.

The opt-in `@mayura/workflows/children` entry exports `defineWorkflowTree`, `createWorkflowTreeRuntime`, `createWorkflowTreeDiscovery` and `createWorkflowTreeCoordinator`. Its current `scheduled-v3` profile drives root-local tools and one-level required child workflows through selected adapters' explicit `workflowTrees` and optional `workflowTreeDiscovery` capabilities, including narrowed authority, exact restartable human approval, fenced dispatch, renewal, close/reopen continuation, exact joins, recovery and terminal accounting. One worker-wide bounded job pool is shared across ready root and child branches and retains timed-out handler capacity until actual settlement. The coordinator processes finite pages against an explicit genuine-definition catalog; it does not infer definitions or run a background poller. Nested children remain rejected in this preview.

The `@mayura/workflows/lifecycle` entry adds format-5 human/timer suspension, authenticated human transport binding and finite fleet coordination. The separate `@mayura/workflows/sagas` entry composes those lifecycle definitions into bounded sequential sagas with stable child identities and reverse-order compensation. The generic aggregate contract does not provide a cross-aggregate transaction; replay repairs child linking through deterministic submission keys.

See the workspace Markdown documentation for complete scheduled/conservative contracts, adoption examples, failure tests and current limitations. This private development build is not an enterprise-qualified release. License and registry namespace remain owner decisions; nothing has been published.
