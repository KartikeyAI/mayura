---
title: "Operating workflows"
description: "Run durable workflows in production: list and inspect runs, cancel, pause, hold the whole fleet, and ship new definition versions safely."
---

Once durable workflows run in production, operators need to see what is running, stop a run that is going wrong,
freeze everything during an incident, and ship a new version of a workflow while old runs are still in flight. This
page covers those tasks. It assumes you run lifecycle workflows with a worker host, as in
[Durable workflows](durable-workflows.md).

Every operation is available three ways: from code on the runtime, over HTTP through the
[agent server](server-and-client.md) (and so from `mayura/client`, the CLI and the operator console), and for fleet
operations through a dedicated fleet control.

## Serve the operator API

`createWorkflowOperatorTransports` builds all the server-side workflow operations over your runtimes: listing,
run views, cancel, approve, pause, resume, the fleet hold and migrations. Spread its result into the server options.

```ts
import { createAgentServer } from 'mayura/server';
import {
  createWorkflowCommandJournal, createWorkflowFleetControl, createWorkflowMigrationCatalog,
  createWorkflowOperatorTransports, lifecycleOperatorTarget,
} from 'mayura/workflows';
import { createWorkflowLifecycleFleetRuntime } from 'mayura/workflows/lifecycle';

const runtime = createWorkflowLifecycleFleetRuntime({ store, scope, permissions, policyVersion: '1', maxCostMicros: 500_000, verifyHuman });

const operator = createWorkflowOperatorTransports({
  store, scope,
  journal: createWorkflowCommandJournal({ store, scope }),       // each command id applies at most once
  fleet: createWorkflowFleetControl({ store, scope }),           // optional: the fleet hold
  migrations: createWorkflowMigrationCatalog([refundsV1toV2]),   // optional: reviewed migrations
  targets: [lifecycleOperatorTarget({ runtime, store, scope, definitions: [refundsV1, refundsV2], approvalCredential })],
});

const server = createAgentServer({ agents, authenticate, publicOrigin: 'https://ops.example.com', ...operator });
```

- Register every definition version that still has runs. A run whose version is not registered is reported as not
  found.
- `approvalCredential` maps the authenticated operator's id to a credential your `verifyHuman` accepts. Without it,
  approvals over HTTP are unavailable. See [Approvals and human input](approvals-and-human-input.md).
- The transports serve one scope. Callers authenticated for another scope see nothing and change nothing.

Callers need these capabilities in their server identity:

| Capability | Allows |
|---|---|
| `workflows:read` | List runs, read a run, list and preview migrations, read the fleet hold. |
| `workflows:control` | Cancel, approve, pause, resume, send signals. |
| `workflows:fleet` | Hold and release the fleet, run fleet sweeps. `workflows:control` does not imply it. |
| `workflows:migrate` | Apply a migration. |

## List and inspect runs

```ts
const active = await client.workflows({ limit: 20 });                   // running, waiting and paused
const finished = await client.workflows({ view: 'settled', limit: 20 }); // recently finished, and runs to reconcile
const view = await client.workflow(active.items[0]!.runId);
console.log(view.definitionVersion, view.status, view.revision, view.steps);
```

Pages come with a `next` cursor; pass it back as `after`. The settled view keeps up to 16,384 lifecycle runs per scope,
dropping the oldest finished ones first. Runs that ended `outcome_unknown` are kept longest, because someone still has
to reconcile them. From code, `runtime.inspect(runId)` and `runtime.settled()` give the same information. The CLI has
`mayura workflow-list` (add `--settled` for the finished view) and `mayura workflow-get`.

## Revisions and command ids

Every run view has a `revision` that changes whenever the run changes. Commands that change a run carry the revision
the operator looked at and a `commandId`:

```ts
await client.pauseWorkflow(runId, view.revision, { commandId: crypto.randomUUID() });
```

- If the run changed since the operator looked, the command is refused (HTTP 409). Read the run again and decide again.
- A command id applies at most once. If a request times out, send it again with the same command id: you get the
  recorded outcome instead of a second action. Never make up a new id just to retry.

## Cancel

`runtime.cancel(runId)`, `client.cancelWorkflow(runId, revision, { commandId })` or `mayura workflow-cancel` stops a run:
steps that have not started are skipped, and the run ends `cancelled`. Cancelling never undoes an effect that already
happened, and a step that is already running is not interrupted in its external system.

