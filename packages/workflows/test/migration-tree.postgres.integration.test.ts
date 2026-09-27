import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe } from 'vitest';
import { createPostgresStore } from '@mayura/storage';
import { treeMigrationConformance } from './migration-tree-conformance.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];
/** Each store owns a disposable schema that is dropped when the store closes. */
const open = async () => {
  const schema = `mayura_tree_migration_${randomUUID().replaceAll('-', '')}`;
  const store = createPostgresStore({ connectionString: connectionString!, schema });
  const close = store.close.bind(store);
  return Object.assign(store, { close: async () => {
    await close();
    if (!/^mayura_tree_migration_[a-f0-9]{32}$/.test(schema)) throw new Error('Unexpected fixture schema.');
    const pool = new Pool({ connectionString: connectionString! });
    try { await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await pool.end(); }
  } });
};
if (connectionString) treeMigrationConformance('PostgreSQL', open);
else describe.skip('workflow-tree in-place migration on PostgreSQL', () => {});
