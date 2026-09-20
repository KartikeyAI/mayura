import { createSqliteStore, type SqliteStoreOptions } from '@mayura/storage-sqlite';
import type { ExecutionWaitAggregateStore } from '@mayura/storage-contracts';

const options: SqliteStoreOptions = { filename: ':memory:' };
const store: ExecutionWaitAggregateStore = createSqliteStore(options);
// @ts-expect-error A SQLite factory is synchronous, not a promise-returning configuration step.
const deferred: Promise<ExecutionWaitAggregateStore> = createSqliteStore(options);
// @ts-expect-error SQLite filenames are required strings.
createSqliteStore({ filename: 123 });
// @ts-expect-error The SQLite-only package does not export PostgreSQL.
import { createPostgresStore } from '@mayura/storage-sqlite';
// @ts-expect-error Private worker implementations are not public authoring exports.
import '@mayura/storage-sqlite/dist/sqlite-worker.js';
void store; void deferred; void createPostgresStore;
