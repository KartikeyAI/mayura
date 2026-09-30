// The conformance suites against a real libSQL server (sqld, as Turso runs it), over the network. Set
// MAYURA_TEST_LIBSQL_URL to a disposable server, for example:
//   docker run -d -p 127.0.0.1:18080:8080 ghcr.io/tursodatabase/libsql-server:latest
//   MAYURA_TEST_LIBSQL_URL=ws://127.0.0.1:18080 (WebSocket: one connection per client, where HTTP sends a request per statement)
// Every fixture starts from, and leaves, a database without Mayura's tables; the suites in this file run one at a time.
import { createClient, type Client } from '@libsql/client';
import { describe, expect, it } from 'vitest';
import type { JsonObject } from 'mayura';
import { createLibsqlStore } from '../src/index.js';
import { aggregateConformance } from '../../../packages/storage/test/conformance.js';
import { durableBudgetConformance } from '../../../packages/storage/test/durable-budget-conformance.js';
import { executionWaitConformance } from '../../../packages/storage/test/execution-waits-conformance.js';
import { identityIntegrityConformance } from '../../../packages/storage/test/identity-integrity-conformance.js';
import { scheduledBounds } from '../../../packages/storage/test/scheduled-bounds-conformance.js';
import { schedulerConformance } from '../../../packages/storage/test/scheduler-conformance.js';
import { memoryConformance } from '../../../packages/memory/test/conformance.js';
import { nativeMemoryConformance } from '../../../packages/memory/test/native-conformance.js';
import { workflowConformance } from '../../../packages/workflows/test/conformance.js';
import { workflowTreeCapabilityConformance } from '../../../packages/storage/test/workflow-tree-capability-conformance.js';
import { workflowTreeRuntimeConformance } from '../../../packages/workflows/test/tree-runtime-conformance.js';
import { workflowTreeCoordinatorConformance } from '../../../packages/workflows/test/tree-coordinator-conformance.js';

const remote = process.env['MAYURA_TEST_LIBSQL_URL'];

async function using<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = createClient({ url: remote! });
  try { return await work(client); } finally { client.close(); }
}
/** Drops Mayura's tables, children first: a table referenced by another's rows cannot be dropped before it. */
async function reset(): Promise<void> {
  await using(async client => {
    for (let pass = 0; pass < 10; pass++) {
      const tables = (await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mayura%'")).rows.map(row => String(row[0]));
      if (tables.length === 0) return;
      for (const table of tables) { try { await client.execute(`DROP TABLE "${table}"`); } catch { /* A table still referenced goes on a later pass. */ } }
    }
    throw new Error('The libSQL test database could not be reset.');
  });
}
const query = (sql: string, parameters: readonly unknown[] = []) => using(async client => {
  const result = await client.execute({ sql, args: [...parameters] as never });
  return result.rows.map(row => Object.fromEntries(result.columns.map((column, index) => [column, row[index]])));
});
const lock = async (): Promise<() => Promise<void>> => {
  // Over HTTP the client sends BEGIN with a transaction's first statement: run one, so the lock is really taken.
  const client = createClient({ url: remote! }); const tx = await client.transaction('write'); await tx.execute('SELECT 1');
  let released = false;
  return async () => { if (released) return; released = true; try { await tx.rollback(); } finally { tx.close(); client.close(); } };
};
const open = () => createLibsqlStore({ url: remote! });
const simple = async () => { await reset(); return { store: open(), reopen: open, cleanup: reset }; };
const children = { adapter: 'libsql', url: remote } as never;

describe.skipIf(!remote)('libSQL server', () => {
  aggregateConformance('libSQL server', simple);
  identityIntegrityConformance('libSQL server', simple);
  scheduledBounds('libSQL server', simple);
  memoryConformance('libSQL server', simple as never);
  nativeMemoryConformance('libSQL server', simple);
  workflowConformance('libSQL server', simple);
  const trees = async () => { await reset(); return { open, cleanup: reset }; };
  workflowTreeCapabilityConformance('libSQL server', trees as never);
  workflowTreeRuntimeConformance('libSQL server', trees as never);
  workflowTreeCoordinatorConformance('libSQL server', trees as never);
  schedulerConformance('libSQL server', async () => {
    await reset();
    return { store: open(), reopen: open, cleanup: reset, childOptions: children,
      holdJob: async () => { const release = await lock(); return { release }; },
      corruptJob: async mutate => {
        const [row] = await query('SELECT data FROM mayura_scheduler_jobs WHERE scope = ? AND job_id = ?', ['scheduler-a', 'job-a']);
        const data = JSON.parse(String(row!['data'])) as JsonObject; mutate(data); const job = data['job'] as JsonObject;
        await query('UPDATE mayura_scheduler_jobs SET data = ?, state = ?, lease_until = ? WHERE scope = ? AND job_id = ?',
          [JSON.stringify(data), job['state'], job['leaseUntilMs'], 'scheduler-a', 'job-a']);
      } };
  });
  executionWaitConformance('libSQL server', async () => { await reset(); return { store: open(), reopen: open, prefix: '', childOptions: children, query, cleanup: reset } as never; });
  durableBudgetConformance('libSQL server', async () => {
    await reset();
    return { store: open(), reopen: open, prefix: '', childOptions: children, query, lockRoot: () => lock(), cleanup: reset } as never;
  });

  it('keeps foreign keys enforced inside the server\'s transactions', async () => {
    await reset(); const store = open(); await store.initialize(); await store.close();
    await using(async client => {
      const tx = await client.transaction('write');
      try {
        await expect(tx.execute("INSERT INTO mayura_events (scope, aggregate_id, sequence, type, data, created_at) VALUES ('s', 'missing', 1, 'x', '{}', 't')"))
          .rejects.toMatchObject({ code: expect.stringMatching(/^SQLITE_CONSTRAINT/) });
      } finally { await tx.rollback(); tx.close(); }
    });
    await reset();
  });
});
