import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSqliteStore } from 'mayura/storage-sqlite';
import { createClient } from 'mayura/client';
import { scriptedModel } from 'mayura/testing';
import { createApplication } from '../server/application.mjs';

const origin = 'http://localhost:3000'; const tokenA = 'a'.repeat(64); const tokenB = 'b'.repeat(64);
const scope = principal => JSON.stringify([principal, 'fixture', 'notes']);
async function fixture(modelOverride) {
  const store = createSqliteStore({ filename: ':memory:' });
  const sessions = [tokenA, tokenB].map((token, index) => ({ tokenSha256: createHash('sha256').update(token).digest('hex'), principalId: index ? 'bob' : 'alice', expiresAtMs: Date.now() + 3600000 }));
  const app = await createApplication({ store, publicOrigin: origin, projectId: 'fixture', sessions, ...(modelOverride ? { modelOverride } : {}) });
  const client = token => createClient({ baseUrl: origin, token: () => token, fetch: (input, init) => { const request = new Request(input, init); const url = new URL(request.url); url.pathname = `/api/mayura${url.pathname}`; return app.fetch(new Request(url, request)); } });
  return { app, store, alice: client(tokenA), bob: client(tokenB), unauthenticated: client('c'.repeat(64)) };
}
const reply = { '~standard': { version: 1, validate: value => value && typeof value.reply === 'string' ? { value } : { issues: ['Expected reply.'] } } };
async function pending(client, threadId, key = 'turn-1') {
  const run = await client.submit('notebook.assistant', { message: 'Remember the release notes.' }, { threadId, idempotencyKey: key });
  const snapshot = await run.inspect(); assert.equal(snapshot.status, 'waiting'); assert.ok(snapshot.approval); return { run, approval: snapshot.approval };
}

test('verified identity owns its thread; unauthenticated and cross-principal access fail', async () => {
  const f = await fixture(); try {
    await assert.rejects(f.unauthenticated.session());
    assert.deepEqual((await f.alice.session()).scope, { principalId: 'alice', projectId: 'fixture' });
    const thread = await f.alice.createThread({ id: 'thread-a', agentId: 'notebook.assistant' });
    await assert.rejects(f.bob.thread(thread.id)); assert.equal((await f.bob.threads()).threads.length, 0);
    const forged = await f.app.fetch(new Request(`${origin}/api/mayura/v1/threads`, { method: 'POST', headers: { authorization: `Bearer ${tokenA}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'forged', scope: { principalId: 'bob', projectId: 'fixture' } }) }));
    assert.equal(forged.status, 400);
  } finally { await f.app.close(); }
});

test('a captured approval writes once, records the resumed run once, and queues a durable workflow', async () => {
  const f = await fixture(); try {
    const thread = await f.alice.createThread({ id: 'approved', agentId: 'notebook.assistant' }); const { run, approval } = await pending(f.alice, thread.id);
    const noteId = `${run.id}:${approval.callId}`; assert.equal(await f.store.read(scope('alice'), noteId), undefined);
    await assert.rejects(f.bob.run(run.id).approve({ callId: approval.callId, digest: approval.digest, decision: 'approved' }));
    await assert.rejects(run.approve({ callId: approval.callId, digest: '0'.repeat(64), decision: 'approved' }));
    await run.approve({ callId: approval.callId, digest: approval.digest, decision: 'approved' });
    assert.equal((await run.result(reply)).status, 'succeeded'); assert.ok(await f.store.read(scope('alice'), noteId));
    await run.approve({ callId: approval.callId, digest: approval.digest, decision: 'approved' }).catch(() => {}); // Idempotent receipt or conflict; never another write.
    await f.app.runOnce();
    const entries = await f.alice.threadEntries(thread.id); assert.deepEqual(entries.filter(entry => entry.kind === 'run' && entry.runId === run.id).map(entry => entry.status), ['running', 'succeeded']);
    assert.equal(entries.filter(entry => entry.kind === 'assistant').length, 1);
    assert.ok(await f.store.read(JSON.stringify(['alice', 'fixture', 'note-index']), noteId));
  } finally { await f.app.close(); }
});

test('rejection and cancellation leave no note write', async () => {
  for (const decision of ['rejected', 'cancelled']) {
    const f = await fixture(); try {
      const thread = await f.alice.createThread({ id: decision, agentId: 'notebook.assistant' }); const { run, approval } = await pending(f.alice, thread.id);
      if (decision === 'cancelled') await run.cancel(); else await run.approve({ callId: approval.callId, digest: approval.digest, decision });
      assert.equal(await f.store.read(scope('alice'), `${run.id}:${approval.callId}`), undefined);
    } finally { await f.app.close(); }
  }
});

test('a scripted unregistered tool is denied before it can write', async () => {
  const model = scriptedModel([{ type: 'tool_calls', calls: [{ id: 'wrong-tool', toolId: 'secrets.export', input: {} }], usage: { costMicros: 0 } }]);
  const f = await fixture(model); try {
    const thread = await f.alice.createThread({ id: 'hostile', agentId: 'notebook.assistant' });
    const run = await f.alice.submit('notebook.assistant', { message: 'hello' }, { threadId: thread.id, idempotencyKey: 'hostile-1' });
    assert.notEqual((await run.result(reply)).status, 'succeeded');
    const entries = await f.alice.threadEntries(thread.id); assert.equal(entries.filter(entry => entry.kind === 'tool_result' && entry.result?.saved === true).length, 0);
  } finally { await f.app.close(); }
});

test('aborted browser requests and same-key replays cannot produce a second run', async () => {
  const f = await fixture(); try {
    const controller = new AbortController(); controller.abort(); await assert.rejects(f.alice.threads({ signal: controller.signal }));
    const thread = await f.alice.createThread({ id: 'replay', agentId: 'notebook.assistant' });
    const one = await pending(f.alice, thread.id); const two = await f.alice.submit('notebook.assistant', { message: 'Remember the release notes.' }, { threadId: thread.id, idempotencyKey: 'turn-1' });
    assert.equal(two.id, one.run.id);
  } finally { await f.app.close(); }
});

test('the next thread turn receives the prior completed conversation history', async () => {
  const histories = []; const model = { id: 'history.fixture', maxCostMicros: 0, capabilities: { tools: true, structuredOutput: true, history: true },
    async generate(request) {
      histories.push(request.history ?? []);
      if (request.messages.some(message => message.role === 'tool')) return { type: 'final', output: { reply: 'Done.' }, usage: { costMicros: 0 } };
      return { type: 'tool_calls', calls: [{ id: crypto.randomUUID(), toolId: 'notes.save', input: { text: 'History note.' } }], usage: { costMicros: 0 } };
    } };
  const f = await fixture(model); try {
    const thread = await f.alice.createThread({ id: 'history', agentId: 'notebook.assistant' }); const first = await pending(f.alice, thread.id);
    await first.run.approve({ callId: first.approval.callId, digest: first.approval.digest, decision: 'approved' });
    assert.equal((await first.run.result(reply)).status, 'succeeded');
    const second = await pending(f.alice, thread.id, 'turn-2');
    assert(histories.at(-1).some(message => message.role === 'assistant' && 'output' in message));
    await second.run.approve({ callId: second.approval.callId, digest: second.approval.digest, decision: 'rejected' });
  } finally { await f.app.close(); }
});
