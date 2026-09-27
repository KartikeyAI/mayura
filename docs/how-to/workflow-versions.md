# Changing a workflow definition with runs in flight

Every durable run is pinned to the digest of the definition that started it. Mayura never resumes stored state under a different definition. A mismatch fails with `CONFLICT`. This follows [plan §4.3](../create-mayura-agentic-framework-plan.md), which requires a deployment to "retain executable versions for active runs or provide a reviewed state migration."

Mayura v1 supports both:

- **Retention.** Old and new versions run side by side until the old runs finish. This is the default, and it needs no operator action per run.
- **Reviewed in-place migration.** A paused run moves to the new version, step by step, under rules that storage enforces. See [Migrating in-flight workflow runs](workflow-migrations.md).

## Policy

1. **Change the version.** Give the changed definition a new `version`, which gives it a new digest. New submissions use the new definition.
2. **Keep the old version registered, or migrate its runs.** Keep the old definition in every host and coordinator catalog (`definitions: [v1, v2]`, `runPage({ sagas: [...] })`) until no active run is pinned to it. Hosts dispatch each run to the definition whose digest matches its stored state. Runs on an unregistered digest are skipped and reported as `unregistered` or `unregistered_definition`, never run with the wrong code. To move runs forward sooner, pause them and apply a reviewed migration.
3. **Retire the old version.** Remove it only after the inventory reports it as `retirable`. That happens once every run pinned to it has finished or migrated. If you cannot wait, and a migration is not appropriate, drain the old runs or cancel them explicitly, then resubmit on the new version.

## Inventory and deploy gate

```ts
import { assertWorkflowVersionsRetained, compositeVersionTarget, graphFleetTarget, inventoryWorkflowVersions, lifecycleFleetTarget, treeFleetTarget } from '@mayura/workflows';

const inventory = await inventoryWorkflowVersions({
  store, scope,
  targets: [
    lifecycleFleetTarget(lifecycleRuntime, 'lifecycle', { includePaused: true }),
    compositeVersionTarget(compositeRuntime),
    graphFleetTarget(graphDiscovery, graphRuntime, 'graphs', { includePaused: true }),
    treeFleetTarget(treeDiscovery, treeRuntime, 'trees', { includePaused: true }),
  ],
  registered: nextDeploymentDefinitions, // the definitions the new release will register
});
assertWorkflowVersionsRetained(inventory); // throws if an active run would be stranded, or if the scan was incomplete
console.log(inventory.retirable);          // registered versions with no active runs
```

Run this as a pre-deploy step against production storage. The inventory is read-only.

It counts running, waiting and paused runs. Graph and tree discovery list paused runs as well: coordinators skip them, and the `includePaused` option passes them to the inventory. The inventory is reported as `complete: false` when `maxRuns` stops the scan, and the gate refuses an incomplete inventory.
