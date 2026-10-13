import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { defineTool } from '@mayura/tools';
import { scriptedModel } from '@mayura/testing';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { createRuntime, defineAgent, type Runtime } from '@mayura/runtime';
import type { ModelAdapter, ModelRequest, ModelResponse, RunEvent, RunHandle } from '@mayura/core';
import { sha256Hex } from '@mayura/core/host';
import { createThreads, purgeIdleThreads, runInThread, type Threads } from '../src/index.js';

type Store = ReturnType<typeof createSqliteStore>;
let directory: string; let store: Store; let runtime: Runtime;
const scope = { principalId: 'user-42', projectId: 'shop' };
const all = { allow: ['thread:read', 'thread:write', 'thread:delete'] };
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mayura-threads-'));
  store = createSqliteStore({ filename: join(directory, 'threads.sqlite') });
  await store.initialize(); await store.threads.initialize();
  runtime = createRuntime({ profile: 'ephemeral', scope, permissions: { allow: ['model:scripted', 'tool:orders.get', 'effect:read', 'tool:orders.refund', 'effect:write'] } });
});
afterEach(async () => {
  await runtime.close(); await store.close();
  const target = resolve(directory);
  if (target.startsWith(`${resolve(tmpdir())}${sep}mayura-threads-`)) await rm(target, { recursive: true, force: true });
});

const final = (reply: string): ModelResponse => ({ type: 'final', output: { reply }, usage: { costMicros: 0 } });
const agentWith = (model: ModelAdapter, tools: readonly ReturnType<typeof defineTool>[] = [], id = 'support') =>
  defineAgent({ id, version: '1', instructions: 'Help with orders.', tools, model, input: z.object({ message: z.string() }), output: z.object({ reply: z.string() }) });
const lookup = (result: () => unknown = () => ({ status: 'shipped' })) => defineTool({ id: 'orders.get', version: '1', description: 'Look up an order',
  input: z.object({ id: z.number() }), output: z.unknown(), effects: 'read', capabilities: [], execute: result });
const threadsFor = (permissions = all, who = scope): Threads => createThreads({ store, scope: who, permissions });
async function until(run: RunHandle<unknown>, type: RunEvent['type']): Promise<RunEvent> {
  for await (const event of run.observe()) if (event.type === type) return event;
  throw new Error(`The run ended without ${type}.`);
}

