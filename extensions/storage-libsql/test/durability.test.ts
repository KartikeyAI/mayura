import { createClient } from '@libsql/client';
import { expect, it } from 'vitest';
import { createLibsqlStore } from '../src/index.js';
import { database, url } from './local-database.js';

// Keep this file-level check isolated from the native handles of the conformance suites.
it('keeps a local file durable with write-ahead logging, full sync and foreign keys', async () => {
  const { filename, cleanup } = await database('durability');
  const connection = url(filename);
  try {
    const store = createLibsqlStore({ url: connection });
    try { await store.initialize(); } finally { await store.close(); }
    const client = createClient({ url: connection });
    try {
      const value = async (pragma: string) => (await client.execute(`PRAGMA ${pragma}`)).rows[0]![0];
      expect([await value('journal_mode'), await value('synchronous'), await value('foreign_keys')]).toEqual(['wal', 2, 1]);
    } finally { client.close(); }
  } finally { await cleanup(); }
});
