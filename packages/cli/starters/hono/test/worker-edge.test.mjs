import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createD1Store } from '@mayurajs/storage-d1';
import worker from '../server/worker-edge.mjs';
import { recoverConversationPage } from '../server/recovery-cursor.mjs';

/** Use D1's SQLite queries and transactional batch API without a hosted binding. */
function localD1(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  const prepare = (query, values = []) => {
    const run = () => ({ results: sqlite.prepare(query).all(...values) });
    return { bind: (...parameters) => prepare(query, parameters), all: async () => run(), run };
  };
  return { prepare, async batch(statements) {
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const result = statements.map(statement => statement.run());
      sqlite.exec('COMMIT');
      return result;
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
  } };
}

const project = 'worker-fixture';
const cursor = store => store.read(JSON.stringify(['notebook-recovery', project]), 'conversation-cursor');

test('successive scheduled invocations advance past a full page of retained checkpoints', async t => {
  const DB = localD1(t);
  const store = createD1Store({ database: DB });
  await store.initialize();
  await store.runCheckpoints.initialize();
  t.after(() => store.close());
  const expiresAtMs = Date.now() + 60_000;
  for (let index = 0; index < 26; index++) {
    const runId = `thread-compact:${String(index).padStart(2, '0')}`;
    await store.runCheckpoints.put({ runId, scope: 'fixture', expiresAtMs, body: {} });
  }
  const env = { DB, MAYURA_PUBLIC_ORIGIN: 'https://notebook.test', MAYURA_PROJECT_ID: project,
    MAYURA_SESSIONS_JSON: JSON.stringify([{ tokenSha256: 'a'.repeat(64), principalId: 'alice', expiresAtMs }]) };
  const scheduled = async () => {
    let pending;
    worker.scheduled(null, env, { waitUntil: work => { pending = work; } });
    return pending;
  };

  assert.equal((await scheduled()).recovered, 25);
  assert.deepEqual((await cursor(store)).state.after, { expiresAtMs, runId: 'thread-compact:24' });
  assert.equal((await scheduled()).recovered, 1);
  assert.equal((await cursor(store)).state.after, null);
  assert.equal((await store.runCheckpoints.scan({ limit: 30 })).length, 26);
});

test('an older recovery page cannot overwrite a newer cursor revision', async t => {
  const database = localD1(t);
  const first = createD1Store({ database });
  const second = createD1Store({ database });
  await first.initialize();
  await second.initialize();
  t.after(async () => { await first.close(); await second.close(); });
  const page = index => ({ outcomes: [], next: { expiresAtMs: index, runId: `page:${index}` } });
  await recoverConversationPage(first, project, async () => page(1));
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const stale = recoverConversationPage(first, project, async after => {
    started.resolve(after);
    await finish.promise;
    return page(2);
  });
  try {
    assert.deepEqual(await started.promise, page(1).next);
    await recoverConversationPage(second, project, async after => {
      assert.deepEqual(after, page(1).next);
      return page(3);
    });
  } finally { finish.resolve(); }
  await stale;
  assert.deepEqual((await cursor(first)).state.after, page(3).next);
});
