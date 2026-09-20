import { createPostgresStore, type PostgresStoreOptions } from '@mayura/storage-postgres';
import type { WorkflowGraphDiscoveryAggregateStore } from '@mayura/storage-contracts';

const options: PostgresStoreOptions = { connectionString: 'postgresql://example.invalid/db', schema: 'app' };
const store: WorkflowGraphDiscoveryAggregateStore = createPostgresStore(options);
void store.workflowGraphDiscovery.scan({ scope: 'a'.repeat(64), policyHash: 'b'.repeat(64), cursor: null, limit: 1 });
void store.workflowGraphs.inspect({ scope: 'a'.repeat(64), id: 'b'.repeat(64), policyHash: 'c'.repeat(64) }).then(value => {
  const profile: 'scheduled-v2' = value.profile; void profile;
});
// @ts-expect-error PostgreSQL factories stay synchronous.
const deferred: Promise<WorkflowGraphDiscoveryAggregateStore> = createPostgresStore(options);
// @ts-expect-error Connections require an explicit string.
createPostgresStore({ connectionString: 123 });
// @ts-expect-error The PostgreSQL-only package does not export SQLite.
import { createSqliteStore } from '@mayura/storage-postgres';
// @ts-expect-error Internal reducer source is not exported by the driver package.
import '@mayura/storage-postgres/src/postgres.js';
void store; void deferred; void createSqliteStore;
