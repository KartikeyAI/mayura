import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe } from 'vitest';
import type { JsonObject } from '@mayura/core';
import { createPostgresStore } from '../dist/index.js';
import { schedulerConformance } from './scheduler-conformance.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];
describe.skipIf(!connectionString)('PostgreSQL scheduler fixture', () => {
  schedulerConformance('PostgreSQL', async () => {
    const schema = `mayura_scheduler_${randomUUID().replaceAll('-', '')}`;
    const open = () => createPostgresStore({ connectionString: connectionString!, schema });
    return { store: open(), reopen: open, childOptions: { adapter: 'postgres', connectionString: connectionString!, schema }, holdJob: async () => {
      const pool = new Pool({ connectionString: connectionString! }); const client = await pool.connect();
      await client.query('BEGIN');
      await client.query(`SELECT job_id FROM "${schema}".mayura_scheduler_jobs WHERE scope = $1 AND job_id = $2 FOR UPDATE`, ['scheduler-a', 'job-a']);
      return { release: async () => { try { await client.query('ROLLBACK'); } finally { client.release(); await pool.end(); } } };
    }, corruptJob: async mutate => {
      const pool = new Pool({ connectionString: connectionString! });
      try {
        const rows = await pool.query<{ data: string }>(`SELECT data FROM "${schema}".mayura_scheduler_jobs WHERE scope = $1 AND job_id = $2`, ['scheduler-a', 'job-a']);
        const data = JSON.parse(rows.rows[0]!.data) as JsonObject; mutate(data); const job = data['job'] as JsonObject;
        await pool.query(`UPDATE "${schema}".mayura_scheduler_jobs SET data = $1, state = $2, lease_until = $3 WHERE scope = $4 AND job_id = $5`, [JSON.stringify(data), job['state'], job['leaseUntilMs'], 'scheduler-a', 'job-a']);
      } finally { await pool.end(); }
    }, cleanup: async () => {
      if (!/^mayura_scheduler_[a-f0-9]{32}$/.test(schema)) throw new Error('Unexpected scheduler fixture schema.');
      const pool = new Pool({ connectionString: connectionString! });
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); }
    } };
  });
});
