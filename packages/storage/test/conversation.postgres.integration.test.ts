import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe } from 'vitest';
import { createPostgresStore } from '@mayura/storage-postgres';
import { conversationConformance } from './conversation-conformance.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];
describe.skipIf(!connectionString)('PostgreSQL threads and run checkpoints', () => {
  conversationConformance('PostgreSQL', async () => {
    const schema = `mayura_conversation_${randomUUID().replaceAll('-', '')}`;
    const store = createPostgresStore({ connectionString: connectionString!, schema });
    return {
      store,
      async close() {
        await store.close();
        if (!/^mayura_conversation_[a-f0-9]{32}$/.test(schema)) throw new Error('Unexpected conversation fixture schema.');
        const pool = new pg.Pool({ connectionString: connectionString!, max: 1 });
        try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); }
      },
    };
  });
});