## Pause and resume

A pause stops a run from starting any new step without cancelling it. Use it to investigate a run, or before
migrating it.

- `runtime.pause(runId)`, `client.pauseWorkflow`, `mayura workflow-pause`.
- `runtime.resume(runId)`, `client.resumeWorkflow`, `mayura workflow-resume`.

A run with a step in flight cannot be paused (`CONFLICT`); wait for the step to finish or recover it first. Resuming
restores `waiting` if the run still waits for an approval, a person or a timer; it never answers the wait for you.
Approvals and answers given while a run is paused are kept and take effect after it resumes.

## Hold the whole fleet

During an incident you may want every worker to stop advancing runs at once. The fleet hold is a durable flag per scope.

```ts
import { createWorkflowFleetControl, lifecycleFleetTarget, type WorkflowFleetSweepCursor } from 'mayura/workflows';
import { createWorkflowLifecycleHost } from 'mayura/workflows/lifecycle';

const fleet = createWorkflowFleetControl({ store, scope });
// Every host checks the hold before each cycle and drives nothing while it is set.
const host = createWorkflowLifecycleHost({ ...options, definitions, hold: fleet });

await fleet.hold();
// Optionally also mark each active run paused, one page at a time.
let cursor: WorkflowFleetSweepCursor | null = null;
do { cursor = (await fleet.sweepPause([lifecycleFleetTarget(host.runtime)], { cursor })).nextCursor; } while (cursor);

// Later
await fleet.release();
do { cursor = (await fleet.sweepResume([lifecycleFleetTarget(host.runtime)], { cursor })).nextCursor; } while (cursor);
```

- `hold()` and `release()` are idempotent. Releasing resumes nothing by itself.
- A pause sweep records which runs it paused; a resume sweep resumes only those, never runs someone paused on purpose.
- Over HTTP: `client.holdWorkflowFleet()`, `client.sweepWorkflowFleet('pause', { cursor })`,
  `client.releaseWorkflowFleet()`. On the CLI: `mayura fleet-hold`, `mayura fleet-sweep`, `mayura fleet-release`,
  `mayura fleet-get`. See [Operations commands](../cli/operations.md).
- A host that cannot read the hold fails its cycle rather than drive runs.

## Signals

The server has a route for delivering a named signal with a small JSON value to a run
(`client.signalWorkflow`, `mayura workflow-signal`, capability `workflows:control`). Mayura does not implement what a
signal means: you provide a `workflowSignals.deliver` adapter to the server that records the signal and journals the
command id, for example in a `createWorkStream` stream from `mayura/workstream`. Lifecycle workflows have no signal
step, so to make a run react to an outside event, see the patterns in [Durable workflows](durable-workflows.md).

## Ship a new version of a workflow

Every run is pinned to the digest of the definition it started with, and never continues under a different one. To
change a workflow:

1. **Add a new version.** Keep the same `id`, give it a new `version`, and submit new runs with it. Never edit a
   version that has runs in flight.
2. **Keep the old version registered** in `definitions` for every host and operator target until its runs finish. The
   host skips runs whose version is missing (they are reported as `unregistered_definition`), so they wait instead of
   running the wrong code.
3. **Or migrate** in-flight runs to the new version after reviewing a plan (below).
4. **Retire the old version** once nothing uses it.

Runs are also pinned to the runtime settings they started with (`permissions`, `policyVersion`, `maxCostMicros`,
`maxOutputBytes`, `approvalTtlMs`). If the release changes any of them, for example to grant a tool the new version
calls, pass the previous release's settings in `previousPolicies` on every runtime and host. Otherwise its in-flight
runs stop with `CONFLICT`. Listed runs finish under their own settings and never gain the new grants; migrating a run
moves it onto the new settings. See [Durable workflows](durable-workflows.md).

### Check before you deploy

`inventoryWorkflowVersions` counts active runs per version. Run it against production storage before a deploy:

