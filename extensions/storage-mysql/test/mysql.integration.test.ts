// The storage, memory and workflow conformance suites against a real MySQL. Set MAYURA_TEST_MYSQL_URL to a
// disposable server whose user may create databases, for example:
//   docker run -d -p 127.0.0.1:13306:3306 -e MYSQL_ROOT_PASSWORD=mayura_test_only mysql:8.4
//   MAYURA_TEST_MYSQL_URL=mysql://root:mayura_test_only@127.0.0.1:13306/mysql
// Every fixture gets its own database, dropped afterwards.
import { randomUUID } from 'node:crypto';
import { createPool } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import type { JsonObject } from 'mayura';
import { createMysqlStore } from '../src/index.js';
import { aggregateConformance } from '../../../packages/storage/test/conformance.js';
import { durableBudgetConformance } from '../../../packages/storage/test/durable-budget-conformance.js';
import { executionWaitConformance } from '../../../packages/storage/test/execution-waits-conformance.js';
import { identityIntegrityConformance } from '../../../packages/storage/test/identity-integrity-conformance.js';
import { scheduledBounds } from '../../../packages/storage/test/scheduled-bounds-conformance.js';
import { schedulerConformance } from '../../../packages/storage/test/scheduler-conformance.js';
import { memoryConformance } from '../../../packages/memory/test/conformance.js';
import { nativeMemoryConformance } from '../../../packages/memory/test/native-conformance.js';
import { workflowConformance } from '../../../packages/workflows/test/conformance.js';
import { graphWorkflowConformance } from '../../../packages/workflows/test/graph-conformance.js';
import { graphCoordinatorConformance } from '../../../packages/workflows/test/graph-coordinator-conformance.js';
import { graphDiscoveryConformance } from '../../../packages/workflows/test/graph-discovery-conformance.js';
import { scheduledWorkflowConformance } from '../../../packages/workflows/test/scheduled-conformance.js';
import { workflowTreeCapabilityConformance } from '../../../packages/storage/test/workflow-tree-capability-conformance.js';
import { workflowTreeRuntimeConformance } from '../../../packages/workflows/test/tree-runtime-conformance.js';
import { workflowTreeCoordinatorConformance } from '../../../packages/workflows/test/tree-coordinator-conformance.js';

const server = process.env['MAYURA_TEST_MYSQL_URL'];

