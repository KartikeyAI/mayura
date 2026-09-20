import { describe, expect, it } from 'vitest';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { createPostgresStore } from '@mayura/storage-postgres';
import { createSqliteStore as compatibleSqlite, createPostgresStore as compatiblePostgres, StorageError as CompatibleError } from '@mayura/storage';
import { StorageError, type ExecutionWaitAggregateStore } from '@mayura/storage-contracts';
import { selectedAdapterCompatibility } from './selected-adapters-conformance.js';
import { executionWaitSqliteFixture } from './execution-waits-fixtures.js';

selectedAdapterCompatibility('SQLite', executionWaitSqliteFixture);

describe('selected SQL adapter package compatibility', () => {
  it('re-exports exactly the selected factories without wrappers or duplicate error constructors', () => {
    expect(compatibleSqlite).toBe(createSqliteStore);
    expect(compatiblePostgres).toBe(createPostgresStore);
    expect(CompatibleError).toBe(StorageError);
  });

  it('loads the selected SQLite worker and reports the shared StorageError identity', async () => {
    const store: ExecutionWaitAggregateStore = createSqliteStore({ filename: ':memory:' });
    try {
      await expect(store.read('scope', 'record')).rejects.toBeInstanceOf(StorageError);
      await store.initialize();
      await store.create({ scope: 'scope', id: 'record', idempotencyKey: 'key', definitionHash: 'definition', state: { selected: true }, events: [] });
      expect(await store.read('scope', 'record')).toMatchObject({ version: 1, state: { selected: true } });
      await expect(store.update({ scope: 'scope', id: 'record', expectedVersion: 2, state: {}, events: [] })).rejects.toBeInstanceOf(StorageError);
    } finally { await store.close(); }
  });

  it('rejects malformed PostgreSQL configuration with the shared error before connecting', () => {
    expect(() => createPostgresStore({ connectionString: 'postgres://unused', schema: 'invalid;schema' })).toThrow(StorageError);
  });
});
