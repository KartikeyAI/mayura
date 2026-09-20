import { createSqliteStore, createPostgresStore, StorageError, type WorkflowGraphAggregateStore } from '@mayura/storage';
import { createSqliteStore as selectedSqlite } from '@mayura/storage-sqlite';
import { createPostgresStore as selectedPostgres } from '@mayura/storage-postgres';

const sqlite: WorkflowGraphAggregateStore = createSqliteStore({ filename: ':memory:' });
const postgres: WorkflowGraphAggregateStore = createPostgresStore({ connectionString: 'postgresql://example.invalid/db' });
void sqlite.workflowGraphs.initialize(); void postgres.workflowGraphs.initialize();
// @ts-expect-error Graph attachment is not an optional migration shortcut.
void sqlite.workflowGraphs.attach;
const sqliteFactory: typeof selectedSqlite = createSqliteStore;
const postgresFactory: typeof selectedPostgres = createPostgresStore;
// @ts-expect-error Compatibility does not expose shared reducer internals.
import '@mayura/storage/dist/scheduler-database.js';
void sqlite; void postgres; void sqliteFactory; void postgresFactory; void StorageError;