```ts
import { assertWorkflowVersionsRetained, inventoryWorkflowVersions, lifecycleFleetTarget } from 'mayura/workflows';

const inventory = await inventoryWorkflowVersions({
  store, scope,
  targets: [lifecycleFleetTarget(runtime, 'lifecycle', { includePaused: true })],
  registered: nextReleaseDefinitions, // what the new release will register
});
assertWorkflowVersionsRetained(inventory); // throws if a run would be stranded, or the scan was incomplete
console.log(inventory.retirable);          // registered versions with no active runs
```

### Migrate in-flight runs

A migration is a reviewed declaration that moves a paused run from one version to another. Mayura works out from the
run's real state what happens to each step and refuses anything unsafe.

```ts
import { defineWorkflowMigration } from 'mayura/workflows/lifecycle';

const refundsV1toV2 = defineWorkflowMigration({
  id: 'refunds-1-to-2',
  from: refundsV1,
  to: refundsV2,
  renames: { announce: 'notify' }, // new step id -> old step id
  description: 'Notify the customer once the refund is issued.',
});

await runtime.pause(runId);
const preview = await runtime.migrate(refundsV1toV2, { id: runId, actorId: 'alice', commandId: 'change-4211', dryRun: true });
if (preview.plan.allowed) {
  await runtime.migrate(refundsV1toV2, { id: runId, actorId: 'alice', commandId: 'change-4211' });
  await runtime.resume(runId);
}
```

The plan lists one action per step:

| Action | When | Effect |
|---|---|---|
| `keep` | The step is unchanged. | Its state is carried over. |
| `update` | The step changed but never started. | It runs under the new definition. |
| `reset` | The step changed while waiting for an approval, a person or a timer. | The request is issued again; old digests stop working. |
| `accept` | The step changed after it finished, and you listed it in `acceptCompleted`. | Its result is kept. |
| `add` | The step is new. | It starts pending. |
| `remove` | The step is gone and never started, or finished and is listed in `acceptRemoved`. | It is dropped. |

A migration is always refused for a run that is not paused, a step with work in flight or an unknown outcome, a
carried step whose new dependencies have not all succeeded, a rename of a finished step, and a plan made against an
older revision. Migrate through the fleet runtime so the worker's index follows the run. The run's event log records
the migration id, both digests, the actor and the command id.

Operators can do the same over HTTP: `client.workflowMigrations(runId)`, `client.planWorkflowMigration(runId, id)` and
`client.migrateWorkflow(runId, id, revision, { commandId })`, backed by the `migrations` catalog above. The
[operator console](operator-console.md) has a review dialog for it.

## Runs with unknown outcomes

A run that ends `outcome_unknown` stays in the settled view until it drops out. A run whose step was in flight when a
process died stays active and cannot be paused; after checking the outside system, call
`runtime.recoverAbandoned(runId)` from code to record the step as unknown. There is no HTTP or CLI command for this
yet. See [Durable workflows](durable-workflows.md).

## Other workflow kinds and hosts

The pieces above also cover the other durable runtimes:

- **Sagas and loops** run on `createWorkflowCompositeHost` from `mayura/workflows/composites`, which also accepts
  `hold`. See [Sagas and loops](sagas-and-loops.md).
- **Graphs and trees** (`mayura/workflows/graphs`, `mayura/workflows/children`) are advanced by coordinators
  (`createWorkflowGraphCoordinator`, `createWorkflowTreeCoordinator`) that work through pages of active runs found by
  a discovery (`createWorkflowGraphDiscovery`, `createWorkflowTreeDiscovery`). Wrap a coordinator with
  `coordinatorUnit` to run it in a worker, and expose its runs with `graphOperatorTarget` or `treeOperatorTarget`.
- **Workers.** `createWorkflowWorker` supervises up to 32 units (hosts, coordinator units, the trace export) under
  one leadership lease, and `worker.drain()` shuts them down gracefully. Give each duty its own leadership `role`.

## Good to know

- Operator commands are journaled permanently, one small record per command id. Use a fresh UUID per operator action.
- Approvals are attributed to the id your `approvalCredential` and `verifyHuman` produce. If every operator token maps
  to one service identity, so does every approval.
- Hosts and coordinators only drive runs whose definitions they were given. After a migration, register the new
  version everywhere before resuming.

## Related

- [Durable workflows](durable-workflows.md)
- [Approvals and human input](approvals-and-human-input.md)
- [Operations commands](../cli/operations.md)
- [Operator console](operator-console.md)
- [Deployment](deployment.md)
