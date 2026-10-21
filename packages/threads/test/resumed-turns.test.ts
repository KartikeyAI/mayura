import { createAuthorizer } from '@mayura/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { createRuntime, defineAgent, type Runtime, type RunRecording } from '@mayura/runtime';
import { defineTool } from '@mayura/tools';
import { scriptedModel } from '@mayura/testing';
import type { ModelResponse, RunHandle, RunEvent } from '@mayura/core';
import { createThreads, runInThread, type Threads } from '../src/index.js';

const scope = { principalId: 'user-42', projectId: 'shop' };
const permissions = { allow: ['thread:read', 'thread:write', 'thread:delete'] };
const grants = { allow: ['model:scripted', 'tool:refund', 'effect:write'] };
let directory: string;
let store: ReturnType<typeof createSqliteStore>;
const runtimes: Runtime[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mayura-resumed-turns-'));
  store = createSqliteStore({ filename: join(directory, 'threads.sqlite') }); store = { ...store, threads: { ...store.threads }, runCheckpoints: { ...store.runCheckpoints } };
  await store.initialize(); await store.threads.initialize();
});
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.close()));
  await store.close(); await rm(directory, { recursive: true, force: true });
});
const final = (reply: string): ModelResponse => ({ type: 'final', output: { reply }, usage: { costMicros: 0 } });
function agentWith(tools: readonly ReturnType<typeof defineTool>[] = [], steps = [final('ok')]) {
  return defineAgent({ id: 'support', version: '1', instructions: 'Help.', input: z.object({ message: z.string() }),
    output: z.object({ reply: z.string() }), model: scriptedModel(steps), tools });
}
function engine(threads: Threads, agents: readonly ReturnType<typeof agentWith>[] = [], extra = {}) {
  const runtime = createRuntime({ profile: 'ephemeral', scope, permissions: grants, recorder: threads.recorder,
    checkpoints: { store: store.runCheckpoints, agents }, ...extra });
  runtimes.push(runtime); return runtime;
}
async function event(run: RunHandle<unknown>, type: RunEvent['type']) {
  for await (const value of run.observe()) if (value.type === type) return value;
  throw new Error(`Missing ${type}`);
}
function refund() {
  const execute = vi.fn(() => ({ refunded: true }));
  const tool = defineTool({ id: 'refund', version: '1', description: 'Refund.', input: z.object({}), output: z.object({ refunded: z.boolean() }),
    effects: 'write', capabilities: [], approval: 'required', execute });
  const agent = agentWith([tool], [{ type: 'tool_calls', calls: [{ id: 'c1', toolId: tool.id, input: {} }], usage: { costMicros: 0 } }, final('Refunded')]);
  return { agent, execute };
}