const admin = () => createPool({ uri: server!, connectionLimit: 2, multipleStatements: false });
/** A fresh database on the test server, and a URL for it. */
async function database(): Promise<{ uri: string; name: string; drop(): Promise<void> }> {
  const name = `mayura_test_${randomUUID().replaceAll('-', '')}`;
  const pool = admin(); try { await pool.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`); } finally { await pool.end(); }
  const url = new URL(server!); url.pathname = `/${name}`;
  return { uri: url.href, name, drop: async () => {
    if (!/^mayura_test_[a-f0-9]{32}$/.test(name)) throw new Error('Unexpected MySQL fixture database.');
    const pool = admin(); try { await pool.query(`DROP DATABASE IF EXISTS ${name}`); } finally { await pool.end(); }
  } };
}
/** Raw SQL on the fixture's database: test-only fault and lock instrumentation. */
function raw(uri: string) {
  const pool = createPool({ uri, connectionLimit: 4, flags: ['-FOUND_ROWS'], supportBigNumbers: true, bigNumberStrings: false });
  const decode = (rows: unknown) => (Array.isArray(rows) ? rows : []).map(row => Object.fromEntries(Object.entries(row as Record<string, unknown>)
    .map(([column, value]) => [column, value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : value])));
  return {
    query: async (sql: string, parameters: readonly unknown[] = []) => decode((await pool.query(sql, [...parameters]))[0]),
    /** Holds a row lock (or every row `sql` selects) in an open transaction until released. */
    lock: async (sql: string, parameters: readonly unknown[]) => {
      const connection = await pool.getConnection();
      await connection.query('START TRANSACTION'); await connection.query(sql, [...parameters]);
      let released = false;
      return async () => { if (released) return; released = true; try { await connection.query('ROLLBACK'); } finally { connection.release(); } };
    },
    end: () => pool.end(),
  };
}
async function fixture() {
  const { uri, drop } = await database(); const sql = raw(uri);
  const open = () => createMysqlStore({ uri });
  return { uri, sql, open, cleanup: async () => { await sql.end(); await drop(); } };
}
const simple = async () => { const { open, cleanup } = await fixture(); return { store: open(), reopen: open, cleanup }; };
/** The workflow suites' fixture: raw queries, and a real row lock on an aggregate while the runtime's own connection waits. */
const workflowFixture = async () => {
  const { uri, sql, open, cleanup } = await fixture();
  return { store: open(), reopen: open, dialect: 'mysql' as const, prefix: '', childConfig: { kind: 'mysql' as const, uri }, query: sql.query,
    lockAggregate: (scope: string, id: string) => sql.lock('SELECT id FROM mayura_aggregates WHERE scope = ? AND id = ? FOR UPDATE', [scope, id]), cleanup };
};

describe.skipIf(!server)('MySQL', () => {
  aggregateConformance('MySQL', simple);
  identityIntegrityConformance('MySQL', simple);
  scheduledBounds('MySQL', simple);
  memoryConformance('MySQL', simple as never);
  nativeMemoryConformance('MySQL', simple);
  workflowConformance('MySQL', simple);
  scheduledWorkflowConformance('MySQL', workflowFixture as never);
  graphWorkflowConformance('MySQL', workflowFixture as never);
  graphDiscoveryConformance('MySQL', workflowFixture as never);
  graphCoordinatorConformance('MySQL', workflowFixture as never);
  workflowTreeCapabilityConformance('MySQL', fixture as never);
  workflowTreeRuntimeConformance('MySQL', fixture as never);
  workflowTreeCoordinatorConformance('MySQL', fixture as never);
  schedulerConformance('MySQL', async () => {
    const { uri, sql, open, cleanup } = await fixture();
    return { store: open(), reopen: open, cleanup, childOptions: { adapter: 'mysql', uri },
      holdJob: async () => ({ release: await sql.lock('SELECT job_id FROM mayura_scheduler_jobs WHERE scope = ? AND job_id = ? FOR UPDATE', ['scheduler-a', 'job-a']) }),
      corruptJob: async mutate => {
        const [row] = await sql.query('SELECT data FROM mayura_scheduler_jobs WHERE scope = ? AND job_id = ?', ['scheduler-a', 'job-a']);
        const data = JSON.parse(String(row!['data'])) as JsonObject; mutate(data); const job = data['job'] as JsonObject;
        await sql.query('UPDATE mayura_scheduler_jobs SET data = ?, state = ?, lease_until = ? WHERE scope = ? AND job_id = ?', [JSON.stringify(data), job['state'], job['leaseUntilMs'], 'scheduler-a', 'job-a']);
      } };
  });
  executionWaitConformance('MySQL', async () => {
    const { uri, sql, open, cleanup } = await fixture();
    return { store: open(), reopen: open, prefix: '', childOptions: { adapter: 'mysql', uri }, query: sql.query, cleanup } as never;
  });
  durableBudgetConformance('MySQL', async () => {
    const { uri, sql, open, cleanup } = await fixture();
    return { store: open(), reopen: open, prefix: '', childOptions: { adapter: 'mysql', uri }, query: sql.query,
      lockRoot: (scope: string, id: string) => sql.lock('SELECT id FROM mayura_durable_budgets WHERE scope = ? AND id = ? FOR UPDATE', [scope, id]), cleanup } as never;
  });

  it('refuses a pool that reports found rows, and options it cannot use', async () => {
    const { uri, cleanup } = await fixture();
    const pool = createPool({ uri, connectionLimit: 1 });
    try {
      const store = createMysqlStore({ driver: pool });
      await expect(store.initialize()).rejects.toMatchObject({ storageCode: 'INVALID_INPUT' });
      await store.close();
    } finally { await pool.end(); await cleanup(); }
    for (const options of [{}, { uri: 'postgres://h/db' }, { uri: 'mysql://h' }, { uri: 'mysql://h/bad-name!' }, { uri: 'mysql://h/db', pool: { max: 0 } }, { uri: 'mysql://h/db', tls: 'yes' },
      { driver: {} }, { driver: { getConnection: () => undefined }, pool: {} }, { uri: 'mysql://h/db', extra: 1 }]) {
      expect(() => createMysqlStore(options as never)).toThrow(expect.objectContaining({ storageCode: 'INVALID_INPUT' }));
    }
  });

  it('keeps identifiers exact: case, accents and trailing spaces are different keys', async () => {
    const { open, cleanup } = await fixture(); const store = open(); await store.initialize();
    try {
      for (const id of ['run', 'Run', 'rún', 'run ']) await store.create({ scope: 's', id, idempotencyKey: `k-${id}`, definitionHash: 'h', state: { id }, events: [] });
      for (const id of ['run', 'Run', 'rún', 'run ']) expect((await store.read('s', id))?.state).toEqual({ id });
    } finally { await store.close(); await cleanup(); }
  });
});
