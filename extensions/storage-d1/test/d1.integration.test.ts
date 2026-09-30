// The storage conformance suites against D1's engine, and a smoke run against real D1.
// - Every suite, crash tests included, runs on a D1 database over a local SQLite file (D1 is SQLite; a batch is one
//   transaction): Cloudflare's local D1 emulator answers each call in tens of milliseconds on some hosts, too slow for
//   the suites' one-second leases. Child processes open the same file.
// - Records and a contended counter run on Cloudflare's own D1 implementation, locally in Miniflare (workerd): the
//   adapter's SQL, its batches and its conflict detection, against the real thing.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createD1Store, d1Backend, type D1Database } from '../src/index.js';
import { sqliteD1 } from '../../../packages/storage/test/fixtures/document.mjs';
import { aggregateConformance } from '../../../packages/storage/test/conformance.js';
import { durableBudgetConformance } from '../../../packages/storage/test/durable-budget-conformance.js';
import { executionWaitConformance } from '../../../packages/storage/test/execution-waits-conformance.js';
import { identityIntegrityConformance } from '../../../packages/storage/test/identity-integrity-conformance.js';
import { scheduledBounds } from '../../../packages/storage/test/scheduled-bounds-conformance.js';
import { schedulerConformance } from '../../../packages/storage/test/scheduler-conformance.js';
import { workflowTreeCapabilityConformance } from '../../../packages/storage/test/workflow-tree-capability-conformance.js';
import { memoryConformance } from '../../../packages/memory/test/conformance.js';
import { nativeMemoryConformance } from '../../../packages/memory/test/native-conformance.js';
import { workflowConformance } from '../../../packages/workflows/test/conformance.js';
import { graphWorkflowConformance } from '../../../packages/workflows/test/graph-conformance.js';
import { graphDiscoveryConformance } from '../../../packages/workflows/test/graph-discovery-conformance.js';
import { graphCoordinatorConformance } from '../../../packages/workflows/test/graph-coordinator-conformance.js';
import { scheduledWorkflowConformance } from '../../../packages/workflows/test/scheduled-conformance.js';
import { workflowTreeRuntimeConformance } from '../../../packages/workflows/test/tree-runtime-conformance.js';
import { workflowTreeCoordinatorConformance } from '../../../packages/workflows/test/tree-coordinator-conformance.js';
import { documentFixtures } from '../../../packages/storage-sql/test/document-fixtures.js';

const worker = 'export default { fetch() { return new Response(null, { status: 404 }); } };';
/** The part of Miniflare this test uses. Its published declarations are written against zod 3, so it loads untyped. */
interface Miniflare { readonly ready: Promise<URL>; getD1Database(name: string): Promise<unknown>; dispose(): Promise<void> }
const miniflareModule = 'miniflare';
let miniflare: Miniflare | undefined; let database: D1Database;
beforeAll(async () => {
  const { Miniflare: create } = await import(miniflareModule) as { Miniflare: new (options: unknown) => Miniflare };
  miniflare = new create({ modules: true, script: worker, d1Databases: { DB: 'mayura-test' } });
  await miniflare.ready;
  database = await miniflare.getD1Database('DB') as unknown as D1Database;
}, 60_000);
afterAll(async () => { await miniflare?.dispose(); });

const fixtures = documentFixtures(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mayura-d1-')); const filename = join(directory, 'd1.sqlite');
  const database = await sqliteD1(filename) as D1Database & { close(): void };
  const backend = d1Backend(database); await backend.initialize();
  return { backend, child: { adapter: 'd1-sqlite', filename },
    raw: {
      scan: async () => ((await database.prepare('SELECT partition, sort, version, body FROM mayura_documents').all<{ partition: string; sort: string; version: number; body: string }>()).results ?? [])
        .map(row => ({ ...row, version: Number(row.version) })),
      write: async changes => {
        if (!changes.length) return;
        await database.batch(changes.map(change => change.body === null
          ? database.prepare('DELETE FROM mayura_documents WHERE partition = ? AND sort = ?').bind(change.partition, change.sort)
          : database.prepare('INSERT INTO mayura_documents (partition, sort, version, body) VALUES (?, ?, 1, ?) ON CONFLICT (partition, sort) DO UPDATE SET version = version + 1, body = excluded.body')
            .bind(change.partition, change.sort, change.body)));
      },
    },
    cleanup: async () => { database.close(); if (!directory.includes('mayura-d1-')) throw new Error('Unexpected D1 fixture directory.'); await rm(directory, { recursive: true, force: true }); } };
});

describe('D1 engine', () => {
  aggregateConformance('D1', fixtures.simple);
  identityIntegrityConformance('D1', fixtures.simple);
  scheduledBounds('D1', fixtures.simple);
  memoryConformance('D1', fixtures.simple as never);
  nativeMemoryConformance('D1', fixtures.simple);
  workflowConformance('D1', fixtures.simple);
  schedulerConformance('D1', fixtures.scheduler as never);
  scheduledWorkflowConformance('D1', fixtures.workflow as never);
  graphWorkflowConformance('D1', fixtures.workflow as never);
  graphDiscoveryConformance('D1', fixtures.workflow as never);
  graphCoordinatorConformance('D1', fixtures.workflow as never);
  executionWaitConformance('D1', fixtures.waits as never);
  durableBudgetConformance('D1', fixtures.budgets as never);
  workflowTreeCapabilityConformance('D1', fixtures.trees as never);
  workflowTreeRuntimeConformance('D1', fixtures.trees as never);
  workflowTreeCoordinatorConformance('D1', fixtures.trees as never);
});

describe('D1 in Miniflare', () => {
  it('stores records and events, and settles contended writers by running the losers again', async () => {
    const store = createD1Store({ database, table: `mayura_test_${randomUUID().replaceAll('-', '')}` }); await store.initialize();
    try {
      const created = await store.create({ scope: 's', id: 'r', idempotencyKey: 'k', definitionHash: 'h', state: { count: 0 }, events: [{ type: 'run.created', data: {} }] });
      expect(created.created).toBe(true);
      expect((await store.create({ scope: 's', id: 'r', idempotencyKey: 'k', definitionHash: 'h', state: { count: 0 }, events: [{ type: 'run.created', data: {} }] })).created).toBe(false);
      // Eight writers race on one record; each retries on a version conflict until it lands, so none is lost.
      await Promise.all(Array.from({ length: 8 }, async () => {
        for (;;) {
          const current = (await store.read('s', 'r'))!;
          try { await store.update({ scope: 's', id: 'r', expectedVersion: current.version, state: { count: (current.state['count'] as number) + 1 }, events: [{ type: 'counted', data: {} }] }); return; }
          catch (error) { if ((error as { code?: string }).code !== 'CONFLICT') throw error; }
        }
      }));
      expect((await store.read('s', 'r'))?.state).toEqual({ count: 8 });
      expect((await store.events('s', 'r')).map(event => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    } finally { await store.close(); }
  }, 180_000);

  it('refuses options it cannot use', () => {
    for (const options of [{}, { database: {} }, { database, extra: 1 }, { database, table: 'bad name' }, { database, retryForMs: -1 }]) {
      expect(() => createD1Store(options as never)).toThrow(expect.objectContaining({ storageCode: 'INVALID_INPUT' }));
    }
  });
});