describe('durable thread/run associations', () => {
  it('records a resumed turn once after reopening storage, including its approval and history', async () => {
    let threads = createThreads({ store, scope, permissions });
    const thread = await threads.create(); const { agent, execute } = refund();
    const first = engine(threads, [agent]);
    const turn = await runInThread({ threads, runtime: first, agent, threadId: thread.id, input: { message: 'Refund' }, leaseMs: 1000 });
    const approval = await event(turn.run, 'approval.requested'); await event(turn.run, 'run.paused');
    const checkpoint = await store.runCheckpoints.get({ runId: turn.run.id });
    expect(checkpoint!.body['recording']).toEqual({ threadId: thread.id, turnId: turn.turnId, startSequence: 0 });
    await first.close(); await store.close();
    store = createSqliteStore({ filename: join(directory, 'threads.sqlite') }); store = { ...store, threads: { ...store.threads }, runCheckpoints: { ...store.runCheckpoints } };
    await store.initialize(); await store.threads.initialize();
    threads = createThreads({ store, scope, permissions });
    const resumed = engine(threads, [agent]);
    const handle = await resumed.approve(turn.run.id, { callId: 'c1', digest: String(approval.metadata['digest']), decision: 'approved', actorId: 'manager' });
    const outcome = await handle.result();
    expect(outcome).toEqual({ status: 'succeeded', output: { reply: 'Refunded' } });
    expect(execute).toHaveBeenCalledTimes(1);
    const entries = await threads.entries(thread.id);
    expect(entries.filter(entry => entry.kind === 'run' && entry.status === 'succeeded')).toHaveLength(1);
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'approval', decision: 'approved', actorId: 'manager' }));
    expect((await threads.history(thread.id)).turns).toBe(1);
    const completion: RunRecording = { runId: handle.id, scope, binding: checkpoint!.body['recording'] as RunRecording['binding'],
      messages: resumed.transcript(handle), approvals: [{ callId: 'c1', toolId: 'refund', decision: 'approved', actorId: 'manager' }], outcome };
    await Promise.all([threads.recorder.complete(completion), threads.recorder.complete(completion)]);
    expect(await threads.entries(thread.id)).toEqual(entries);
    expect((await threads.get(thread.id))!.activeTurnId).toBeNull();
    await expect(resumed.approve(turn.run.id, { callId: 'c1', digest: String(approval.metadata['digest']), decision: 'approved', actorId: 'manager' })).rejects.toBeDefined();
  });

  it('retains earlier approval decisions through a second checkpoint on another runtime', async () => {
    const threads = createThreads({ store, scope, permissions }); const { agent: original, execute } = refund();
    const agent = agentWith(original.tools, [{ type: 'tool_calls', calls: [
      { id: 'c1', toolId: 'refund', input: {} }, { id: 'c2', toolId: 'refund', input: {} },
    ], usage: { costMicros: 0 } }, final('Both refunded')]);
    const thread = await threads.create(); const first = engine(threads, [agent]);
    const turn = await runInThread({ threads, runtime: first, agent, threadId: thread.id, input: { message: 'Refund both' } });
    const approval = await event(turn.run, 'approval.requested'); await event(turn.run, 'run.paused'); await first.close();
    const second = engine(threads, [agent]);
    const run = await second.approve(turn.run.id, { callId: 'c1', digest: String(approval.metadata['digest']), decision: 'approved', actorId: 'first-manager' });
    const next = await event(run, 'approval.requested'); await event(run, 'run.paused'); await second.close();
    const third = engine(threads, [agent]);
    const resumed = await third.approve(run.id, { callId: 'c2', digest: String(next.metadata['digest']), decision: 'approved', actorId: 'second-manager' });
    expect((await resumed.result()).status).toBe('succeeded'); expect(execute).toHaveBeenCalledTimes(2);
    const entries = await threads.entries(thread.id);
    expect(entries.filter(entry => entry.kind === 'approval').map(entry => entry.kind === 'approval' ? entry.actorId : null)).toEqual(['first-manager', 'second-manager']);
    expect((await threads.history(thread.id)).turns).toBe(1);
  });

  it('records cancellation on expiry after the owning runtime has stopped', async () => {
    const threads = createThreads({ store, scope, permissions }); const { agent, execute } = refund();
    const thread = await threads.create();
    const first = engine(threads, [agent], { approvals: { expiresInMs: 1000, onExpired: 'cancel' } });
    const turn = await runInThread({ threads, runtime: first, agent, threadId: thread.id, input: { message: 'Refund' } });
    await event(turn.run, 'run.paused'); await first.close();
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(await engine(threads, [agent]).expireApprovals()).toBe(1);
    expect((await threads.entries(thread.id)).filter(entry => entry.kind === 'run' && entry.status === 'cancelled')).toHaveLength(1);
    expect((await threads.get(thread.id))!.activeTurnId).toBeNull(); expect(execute).not.toHaveBeenCalled();
  });

  it('records a definition-change failure after a restart without calling the changed agent', async () => {
    const threads = createThreads({ store, scope, permissions }); const { agent, execute } = refund();
    const thread = await threads.create(); const first = engine(threads, [agent]);
    const turn = await runInThread({ threads, runtime: first, agent, threadId: thread.id, input: { message: 'Refund' } });
    const approval = await event(turn.run, 'approval.requested'); await event(turn.run, 'run.paused'); await first.close();
    const changed = defineAgent({ id: 'support', version: '2', instructions: 'Changed.', input: z.object({ message: z.string() }),
      output: z.object({ reply: z.string() }), tools: agent.tools, model: scriptedModel([final('Never')]) });
    await expect(engine(threads, [changed]).approve(turn.run.id, { callId: 'c1', digest: String(approval.metadata['digest']), decision: 'approved', actorId: 'manager' })).rejects.toMatchObject({ code: 'DEFINITION_CHANGED' });
    expect((await threads.entries(thread.id)).filter(entry => entry.kind === 'run' && entry.status === 'failed')).toHaveLength(1);
    expect((await threads.get(thread.id))!.activeTurnId).toBeNull(); expect(execute).not.toHaveBeenCalled();
  });

  it('does not let an expired lease admit a second turn while a persisted run waits', async () => {
    const threads = createThreads({ store, scope, permissions }); const { agent } = refund();
    const runtime = engine(threads, [agent]); const thread = await threads.create();
    const turn = await runInThread({ threads, runtime, agent, threadId: thread.id, input: { message: 'Refund' }, leaseMs: 1000 });
    await event(turn.run, 'run.paused'); await runtime.close();
    await new Promise(resolve => setTimeout(resolve, 1100));
    await expect(runInThread({ threads, runtime: engine(threads), agent: agentWith(), threadId: thread.id, input: { message: 'Other' } })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses a resume without a recorder and leaves the checkpoint intact', async () => {
    const threads = createThreads({ store, scope, permissions }); const { agent, execute } = refund();
    const runtime = engine(threads, [agent]); const thread = await threads.create();
    const turn = await runInThread({ threads, runtime, agent, threadId: thread.id, input: { message: 'Refund' } });
    const approval = await event(turn.run, 'approval.requested'); await event(turn.run, 'run.paused'); await runtime.close();
    const missing = createRuntime({ profile: 'ephemeral', scope, permissions: grants, checkpoints: { store: store.runCheckpoints, agents: [agent] } });
    runtimes.push(missing);
    await expect(missing.approve(turn.run.id, { callId: 'c1', digest: String(approval.metadata['digest']), decision: 'approved', actorId: 'manager' })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(await store.runCheckpoints.get({ runId: turn.run.id })).toMatchObject({ status: 'waiting' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('tolerates committed appends whose replies are lost without duplicating entries', async () => {
    let lost = 0;
    const wrapped = { threads: { ...store.threads, append: async (...args: Parameters<typeof store.threads.append>) => {
      await store.threads.append(...args); lost++; throw new Error('private transport failure');
    } } };
    const threads = createThreads({ store: wrapped, scope, permissions }); const runtime = engine(threads); const thread = await threads.create();
    const turn = await runInThread({ threads, runtime, agent: agentWith(), threadId: thread.id, input: { message: 'Hello' } });
    expect((await turn.done).outcome.status).toBe('succeeded');
    expect(lost).toBe(2);
    expect((await threads.entries(thread.id)).filter(entry => entry.kind === 'user')).toHaveLength(1);
    expect((await threads.history(thread.id)).messages).toHaveLength(2);
  });

  it('recovers a partial completion after reopening storage without re-execution or duplicate chunks', async () => {
    let fail = true; let writes = 0;
    const wrapped = { threads: { ...store.threads, append: async (command: Parameters<typeof store.threads.append>[0]) => {
      writes++;
      if (writes === 3 && fail) throw new Error('private recording failure');
      return store.threads.append(command);
    } } };
    const threads = createThreads({ store: wrapped, scope, permissions }); const runtime = engine(threads, [], { limits: { maxToolCalls: 100 } }); const thread = await threads.create();
    const execute = vi.fn(() => ({ refunded: true }));
    const tool = defineTool({ id: 'refund', version: '1', description: 'Test.', input: z.object({}), output: z.object({ refunded: z.boolean() }), effects: 'write', capabilities: [], execute });
    const agent = agentWith([tool], [{ type: 'tool_calls', calls: Array.from({ length: 80 }, (_, index) => ({ id: `c${index}`, toolId: tool.id, input: {} })), usage: { costMicros: 0 } }, final('Done')]);
    const turn = await runInThread({ threads, runtime, agent, threadId: thread.id, input: { message: 'Go' } });
    expect((await turn.done).outcome).toMatchObject({ status: 'failed', error: { code: 'STORAGE_UNAVAILABLE' } });
    expect(execute).toHaveBeenCalledTimes(80);
    fail = false;
    await runtime.close(); await store.close();
    store = createSqliteStore({ filename: join(directory, 'threads.sqlite') }); store = { ...store, threads: { ...store.threads }, runCheckpoints: { ...store.runCheckpoints } };
    await store.initialize(); await store.threads.initialize();
    const recovered = createThreads({ store, scope, permissions });
    await Promise.all([recovered.recoverRun(thread.id, turn.run.id), recovered.recoverRun(thread.id, turn.run.id)]);
    expect(await recovered.recoverRun(thread.id, turn.run.id)).toBe(false);
    const entries = await recovered.entries(thread.id);
    expect(entries.filter(entry => entry.kind === 'tool_result')).toHaveLength(80);
    expect(entries.filter(entry => entry.kind === 'run' && entry.status === 'succeeded')).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(80);
    expect((await recovered.history(thread.id)).turns).toBe(1);
    expect((await recovered.get(thread.id))!.activeTurnId).toBeNull();
  });

  it('checks scope and permissions before persisting an association or executing a model', async () => {
    const threads = createThreads({ store, scope, permissions }); const thread = await threads.create();
    const runtime = engine(threads, [], { scope: { principalId: 'other', projectId: 'shop' } });
    const turn = await runInThread({ threads, runtime, agent: agentWith(), threadId: thread.id, input: { message: 'Hello' } });
    expect((await turn.done).outcome).toMatchObject({ status: 'failed', error: { code: 'NOT_FOUND' } });
    expect(await threads.entries(thread.id)).toEqual([]);
    const denied = createThreads({ store, scope, permissions: { allow: [] } });
    await expect(denied.recorder.begin({ runId: 'r1', scope, binding: { threadId: thread.id, turnId: 't1', startSequence: 0 } })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('records cancellation and never recreates a deleted thread when a paused run resumes', async () => {
    const threads = createThreads({ store, scope, permissions }); const { agent, execute } = refund(); const runtime = engine(threads, [agent]);
    const thread = await threads.create();
    const turn = await runInThread({ threads, runtime, agent, threadId: thread.id, input: { message: 'Refund' } });
    await event(turn.run, 'run.paused'); turn.run.cancel();
    expect((await turn.done).outcome.status).toBe('cancelled');
    expect((await threads.entries(thread.id)).filter(entry => entry.kind === 'run' && entry.status === 'cancelled')).toHaveLength(1);
    const second = await runInThread({ threads, runtime, agent: agentWith(), threadId: thread.id, input: { message: 'Again' } });
    await second.done;
    await threads.delete(thread.id);
    expect((await threads.get(thread.id))!.status).toBe('deleted'); expect(execute).not.toHaveBeenCalled();
    const another = await threads.create(); const next = refund(); const owner = engine(threads, [next.agent]);
    const pending = await runInThread({ threads, runtime: owner, agent: next.agent, threadId: another.id, input: { message: 'Refund' } });
    const approval = await event(pending.run, 'approval.requested'); await event(pending.run, 'run.paused');
    await owner.close(); await threads.delete(another.id);
    await expect(engine(threads, [next.agent]).approve(pending.run.id, { callId: 'c1', digest: String(approval.metadata['digest']), decision: 'approved', actorId: 'manager' })).rejects.toBeDefined();
    expect(next.execute).not.toHaveBeenCalled(); expect(await threads.entries(another.id)).toEqual([]);
  });
});


it('leaves a thread-bound saved approval unclaimed when thread approval policy is revoked', async () => {
  let denied = false;
  const authorization = createAuthorizer({ permissions: { allow: ['authz:evaluate'] }, policy: { version: 'v1', authorize: request =>
    denied && request.resource.kind === 'thread' && request.action === 'approve'
      ? { effect: 'deny', reason: 'explicit_deny', policyVersion: 'v1', ruleId: null }
      : { effect: 'allow', reason: 'allowed', policyVersion: 'v1', ruleId: null } } });
  try {
    const threads = createThreads({ store, scope, permissions, authorization }); const thread = await threads.create();
    const { agent, execute } = refund(); const first = engine(threads, [agent], { authorization });
    const turn = await runInThread({ threads, runtime: first, agent, threadId: thread.id, input: { message: 'Refund' } });
    const approval = await event(turn.run, 'approval.requested'); await event(turn.run, 'run.paused'); await first.close();
    const restarted = engine(threads, [agent], { authorization });
    const before = await threads.entries(thread.id); const claim = vi.spyOn(store.runCheckpoints, 'claim'); denied = true;
    const answer = { callId: 'c1', digest: String(approval.metadata['digest']), decision: 'approved' as const, actorId: 'manager' };
    await expect(restarted.approve(turn.run.id, answer)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(claim).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    expect((await store.runCheckpoints.get({ runId: turn.run.id }))?.status).toBe('waiting');
    expect(await threads.entries(thread.id)).toEqual(before);
    denied = false; const resumed = await restarted.approve(turn.run.id, answer);
    expect(await resumed.result()).toMatchObject({ status: 'succeeded' }); expect(execute).toHaveBeenCalledTimes(1);
    expect((await threads.entries(thread.id)).filter(entry => entry.kind === 'run' && entry.status === 'succeeded')).toHaveLength(1);
  } finally { authorization.close(); }
});
