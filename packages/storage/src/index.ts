// Compatibility facade: explicitly selects both adapters. New applications can select just one.
export * from '@mayura/storage-contracts';
export { createSqliteStore, migrateSqliteStoreV0ToV1, type SqliteStoreOptions, type SqliteV0MigrationOptions } from '@mayura/storage-sqlite';
export { createPostgresStore, type PostgresStoreOptions } from '@mayura/storage-postgres';
