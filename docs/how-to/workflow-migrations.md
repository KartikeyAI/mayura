# Migrating in-flight workflow runs

A durable run is pinned to the digest of the definition that started it. When you ship a new version of a definition, you have two options for the runs already in flight:

- **Retain** the old version until its runs finish. See [Changing a workflow definition with runs in flight](workflow-versions.md).
- **Migrate** the runs in place to the new version. This guide covers that option.

A migration is a reviewed declaration. Mayura decides from each run's real state what the migration does to every step, and refuses anything it cannot do safely. Storage checks the migrated state again inside its transaction, so a stale or wrong plan can never be applied.

Every workflow format supports migration:

| Format | Runtime method |
|---|---|
| Aggregate workflows (format 2) | `createWorkflowRuntime(...).migrate` |
| Scheduled workflows (format 2, scheduled storage) | `createScheduledWorkflowRuntime(...).migrate` |
| Graph workflows (format 3) | `createWorkflowGraphRuntime(...).migrate` |
| Workflow trees (format 4) | `createWorkflowTreeRuntime(...).migrate` |
| Lifecycle workflows (format 5) | `createWorkflowLifecycleRuntime(...).migrate`, or the fleet runtime's `migrate` |
| Sagas | `createWorkflowSagaRuntime(...).migrate`, or the composite fleet's `migrateSaga` |
| Loops | `createWorkflowLoopRuntime(...).migrate`, or the composite fleet's `migrateLoop` |

## 1. Declare the migration

```ts
import { defineWorkflowMigration } from 'mayura/workflows';

const releaseV1toV2 = defineWorkflowMigration({
  id: 'release-1-to-2',            // letters, digits, '.', '_', '-'; recorded in the run's audit trail
  from: releaseV1,
  to: releaseV2,
  renames: { announce: 'notify' },  // target step id -> source step id
  acceptCompleted: [],              // changed steps whose settled result you accept as-is
  acceptRemoved: [],                // settled steps you accept dropping
  description: 'Announce each release once it is published.',
});
```

By default, a migration may only:

- carry a step over unchanged,
- change or rename a step that has not started,
- re-issue a step that is waiting on a decision (an approval, a human request, a timer or a signal),
- add new steps,
- remove steps that have not started.

Changing or removing a step that already settled needs your explicit acceptance, through `acceptCompleted` or `acceptRemoved`.

## 2. Pause, plan, apply, resume

```ts
await runtime.pause(runId);

// A dry run writes nothing and returns the plan.
const { plan } = await runtime.migrate(releaseV1toV2, { id: runId, actorId: 'alice', commandId: 'change-4211', dryRun: true });
console.table(plan.entries);          // keep / update / reset / accept / add / remove, per step
if (!plan.allowed) console.log(plan.blockers);

const { snapshot } = await runtime.migrate(releaseV1toV2, { id: runId, actorId: 'alice', commandId: 'change-4211' });
// snapshot.status === 'paused': review it, then resume
await runtime.resume(runId);
```

After the migration, only the new definition can drive the run. Keep the new definition registered with your hosts and coordinators. The run's events gain a `run.migrated` entry with the migration id, both digests, the actor, the command id and the per-step actions.

### What the plan does to each step

| Action | When | Effect |
|---|---|---|
| `keep` | The step's definition is unchanged. | State is carried over exactly. |
| `update` | The step changed but never started. | It runs under the new definition. |
| `reset` | The step changed while waiting on a decision. | The request is re-issued; old approval and response digests stop working. |
| `accept` | The step changed after it settled, and it is listed in `acceptCompleted`. | The existing result is kept. |
| `add` | The step is new. | It starts pending. |
| `remove` | The step is gone and never started, or it settled and is listed in `acceptRemoved`. | It is dropped. |

### What is always refused

- A run that is not paused.
- A step with work in flight: dispatching, leased, started, or with an unknown outcome.
- A step with scheduler history (a prepared or claimed job) or an admitted child, if its definition changed, it was renamed or it was removed. Scheduled, graph and tree storage enforce this inside the transaction.
- A carried step whose new dependencies have not all succeeded.
- A rename of a settled step.
- A run that another workflow waits on (graph wait targets and execution waits), because that would change the identity the waiter pinned.
- A plan made against an older revision of the run: plan again.

