// The storage conformance suites against a real MongoDB replica set. Set MAYURA_TEST_MONGODB_URL to a disposable
// deployment, for example a single-node replica set:
//   docker run -d -p 127.0.0.1:27018:27017 mongo:8.0 --replSet rs0 --bind_ip_all
//   docker exec <container> mongosh --eval "rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:27017'}]})"
//   MAYURA_TEST_MONGODB_URL=mongodb://127.0.0.1:27018/?replicaSet=rs0&directConnection=true
// Every fixture gets its own database, dropped afterwards.
import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { describe, expect, it } from 'vitest';
import type { JsonObject } from 'mayura';
import { createMongoStore } from '../src/index.js';
import { keyManagerConformance } from 'mayura/keys/testing';
import { aggregateConformance } from '../../../packages/storage/test/conformance.js';
import { durableBudgetConformance } from '../../../packages/storage/test/durable-budget-conformance.js';
import { executionWaitConformance } from '../../../packages/storage/test/execution-waits-conformance.js';
import { identityIntegrityConformance } from '../../../packages/storage/test/identity-integrity-conformance.js';
import { scheduledBounds } from '../../../packages/storage/test/scheduled-bounds-conformance.js';
import { schedulerConformance } from '../../../packages/storage/test/scheduler-conformance.js';
import { memoryConformance } from '../../../packages/memory/test/conformance.js';
import { nativeMemoryConformance } from '../../../packages/memory/test/native-conformance.js';
import { workflowConformance } from '../../../packages/workflows/test/conformance.js';
import { scheduledWorkflowConformance } from '../../../packages/workflows/test/scheduled-conformance.js';
import { graphWorkflowConformance } from '../../../packages/workflows/test/graph-conformance.js';
import { graphCoordinatorConformance } from '../../../packages/workflows/test/graph-coordinator-conformance.js';
import { graphDiscoveryConformance } from '../../../packages/workflows/test/graph-discovery-conformance.js';
import { mongoSql } from './sql-shim.js';
import { workflowTreeCapabilityConformance } from '../../../packages/storage/test/workflow-tree-capability-conformance.js';
import { workflowTreeRuntimeConformance } from '../../../packages/workflows/test/tree-runtime-conformance.js';
import { workflowTreeCoordinatorConformance } from '../../../packages/workflows/test/tree-coordinator-conformance.js';
import type { WorkflowTreeManifest, WorkflowTreePolicyManifest } from 'mayura/storage-contracts';

const server = process.env['MAYURA_TEST_MONGODB_URL'];

/**
 * A killed writer's open transaction holds its documents until the server aborts it (transactionLifetimeLimitSeconds,
 * 60 s by default): the test server aborts them after 5 s, so crash tests recover within their time bounds.
 */
let configured: Promise<void> | undefined;
const configureServer = () => configured ??= (async () => {
  const client = new MongoClient(server!); try { await client.db('admin').command({ setParameter: 1, transactionLifetimeLimitSeconds: 5 }); } finally { await client.close(); }
})();

/** Holds a write on one document in an open transaction until released: another writer conflicts and waits. */
async function holdDocument(database: string, collection: string, filter: Record<string, unknown>): Promise<() => Promise<void>> {
  const client = new MongoClient(server!); const session = client.startSession(); session.startTransaction();
  await client.db(database).collection(collection).updateOne(filter, { $set: { lockedByTest: randomUUID() } }, { session });
  let released = false;
  return async () => { if (released) return; released = true; try { await session.abortTransaction(); } finally { await session.endSession(); await client.close(); } };
}

async function fixture() {
  await configureServer();
  const database = `mayura_test_${randomUUID().replaceAll('-', '')}`;
  const open = () => createMongoStore({ uri: server!, database });
  return { database, open, cleanup: async () => {
    if (!/^mayura_test_[a-f0-9]{32}$/.test(database)) throw new Error('Unexpected MongoDB fixture database.');
    const client = new MongoClient(server!); try { await client.db(database).dropDatabase(); } finally { await client.close(); }
  } };
}