describe('threads', () => {
  it('creates, lists, renames, archives and restores a scope\'s threads', async () => {
    const threads = threadsFor();
    const first = await threads.create({ title: 'Order 7', metadata: { channel: 'web' } });
    expect(first).toMatchObject({ title: 'Order 7', metadata: { channel: 'web' }, status: 'active', entryCount: 0, lastSequence: 0, activeTurnId: null, agentId: null });
    const chosen = await threads.create({ id: 'support-1', agentId: 'support' });
    expect((await threads.create({ id: 'support-1', title: 'ignored' })).version).toBe(chosen.version); // idempotent
    expect((await threads.list()).threads.map(thread => thread.id).sort()).toEqual([first.id, 'support-1'].sort());
    const renamed = await threads.update('support-1', { title: 'Refund' });
    expect(renamed.title).toBe('Refund');
    await expect(threads.update('support-1', { title: 'stale', expectedVersion: chosen.version })).rejects.toMatchObject({ code: 'CONFLICT' });
    await threads.archive(first.id);
    expect((await threads.list()).threads.map(thread => thread.id)).toEqual(['support-1']);
    expect((await threads.list({ status: 'archived' })).threads.map(thread => thread.id)).toEqual([first.id]);
    expect((await threads.restore(first.id)).status).toBe('active');
    expect(await threads.get('missing')).toBeUndefined();
  });

  it('keeps each scope\'s threads apart', async () => {
    const mine = threadsFor(); const theirs = threadsFor(all, { principalId: 'user-7', projectId: 'shop' });
    const thread = await mine.create({ id: 'private-1' });
    expect(await theirs.get(thread.id)).toBeUndefined();
    expect((await theirs.list()).threads).toEqual([]);
    await expect(theirs.history(thread.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(theirs.delete(thread.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await mine.get(thread.id)).toBeDefined();
  });

  it('allows nothing without its grant', async () => {
    const thread = await threadsFor().create({ id: 't1' });
    const reader = threadsFor({ allow: ['thread:read'] }); const none = threadsFor({ allow: [] });
    await expect(none.get(thread.id)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(none.list()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(none.entries(thread.id)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(none.history(thread.id)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(reader.create()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(reader.update(thread.id, { title: 'x' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(reader.archive(thread.id)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(reader.delete(thread.id)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(runInThread({ threads: reader, runtime, agent: agentWith(scriptedModel([final('x')])), threadId: thread.id, input: { message: 'hi' } }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(await reader.get(thread.id)).toBeDefined();
  });

  it('deletes a thread and its entries for good, and never reuses its id', async () => {
    const threads = threadsFor();
    const thread = await threads.create({ id: 'gone' });
    await (await runInThread({ threads, runtime, agent: agentWith(scriptedModel([final('hello')])), threadId: thread.id, input: { message: 'hi' } })).done;
    expect((await threads.get(thread.id))!.entryCount).toBe(3);
    expect(await threads.delete(thread.id)).toEqual({ removed: 3 });
    expect(await threads.get(thread.id)).toMatchObject({ status: 'deleted', entryCount: 0, title: null });
    await expect(threads.entries(thread.id)).resolves.toEqual([]);
    await expect(threads.create({ id: 'gone' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(runInThread({ threads, runtime, agent: agentWith(scriptedModel([final('x')])), threadId: thread.id, input: { message: 'hi' } }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('runInThread', () => {
  it('records each turn, and gives the next run the conversation so far', async () => {
    const threads = threadsFor();
    const thread = await threads.create({ agentId: 'support' });
    const seen: ModelRequest[] = [];
    const model = scriptedModel([
      request => { seen.push(request); return { type: 'tool_calls', calls: [{ id: 'call-1', toolId: 'orders.get', input: { id: 7 } }], usage: { costMicros: 0 } }; },
      request => { seen.push(request); return final('Order 7 has shipped.'); },
      request => { seen.push(request); return final('Tomorrow.'); },
    ]);
    const agent = agentWith(model, [lookup()]);
    const first = await runInThread({ threads, runtime, agent, threadId: thread.id, input: { message: 'Where is order 7?' } });
    expect(first.history.messages).toEqual([]);
    const recorded = await first.done;
    expect(recorded.outcome).toEqual({ status: 'succeeded', output: { reply: 'Order 7 has shipped.' } });
    expect(recorded.entries.map(entry => entry.kind)).toEqual(['user', 'tool_calls', 'tool_result', 'assistant', 'run']);
    expect(recorded.entries.every(entry => entry.turnId === first.turnId)).toBe(true);
    expect(recorded.entries.at(-1)).toMatchObject({ kind: 'run', runId: first.run.id, status: 'succeeded' });
    expect('history' in seen[0]!).toBe(false);

    const second = await runInThread({ threads, runtime, agent, threadId: thread.id, input: { message: 'When will it arrive?' } });
    await second.done;
    expect(seen[2]!.history).toEqual([
      { role: 'user', content: { message: 'Where is order 7?' } },
      { role: 'assistant', calls: [{ id: 'call-1', toolId: 'orders.get', input: { id: 7 } }] },
      { role: 'tool', callId: 'call-1', toolId: 'orders.get', result: { status: 'shipped' } },
      { role: 'assistant', output: { reply: 'Order 7 has shipped.' } },
    ]);
    expect(second.history).toMatchObject({ turns: 1, omittedTurns: 0 });
    const entries = await threads.entries(thread.id);
    expect(entries.map(entry => entry.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect((await threads.get(thread.id))).toMatchObject({ entryCount: 8, lastSequence: 8, activeTurnId: null });
  });

  it('records a failed turn but leaves it out of the next run\'s history', async () => {
    const threads = threadsFor();
    const thread = await threads.create();
    const seen: ModelRequest[] = [];
    const agent = agentWith(scriptedModel([{ type: 'final', output: { wrong: true }, usage: { costMicros: 0 } } as never, request => { seen.push(request); return final('ok'); }]));
    const failed = await (await runInThread({ threads, runtime, agent, threadId: thread.id, input: { message: 'first' } })).done;
    expect(failed.outcome.status).not.toBe('succeeded');
    expect(failed.entries.map(entry => entry.kind)).toEqual(['user', 'run']);
    expect(failed.entries[1]).toMatchObject({ kind: 'run', errorCode: expect.any(String) });
    await (await runInThread({ threads, runtime, agent, threadId: thread.id, input: { message: 'second' } })).done;
    expect('history' in seen[0]!).toBe(false);
  });

  it('runs one turn at a time in a thread, and keeps it held while the run waits', async () => {
    const threads = threadsFor();
    const thread = await threads.create();
    const refund = defineTool({ id: 'orders.refund', version: '1', description: 'Refund', input: z.object({ id: z.number() }), output: z.object({ ok: z.boolean() }),
      effects: 'write', capabilities: [], approval: 'required', execute: () => ({ ok: true }) });
    const agent = agentWith(scriptedModel([{ type: 'tool_calls', calls: [{ id: 'r1', toolId: 'orders.refund', input: { id: 7 } }], usage: { costMicros: 0 } }, final('Refunded.')]), [refund]);
    const turn = await runInThread({ threads, runtime, agent, threadId: thread.id, input: { message: 'Refund order 7' }, leaseMs: 1_000 });
    const asked = await until(turn.run, 'approval.requested');
    expect((await threads.get(thread.id))!.activeTurnId).toBe(turn.turnId);
    await new Promise(done => setTimeout(done, 1_300)); // past the lease: renewals keep it held
    await expect(runInThread({ threads, runtime, agent, threadId: thread.id, input: { message: 'again' } })).rejects.toMatchObject({ code: 'CONFLICT' });
    await runtime.approve(turn.run, { callId: 'r1', digest: asked.metadata['digest'] as string, decision: 'approved', actorId: 'manager-2' });
    const { entries } = await turn.done;
    expect(entries.map(entry => entry.kind)).toEqual(['user', 'tool_calls', 'approval', 'tool_result', 'assistant', 'run']);
    expect(entries[2]).toMatchObject({ kind: 'approval', callId: 'r1', toolId: 'orders.refund', decision: 'approved', actorId: 'manager-2' });
    expect((await threads.get(thread.id))!.activeTurnId).toBeNull();
  });

  it('refuses another agent than the thread\'s, and an archived thread', async () => {
    const threads = threadsFor();
    const fixed = await threads.create({ agentId: 'billing' });
    await expect(runInThread({ threads, runtime, agent: agentWith(scriptedModel([final('x')])), threadId: fixed.id, input: { message: 'hi' } })).rejects.toMatchObject({ code: 'CONFLICT' });
    const archived = await threads.create();
    await threads.archive(archived.id);
    await expect(runInThread({ threads, runtime, agent: agentWith(scriptedModel([final('x')])), threadId: archived.id, input: { message: 'hi' } })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await threads.get(fixed.id))!.activeTurnId).toBeNull();
  });

  it('fits the newest whole turns into the history policy, and says what it left out', async () => {
    const threads = threadsFor();
    const thread = await threads.create();
    const agent = agentWith(scriptedModel(Array.from({ length: 6 }, (_, index) => final(`reply ${index}`))));
    for (let index = 0; index < 5; index++) await (await runInThread({ threads, runtime, agent, threadId: thread.id, input: { message: `message ${index}` } })).done;
    const fitted = await threads.history(thread.id, { maxEntries: 4 });
    expect(fitted).toMatchObject({ turns: 2, omittedTurns: 3 });
    expect(fitted.messages).toEqual([
      { role: 'user', content: { message: 'message 3' } }, { role: 'assistant', output: { reply: 'reply 3' } },
      { role: 'user', content: { message: 'message 4' } }, { role: 'assistant', output: { reply: 'reply 4' } },
    ]);
    await expect(threads.history(thread.id, { maxEntries: 1 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect((await threads.history(thread.id)).turns).toBe(5);
  });

  it('keeps a turn whole when a result is too large to store, and says so', async () => {
    const threads = threadsFor();
    const thread = await threads.create();
    const seen: ModelRequest[] = [];
    const big = lookup(() => ({ text: 'x'.repeat(300_000) }));
    const agent = agentWith(scriptedModel([{ type: 'tool_calls', calls: [{ id: 'big-1', toolId: 'orders.get', input: { id: 1 } }], usage: { costMicros: 0 } }, final('done'),
      request => { seen.push(request); return final('next'); }]), [big]);
    const { entries } = await (await runInThread({ threads, runtime, agent, threadId: thread.id, input: { message: 'big' } })).done;
    expect(entries.find(entry => entry.kind === 'tool_result')).toMatchObject({ result: null, omitted: 'too_large' });
    await (await runInThread({ threads, runtime, agent, threadId: thread.id, input: { message: 'next' } })).done;
    expect(seen[0]!.history?.[2]).toEqual({ role: 'tool', callId: 'big-1', toolId: 'orders.get', result: { omitted: 'too_large' } });
  });

  it('records a turn larger than one append, in order', async () => {
    const threads = threadsFor();
    const thread = await threads.create();
    const batch = (prefix: string): ModelResponse => ({ type: 'tool_calls', calls: Array.from({ length: 35 }, (_, index) => ({ id: `${prefix}-${index}`, toolId: 'orders.get', input: { id: index } })), usage: { costMicros: 0 } });
    const agent = agentWith(scriptedModel([batch('a'), batch('b'), final('done')]), [lookup()]);
    const roomy = createRuntime({ profile: 'ephemeral', scope, permissions: { allow: ['model:scripted', 'tool:orders.get', 'effect:read'] }, limits: { maxToolCalls: 128 } });
    const { entries, outcome } = await (await runInThread({ threads, runtime: roomy, agent, threadId: thread.id, input: { message: 'many' } })).done.finally(() => roomy.close());
    expect(outcome.status).toBe('succeeded');
    expect(entries).toHaveLength(1 + 2 * 36 + 2);
    expect(entries.map(entry => entry.sequence)).toEqual(Array.from({ length: 75 }, (_, index) => index + 1));
    expect(entries[37]).toMatchObject({ kind: 'tool_calls' });
    expect((await threads.history(thread.id)).messages).toHaveLength(75 - 1);
  });

  it('frees the thread when the run cannot start', async () => {
    const threads = threadsFor();
    const thread = await threads.create();
    const noHistory = agentWith(scriptedModel([final('a'), final('b')], { history: false }));
    await (await runInThread({ threads, runtime, agent: noHistory, threadId: thread.id, input: { message: 'one' } })).done;
    // The adapter takes no history, so the second turn cannot start; the thread is not left held.
    await expect(runInThread({ threads, runtime, agent: noHistory, threadId: thread.id, input: { message: 'two' } })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect((await threads.get(thread.id))!.activeTurnId).toBeNull();
  });
});

describe('purgeIdleThreads', () => {
  it('deletes threads idle since before a time, in every scope', async () => {
    const mine = threadsFor(); const theirs = threadsFor(all, { principalId: 'user-7', projectId: 'shop' });
    const old = await mine.create({ id: 'old' }); const other = await theirs.create({ id: 'other' });
    await (await runInThread({ threads: mine, runtime, agent: agentWith(scriptedModel([final('hi')])), threadId: old.id, input: { message: 'hi' } })).done;
    expect(await purgeIdleThreads({ store, idleBefore: Date.now() + 1_000 })).toBe(2);
    expect(await mine.get(old.id)).toMatchObject({ status: 'deleted', entryCount: 0 });
    expect(await theirs.get(other.id)).toMatchObject({ status: 'deleted' });
    expect(await purgeIdleThreads({ store, idleBefore: new Date(0) })).toBe(0);
  });
});

describe('large threads', () => {
  /** A thread of 512 entries, written straight through the store (eight appends of 64). */
  async function bigThread(scopeKey: string, id: string): Promise<void> {
    await store.threads.create({ scope: scopeKey, id, agentId: null, title: null, metadata: {} });
    const lease = { scope: scopeKey, id, runId: 'turn-1', holderId: 'turn-1' };
    await store.threads.acquire({ ...lease, leaseMs: 60_000 });
    for (let page = 0; page < 8; page++) {
      await store.threads.append({ ...lease, expectedSequence: page * 64, entries: Array.from({ length: 64 }, (_, index) => ({ kind: 'user' as const, data: { content: `m${page}-${index}` } })) });
    }
    await store.threads.release(lease);
  }
  it('deletes and purges threads larger than one page of deletion', async () => {
    const key = sha256Hex(`mayura:thread-scope:v1 ${scope.principalId} ${scope.projectId}`);
    await bigThread(key, 'big-1');
    const threads = threadsFor();
    expect((await threads.get('big-1'))!.entryCount).toBe(512);
    expect(await threads.delete('big-1')).toEqual({ removed: 512 });
    expect(await threads.get('big-1')).toMatchObject({ status: 'deleted', entryCount: 0 });
    await bigThread('another-scope', 'big-2');
    expect(await purgeIdleThreads({ store, idleBefore: Date.now() + 1_000 })).toBe(1);
    expect(await store.threads.get({ scope: 'another-scope', id: 'big-2' })).toMatchObject({ status: 'deleted', entryCount: 0 });
  });
});

describe('options', () => {
  it('refuses a store without threads, unbounded scopes and bad input', async () => {
    expect(() => createThreads({ store: {} as never, scope, permissions: all })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => createThreads({ store, scope: { principalId: '', projectId: 'p' }, permissions: all })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => createThreads({ store, scope, permissions: {} as never })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    const threads = threadsFor();
    await expect(threads.get('bad id!')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(threads.list({ limit: 1_000 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(runInThread({ threads: {} as never, runtime, agent: agentWith(scriptedModel([])), threadId: 't', input: { message: 'x' } })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    vi.restoreAllMocks();
  });
});
