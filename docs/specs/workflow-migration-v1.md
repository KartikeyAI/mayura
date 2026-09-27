# Workflow run migration v1

Status: implemented for workflow formats 2 (aggregate and scheduled), 3 (graphs), 4 (trees), 5 (lifecycle), sagas and loops, on SQLite and PostgreSQL.

Plan §4.3 requires a deployment to "retain executable versions for active runs or provide a reviewed state migration." Retention is covered in [the versions guide](../how-to/workflow-versions.md). This spec defines the reviewed migration.

## Model

- A `WorkflowMigration` is a frozen declaration: `id`, `from`, `to`, `renames` (target → source), `acceptCompleted`, `acceptRemoved` and `description`. It carries no code that runs against state.
- Each format reduces both definitions to nodes `{ id, kind, dependsOn, fingerprint }`. The fingerprint is `sha256("mayura:migration-node:v1", node without id)`, and it covers everything that determines the node's behavior: tool identity and version, bindings, approval, policy, resources and child definitions. Scheduled formats also include the node's resource plan.
- `planWorkflowMigration` compares the node sets against the run's step statuses and returns entries (`keep`, `update`, `reset`, `accept`, `add`, `remove`) and blockers. `allowed` is true exactly when there are no blockers.

## Rules

1. The run must be paused. The format's quiescence rules apply: no leased or started job, and no dispatching step.
2. Statuses `dispatching`, `unknown`, `leased`, `started` and `running` are in flight. A step in flight is never changed, renamed or removed. Its dependencies in the target must all have succeeded.
3. Settled statuses can only be carried unchanged. A changed or removed settled step needs `acceptCompleted` or `acceptRemoved`. A settled step cannot be renamed.
4. A changed step parked on a decision (`waiting`, `approved`, `forward_waiting`, `compensation_waiting`) is reset to pending, and its request is re-issued with a new digest.
5. Blocked nodes keep their current status in the plan, so their dependents report only root causes.
6. Durable history keyed by node must survive unchanged under its own id. That covers a scheduler job (scheduled and graph formats, tree roots) and an admitted child (trees). Storage enforces this inside the migration transaction, independently of the runtime's plan.
7. A run that is a wait target cannot migrate. That covers graph wait targets and execution-completion waits, in either table.

## Storage primitive

- The aggregate formats (2, 5, sagas, loops) use `AggregateStore.migrate(MigrateRecord)`. It compares the version and `expectedDefinitionHash`, then rewrites `definition_hash`, the state and the events atomically. It refuses runs owned by scheduled storage.
- Scheduled storage (profiles 1 and 2) implements `migrate(ScheduledMigrate)` inside its locked transaction. It re-validates the complete new state against the new manifest and re-projects the wait target rows. It updates the definition and resource hashes of the owner rows, and appends the previous digest to `owner.lineage` so existing jobs stay valid.
- Tree storage implements `migrateRoot`. It applies the same checks to the root, re-applies the submission funding rule against the unchanged policy, and updates the aggregate, owner and member rows.

Every applied migration appends `run.migrated { migrationId, from, to, actorId, commandId }`. Aggregate formats also record the per-step `actions`. The run stays paused.

## Composition

- A saga or loop child is compared by the definition it is actually pinned to. Migrate the child first, then the parent.
- Fleet wrappers move index entries with the run. The composite index accepts an identity change only from the migration's source digest.

## Transport

- The server exposes list, plan and apply at `/v1/workflow-runs/:id/migrations[/:migrationId]`. Apply requires `workflows:migrate`, an exact revision and a command id. It returns `409` with the plan when refused, and `409` when the revision changed. Every reply is validated before it is returned.
- `createWorkflowMigrationService` connects a catalog and a runtime to these routes. It never decides safety itself.

## Verification

- `packages/workflows/test/migration-*-conformance.ts` runs every format on SQLite and PostgreSQL. The tests cover:
  - a migrated run completing on the new version, with executed steps not repeating,
  - refusal of changes to settled or history-bearing steps,
  - wait-target re-projection, and refusal to migrate a wait target,
  - saga child-first migration,
  - loop bounds,
  - fleet index movement,
  - paused runs in discovery, inventories and coordinators.
- `packages/server/test/server.test.ts` and `packages/client/test/client.test.ts` cover the routes, capability separation, hostile transport replies, and an end-to-end migration through the client.
