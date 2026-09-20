// Compatibility facade: explicitly selects both adapters. New applications can select just one.
export * from '@mayura/storage-contracts';
export { createSqliteStore, type SqliteStoreOptions } from '@mayura/storage-sqlite';
export { createPostgresStore, type PostgresStoreOptions } from '@mayura/storage-postgres';
