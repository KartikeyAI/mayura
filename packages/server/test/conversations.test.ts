import { createClient } from '../../client/src/index.js';
import { createHeadlessThreadStore, createRunApprovalController } from '../../client/src/headless.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { defineAgent } from '@mayura/runtime';
import { defineTool } from '@mayura/tools';
import { scriptedModel } from '@mayura/testing';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { createAggregateRunRecords } from '../../storage-contracts/dist/index.js';
import { createAgentServer, type AgentServer, type ServerIdentity, type AgentServerOptions } from '../src/index.js';

const origin = 'https://agents.example.test';
let directory: string; let store: ReturnType<typeof createSqliteStore>;
const servers: AgentServer[] = [];
const identities = (token: string): ServerIdentity => ({ scope: { principalId: token === 'bob' ? 'bob' : 'alice', projectId: token === 'project' ? 'other' : 'shop' },
  agentIds: token === 'other-agent' ? ['other'] : ['support'], capabilities: token === 'denied' ? ['runs:read'] :
    ['runs:read', 'runs:submit', 'runs:cancel', 'runs:approve', 'operations:read', 'threads:read', 'threads:write', 'threads:delete'], expiresAtMs: Date.now() + 60_000 });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mayura-server-threads-'));
  store = createSqliteStore({ filename: join(directory, 'threads.sqlite') });
  await store.initialize(); await store.threads.initialize();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server => server.close())); await store.close();
  await rm(directory, { recursive: true, force: true });
});
function fixture() {
  const execute = vi.fn(() => ({ refunded: true }));
  const tool = defineTool({ id: 'refund', version: '1', description: 'Refund.', input: z.object({}), output: z.object({ refunded: z.boolean() }),
    effects: 'write', capabilities: [], approval: 'required', execute });
  const agent = defineAgent({ id: 'support', version: '1', instructions: 'Help.', input: z.object({ message: z.string() }), output: z.object({ reply: z.string() }), tools: [tool],
    model: scriptedModel([{ type: 'tool_calls', calls: [{ id: 'c1', toolId: 'refund', input: {} }], usage: { costMicros: 0 } },
      { type: 'final', output: { reply: 'Done' }, usage: { costMicros: 0 } }]) });
  return { agent, execute };
}
function server(agent: AgentServerOptions['agents'][number]['agent'], overrides: Partial<AgentServerOptions> = {}) {
  const value = createAgentServer({ publicOrigin: origin, threads: { store }, runRecords: createAggregateRunRecords(store),
    agents: [{ agent, permissions: { allow: ['model:scripted', 'tool:refund', 'effect:write'] } }],
    authenticate: async ({ token }) => identities(token), limits: { runRecordPollMs: 10 }, ...overrides });
  servers.push(value); return value;
}
const call = (server: AgentServer, path: string, method = 'GET', body?: unknown, token = 'alice', headers: Record<string, string> = {}) =>
  server.fetch(new Request(origin + path, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
const json = async (response: Response) => response.json() as Promise<Record<string, any>>;
async function create(server: AgentServer, id = 'thread-1') {
  const response = await call(server, '/v1/threads', 'POST', { id, agentId: 'support', title: 'Refund' });
  expect(response.status).toBe(201); return (await json(response)).thread;
}
async function start(server: AgentServer, threadId = 'thread-1') {
  const response = await call(server, '/v1/runs', 'POST', { agentId: 'support', input: { message: 'Refund' }, threadId }, 'alice', { 'idempotency-key': threadId });
  expect(response.status).toBe(202); return (await json(response)).id as string;
}
async function waiting(server: AgentServer, runId: string) {
  let view: Record<string, any> = {};
  await vi.waitFor(async () => { const response = await call(server, `/v1/runs/${runId}`); expect(response.status).toBe(200); view = await json(response); expect(view.status).toBe('waiting'); expect(view.approval).toBeDefined(); }, { timeout: 3000, interval: 5 });
  return view;
}
const answer = (view: Record<string, any>) => ({ callId: view.approval.callId, digest: view.approval.digest, decision: 'approved' });

describe('scoped thread routes and run approvals', () => {
  it('creates, paginates, edits, archives, restores, reads entries and deletes scoped threads', async () => {
    const { agent } = fixture(); const api = server(agent); await create(api);
    await create(api, 'thread-2');
    const first = await json(await call(api, '/v1/threads?limit=1')); expect(first.threads).toHaveLength(1); expect(first.cursor).toEqual(expect.any(String));
    const next = await json(await call(api, `/v1/threads?limit=1&cursor=${encodeURIComponent(first.cursor)}`)); expect(next.threads).toHaveLength(1);
    expect(next.threads[0].id).not.toBe(first.threads[0].id);
    expect((await json(await call(api, '/v1/threads/thread-1', 'POST', { title: 'Changed', expectedVersion: 1 }))).thread.title).toBe('Changed');
    expect((await call(api, '/v1/threads/thread-1/archive', 'POST')).status).toBe(200);
    expect((await json(await call(api, '/v1/threads?status=archived'))).threads).toHaveLength(1);
    expect((await call(api, '/v1/threads/thread-1/restore', 'POST')).status).toBe(200);
    expect((await json(await call(api, '/v1/threads/thread-1/entries'))).entries).toEqual([]);
    expect((await call(api, '/v1/threads/thread-1', 'DELETE')).status).toBe(200);
    expect((await call(api, '/v1/threads/thread-1')).status).toBe(404);
  });

  it('requires explicit capabilities and derives all thread ownership from the verified scope', async () => {
    const { agent } = fixture(); const api = server(agent); await create(api);
    for (const token of ['bob', 'project']) {
      expect((await call(api, '/v1/threads/thread-1', 'GET', undefined, token)).status).toBe(404);
      expect(await json(await call(api, '/v1/threads/thread-1', 'DELETE', undefined, token))).toMatchObject({error:{code:'THREAD_NOT_FOUND'}});
      expect((await json(await call(api, '/v1/threads', 'GET', undefined, token))).threads).toEqual([]);
    }
    expect((await call(api, '/v1/threads', 'POST', { id: 'spoof', scope: { principalId: 'bob', projectId: 'shop' } })).status).toBe(400);
    expect((await call(api, '/v1/threads', 'POST', {}, 'denied')).status).toBe(403);
    expect((await call(api, '/v1/threads/thread-1', 'DELETE', undefined, 'denied')).status).toBe(403);
    expect((await call(api, '/v1/threads', 'POST', { agentId: 'support' }, 'other-agent')).status).toBe(404);
  });

  it('exposes the exact pending call and records an approval attributed to the authenticated principal', async () => {
    const { agent, execute } = fixture(); const api = server(agent); await create(api); const id = await start(api); const view = await waiting(api, id);
    expect(execute).not.toHaveBeenCalled();
    for (const token of ['bob', 'project', 'other-agent']) expect((await call(api, `/v1/runs/${id}/approvals`, 'POST', answer(view), token)).status).toBe(404);
    expect((await call(api, `/v1/runs/${id}/approvals`, 'POST', answer(view), 'denied')).status).toBe(403);
    expect((await call(api, `/v1/runs/${id}/approvals`, 'POST', { ...answer(view), actorId: 'someone-else' })).status).toBe(400);
    expect((await call(api, `/v1/runs/${id}/approvals`, 'POST', { ...answer(view), digest: 'a'.repeat(64) })).status).toBe(409);
    expect((await call(api, `/v1/runs/${id}/approvals`, 'POST', answer(view))).status).toBe(202);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => expect((await json(await call(api, `/v1/runs/${id}`))).status).toBe('succeeded'));
    const entries = (await json(await call(api, '/v1/threads/thread-1/entries'))).entries;
    expect(entries.filter((entry: any) => entry.kind === 'approval')).toMatchObject([{ actorId: 'alice', decision: 'approved' }]);
    expect((await call(api, `/v1/runs/${id}/approvals`, 'POST', answer(view))).status).toBe(409);
  });

  it('resumes on another server after shutdown, with one durable event sequence and one recorded turn', async () => {
    const { agent, execute } = fixture(); const first = server(agent); await create(first); const id = await start(first); const view = await waiting(first, id);
    await first.close();
    const second = server(agent); const remote = await waiting(second, id); expect(remote.approval.digest).toBe(view.approval.digest);
    const third = server(agent);
    const responses = await Promise.all([call(second, `/v1/runs/${id}/approvals`, 'POST', answer(view)), call(third, `/v1/runs/${id}/approvals`, 'POST', answer(view))]);
    expect(responses.map(response => response.status).sort()).toEqual([202, 409]);
    await vi.waitFor(async () => expect((await json(await call(third, `/v1/runs/${id}`))).status).toBe('succeeded'), { timeout: 3000 });
    expect(execute).toHaveBeenCalledTimes(1);
    const frames = await (await call(third, `/v1/runs/${id}/events`)).text();
    expect(frames).not.toContain('stream.error');
    const sequences = [...frames.matchAll(/^id: ([0-9]+)$/gm)].map(match => Number(match[1]));
    expect(sequences.length).toBeGreaterThan(4); expect(new Set(sequences).size).toBe(sequences.length);
    const entries = (await json(await call(second, '/v1/threads/thread-1/entries'))).entries;
    expect(entries.filter((entry: any) => entry.kind === 'run' && entry.status === 'succeeded')).toHaveLength(1);
  });

  it('cancels a checkpointed turn on another replica without executing its tool', async () => {
    const { agent, execute } = fixture(); const first = server(agent); await create(first); const id = await start(first); await waiting(first, id); await first.close();
    const second = server(agent);
    expect((await call(second, `/v1/runs/${id}/cancel`, 'POST', undefined, 'bob')).status).toBe(404);
    expect((await call(second, `/v1/runs/${id}/cancel`, 'POST')).status).toBe(202);
    expect((await json(await call(second, `/v1/runs/${id}`))).status).toBe('cancelled'); expect(execute).not.toHaveBeenCalled();
    const entries = (await json(await call(second, '/v1/threads/thread-1/entries'))).entries;
    expect(entries.filter((entry: any) => entry.kind === 'run' && entry.status === 'cancelled')).toHaveLength(1);
  });

  it('leaves the checkpoint waiting if run record ownership cannot transfer, then allows a retry', async () => {
    const { agent, execute } = fixture(); const first = server(agent); await create(first); const id = await start(first); const view = await waiting(first, id); await first.close();
    const records = createAggregateRunRecords(store); let unavailable = true;
    const second = server(agent, { runRecords: { ...records, resume: async input => {
      if (unavailable) throw new Error('PRIVATE_DATABASE_ERROR'); return records.resume!(input);
    } } });
    expect((await call(second, `/v1/runs/${id}/approvals`, 'POST', answer(view))).status).toBe(409);
    expect(await store.runCheckpoints.get({ runId: id })).toMatchObject({ status: 'waiting' }); expect(execute).not.toHaveBeenCalled();
    unavailable = false;
    expect((await call(second, `/v1/runs/${id}/approvals`, 'POST', answer(view))).status).toBe(202);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  });

  it('records a changed definition as a failure after restart instead of abandoning the run', async () => {
    const { agent, execute } = fixture(); const first = server(agent); await create(first); const id = await start(first); const view = await waiting(first, id); await first.close();
    const changed = defineAgent({ id: agent.id, version: '2', instructions: 'Changed.', input: agent.input, output: agent.output, tools: agent.tools, model: agent.model });
    const second = server(changed);
    expect((await call(second, `/v1/runs/${id}/approvals`, 'POST', answer(view))).status).toBe(409);
    const snapshot = await json(await call(second, `/v1/runs/${id}`)); expect(snapshot.status).toBe('failed'); expect(snapshot.outcome.error.code).toBe('DEFINITION_CHANGED'); expect(execute).not.toHaveBeenCalled();
  });

  it('replays thread submissions idempotently and refuses the same key for another thread', async () => {
    const { agent } = fixture(); const api = server(agent); await create(api); const id = await start(api); await waiting(api, id);
    const again = await call(api, '/v1/runs', 'POST', { agentId: 'support', input: { message: 'Refund' }, threadId: 'thread-1' }, 'alice', { 'idempotency-key': 'thread-1' });
    expect(again.status).toBe(200); expect((await json(again)).id).toBe(id);
    expect((await call(api, '/v1/runs', 'POST', { agentId: 'support', input: { message: 'Refund' }, threadId: 'thread-2' }, 'alice', { 'idempotency-key': 'thread-1' })).status).toBe(409);
  });

  it('supports request-mode submissions and approvals ending at a durable pause or completion', async () => {
    const { agent, execute } = fixture(); const api = server(agent, { runExecution: 'request' }); await create(api);
    const id = await start(api); const view = await waiting(api, id);
    const approved = await call(api, `/v1/runs/${id}/approvals`, 'POST', answer(view)); expect(approved.status).toBe(202);
    expect(execute).toHaveBeenCalledTimes(1); expect((await json(await call(api, `/v1/runs/${id}`))).status).toBe('succeeded');
  });

  it('rejects malformed queries, unsupported methods and storage failures without leaking adapter diagnostics', async () => {
    const { agent } = fixture(); const api = server(agent); await create(api);
    for (const query of ['?limit=0', '?limit=501', '?limit=2&limit=3', '?scope=bob']) expect((await call(api, '/v1/threads' + query)).status).toBe(400);
    expect((await call(api, '/v1/threads/thread-1', 'PUT')).status).toBe(405);
    const failing = server(agent, { threads: { store: { ...store, threads: { ...store.threads, list: async () => { throw new Error('private DATABASE_URL'); } } } } });
    const response = await call(failing, '/v1/threads'); expect(response.status).toBe(503); expect(await response.text()).not.toContain('DATABASE_URL');
  });
});


describe('conversation client against the scoped server', () => {
  it.each(['approved', 'rejected', 'cancelled'] as const)('finishes a %s threaded run through client and headless APIs exactly once', async decision => {
    const { agent, execute } = fixture(); const api = server(agent, { runExecution: 'request' });
    const client = createClient({ baseUrl: origin, token: () => 'alice', fetch: (url, init) => api.fetch(new Request(url, init)) });
    const created = await client.createThread({ id: 'client-chat', agentId: 'support' });
    const conversation = createHeadlessThreadStore({ client, threadId: created.id });
    const run = await conversation.submit('support', { message: 'Refund' }, { idempotencyKey: 'client-turn' });
    const view = await run.inspect(); expect(view.status).toBe('waiting'); expect(view.approval).toBeDefined();
    expect(await run.result(z.object({ reply: z.string() }))).toBeUndefined();
    if (decision === 'cancelled') await run.cancel();
    else {
      const controller = createRunApprovalController({ run, approval: view.approval! });
      await controller.submit(decision); expect(controller.getSnapshot().status).toBe('succeeded'); controller.dispose();
    }
    await vi.waitFor(async () => expect((await run.inspect()).status).toBe(decision === 'approved' ? 'succeeded' : decision === 'rejected' ? 'succeeded' : 'cancelled'), { timeout: 3_000 });
    const observed = []; for await (const event of run.events({ reconnect: false })) observed.push(event.type);
    expect(observed).toContain('approval.requested'); expect(observed).toContain('run.paused'); expect(observed).toContain('run.completed');
    await conversation.refresh(); const entries = conversation.getSnapshot().entries;
    expect(entries.filter(entry => entry.kind === 'run' && entry.status !== 'running')).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(decision === 'approved' ? 1 : 0);
    if (decision === 'approved') expect(entries.filter(entry => entry.kind === 'approval')).toMatchObject([{ actorId: 'alice', decision: 'approved' }]);
    const repeated = await client.submit('support', { message: 'Refund' }, { idempotencyKey: 'client-turn', threadId: created.id }); expect(repeated.id).toBe(run.id);
    await expect(run.approve({ callId: view.approval!.callId, digest: view.approval!.digest, decision: 'approved' })).rejects.toMatchObject({ code: 'APPROVAL_CONFLICT' });
    expect((await client.threadEntries(created.id)).filter(entry => entry.kind === 'run' && entry.status !== 'running')).toHaveLength(1);
    conversation.dispose();
  });
  it.each(['request', 'background'] as const)('recovers expired approvals after restart in %s mode without executing the unapproved call', async runExecution => {
    const { agent, execute } = fixture(); const first = server(agent, { runExecution });
    await create(first); const id = await start(first); const view = await waiting(first, id); await first.close();
    const now = vi.spyOn(Date, 'now').mockReturnValue(view.approval.expiresAtMs + 1);
    const authorize = vi.fn(async () => true);
    const second = server(agent, { runExecution, conversationRecovery: { permissions: { allow: ['conversations:recover'] }, authorize } });
    const report = await second.recoverConversations({ limit: 1 });
    expect(report.outcomes).toEqual([{ id, status: 'resumed' }]);
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ scope: { principalId: 'alice', projectId: 'shop' }, agentId: 'support', kind: 'approval' }));
    await vi.waitFor(async () => expect((await json(await call(second, `/v1/runs/${id}`))).status).toBe('succeeded'));
    const entries = (await json(await call(second, '/v1/threads/thread-1/entries'))).entries;
    expect(entries.filter((entry: any) => entry.kind === 'approval')).toMatchObject([{ decision: 'expired' }]);
    expect(entries.filter((entry: any) => entry.kind === 'run' && entry.status === 'succeeded')).toHaveLength(1);
    expect((await second.recoverConversations()).outcomes).toEqual([]); expect(execute).not.toHaveBeenCalled(); now.mockRestore();
  });

  it('requires the service grant and fails closed when scope policy denies recovery', async () => {
    const { agent, execute } = fixture(); const first = server(agent, { runExecution: 'request' });
    await expect(first.recoverConversations()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(() => server(agent, { conversationRecovery: { permissions: { allow: [] }, authorize: async () => true } })).toThrow();
    expect(() => server(agent, { runExecution: 'request', conversationRecovery: { permissions: { allow: ['conversations:recover'] }, authorize: async () => true, intervalMs: 100 } })).toThrow();
    await create(first); const id = await start(first); const view = await waiting(first, id); await first.close();
    vi.spyOn(Date, 'now').mockReturnValue(view.approval.expiresAtMs + 1);
    const second = server(agent, { conversationRecovery: { permissions: { allow: ['conversations:recover'] }, authorize: async () => false } });
    expect((await second.recoverConversations()).outcomes).toEqual([{ id, status: 'skipped', code: 'PERMISSION_DENIED' }]);
    expect(await store.runCheckpoints.get({ runId: id })).toMatchObject({ status: 'waiting' }); expect(execute).not.toHaveBeenCalled();
    expect((await call(second, '/v1/conversations/recover', 'POST')).status).toBe(404);
  });

  it('repairs an interrupted terminal recording once after restart without rerunning the agent', async () => {
    const { agent, execute } = fixture(); let fail = true;
    const wrapped = { ...store, threads: { ...store.threads, append: async (input: Parameters<typeof store.threads.append>[0]) => {
      if (fail && input.entries.some(entry => entry.kind === 'run' && entry.data['status'] === 'succeeded')) throw new Error('PRIVATE_DB_FAILURE');
      return store.threads.append(input);
    } } };
    const first = server(agent, { threads: { store: wrapped }, runExecution: 'request' });
    await create(first); const id = await start(first); const view = await waiting(first, id);
    expect((await call(first, `/v1/runs/${id}/approvals`, 'POST', answer(view))).status).toBe(202);
    expect((await json(await call(first, `/v1/runs/${id}`))).status).toBe('failed');
    await first.close(); fail = false;
    const second = server(agent, { conversationRecovery: { permissions: { allow: ['conversations:recover'] }, authorize: async () => true } });
    const report = await second.recoverConversations(); expect(report.outcomes).toEqual([expect.objectContaining({ status: 'recovered' })]);
    expect((await second.recoverConversations()).outcomes).toEqual([]);
    const entries = (await json(await call(second, '/v1/threads/thread-1/entries'))).entries;
    expect(entries.filter((entry: any) => entry.kind === 'run' && entry.status === 'succeeded')).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await json(await call(second, `/v1/runs/${id}`))).status).toBe('failed');
  });

  it('lets competing hosts resume an expired approval only once', async () => {
    const { agent, execute } = fixture(); const first = server(agent, { runExecution: 'request' });
    await create(first); const id = await start(first); const view = await waiting(first, id); await first.close();
    vi.spyOn(Date, 'now').mockReturnValue(view.approval.expiresAtMs + 1);
    const config = { runExecution: 'request' as const, conversationRecovery: { permissions: { allow: ['conversations:recover'] }, authorize: async () => true } };
    const second = server(agent, config); const third = server(agent, config);
    const reports = await Promise.all([second.recoverConversations(), third.recoverConversations()]);
    expect(reports.flatMap(report => report.outcomes).filter(outcome => outcome.status === 'resumed')).toHaveLength(1);
    const entries = (await json(await call(second, '/v1/threads/thread-1/entries'))).entries;
    expect(entries.filter((entry: any) => entry.kind === 'run' && entry.status === 'succeeded')).toHaveLength(1);
    const events = await (await call(second, `/v1/runs/${id}/events`)).text();
    const sequences = [...events.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]));
    expect(sequences.length).toBeGreaterThan(0); expect(new Set(sequences).size).toBe(sequences.length);
    expect(execute).not.toHaveBeenCalled();
  });

  it('skips a claimed checkpoint even after its lease expires, preserving uncertain write evidence', async () => {
    const { agent, execute } = fixture(); const first = server(agent, { runExecution: 'request' });
    await create(first); const id = await start(first); const view = await waiting(first, id); await first.close();
    await store.runCheckpoints.claim({ runId: id, holderId: 'interrupted-worker', leaseMs: 1000 });
    vi.spyOn(Date, 'now').mockReturnValue(view.approval.expiresAtMs + 1);
    const authorize = vi.fn(async () => true);
    const second = server(agent, { conversationRecovery: { permissions: { allow: ['conversations:recover'] }, authorize } });
    expect((await second.recoverConversations()).outcomes).toEqual([{ id, status: 'skipped' }]);
    expect(authorize).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    expect(await store.runCheckpoints.get({ runId: id })).toMatchObject({ status: 'claimed', holderId: 'interrupted-worker' });
  });

  it('retries authorization failures without exposing their details or mutating the checkpoint', async () => {
    const { agent, execute } = fixture(); const first = server(agent, { runExecution: 'request' });
    await create(first); const id = await start(first); const view = await waiting(first, id); await first.close();
    vi.spyOn(Date, 'now').mockReturnValue(view.approval.expiresAtMs + 1);
    const second = server(agent, { conversationRecovery: { permissions: { allow: ['conversations:recover'] }, authorize: async () => { throw new Error('PRIVATE_POLICY_KEY'); } } });
    expect((await second.recoverConversations()).outcomes).toEqual([{ id, status: 'retry', code: 'STORAGE_UNAVAILABLE' }]);
    expect(await store.runCheckpoints.get({ runId: id })).toMatchObject({ status: 'waiting' }); expect(execute).not.toHaveBeenCalled();
  });

  it('drains recovery on close and refuses late authorization before executing work', async () => {
    const { agent, execute } = fixture(); const first = server(agent, { runExecution: 'request' });
    await create(first); const id = await start(first); const view = await waiting(first, id); await first.close();
    vi.spyOn(Date, 'now').mockReturnValue(view.approval.expiresAtMs + 1);
    let release!: (allow: boolean) => void; let entered!: () => void;
    const authorizationStarted = new Promise<void>(resolve => { entered = resolve; });
    const second = server(agent, { conversationRecovery: { permissions: { allow: ['conversations:recover'] }, authorize: () => {
      entered(); return new Promise(resolve => { release = resolve; });
    } } });
    const pending = second.recoverConversations(); await authorizationStarted;
    const closing = second.close(); await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    release(true); await closing;
    expect(await store.runCheckpoints.get({ runId: id })).toMatchObject({ status: 'waiting' }); expect(execute).not.toHaveBeenCalled();
  });

  it('schedules automatic recovery pages only for an explicitly configured background host', async () => {
    const { agent, execute } = fixture(); const first = server(agent, { runExecution: 'request' });
    await create(first); const id = await start(first); const view = await waiting(first, id); await first.close();
    vi.spyOn(Date, 'now').mockReturnValue(view.approval.expiresAtMs + 1);
    const second = server(agent, { conversationRecovery: { permissions: { allow: ['conversations:recover'] }, authorize: async () => true, intervalMs: 100, pageSize: 1 } });
    await vi.waitFor(async () => expect((await json(await call(second, `/v1/runs/${id}`))).status).toBe('succeeded'));
    await second.close(); expect(execute).not.toHaveBeenCalled();
  });

  it.each(['not_started', 'succeeded', 'failed', 'unknown'] as const)('closes a claimed approval with %s effect evidence without dispatching any tool', async effect => {
    const { agent, execute } = fixture(); const generate = vi.fn(agent.model.generate.bind(agent.model));
    const definition = defineAgent({ id: agent.id, version: agent.version, instructions: agent.instructions, input: agent.input, output: agent.output,
      tools: agent.tools, model: { ...agent.model, generate } });
    const first = server(definition, { runExecution: 'request' }); await create(first); const id = await start(first); const waitingView = await waiting(first, id); await first.close();
    await store.runCheckpoints.claim({ runId: id, holderId: 'interrupted-worker', leaseMs: 1000 });
    const options = { approvalReconciliation: { permissions: { allow: ['conversations:reconcile'] }, authorize: async ({ actorId }: { actorId: string }) => actorId === 'operator' } };
    const second = server(definition, options); const request = { runId: id, scope: { principalId: 'alice', projectId: 'shop' }, actorId: 'operator' };
    const live = await second.inspectClaimedApproval(request); expect(live.eligible).toBe(false); expect(live.blockers).toContain('checkpoint_live');
    await new Promise(resolve => setTimeout(resolve, 1050)); vi.spyOn(Date, 'now').mockReturnValue(waitingView.approval.expiresAtMs + 1);
    const view = await second.inspectClaimedApproval(request); expect(view.eligible).toBe(true);
    const command = { ...request, reviewDigest: view.reviewDigest, commandId: 'incident-1', effect, evidenceRef: 'external/receipt-123', workerStopped: true as const };
    const result = await second.reconcileClaimedApproval(command); expect(result.status).toBe('closed');
    expect(result.receipt).toMatchObject({ actorId: 'operator', effect, evidenceRef: 'external/receipt-123', expectedHolderId: 'interrupted-worker' });
    expect(await second.reconcileClaimedApproval(command)).toEqual(result);
    await expect(second.reconcileClaimedApproval({ ...command, commandId: 'different' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await json(await call(second, `/v1/runs/${id}`))).status).toBe('outcome_unknown');
    const client = createClient({ baseUrl: origin, token: () => 'alice', fetch: (url, init) => second.fetch(new Request(url, init)) });
    const remote = client.run(id); expect((await remote.inspect()).status).toBe('outcome_unknown'); expect((await remote.inspect()).approval).toBeUndefined();
    const events = []; for await (const event of remote.events({ reconnect: false })) events.push(event);
    expect(events.filter(event => event.type === 'run.completed')).toHaveLength(1);
    expect(new Set(events.map(event => event.sequence)).size).toBe(events.length);
    const entries = await client.threadEntries('thread-1');
    expect(entries.filter(entry => entry.kind === 'run' && entry.status === 'outcome_unknown')).toHaveLength(1);
    expect(entries.filter((entry: any) => entry.kind === 'tool_result')).toEqual([]);
    expect(execute).not.toHaveBeenCalled(); expect(generate).toHaveBeenCalledTimes(1);
    // The retained sealed checkpoint is the audit source; normal claim/resume paths cannot reopen it.
    expect((await store.runCheckpoints.get({ runId: id }))!.body['reconciliation']).toEqual(result.receipt);
    await expect(store.runCheckpoints.claim({ runId: id, holderId: 'stale-worker', leaseMs: 1000 })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await second.inspectClaimedApproval(request)).receipt).toEqual(result.receipt);
    const replay = await call(second, '/v1/runs', 'POST', { agentId: 'support', input: { message: 'Refund' }, threadId: 'thread-1' }, 'alice', { 'idempotency-key': 'thread-1' });
    expect(replay.status).toBe(200); expect((await json(replay)).id).toBe(id); // Original submission key stays bound to the terminal run.
    expect((await call(second, '/v1/runs', 'POST', { agentId: 'support', input: { message: 'Another turn' }, threadId: 'thread-1' }, 'alice', { 'idempotency-key': 'next-turn' })).status).toBe(202);
  });

  it('requires independent reconciliation authority and never exposes it as an HTTP route', async () => {
    const { agent } = fixture(); const api = server(agent);
    const request = { runId: crypto.randomUUID(), scope: { principalId: 'alice', projectId: 'shop' }, actorId: 'operator' };
    await expect(api.inspectClaimedApproval(request)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(() => server(agent, { approvalReconciliation: { permissions: { allow: [] }, authorize: async () => true } })).toThrow();
    expect((await call(api, `/v1/runs/${request.runId}/reconcile`, 'POST')).status).toBe(404);
  });

  it('finishes a sealed reconciliation after a restart and an interrupted thread journal write', async () => {
    const { agent, execute } = fixture(); const first = server(agent, { runExecution: 'request' });
    await create(first); const id = await start(first); const view = await waiting(first, id); await first.close();
    await store.runCheckpoints.claim({ runId: id, holderId: 'interrupted-worker', leaseMs: 1000 });
    await new Promise(resolve => setTimeout(resolve, 1050)); vi.spyOn(Date, 'now').mockReturnValue(view.approval.expiresAtMs + 1);
    const authority = { permissions: { allow: ['conversations:reconcile'] }, authorize: async () => true };
    const wrapped = { ...store, threads: { ...store.threads, append: async (input: Parameters<typeof store.threads.append>[0]) => {
      if (input.entries.some(entry => entry.data['status'] === 'outcome_unknown')) throw new Error('PRIVATE_APPEND_FAILURE');
      return store.threads.append(input);
    } } };
    const second = server(agent, { approvalReconciliation: authority, threads: { store: wrapped } });
    const request = { scope: { principalId: 'alice', projectId: 'shop' }, actorId: 'operator', runId: id };
    const review = await second.inspectClaimedApproval(request);
    const command = { ...request, reviewDigest: review.reviewDigest, commandId: 'restart-1', evidenceRef: 'incident/321', effect: 'unknown' as const, workerStopped: true as const };
    await expect(second.reconcileClaimedApproval(command)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await second.close();
    const third = server(agent, { approvalReconciliation: authority });
    const result = await third.reconcileClaimedApproval({ ...command, scope: { projectId: 'shop', principalId: 'alice' } });
    expect(result.status).toBe('closed'); expect(execute).not.toHaveBeenCalled();
    const entries = (await json(await call(third, '/v1/threads/thread-1/entries'))).entries;
    expect(entries.filter((entry: any) => entry.kind === 'run' && entry.status === 'outcome_unknown')).toHaveLength(1);
    expect((await store.runCheckpoints.scan({ limit: 10 })).map(row => row.runId)).toEqual([id]);
  });

});


