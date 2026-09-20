import { createSqliteStore, type SqliteStoreOptions } from '@mayura/storage-sqlite';
import type { WorkflowGraphDiscoveryAggregateStore } from '@mayura/storage-contracts';

const options: SqliteStoreOptions = { filename: ':memory:' };
const store: WorkflowGraphDiscoveryAggregateStore = createSqliteStore(options);
void store.workflowGraphDiscovery.scan({ scope: 'a'.repeat(64), policyHash: 'b'.repeat(64), cursor: null, limit: 1 });
void store.workflowGraphs.inspect({ scope: 'a'.repeat(64), id: 'b'.repeat(64), policyHash: 'c'.repeat(64) }).then(value => {
  const profile: 'scheduled-v2' = value.profile; void profile;
});
// @ts-expect-error A SQLite factory is synchronous, not a promise-returning configuration step.
const deferred: Promise<WorkflowGraphDiscoveryAggregateStore> = createSqliteStore(options);
// @ts-expect-error SQLite filenames are required strings.
createSqliteStore({ filename: 123 });
// @ts-expect-error The SQLite-only package does not export PostgreSQL.
import { createPostgresStore } from '@mayura/storage-sqlite';
// @ts-expect-error Private worker implementations are not public authoring exports.
import '@mayura/storage-sqlite/dist/sqlite-worker.js';
void store; void deferred; void createPostgresStore;
