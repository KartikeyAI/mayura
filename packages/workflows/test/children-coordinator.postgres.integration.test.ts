import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe } from 'vitest';
import { createPostgresStore } from '@mayura/storage';
import { workflowTreeCoordinatorConformance } from './tree-coordinator-conformance.js';

const connectionString=process.env['MAYURA_TEST_POSTGRES_URL'];
/** A disposable schema per test. */
async function fixture() {
  const schema=`mayura_tree_coordinator_${randomUUID().replaceAll('-','')}`;
  return { open: () => createPostgresStore({ connectionString: connectionString!, schema }), cleanup: async () => {
    if(!/^mayura_tree_coordinator_[a-f0-9]{32}$/.test(schema))throw new Error('Unexpected fixture schema.');
    const pool=new Pool({connectionString:connectionString!});try{await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{await pool.end();}
  } };
}
describe.skipIf(!connectionString)('PostgreSQL workflow trees', () => { workflowTreeCoordinatorConformance('PostgreSQL', fixture as never); });
