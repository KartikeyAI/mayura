import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createSqliteStore, migrateSqliteStoreV0ToV1 } from '@mayura/storage-sqlite';

describe('V21 prior-version storage migration', () => {
  it('migrates the exact v0 fixture once and preserves records and events', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mayura-v21-upgrade-'));
    const filename = join(directory, 'prior.sqlite');
    try {
      const prior = new Database(filename);
      prior.pragma('foreign_keys = ON');
      prior.exec(`
        CREATE TABLE mayura_storage_meta (version INTEGER PRIMARY KEY CHECK(version BETWEEN 0 AND 1));
        INSERT INTO mayura_storage_meta (version) VALUES (0);
        CREATE TABLE mayura_aggregates (
          scope TEXT NOT NULL, id TEXT NOT NULL, idempotency_key TEXT NOT NULL, definition_hash TEXT NOT NULL,
          submission_digest TEXT NOT NULL, version INTEGER NOT NULL, event_sequence INTEGER NOT NULL, state TEXT NOT NULL,
          PRIMARY KEY(scope, id), UNIQUE(scope, idempotency_key));
        CREATE TABLE mayura_events (
          scope TEXT NOT NULL, aggregate_id TEXT NOT NULL, sequence INTEGER NOT NULL, type TEXT NOT NULL,
          data TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(scope, aggregate_id, sequence),
          FOREIGN KEY(scope, aggregate_id) REFERENCES mayura_aggregates(scope, id));
        INSERT INTO mayura_aggregates VALUES ('scope','record','key','${'a'.repeat(64)}','${'b'.repeat(64)}',1,1,'{"value":1}');
        INSERT INTO mayura_events VALUES ('scope','record',1,'prior.created','{"version":0}','2026-01-01T00:00:00.000Z');
      `);
      prior.close();

      migrateSqliteStoreV0ToV1({ filename });
      expect(() => migrateSqliteStoreV0ToV1({ filename })).toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
      const current = createSqliteStore({ filename });
      await current.initialize();
      try {
        await expect(current.read('scope', 'record')).resolves.toMatchObject({ id: 'record', version: 1, state: { value: 1 } });
        await expect(current.events('scope', 'record')).resolves.toEqual([expect.objectContaining({ sequence: 1, type: 'prior.created', data: { version: 0 } })]);
      } finally { await current.close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
