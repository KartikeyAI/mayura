import { MayuraError, type Scope } from '@mayura/core';
import type { AggregateStore } from '@mayura/storage-contracts';
import { digest } from './definition.js';
import type { MigrationCommand, MigrationPlan, WorkflowMigration, WorkflowMigrationCatalog, WorkflowMigrationResult } from './migration.js';

/** The definition digest a durable run is pinned to, or undefined when the run does not exist in this scope. */
export async function pinnedDefinitionHash(store: AggregateStore, scope: Scope, runId: string): Promise<string | undefined> {
  if (typeof runId !== 'string' || !/^[a-f0-9]{64}$/.test(runId)) throw new MayuraError('INVALID_INPUT', 'An exact run id is required.');
  const record = await store.read(digest('mayura:scope:v1', { principalId: scope?.principalId, projectId: scope?.projectId }), runId);
  return record?.definitionHash;
}

export interface WorkflowMigrationOfferRecord {
  readonly id: string; readonly description: string;
  readonly fromVersion: string; readonly toVersion: string; readonly fromDigest: string; readonly toDigest: string;
}
export interface WorkflowMigrationServiceOptions<S extends { readonly version: number }> {
  readonly catalog: WorkflowMigrationCatalog;
  /** The run's pinned definition digest; undefined when the run is not visible. See `pinnedDefinitionHash`. */
  readonly pinned: (runId: string) => Promise<string | undefined>;
  /** The run's current snapshot; its `version` is the revision operators act on. */
  readonly inspect: (runId: string) => Promise<S>;
  /** The format runtime's `migrate` (for fleets, the fleet wrapper so indexes follow the run). */
  readonly migrate: (migration: WorkflowMigration, command: MigrationCommand) => Promise<WorkflowMigrationResult<S>>;
}
export type WorkflowMigrationApplyResult<S> =
  | { readonly status: 'applied'; readonly plan: MigrationPlan; readonly snapshot: S }
  | { readonly status: 'refused'; readonly plan: MigrationPlan }
  | { readonly status: 'conflict' } | { readonly status: 'not_found' };
export interface WorkflowMigrationService<S> {
  list(runId: string): Promise<readonly WorkflowMigrationOfferRecord[] | null>;
  plan(runId: string, migrationId: string): Promise<MigrationPlan | null>;
  /** Apply at an exact revision. A plan with blockers is `refused`; a changed revision or concurrent change is `conflict`. */
  apply(runId: string, migrationId: string, command: { readonly revision: number; readonly actorId: string; readonly commandId: string }): Promise<WorkflowMigrationApplyResult<S>>;
}

const identity = (definition: unknown): { readonly version: string; readonly digest: string } => {
  const value = definition as { readonly version?: unknown; readonly digest?: unknown };
  if (typeof value?.version !== 'string' || typeof value.digest !== 'string') throw new MayuraError('INVALID_CONFIG', 'Migration definitions need a version and digest.');
  return { version: value.version, digest: value.digest };
};
const isConflict = (error: unknown): boolean => error instanceof MayuraError && error.code === 'CONFLICT';

/**
 * Operator-facing migration service over one format runtime: offers the catalog's migrations for a run's pinned
 * version, previews plans and applies them at an exact revision. It adds no authority: every decision stays in the
 * runtime's planner and the store's transactional re-verification.
 */
export function createWorkflowMigrationService<S extends { readonly version: number }>(options: WorkflowMigrationServiceOptions<S>): WorkflowMigrationService<S> {
  const { catalog, pinned, inspect, migrate } = options;
  if (!catalog || typeof catalog.from !== 'function' || typeof pinned !== 'function' || typeof inspect !== 'function' || typeof migrate !== 'function') {
    throw new MayuraError('INVALID_CONFIG', 'A migration service needs a catalog and pinned, inspect and migrate callbacks.');
  }
  const offered = async (runId: string, migrationId: string): Promise<WorkflowMigration | undefined> => {
    const hash = await pinned(runId); if (hash === undefined) return undefined;
    return catalog.from(hash).find(migration => migration.id === migrationId);
  };
  const service: WorkflowMigrationService<S> = {
    async list(runId) {
      const hash = await pinned(runId); if (hash === undefined) return null;
      return Object.freeze(catalog.from(hash).map(migration => {
        const from = identity(migration.from); const to = identity(migration.to);
        return Object.freeze({ id: migration.id, description: migration.description, fromVersion: from.version, toVersion: to.version, fromDigest: from.digest, toDigest: to.digest });
      }));
    },
    async plan(runId, migrationId) {
      const migration = await offered(runId, migrationId); if (!migration) return null;
      // The plan carries no authority; the actor and command identities are placeholders that are never recorded.
      return (await migrate(migration, { id: runId, actorId: 'preview', commandId: 'preview', dryRun: true })).plan;
    },
    async apply(runId, migrationId, command) {
      const migration = await offered(runId, migrationId); if (!migration) return (await pinned(runId)) === undefined ? { status: 'not_found' } : { status: 'conflict' };
      if ((await inspect(runId)).version !== command.revision) return { status: 'conflict' };
      const { plan } = await migrate(migration, { id: runId, actorId: command.actorId, commandId: command.commandId, dryRun: true });
      if (!plan.allowed) return { status: 'refused', plan };
      try {
        const result = await migrate(migration, { id: runId, actorId: command.actorId, commandId: command.commandId });
        return { status: 'applied', plan: result.plan, snapshot: result.snapshot! };
      } catch (error) { if (isConflict(error)) return { status: 'conflict' }; throw error; }
    },
  };
  return Object.freeze(service);
}
