import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { createPostgresStore, type PostgresPoolOptions } from '@mayura/storage-postgres';
import { aggregateConformance } from './conformance.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];
describe.skipIf(!connectionString)('PostgreSQL integration', () => {
  aggregateConformance('PostgreSQL', async () => fixture());
  // Serverless functions run one small pool per instance: everything must work over a single connection.
  aggregateConformance('PostgreSQL with one pooled connection', async () => fixture({ max: 1, connectionTimeoutMs: 10_000, idleTimeoutMs: 1_000 }));
});

function fixture(pool?: PostgresPoolOptions) {
  {
    const schema = `mayura_test_${randomUUID().replaceAll('-', '')}`;
    const open = () => createPostgresStore({ connectionString: connectionString!, schema, ...(pool ? { pool } : {}) });
    return {
      store: open(), reopen: open,
      cleanup: async () => {
        // Only this test's generated, validated schema is ever removed; no shared schema cleanup.
        if (!/^mayura_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unexpected fixture schema.');
        const pool = new Pool({ connectionString: connectionString! });
        try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
        finally { await pool.end(); }
      },
    };
  }
}

it('rejects PostgreSQL schema injection before opening a connection', () => {
  for (const schema of ['public; DROP TABLE users', 'a"b', 'Uppercase', 'x'.repeat(64), '']) {
    expect(() => createPostgresStore({ connectionString: 'postgres://unused', schema })).toThrow();
  }
});