## Format-specific rules

- **Graphs.** Wait targets are projected again from the new definition. A wait that already started must keep exactly the same targets.
- **Trees.** Migration changes the root definition. An admitted child must stay unchanged. The root policy must still fund every declared tool, as it does at submission.
- **Lifecycle.** A waiting human step that changed gets a fresh request digest, so earlier responses are refused.
- **Sagas.** Only a saga in its forward phase can migrate. A saga that is compensating cannot. A step whose child is still running keeps that child only if the child already runs the target's child definition. Migrate the child first, then the saga:
  ```ts
  await sagas.lifecycle.pause(childId);
  await sagas.lifecycle.migrate(reviewV1toV2, { id: childId, actorId, commandId });
  await sagas.lifecycle.resume(childId);
  await sagas.migrate(orderV1toV2, { id: sagaId, actorId, commandId });
  ```
- **Loops.** Control settings (`maxIterations`, bindings, bounds) apply from the next iteration. `maxIterations` cannot drop below the number of iterations the loop has already run. An active iteration child follows the same rule as a saga child.
- **Fleets.** Use the fleet wrappers (`lifecycleFleet.migrate`, `composites.migrateSaga`, `composites.migrateLoop`) so the fleet index moves with the run.

## Serving migrations to operators

The agent server exposes migrations through the `workflowMigrations` transport:

| Route | Capability | Purpose |
|---|---|---|
| `GET /v1/workflow-runs/:id/migrations` | `workflows:read` | Migrations offered for the run's pinned version |
| `GET /v1/workflow-runs/:id/migrations/:migrationId` | `workflows:read` | Dry-run plan |
| `POST /v1/workflow-runs/:id/migrations/:migrationId` with `{ commandId, revision }` | `workflows:migrate` | Apply at an exact revision; a refused plan or a changed revision is HTTP 409 |

The simplest wiring is the [production operator API](workflow-operator-api.md): pass `migrations: createWorkflowMigrationCatalog([...])` to `createWorkflowOperatorTransports`. It journals every apply, so a retried command returns the same plan. To wire one runtime by hand, `createWorkflowMigrationService` connects a migration catalog to it:

```ts
import { createWorkflowMigrationCatalog, createWorkflowMigrationService, pinnedDefinitionHash } from 'mayura/workflows';

const migrations = createWorkflowMigrationService({
  catalog: createWorkflowMigrationCatalog([releaseV1toV2]),
  pinned: runId => pinnedDefinitionHash(store, scope, runId),
  inspect: runId => runtime.inspect(runId),
  migrate: (migration, command) => runtime.migrate(migration, command),
});

await listenAgentServer({
  // ...
  workflowMigrations: {
    list: ({ runId }) => migrations.list(runId),
    plan: ({ runId, migrationId }) => migrations.plan(runId, migrationId),
    apply: async ({ runId, migrationId, revision, actorId, commandId }) => {
      const result = await migrations.apply(runId, migrationId, { revision, actorId, commandId });
      return result.status === 'applied' ? { status: 'applied', plan: result.plan, workflow: await view(runId) } : result;
    },
  },
});
```

Clients call `client.workflowMigrations(id)`, `client.planWorkflowMigration(id, migrationId)` and `client.migrateWorkflow(id, migrationId, revision, { commandId })`. The [operator console](inspector.md) has a Migrations view and a review dialog on each run page. `examples/inspector.mjs` wires all of this end to end.

## Caveats

- Idempotent resubmission is keyed on the original submission. Submitting the same idempotency key with the old definition after a migration is refused with `CONFLICT`, because the stored run now uses the new version.
- Migration never rewrites effects that already happened. A step you accept with `acceptCompleted` keeps its recorded output, even if the new step would have produced something different.
- A settled step's result stays bound to what produced it. A tool step whose tool changed cannot be accepted: its receipt names the old tool. Reset it by giving the new step a new id, or finish the run on the old version.
- Record your migration ids and keep old definitions until every run has migrated or finished. `inventoryWorkflowVersions` counts running, waiting and paused runs per version.
