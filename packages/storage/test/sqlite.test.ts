import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { aggregateConformance } from './conformance.js';

aggregateConformance('SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mayura-storage-'));
  const filename = join(directory, 'aggregate.sqlite');
  const open = () => createSqliteStore({ filename });
  return {
    store: open(), reopen: open,
    cleanup: async () => {
      const safeDirectory = resolve(directory);
      if (!safeDirectory.startsWith(`${resolve(tmpdir())}\\mayura-storage-`) && !safeDirectory.startsWith(`${resolve(tmpdir())}/mayura-storage-`)) throw new Error('Unexpected fixture directory.');
      await rm(safeDirectory, { recursive: true, force: true });
    },
  };
});

it('requires explicit initialization before record access', async () => {
  const store = createSqliteStore({ filename: ':memory:' });
  try { await expect(store.read('scope', 'id')).rejects.toMatchObject({ code: 'STORE_NOT_INITIALIZED' }); }
  finally { await store.close(); }
});

it('rejects an invalid SQLite filename without spawning a worker', () => {
  expect(() => createSqliteStore({ filename: '' })).toThrow();
  expect(() => createSqliteStore({ filename: 'invalid\0path' })).toThrow();
});
