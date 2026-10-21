import type { AuthorizationDecision } from '@mayura/core';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { createAgentServer } from '@mayura/server';
import { createClient } from '@mayura/client';
import { normalizeNodeRequest, snapshotSettings } from '../src/hardening.js';

const example = await import(new URL('../../../examples/thread-chat/agent.mjs', import.meta.url).href);
let store: ReturnType<typeof createSqliteStore> | undefined; let directory: string | undefined; let api: ReturnType<typeof createAgentServer> | undefined;
afterEach(async () => { await api?.close(); await store?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

describe('Node hosts preserve conversation options', () => {
  it('keeps thread configuration and request-mode approval waits when taking the shared host snapshot', async () => {
    directory = await mkdtemp(join(tmpdir(), 'mayura-node-conversations-')); store = createSqliteStore({ filename: join(directory, 'chat.sqlite') });
    await store.initialize(); await store.threads.initialize();
    const options = example.createChatServerOptions(store, async () => ({ scope: example.demoScope, agentIds: [example.agentId],
      capabilities: ['runs:read', 'runs:submit', 'runs:approve', 'threads:read', 'threads:write'], expiresAtMs: Date.now() + 60_000 }));
    const snapshot = snapshotSettings(options); options.threads.store = null;
    expect(Object.isFrozen(snapshot.threads)).toBe(true); expect(snapshot.runExecution).toBe('request');
    api = createAgentServer({ ...snapshot, publicOrigin: 'https://chat.test' });
    const client = createClient({ baseUrl: 'https://chat.test', token: () => 'test', fetch: (url, init) => api!.fetch(new Request(url, init)) });
    const thread = await client.createThread({ agentId: example.agentId });
    const run = await client.submit(example.agentId, { message: 'A note' }, { idempotencyKey: 'first', threadId: thread.id });
    // Request mode must return only after the checkpoint and waiting record are durable, without polling.
    const waiting = await run.inspect(); expect(waiting.status).toBe('waiting'); expect(waiting.approval).toBeDefined();
    await run.approve({ callId: waiting.approval!.callId, digest: waiting.approval!.digest, decision: 'approved' });
    expect((await run.inspect()).status).toBe('succeeded');
    for (const action of ['archive', 'restore']) {
      const incoming = new Request(`https://chat.test/v1/threads/${thread.id}/${action}`, { method: 'POST', headers: { authorization: 'Bearer test', 'content-length': '0' }, body: '' });
      expect((await api.fetch(normalizeNodeRequest(incoming))).status).toBe(200);
    }
    const withBody = new Request(`https://chat.test/v1/threads/${thread.id}/archive`, { method: 'POST', headers: { authorization: 'Bearer test', 'content-length': '2' }, body: '{}' });
    expect((await api.fetch(normalizeNodeRequest(withBody))).status).toBe(400);
  });
});


it('normalizes empty Node HTTP streams without discarding a framed request body', async () => {
  for (const method of ['POST', 'DELETE']) for (const headers of [{}, { 'content-length': '0' }]) {
    const request = new Request('https://chat.test/v1/runs/id/cancel', { method, headers, body: '' });
    const normalized = normalizeNodeRequest(request); expect(normalized.body).toBeNull(); expect(normalized.method).toBe(method);
  }
  for (const headers of [{ 'content-length': '2' }, { 'transfer-encoding': 'chunked' }]) {
    const request = new Request('https://chat.test/v1/runs/id/cancel', { method: 'POST', headers, body: '{}' });
    expect(normalizeNodeRequest(request)).toBe(request); expect(await request.text()).toBe('{}');
  }
});

it('snapshots recovery service authority before the host opens', () => {
  const policy = { permissions: { allow: ['conversations:recover'] }, authorize: async () => true, pageSize: 3 };
  const snapshot = snapshotSettings({ agents: [], authenticate: async () => null, conversationRecovery: policy });
  policy.permissions.allow.length = 0; policy.pageSize = 100;
  expect(snapshot.conversationRecovery?.permissions.allow).toEqual(['conversations:recover']);
  expect(snapshot.conversationRecovery?.pageSize).toBe(3);
  expect(Object.isFrozen(snapshot.conversationRecovery?.permissions.allow)).toBe(true);
});

it('snapshots reconciliation service authority independently of recovery', () => {
  const policy = { permissions: { allow: ['conversations:reconcile'] }, authorize: async () => true };
  const snapshot = snapshotSettings({ agents: [], authenticate: async () => null, approvalReconciliation: policy });
  policy.permissions.allow.length = 0;
  expect(snapshot.approvalReconciliation?.permissions.allow).toEqual(['conversations:reconcile']);
  expect(Object.isFrozen(snapshot.approvalReconciliation)).toBe(true);
});

it('snapshots compaction budgets and grants before accepting requests', () => {
  const policy = { agent: null as never, agentIds: ['support'], permissions: { allow: ['thread:compact', 'model:scripted'] }, maxCostMicros: 100, maxConcurrent: 2 };
  const snapshot = snapshotSettings({ agents: [], authenticate: async () => null, threadCompaction: policy });
  policy.agentIds.length = 0; policy.permissions.allow.length = 0; policy.maxCostMicros = 999;
  expect(snapshot.threadCompaction?.agentIds).toEqual(['support']); expect(snapshot.threadCompaction?.maxCostMicros).toBe(100);
  expect(snapshot.threadCompaction?.permissions.allow).toEqual(['thread:compact', 'model:scripted']);
  expect(Object.isFrozen(snapshot.threadCompaction?.agentIds)).toBe(true);
});

it('snapshots HTTP authorization policy, limits and cursor key before opening the host', () => {
  const key = new Uint8Array(32).fill(7); const allow: AuthorizationDecision = { effect: 'allow', reason: 'allowed', policyVersion: 'v1', ruleId: null };
  const policy = { version: 'v1', authorize: () => allow };
  const authorization = { policy, cursorKey: key, permissions: { allow: ['authz:evaluate'] }, limits: { timeoutMs: 123 } };
  const snapshot = snapshotSettings({ agents: [], authenticate: async () => null, authorization });
  policy.version = 'v2'; authorization.permissions.allow.length = 0; key.fill(0); authorization.limits.timeoutMs = 999;
  expect(snapshot.authorization?.policy.version).toBe('v1'); expect(snapshot.authorization?.permissions?.allow).toEqual(['authz:evaluate']);
  expect(snapshot.authorization?.limits?.timeoutMs).toBe(123); expect(snapshot.authorization?.cursorKey?.[0]).toBe(7);
});

it('snapshots audit delivery configuration separately from mutable host options', () => {
  const receipt: AuthorizationDecision = { effect: 'allow', reason: 'allowed', policyVersion: 'v1', ruleId: null };
  const sink = () => {}; const audit = { sink, timeoutMs: 10, maxConcurrent: 2 };
  const snapshot = snapshotSettings({ agents: [], authenticate: async () => null, authorization: {
    policy: { version: 'v1', authorize: () => receipt }, permissions: { allow: ['authz:evaluate', 'authz:audit'] }, audit,
  } });
  audit.timeoutMs = 999; audit.maxConcurrent = 64; audit.sink = () => { throw new Error('mutated'); };
  expect(snapshot.authorization?.audit).toEqual({ sink, timeoutMs: 10, maxConcurrent: 2 });
  expect(Object.isFrozen(snapshot.authorization?.audit)).toBe(true);
});
