import { createSqliteStore, createPostgresStore, StorageError, type ExecutionWaitAggregateStore } from '@mayura/storage';
import { createSqliteStore as selectedSqlite } from '@mayura/storage-sqlite';
import { createPostgresStore as selectedPostgres } from '@mayura/storage-postgres';

const sqlite: ExecutionWaitAggregateStore = createSqliteStore({ filename: ':memory:' });
const postgres: ExecutionWaitAggregateStore = createPostgresStore({ connectionString: 'postgresql://example.invalid/db' });
const sqliteFactory: typeof selectedSqlite = createSqliteStore;
const postgresFactory: typeof selectedPostgres = createPostgresStore;
// @ts-expect-error Compatibility does not expose shared reducer internals.
import '@mayura/storage/dist/scheduler-database.js';
void sqlite; void postgres; void sqliteFactory; void postgresFactory; void StorageError;