it('keeps hosted handoff approvals on the original scoped run and source agent identity', async () => {
  const execute = vi.fn(() => ({ saved: true }));
  const tool = defineTool({ id: 'save-note', version: '1', description: 'Save', input: z.object({}), output: z.object({ saved: z.boolean() }),
    effects: 'write', capabilities: [], approval: 'required', execute });
  const billing = defineAgent({ id: 'billing', version: '1', instructions: 'Handle billing', tools: [tool], input: z.object({ message: z.string() }), output: z.object({ reply: z.string() }),
    model: scriptedModel([{ type: 'tool_calls', calls: [{ id: 'save1', toolId: tool.id, input: {} }], usage: { costMicros: 0 } },
      { type: 'final', output: { reply: 'Saved' }, usage: { costMicros: 0 } }], { id: 'billing-model' }) });
  const support = defineAgent({ id: 'support', version: '1', instructions: 'Transfer billing', tools: [], input: z.object({ message: z.string() }), output: z.object({ reply: z.string() }),
    handoffs: [{ agent: billing, permissions: { allow: ['model:billing-model', `tool:${tool.id}`, 'effect:write'] } }],
    model: scriptedModel([{ type: 'tool_calls', calls: [{ id: 'transfer1', toolId: 'handoff.billing', input: { message: 'A note' } }], usage: { costMicros: 0 } }], { id: 'support-model' }) });
  const api = server(support, { runExecution: 'request', agents: [{ agent: support, permissions: { allow: ['model:support-model', 'agent:billing'] } }] });
  await create(api); const runId = await start(api); const pending = await waiting(api, runId);
  expect(pending.approval.toolId).toBe('save-note'); expect(execute).not.toHaveBeenCalled();
  const catalog = await json(await call(api, '/v1/tools')); expect(JSON.stringify(catalog)).toContain('handoff.billing');
  expect((await call(api, `/v1/runs/${runId}/approvals`, 'POST', answer(pending), 'bob')).status).toBe(404);
  expect((await call(api, `/v1/runs/${runId}/approvals`, 'POST', answer(pending))).status).toBe(202);
  await vi.waitFor(async () => expect((await json(await call(api, `/v1/runs/${runId}`))).status).toBe('succeeded')); expect(execute).toHaveBeenCalledTimes(1);
  const entries = (await json(await call(api, '/v1/threads/thread-1/entries'))).entries;
  expect(entries.filter((entry: { kind: string }) => entry.kind === 'assistant')).toHaveLength(1);
});
