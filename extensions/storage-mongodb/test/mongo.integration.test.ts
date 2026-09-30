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
import { aggregateConformance } from '../../../packages/storage/test/conformance.js';
import { durableBudgetConformance } from '../../../packages/storage/test/durable-budget-conformance.js';
import { identityIntegrityConformance } from '../../../packages/storage/test/identity-integrity-conformance.js';
import { schedulerConformance } from '../../../packages/storage/test/scheduler-conformance.js';
import { memoryConformance } from '../../../packages/memory/test/conformance.js';
import { nativeMemoryConformance } from '../../../packages/memory/test/native-conformance.js';
import { workflowConformance } from '../../../packages/workflows/test/conformance.js';

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

/**
 * The few SQL statements the durable-budget suite uses to read and tamper with rows, applied to the same documents.
 * Test-only instrumentation; any other statement fails the test.
 */
function budgetSql(database: string) {
  return async (sql: string, parameters: readonly unknown[] = []): Promise<readonly Record<string, unknown>[]> => {
    const client = new MongoClient(server!);
    try {
      const db = client.db(database); const text = sql.replace(/\s+/g, ' ').trim();
      const table = /^SELECT \* FROM (mayura_durable_budgets|mayura_durable_budget_events) ORDER BY 1,2$/.exec(text);
      if (table) return await db.collection(table[1]!).find({}, { projection: { _id: 0 } }).sort({ scope: 1, id: 1, budgetId: 1, sequence: 1 }).toArray();
      const [first, scope, id] = parameters as [unknown, string, string];
      if (text === 'SELECT state FROM mayura_durable_budgets WHERE scope = ? AND id = ?') return await db.collection('mayura_durable_budgets').find({ scope: parameters[0], id: parameters[1] }, { projection: { _id: 0, state: 1 } }).toArray();
      if (text === 'UPDATE mayura_durable_budgets SET state = ? WHERE scope = ? AND id = ?') { await db.collection('mayura_durable_budgets').updateOne({ scope, id }, { $set: { state: first } }); return []; }
      if (text === 'UPDATE mayura_durable_budgets SET version = version + 1 WHERE scope = ? AND id = ?') { await db.collection('mayura_durable_budgets').updateOne({ scope: parameters[0], id: parameters[1] }, { $inc: { version: 1 } }); return []; }
      if (text === 'UPDATE mayura_durable_budget_events SET data = ? WHERE scope = ? AND budget_id = ?') { await db.collection('mayura_durable_budget_events').updateMany({ scope, budgetId: id }, { $set: { data: first } }); return []; }
      throw new Error(`The MongoDB test shim has no translation for: ${text}`);
    } finally { await client.close(); }
  };
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
  identityIntegrityConformance('MongoDB', simple);
  memoryConformance('MongoDB', simple as never);
  nativeMemoryConformance('MongoDB', simple);
  workflowConformance('MongoDB', simple);
  durableBudgetConformance('MongoDB', async () => {
    const { database, open, cleanup } = await fixture();
    return { store: open(), reopen: open, prefix: '', childOptions: { adapter: 'mongodb', uri: server!, database }, query: budgetSql(database),
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
