import { randomUUID } from 'node:crypto';
import { Pool, types } from 'pg';
import { describe, expect, it } from 'vitest';
import { createPostgresStore, type PostgresPoolOptions } from '@mayura/storage-postgres';
import { createPostgresStore as createDriverStore } from '@mayura/storage-postgres/driver';
import { aggregateConformance } from './conformance.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];
describe.skipIf(!connectionString)('PostgreSQL integration', () => {
  aggregateConformance('PostgreSQL', async () => fixture());
  // Serverless functions run one small pool per instance: everything must work over a single connection.
  aggregateConformance('PostgreSQL with one pooled connection', async () => fixture({ max: 1, connectionTimeoutMs: 10_000, idleTimeoutMs: 1_000 }));
  // Edge runtimes bring their own pg-compatible pool (Neon's WebSocket Pool on Vercel Edge). This one leaves TIMESTAMPTZ
  // as text, as a driver without type parsing does, and Mayura must never end it.
  aggregateConformance('PostgreSQL through a driver pool you own', async () => driverFixture());

  it('leaves a driver pool open when the store closes', async () => {
    const { store, cleanup, driver } = driverFixture();
    try {
      await store.initialize(); await store.close();
      expect((await driver.query('SELECT 1 AS one')).rows).toEqual([{ one: 1 }]);
    } finally { await cleanup(); }
  });
});

function driverFixture() {
  const schema = `mayura_test_${randomUUID().replaceAll('-', '')}`;
  const driver = new Pool({ connectionString: connectionString!, max: 2,
    types: { getTypeParser: ((oid: number, format?: 'text' | 'binary') => oid === 1184 ? (value: string) => value : types.getTypeParser(oid, format as 'text')) as typeof types.getTypeParser } });
  const open = () => createDriverStore({ driver, schema });
  return {
    store: open(), reopen: open, driver,
    cleanup: async () => {
      if (!/^mayura_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unexpected fixture schema.');
      try { await driver.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await driver.end(); }
    },
  };
}

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
