# Changing a workflow definition with runs in flight

Every durable run is pinned to the digest of the definition that started it. Mayura never resumes stored state under a different definition; a mismatch fails with `CONFLICT`. This follows [plan §4.3](../create-mayura-agentic-framework-plan.md), which requires a deployment to "retain executable versions for active runs or provide a reviewed state migration."

Mayura v1 implements retention. A reviewed in-place state migration is not offered, because rewriting a run's durable state under new semantics is exactly what the pinning rule exists to prevent.

## Policy

1. **Change the version.** Give the changed definition a new `version`, which gives it a new digest. New submissions use the new definition.
2. **Keep the old version registered.** Keep the old definition in every host and coordinator catalog (`definitions: [v1, v2]`, `runPage({ sagas: [...] })`) until no active run is pinned to it. Hosts dispatch each run to the definition whose digest matches its stored state. Runs on an unregistered digest are skipped and reported as `unregistered` or `unregistered_definition`, never run with the wrong code.
3. **Retire the old version.** Remove it only after the inventory reports it as `retirable`. If you cannot wait, drain the old runs (let them finish) or cancel them explicitly, then resubmit on the new version with any mapping of inputs you have reviewed.

## Inventory and deploy gate

```ts
import { assertWorkflowVersionsRetained, compositeVersionTarget, inventoryWorkflowVersions, lifecycleFleetTarget } from '@mayura/workflows';

const inventory = await inventoryWorkflowVersions({
  store, scope,
  targets: [lifecycleFleetTarget(lifecycleRuntime, 'lifecycle', { includePaused: true }), compositeVersionTarget(compositeRuntime),
    graphFleetTarget(graphDiscovery, graphRuntime), treeFleetTarget(treeDiscovery, treeRuntime)],
  registered: nextDeploymentDefinitions, // the definitions the new release will register
});
assertWorkflowVersionsRetained(inventory); // throws if an active run would be stranded, or if the scan was incomplete
console.log(inventory.retirable);          // registered versions with no active runs
```

Run this as a pre-deploy step against production storage. The inventory is read-only. It counts running, waiting and paused runs. It is reported as `complete: false` when `maxRuns` stops the scan, and the gate refuses an incomplete inventory.
