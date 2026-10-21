// Offline smoke test: the same app session and server options, with Fetch in-process rather than a network socket.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createClient } from 'mayura/client';
import { createAgentServer } from 'mayura/server';
import { createSqliteStore } from 'mayura/storage';
import { agentId, createChatServerOptions, demoScope } from './agent.mjs';
import { createChatSession } from './session.js';
import { browserBuild } from './server.mjs';

const directory = await mkdtemp(join(tmpdir(), 'mayura-chat-check-')); const store = createSqliteStore({ filename: join(directory, 'chat.sqlite') });
await store.initialize(); await store.threads.initialize();
const api = createAgentServer({ ...createChatServerOptions(store, async ({ token }) => token !== 'local-test' ? null : {
  scope: demoScope, agentIds: [agentId], capabilities: ['runs:read', 'runs:submit', 'runs:cancel', 'runs:approve', 'threads:read', 'threads:write'], expiresAtMs: Date.now() + 60_000,
}), publicOrigin: 'https://chat.test' });
const client = createClient({ baseUrl: 'https://chat.test', token: () => 'local-test', fetch: (url, init) => api.fetch(new Request(url, init)) });
const values = new Map(); const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
const sessions = [];
const session = () => { const value = createChatSession({ client, storage }); sessions.push(value); return value; };
async function until(test) { const deadline = Date.now() + (process.env.CI === 'true' && process.platform === 'win32' ? 30_000 : 5_000); while (!test()) { if (Date.now() > deadline) throw new Error('Chat flow did not reach the expected state.'); await sleep(10); } }
try {
  await browserBuild(join(directory, 'ui'));
  let chat = session(); await chat.open(); await chat.send('Save the release notes.');
  await until(() => Boolean(chat.getSnapshot().approval)); const runId = chat.getSnapshot().runId; const threadId = chat.getSnapshot().threadId;
  // Reload recovers the same waiting run from SQLite; it never submits another turn or answers automatically.
  chat.dispose(); chat = session(); await chat.open(); await until(() => Boolean(chat.getSnapshot().approval));
  assert.equal(chat.getSnapshot().runId, runId); const callId = chat.getSnapshot().approval.getSnapshot().approval.callId; await chat.getSnapshot().approval.submit('approved');
  await until(() => chat.getSnapshot().phase === 'ready');
  const entries = await client.threadEntries(threadId); assert.equal(entries.filter(entry => entry.kind === 'run' && entry.status === 'succeeded').length, 1);
  assert.equal(entries.filter(entry => entry.kind === 'approval' && entry.decision === 'approved').length, 1);
  assert.equal((await store.read(JSON.stringify([demoScope.principalId, demoScope.projectId, 'notes']), `${runId}:${callId}`))?.state.text, 'Save the release notes.');
  await chat.send('Do not save this note.'); await until(() => Boolean(chat.getSnapshot().approval)); const rejectedCallId = chat.getSnapshot().approval.getSnapshot().approval.callId; await chat.getSnapshot().approval.submit('rejected');
  await until(() => chat.getSnapshot().phase === 'ready');
  const rejectedId = chat.getSnapshot().runStore.getSnapshot().snapshot.id;
  assert.equal(await store.read(JSON.stringify([demoScope.principalId, demoScope.projectId, 'notes']), `${rejectedId}:${rejectedCallId}`), undefined);
  await chat.send('Cancel this turn.'); await until(() => Boolean(chat.getSnapshot().approval)); await chat.cancel(); await until(() => chat.getSnapshot().phase === 'ready');
  assert.equal(chat.getSnapshot().runStore.getSnapshot().snapshot.status, 'cancelled');
  console.log(JSON.stringify({ status: 'passed', example: 'thread-chat', approved: true, rejected: true, cancelled: true, reload: true }));
} finally {
  for (const chat of sessions) chat.dispose(); await api.close(); await store.close();
  // mkdtemp creates this exact test-owned directory under the OS temporary root.
  if (!directory.startsWith(join(tmpdir(), 'mayura-chat-check-'))) throw new Error('Unsafe test cleanup path.');
  await rm(directory, { recursive: true, force: true });
}
