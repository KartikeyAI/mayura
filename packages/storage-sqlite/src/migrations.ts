import Database from 'better-sqlite3';
import { StorageError } from '@mayura/storage-contracts';

export interface SqliteV0MigrationOptions { readonly filename: string }

const v0Tables = ['mayura_aggregates', 'mayura_events', 'mayura_storage_meta'];
const columns = {
  mayura_storage_meta: ['version'],
  mayura_aggregates: ['scope', 'id', 'idempotency_key', 'definition_hash', 'submission_digest', 'version', 'event_sequence', 'state'],
  mayura_events: ['scope', 'aggregate_id', 'sequence', 'type', 'data', 'created_at'],
} as const;

/** Explicit, one-way migration for the recorded 0.1 development storage fixture. */
export function migrateSqliteStoreV0ToV1(options: SqliteV0MigrationOptions): void {
  if (typeof options?.filename !== 'string' || options.filename.length === 0 || options.filename === ':memory:' || options.filename.includes('\0')) {
    throw new StorageError('INVALID_INPUT', 'A persistent SQLite v0 filename is required for migration.');
  }
  const database = new Database(options.filename, { fileMustExist: true });
  try {
    database.pragma('foreign_keys = ON');
    database.transaction(() => {
      const integrity = database.pragma('integrity_check', { simple: true });
      if (integrity !== 'ok') throw new StorageError('STORAGE_UNAVAILABLE', 'The prior SQLite store failed integrity validation.');
      const tables = (database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'mayura_%' ORDER BY name").pluck().all() as string[]);
      if (JSON.stringify(tables) !== JSON.stringify(v0Tables)) throw new StorageError('CONFLICT', 'The SQLite store is not the exact supported v0 layout.');
      for (const [table, expected] of Object.entries(columns)) {
        const actual = (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(item => item.name);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new StorageError('CONFLICT', 'The SQLite store has an incompatible v0 table layout.');
      }
      const versions = database.prepare('SELECT version FROM mayura_storage_meta').pluck().all();
      if (versions.length !== 1 || versions[0] !== 0) throw new StorageError('CONFLICT', 'The SQLite store is not at migratable version 0.');
      database.exec(`
        CREATE TABLE mayura_workflow_owners (
          scope TEXT NOT NULL, aggregate_id TEXT NOT NULL, profile INTEGER NOT NULL CHECK(profile > 0),
          aggregate_version BIGINT NOT NULL CHECK(aggregate_version > 0), definition_hash TEXT NOT NULL,
          policy_hash TEXT NOT NULL, resource_hash TEXT NOT NULL, data TEXT NOT NULL,
          PRIMARY KEY(scope, aggregate_id), FOREIGN KEY(scope, aggregate_id) REFERENCES mayura_aggregates(scope, id)
        );
        UPDATE mayura_storage_meta SET version = 1 WHERE version = 0;
      `);
      if (database.prepare('SELECT version FROM mayura_storage_meta').pluck().get() !== 1) {
        throw new StorageError('STORAGE_UNAVAILABLE', 'SQLite v0 migration did not commit the expected version.');
      }
    }).immediate();
  } finally { database.close(); }
}
