import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe } from 'vitest';
import { createPostgresStore } from '@mayura/storage-postgres';
import { scheduledBounds } from './scheduled-bounds-conformance.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];
describe.skipIf(!connectionString)('PostgreSQL scheduled bounds fixture',() => {
  scheduledBounds('PostgreSQL',async () => {
    const schema = `mayura_bounds_${randomUUID().replaceAll('-','')}`;
    return {store:createPostgresStore({connectionString:connectionString!,schema}),cleanup:async () => {
      if (!/^mayura_bounds_[a-f0-9]{32}$/.test(schema)) throw new Error('Unexpected bounded fixture schema.');
      const pool = new Pool({connectionString:connectionString!});
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); }
    }};
  });
});