describe.skipIf(!server)('MongoDB', () => {
  const simple = async () => { const { open, cleanup } = await fixture(); return { store: open(), reopen: open, cleanup }; };
  aggregateConformance('MongoDB', simple);
  describe('MongoDB key manager conformance', () => {
    for (const test of keyManagerConformance) {
      it(test.name, async () => {
        const fixture = await simple(); await fixture.store.initialize();
        try { await test.run({ store: fixture.store }); } finally { await fixture.store.close(); await fixture.cleanup(); }
      });
    }
  });
  identityIntegrityConformance('MongoDB', simple);
  memoryConformance('MongoDB', simple as never);
  nativeMemoryConformance('MongoDB', simple);
  workflowConformance('MongoDB', simple);
  scheduledBounds('MongoDB', simple);
  /** The workflow suites' fixture: row tampering through the SQL shim, a real held write on an aggregate, and native index access. */
  const workflowFixture = async () => {
    const { database, open, cleanup } = await fixture();
    const owners = async <T>(body: (collection: import('mongodb').Collection) => Promise<T>) => {
      const client = new MongoClient(server!); try { return await body(client.db(database).collection('mayura_workflow_owners')); } finally { await client.close(); }
    };
    return { store: open(), reopen: open, dialect: 'mongodb', prefix: '', childConfig: { kind: 'mongodb', uri: server!, database }, query: mongoSql(server!, database),
      lockAggregate: (scope: string, id: string) => holdDocument(database, 'mayura_aggregates', { scope, id }), cleanup,
      discoveryIndex: {
        create: (mismatch: string) => owners(async collection => {
          const key = mismatch === 'wrong columns' ? { scope: 1 } : { scope: 1, policy_hash: 1, profile: 1, aggregate_id: mismatch === 'descending' ? -1 : 1 };
          await collection.createIndex(key, { name: 'mayura_workflow_owners_discovery', ...(mismatch === 'unique' ? { unique: true } : {}),
            ...(mismatch === 'partial' ? { partialFilterExpression: { profile: 2 } } : {}), ...(mismatch === 'wrong collation' ? { collation: { locale: 'en', strength: 2 } } : {}) });
        }),
        list: () => owners(async collection => (await collection.listIndexes().toArray().catch(() => [])).filter(index => index['name'] === 'mayura_workflow_owners_discovery')),
        // The same query the store runs for a discovery scan.
        explain: (scope: string, policyHash: string) => owners(async collection => (await collection.find({ scope, policy_hash: policyHash, profile: 2, aggregate_id: { $gt: '' } },
          { projection: { _id: 0, aggregate_id: 1 } }).sort({ aggregate_id: 1 }).limit(16).explain('queryPlanner'))['queryPlanner']['winningPlan']),
      } };
  };
  scheduledWorkflowConformance('MongoDB', workflowFixture as never);
  graphWorkflowConformance('MongoDB', workflowFixture as never);
  graphDiscoveryConformance('MongoDB', workflowFixture as never);
  graphCoordinatorConformance('MongoDB', workflowFixture as never);
  workflowTreeCapabilityConformance('MongoDB', fixture as never);
  workflowTreeRuntimeConformance('MongoDB', fixture as never);
  workflowTreeCoordinatorConformance('MongoDB', fixture as never);
  it('scans workflow-tree discovery through its index, in key order, over populated history', async () => {
    const { database, open, cleanup } = await fixture(); const store = open();
    const manifest: WorkflowTreeManifest = { format: 4, id: 'plan-root', version: '1', graph: [{ kind: 'tool', id: 'work', dependsOn: [], tool: 'fixture/tool', toolVersion: '1', effects: 'none',
      capabilities: [], costMicros: 1, approval: false, input: { kind: 'input', path: [] } }], result: { kind: 'step', stepId: 'work', path: [] } };
    const policy: WorkflowTreePolicyManifest = { scope: { principalId: 'plan', projectId: 'tree-discovery' }, permissions: ['tool:fixture/tool'], policyVersion: 'selected',
      maxCostMicros: 1, maxCalls: 1, maxOutputBytes: 1_024, approvalTtlMs: 1_000 };
    const client = new MongoClient(server!);
    try {
      await store.initialize(); await store.workflowTrees.initialize(); await store.workflowTreeDiscovery.initialize();
      for (let offset = 0; offset < 128; offset += 16) await Promise.all(Array.from({ length: 16 }, (_, step) => store.workflowTrees.submit({ manifest,
        policy: { ...policy, policyVersion: `filler-${offset + step}` }, resources: { work: [] }, input: null, idempotencyKey: `filler-${offset + step}` })));
      const selected = (await store.workflowTrees.submit({ manifest, policy, resources: { work: [] }, input: null, idempotencyKey: 'selected' })).snapshot;
      // The same query the store runs for a tree discovery scan.
      const plan = JSON.stringify((await client.db(database).collection('mayura_workflow_owners').find({ scope: selected.record.scope, policy_hash: selected.policyHash, profile: 3,
        aggregate_id: { $gt: '' } }, { projection: { _id: 0, aggregate_id: 1 } }).sort({ aggregate_id: 1 }).limit(16).explain('queryPlanner'))['queryPlanner']['winningPlan']);
      expect(plan).toContain('"indexName":"mayura_workflow_owners_discovery"'); expect(plan).toContain('"stage":"IXSCAN"'); expect(plan).not.toContain('"stage":"SORT"');
      expect((await store.workflowTreeDiscovery.scan({ scope: selected.record.scope, policyHash: selected.policyHash, cursor: null, limit: 32 })).candidates.map(candidate => candidate.rootId)).toEqual([selected.rootId]);
    } finally { await client.close(); await store.close(); await cleanup(); }
  }, 120_000);
  executionWaitConformance('MongoDB', async () => {
    const { database, open, cleanup } = await fixture();
    return { store: open(), reopen: open, prefix: '', childOptions: { adapter: 'mongodb', uri: server!, database }, query: mongoSql(server!, database), cleanup } as never;
  });
  durableBudgetConformance('MongoDB', async () => {
    const { database, open, cleanup } = await fixture();
    return { store: open(), reopen: open, prefix: '', childOptions: { adapter: 'mongodb', uri: server!, database }, query: mongoSql(server!, database),
      lockRoot: (scope: string, id: string) => holdDocument(database, 'mayura_durable_budgets', { scope, id }), cleanup } as never;
  });
  schedulerConformance('MongoDB', async () => {
    const { database, open, cleanup } = await fixture();
    return { store: open(), reopen: open, cleanup, childOptions: { adapter: 'mongodb', uri: server!, database },
      holdJob: async () => ({ release: await holdDocument(database, 'mayura_scheduler_jobs', { scope: 'scheduler-a', job_id: 'job-a' }) }),
      corruptJob: async mutate => {
        const client = new MongoClient(server!);
        try {
          const jobs = client.db(database).collection('mayura_scheduler_jobs'); const filter = { scope: 'scheduler-a', job_id: 'job-a' };
          const row = await jobs.findOne(filter);
          const data = JSON.parse(String(row!['data'])) as JsonObject; mutate(data); const job = data['job'] as JsonObject;
          await jobs.updateOne(filter, { $set: { data: JSON.stringify(data), state: job['state'], lease_until: job['leaseUntilMs'] } });
        } finally { await client.close(); }
      } };
  });

  it('keeps identifiers exact: case, accents and trailing spaces are different keys', async () => {
    const { open, cleanup } = await fixture(); const store = open(); await store.initialize();
    try {
      for (const id of ['run', 'Run', 'rún', 'run ']) await store.create({ scope: 's', id, idempotencyKey: `k-${id}`, definitionHash: 'h', state: { id }, events: [] });
      for (const id of ['run', 'Run', 'rún', 'run ']) expect((await store.read('s', id))?.state).toEqual({ id });
    } finally { await store.close(); await cleanup(); }
  });

  it('stores state keys MongoDB would refuse or rewrite as field names, exactly', async () => {
    const { open, cleanup } = await fixture(); const store = open(); await store.initialize();
    try {
      const state = { $set: { 'a.b': 1 }, '': 'empty key', big: 2 ** 53 - 1, nested: { $where: 'x' } };
      await store.create({ scope: 's', id: 'r', idempotencyKey: 'k', definitionHash: 'h', state, events: [{ type: 'run.created', data: { $gt: 1 } }] });
      expect((await store.read('s', 'r'))?.state).toEqual(state);
      expect((await store.events('s', 'r'))[0]?.data).toEqual({ $gt: 1 });
    } finally { await store.close(); await cleanup(); }
  });

  it('uses a client you give without closing it, and refuses options it cannot use', async () => {
    const { database, cleanup } = await fixture(); const client = new MongoClient(server!);
    try {
      const store = createMongoStore({ client, database }); await store.initialize();
      await store.create({ scope: 's', id: 'r', idempotencyKey: 'k', definitionHash: 'h', state: {}, events: [] });
      await store.close();
      expect(await client.db(database).collection('mayura_aggregates').countDocuments()).toBe(1);
    } finally { await client.close(); await cleanup(); }
    for (const options of [{}, { database: 'd' }, { uri: 'postgres://h/x', database: 'd' }, { uri: 'mongodb://h', database: '' }, { uri: 'mongodb://h', database: 'bad name' },
      { uri: 'mongodb://h', database: 'd', client: {} }, { client: {}, database: 'd' }, { uri: 'mongodb://h', database: 'd', extra: 1 }]) {
      expect(() => createMongoStore(options as never)).toThrow(expect.objectContaining({ storageCode: 'INVALID_INPUT' }));
    }
  });
});
