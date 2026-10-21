import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatSession } from '../src/session.js';
const threadId = 'thread-one';
const thread = Object.freeze({ id: threadId, agentId: 'notebook.assistant', title: 'Notebook', metadata: Object.freeze({}), status: 'active', createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z', lastSequence: 0, entryCount: 0, activeTurnId: null, version: 1 });
const storage = () => { let value; return { getItem: () => value, setItem: (_key, next) => { value = next; } }; };
test('render-independent session creation does no work; an ambiguous submission retains its exact key', async () => {
  const calls = []; const client = { updateThread: async () => thread, archiveThread: async () => thread, restoreThread: async () => thread, deleteThread: async () => ({ removed: 0 }), createThread: async () => thread, thread: async () => thread, threadEntries: async () => [], submit: async (_agentId, input, options) => { calls.push({ input, key: options.idempotencyKey }); throw new Error('Lost response.'); } };
  const session = createChatSession({ client, storage: storage(), storageKey: 'fixture' });
  try { assert.equal(calls.length, 0); await session.open(); await assert.rejects(session.send('hello')); await assert.rejects(session.retrySubmission()); assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]); assert.equal(session.getSnapshot().hasPending, true); }
  finally { session.dispose(); }
});
test('disposal does not resubmit or cancel a remote write', async () => {
  let submissions = 0; const client = { updateThread: async () => thread, archiveThread: async () => thread, restoreThread: async () => thread, deleteThread: async () => ({ removed: 0 }), createThread: async () => thread, thread: async () => thread, threadEntries: async () => [], submit: async () => { submissions++; throw new Error('Unconfirmed.'); } };
  const session = createChatSession({ client, storage: storage(), storageKey: 'fixture' }); await session.open(); await assert.rejects(session.send('hello')); session.dispose(); assert.equal(submissions, 1); await assert.rejects(session.retrySubmission()); assert.equal(submissions, 1);
});
