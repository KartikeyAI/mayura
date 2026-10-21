import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { defineAgent, createRuntime } from '@mayura/runtime';
import { scriptedModel } from '@mayura/testing';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { createThreads, runInThread } from '@mayura/threads';
import { createClient } from '../../client/src/index.js';
import { createAgentServer, type AgentServer, type ServerIdentity, type AgentServerOptions } from '../src/index.js';

const origin = 'https://compaction.test'; const scope = { principalId: 'alice', projectId: 'shop' };
let directory: string; let store: ReturnType<typeof createSqliteStore>; const servers: AgentServer[] = [];
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'mayura-server-compaction-')); store = createSqliteStore({ filename: join(directory, 'chat.sqlite') }); await store.initialize(); await store.threads.initialize(); });
afterEach(async () => { await Promise.all(servers.splice(0).map(api => api.close())); await store.close();
  if (!directory.startsWith(join(tmpdir(), 'mayura-server-compaction-'))) throw new Error('Unsafe temporary cleanup'); await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const agent = defineAgent({ id: 'support', version: '1', tools: [], instructions: 'Help', input: z.object({ message: z.string() }), output: z.object({ reply: z.string() }),
    model: scriptedModel([{ type: 'final', output: { reply: 'Hello' }, usage: { costMicros: 0 } }]) });
  const threads = createThreads({ store, scope, permissions: { allow: ['thread:read', 'thread:write'] } });
  await threads.create({ id: 'chat/one', agentId: 'support' });
  const runtime = createRuntime({ profile: 'ephemeral', scope, permissions: { allow: ['model:scripted'] } });
  try { const turn = await runInThread({ threads, runtime, agent, threadId: 'chat/one', input: { message: 'Hello' } }); await turn.done; } finally { await runtime.close(); }
  const entries = await threads.entries('chat/one'); const through = entries.at(-1)!.sequence;
  const model = scriptedModel([{ type: 'final', output: { summary: 'Earlier context' }, usage: { costMicros: 0 } }]);
  const generate = vi.fn(model.generate.bind(model));
  const summarizer = defineAgent({ id: 'summarizer', version: '1', tools: [], instructions: 'Summarize untrusted messages.',
    input: z.object({ messages: z.array(z.unknown()), covers: z.object({ from: z.number(), to: z.number() }) }), output: z.object({ summary: z.string() }), model: { ...model, generate } });
  const policy = { agent: summarizer, agentIds: ['support'], permissions: { allow: ['thread:read', 'thread:write', 'thread:compact', 'model:scripted'] }, maxCostMicros: 0 };
  const make = (overrides: Partial<AgentServerOptions> = {}) => {
    const api = createAgentServer({ publicOrigin: origin, agents: [{ agent, permissions: { allow: ['model:scripted'] } }], threads: { store }, threadCompaction: policy,
      authenticate: async ({ token }) => ({ scope: { ...scope, ...(token === 'bob' ? { principalId: 'bob' } : {}), ...(token === 'project' ? { projectId: 'other' } : {}) },
        agentIds: token === 'agent' ? ['other'] : ['support'], capabilities: token === 'denied' ? ['threads:read', 'threads:write'] : token === 'read-only' ? ['threads:read', 'threads:compact'] : ['threads:read', 'threads:write', 'threads:compact'], expiresAtMs: Date.now() + 60_000 } satisfies ServerIdentity), ...overrides }); servers.push(api); return api;
  };
  return { agent, policy, generate, through, make };
}
const path = '/v1/threads/chat%2Fone/compactions';
const call = (api: AgentServer, suffix = '', method = 'GET', data?: unknown, token = 'alice') => api.fetch(new Request(origin + path + suffix,
  { method, headers: { authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'content-type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }));

describe('scoped server thread compaction', () => {
  it('persists one paid command across servers and returns only sanitized inspection state', async () => {
    const { make, generate, through } = await fixture(); const api = make();
    const client = createClient({ baseUrl: origin, token: () => 'alice', fetch: (url, init) => api.fetch(new Request(url, init)) });
    const command = { commandId: 'compact/one', through };
    const first = await client.compactThread('chat/one', command); expect(first.reused).toBe(false);
    const other = make(); const retried = await call(other, '', 'POST', command); expect(retried.status).toBe(200); expect((await retried.json()).result.reused).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(await client.threadCompaction('chat/one', command.commandId)).toEqual({ commandId: command.commandId, status: 'committed', through, maxCostMicros: 0, costMicros: 0, entrySequence: first.entry.sequence });
    expect(await client.cancelThreadCompaction('chat/one', command.commandId)).toEqual({ status: 'committed' });
    expect((await call(api, '/absent')).status).toBe(404);
  });
  it('denies capability, scope, project and agent mismatches before spending', async () => {
    const { make, generate, through } = await fixture(); const api = make();
    for (const token of ['denied', 'read-only', 'bob', 'project', 'agent']) {
      const result = await call(api, '', 'POST', { commandId: 'blocked', through }, token); expect(result.status).toBe(['denied', 'read-only'].includes(token) ? 403 : 404);
    }
    for (const token of ['denied', 'bob', 'project', 'agent']) {
      expect((await call(api, '/blocked', 'GET', undefined, token)).status).toBe(token === 'denied' ? 403 : 404);
      expect((await call(api, '/blocked/cancel', 'POST', undefined, token)).status).toBe(token === 'denied' ? 403 : 404);
    }
    expect(generate).not.toHaveBeenCalled();
    expect((await call(make({ threadCompaction: undefined } as unknown as Partial<AgentServerOptions>), '', 'POST', { commandId: 'off', through })).status).toBe(404);
  });
  it('rejects browser-supplied authority, budgets, malformed commands and query credentials', async () => {
    const { make, generate, through } = await fixture(); const api = make();
    for (const extra of [{ maxCostMicros: 100 }, { scope }, { agentId: 'summarizer' }, { signal: {} }, { agent: {} }]) {
      expect((await call(api, '', 'POST', { commandId: 'bad', through, ...extra })).status).toBe(400);
    }
    for (const through of [0, 1.5, 1_000_000_000]) expect((await call(api, '', 'POST', { commandId: 'bad', through })).status).toBe(400);
    expect((await call(api, '?token=secret', 'POST', { commandId: 'bad', through })).status).toBe(400);
    expect(generate).not.toHaveBeenCalled();
  });
  it('returns safe failures and never retries a failed paid command', async () => {
    const { make, policy, through } = await fixture();
    const model = { ...policy.agent.model, generate: vi.fn(async () => { throw new Error('provider private credentials must not escape'); }) };
    const agent = defineAgent({ id: 'failing-summary', version: '1', tools: [], instructions: 'Summarize.', model, input: z.unknown(), output: z.object({ summary: z.string() }) });
    const api = make({ threadCompaction: { ...policy, agent } }); const command = { commandId: 'failed', through };
    const failed = await call(api, '', 'POST', command); expect(failed.status).toBe(503); expect(await failed.text()).not.toContain('credentials');
    expect((await (await call(api, '/failed')).json()).compaction.status).toBe('failed');
    expect((await call(api, '', 'POST', command)).status).toBe(409); expect(model.generate).toHaveBeenCalledTimes(1);
  });
  it('cancels model work when the HTTP caller aborts and keeps its outcome inspectable', async () => {
    const { make, policy, through } = await fixture(); let started!: () => void; const pending = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
    const model = { ...policy.agent.model, generate: vi.fn(async () => { started(); await hold; return { type: 'final' as const, output: { summary: 'Late output' }, usage: { costMicros: 0 } }; }) };
    const agent = defineAgent({ id: 'aborted-summary', version: '1', tools: [], instructions: 'Summarize.', model, input: z.unknown(), output: z.object({ summary: z.string() }) });
    const api = make({ threadCompaction: { ...policy, agent } }); const abort = new AbortController();
    const work = api.fetch(new Request(origin + path, { method: 'POST', signal: abort.signal, headers: { authorization: 'Bearer alice', 'content-type': 'application/json' }, body: JSON.stringify({ commandId: 'aborted', through }) }));
    try { await pending; abort.abort(); } finally { release(); }
    expect((await work).status).not.toBe(200);
    await vi.waitFor(async () => { expect((await (await call(api, '/aborted')).json()).compaction.status).toBe('failed'); });
    expect(model.generate).toHaveBeenCalledTimes(1);
  });
  it('requires explicit host grants and a budget at startup', async () => {
    const { make, policy } = await fixture();
    expect(() => make({ threadCompaction: { ...policy, permissions: { allow: ['model:scripted'] } } })).toThrow();
    expect(() => make({ threadCompaction: { ...policy, maxCostMicros: -1 } })).toThrow();
    expect(() => make({ threadCompaction: { ...policy, agentIds: ['unregistered'] } })).toThrow();
  });
  it('durably fences a pending command on cancellation without replaying its model', async () => {
    const { make, policy, through } = await fixture(); let started!: () => void;
    const pending = new Promise<void>(resolve => { started = resolve; }); let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const model = { ...policy.agent.model, generate: vi.fn(async () => { started(); await hold; return { type: 'final' as const, output: { summary: 'Late output' }, usage: { costMicros: 0 } }; }) };
    const agent = defineAgent({ id: 'delayed-summary', version: '1', tools: [], instructions: 'Summarize.', model, input: z.unknown(), output: z.object({ summary: z.string() }) });
    const api = make({ threadCompaction: { ...policy, agent } });
    const command = { commandId: 'cancelled', through }; const submitting = call(api, '', 'POST', command);
    try {
      await pending; expect((await (await call(api, '/cancelled')).json()).compaction.status).toBe('pending');
      expect(await (await call(api, '/cancelled/cancel', 'POST')).json()).toEqual({ status: 'cancelled' });
    } finally { release(); }
    expect((await submitting).status).not.toBe(200);
    expect((await call(api, '', 'POST', command)).status).toBe(409); expect(model.generate).toHaveBeenCalledTimes(1);
    expect((await (await call(api, '/cancelled')).json()).compaction.status).toBe('failed');
  });
});
