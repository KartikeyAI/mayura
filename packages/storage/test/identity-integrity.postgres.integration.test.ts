import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe } from 'vitest';
import { createPostgresStore } from '@mayura/storage-postgres';
import { identityIntegrityConformance } from './identity-integrity-conformance.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];
describe.skipIf(!connectionString)('PostgreSQL identity integrity', () => {
  identityIntegrityConformance('PostgreSQL', async () => {
    const schema = `mayura_identity_${randomUUID().replaceAll('-', '')}`;
    const open = () => createPostgresStore({ connectionString: connectionString!, schema });
    return { store: open(), reopen: open, cleanup: async () => {
      if (!/^mayura_identity_[a-f0-9]{32}$/.test(schema)) throw new Error('Unexpected identity fixture schema.');
      const pool = new Pool({ connectionString: connectionString! });
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await pool.end(); }
    } };
  });
});
