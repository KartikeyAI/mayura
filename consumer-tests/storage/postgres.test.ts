import { createPostgresStore, type PostgresStoreOptions } from '@mayura/storage-postgres';
import type { ExecutionWaitAggregateStore } from '@mayura/storage-contracts';

const options: PostgresStoreOptions = { connectionString: 'postgresql://example.invalid/db', schema: 'app' };
const store: ExecutionWaitAggregateStore = createPostgresStore(options);
// @ts-expect-error PostgreSQL factories stay synchronous.
const deferred: Promise<ExecutionWaitAggregateStore> = createPostgresStore(options);
// @ts-expect-error Connections require an explicit string.
createPostgresStore({ connectionString: 123 });
// @ts-expect-error The PostgreSQL-only package does not export SQLite.
import { createSqliteStore } from '@mayura/storage-postgres';
// @ts-expect-error Internal reducer source is not exported by the driver package.
import '@mayura/storage-postgres/src/postgres.js';
void store; void deferred; void createSqliteStore;
