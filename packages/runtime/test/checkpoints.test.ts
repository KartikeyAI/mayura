import { createAuthorizer } from '@mayura/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { defineTool } from '@mayura/tools';
import { scriptedModel } from '@mayura/testing';
import { createSqliteStore } from '@mayura/storage-sqlite';
import type { ModelAdapter, ModelRequest, ModelResponse, RunEvent, RunHandle } from '@mayura/core';
import { createRuntime, defineAgent, defineHook, type RunCheckpointPort, type Runtime, type RuntimeOptions } from '../src/index.js';

type Store = ReturnType<typeof createSqliteStore>;
let directory: string; let store: Store; const runtimes: Runtime[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mayura-checkpoints-'));
  store = createSqliteStore({ filename: join(directory, 'runs.sqlite') }); store = { ...store, threads: { ...store.threads }, runCheckpoints: { ...store.runCheckpoints } };
  await store.initialize(); await store.runCheckpoints.initialize();
});
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  await store.close();
  const target = resolve(directory);
  if (target.startsWith(`${resolve(tmpdir())}${sep}mayura-checkpoints-`)) await rm(target, { recursive: true, force: true });
});

const scope = { principalId: 'support-team', projectId: 'shop' };
function refundTool(execute = vi.fn((input: { amount: number }) => ({ refunded: input.amount }))) {
  const tool = defineTool({ id: 'orders.refund', version: '3', description: 'Refund an order', input: z.object({ order: z.number(), amount: z.number() }),
    output: z.object({ refunded: z.number() }), effects: 'write', capabilities: [], costMicros: 5, approval: 'required', execute });
  return { tool, execute };
}
const call = (id: string, amount: number, toolId = 'orders.refund') => ({ type: 'tool_calls' as const, calls: [{ id, toolId, input: { order: 7, amount } }], usage: { costMicros: 3 } });
/** A scripted model that may cost what these responses report. */
const priced = (steps: Parameters<typeof scriptedModel>[0]) => scriptedModel(steps, { maxCostMicros: 3 });
const done = (reply: string) => ({ type: 'final' as const, output: { reply }, usage: { costMicros: 3 } });
const agentWith = (model: ModelAdapter, tools: readonly ReturnType<typeof defineTool>[], instructions = 'Handle refunds.') =>
  defineAgent({ id: 'support', version: '1', instructions, tools, model, input: z.object({ question: z.string() }), output: z.object({ reply: z.string() }) });
const grants = ['model:scripted', 'tool:orders.refund', 'effect:write'];
function runtime(options: Partial<Omit<RuntimeOptions, 'profile'>> & { agents?: Parameters<typeof defineAgent>[0][] | ReturnType<typeof defineAgent>[]; checkpointStore?: RunCheckpointPort } = {}): Runtime {
  const { agents, checkpointStore, ...rest } = options;
  const created = createRuntime({ profile: 'ephemeral', scope, permissions: { allow: grants }, limits: { maxCostMicros: 100 },
    checkpoints: { store: checkpointStore ?? store.runCheckpoints, ...(agents ? { agents: agents as never } : {}) }, ...rest });
  runtimes.push(created); return created;
}
async function until(run: RunHandle<unknown>, type: RunEvent['type']): Promise<RunEvent> {
  for await (const event of run.observe()) if (event.type === type) return event;
  throw new Error(`The run ended without ${type}: ${JSON.stringify(await run.result())}`);
}
const typesOf = async (run: RunHandle<unknown>) => { const types: string[] = []; for await (const event of run.observe()) types.push(event.type); return types; };
const resultFor = (request: ModelRequest, callId: string) =>
  (request.messages.find(message => message.role === 'tool' && message.callId === callId) as { result: unknown } | undefined)?.result;

describe('runs paused to a checkpoint store', () => {
  it('saves the run and lets go of it: no slot held, the call shown, the store holding it', async () => {
    const { tool, execute } = refundTool();
    const model = priced([call('c1', 40), done('ok')]);
    const engine = runtime({ limits: { maxCostMicros: 100, maxConcurrentRuns: 1 } });
    const run = engine.submit(agentWith(model, [tool]), { input: { question: 'Refund order 7' } });
    const paused = await until(run, 'run.paused');
    expect(paused.metadata).toEqual({ callId: 'c1' });
    const view = engine.inspect(run);
    expect(view.status).toBe('waiting');
    expect(view.approval).toMatchObject({ callId: 'c1', toolId: 'orders.refund', toolVersion: '3', input: { order: 7, amount: 40 } });
    expect(view.budget).toMatchObject({ spentMicros: 3, reservedMicros: 0 });
    const saved = await store.runCheckpoints.get({ runId: run.id });
    expect(saved).toMatchObject({ status: 'waiting', expiresAtMs: view.approval!.expiresAtMs });
    expect(saved!.scope).toMatch(/^[0-9a-f]{64}$/u);
    // The key is a digest of the scope; the body keeps the scope itself, and the run's input, to check and continue it.
    expect(saved!.body).toMatchObject({ scope, input: { question: 'Refund order 7' }, pending: { callId: 'c1' } });
    // A paused run holds no concurrency slot: another run starts.
    const other = engine.submit(agentWith(priced([done('other')]), []), { input: { question: 'Hi' } });
    expect((await other.result()).status).toBe('succeeded');
    expect(execute).not.toHaveBeenCalled();
  });

  it('resumes in place when this process answers: the same handle, the call run once, the checkpoint gone', async () => {
    const { tool, execute } = refundTool();
    const seen: ModelRequest[] = [];
    const model = priced([call('c1', 40), request => { seen.push(request); return done('Refunded.'); }]);
    const engine = runtime();
    const run = engine.submit(agentWith(model, [tool]), { input: { question: 'Refund' } });
    const { metadata } = await until(run, 'approval.requested');
    await until(run, 'run.paused');
    const resumed = await engine.approve(run, { callId: 'c1', digest: metadata['digest'] as string, decision: 'approved', actorId: 'manager-2' });
    expect(resumed).toBe(run);
    expect(await run.result()).toEqual({ status: 'succeeded', output: { reply: 'Refunded.' } });
    expect(execute).toHaveBeenCalledOnce();
    expect(resultFor(seen[0]!, 'c1')).toEqual({ refunded: 40 });
    expect(await store.runCheckpoints.get({ runId: run.id })).toBeUndefined();
    const types = await typesOf(run);
    expect(types.filter(type => type.startsWith('run.') || type.startsWith('approval.') || type.startsWith('tool.')))
      .toEqual(['run.started', 'approval.requested', 'run.paused', 'run.resumed', 'approval.resolved', 'tool.started', 'tool.completed', 'run.completed']);
    expect(engine.inspect(run).budget).toMatchObject({ spentMicros: 11, reservedMicros: 0 });
  });

  it('resumes in another runtime after a restart, with the conversation, budget and permissions it had', async () => {
    const { tool, execute } = refundTool();
    const seen: ModelRequest[] = [];
    const model = priced([call('c1', 40), request => { seen.push(request); return done('Refunded.'); }]);
    const agent = agentWith(model, [tool]);
    const first = runtime();
    const run = first.submit(agent, { input: { question: 'Refund order 7' }, history: [{ role: 'user', content: 'earlier' }, { role: 'assistant', output: { reply: 'before' } }] });
    const digest = (await until(run, 'approval.requested')).metadata['digest'] as string;
    await until(run, 'run.paused');
    await first.close(); // the process goes away; the run stays saved

    const second = runtime({ agents: [agent] });
    const resumed = await second.approve(run.id, { callId: 'c1', digest, decision: 'approved', actorId: 'manager-2' });
    expect(resumed.id).toBe(run.id);
    expect(await resumed.result()).toEqual({ status: 'succeeded', output: { reply: 'Refunded.' } });
    expect(execute).toHaveBeenCalledOnce();
    // The model saw the whole conversation again: history, the input, its call and the result.
    expect(seen[0]!.history).toEqual([{ role: 'user', content: 'earlier' }, { role: 'assistant', output: { reply: 'before' } }]);
    expect(seen[0]!.messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool']);
    expect(seen[0]!.messages[0]).toEqual({ role: 'user', content: { question: 'Refund order 7' } });
    // What it spent before the pause counts: 3 + 5 + 3.
    expect(second.inspect(resumed).budget).toMatchObject({ spentMicros: 11, reservedMicros: 0 });
    const types = await typesOf(resumed);
    expect(types[0]).toBe('run.resumed');
    expect(await store.runCheckpoints.get({ runId: run.id })).toBeUndefined();
  });

  it('tells the model of a rejection given in another runtime', async () => {
    const { tool, execute } = refundTool();
    const seen: ModelRequest[] = [];
    const model = priced([call('c1', 4_000), request => { seen.push(request); return done('Not refunded.'); }]);
    const agent = agentWith(model, [tool]);
    const first = runtime();
    const run = first.submit(agent, { input: { question: 'Refund' } });
    const digest = (await until(run, 'approval.requested')).metadata['digest'] as string;
    await until(run, 'run.paused');
    const resumed = await runtime({ agents: [agent] }).approve(run.id, { callId: 'c1', digest, decision: 'rejected', actorId: 'm', reason: 'Too much.' });
    expect((await resumed.result()).status).toBe('succeeded');
    expect(execute).not.toHaveBeenCalled();
    expect(resultFor(seen[0]!, 'c1')).toMatchObject({ error: 'APPROVAL_REJECTED', reason: 'Too much.' });
  });

  it('refuses to resume when the agent changed while the run waited, and ends the run', async () => {
    const { tool, execute } = refundTool();
    const model = priced([call('c1', 40), done('never')]);
    const run = runtime().submit(agentWith(model, [tool]), { input: { question: 'Refund' } });
    const digest = (await until(run, 'approval.requested')).metadata['digest'] as string;
    await until(run, 'run.paused');
    const changed = agentWith(model, [tool], 'Handle refunds generously.');
    await expect(runtime({ agents: [changed] }).approve(run.id, { callId: 'c1', digest, decision: 'approved', actorId: 'm' }))
      .rejects.toMatchObject({ code: 'DEFINITION_CHANGED' });
    expect(execute).not.toHaveBeenCalled();
    expect(await store.runCheckpoints.get({ runId: run.id })).toBeUndefined();
  });

  it('refuses a runtime that does not know the agent, or serves another scope, and leaves the run waiting', async () => {
    const { tool } = refundTool();
    const run = runtime().submit(agentWith(priced([call('c1', 40), done('ok')]), [tool]), { input: { question: 'Refund' } });
    const digest = (await until(run, 'approval.requested')).metadata['digest'] as string;
    await until(run, 'run.paused');
    const answer = { callId: 'c1', digest, decision: 'approved' as const, actorId: 'm' };
    await expect(runtime().approve(run.id, answer)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const stranger = createRuntime({ profile: 'ephemeral', scope: { principalId: 'someone-else', projectId: 'shop' }, permissions: { allow: grants },
      checkpoints: { store: store.runCheckpoints, agents: [agentWith(priced([]), [tool])] } });
    runtimes.push(stranger);
    await expect(stranger.approve(run.id, answer)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(runtime().approve(run.id, { ...answer, digest: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(runtime({ agents: [agentWith(priced([]), [tool])] }).approve(run.id, { ...answer, callId: 'c2' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await store.runCheckpoints.get({ runId: run.id })).toMatchObject({ status: 'waiting' });
  });

  it('lets only one of two runtimes resume a run, so the call runs once', async () => {
    const { tool, execute } = refundTool();
    const model = priced([call('c1', 40), done('ok'), done('ok')]);
    const agent = agentWith(model, [tool]);
    const first = runtime();
    const run = first.submit(agent, { input: { question: 'Refund' } });
    const digest = (await until(run, 'approval.requested')).metadata['digest'] as string;
    await until(run, 'run.paused');
    await first.close();
    const answer = { callId: 'c1', digest, decision: 'approved' as const, actorId: 'm' };
    const results = await Promise.allSettled([runtime({ agents: [agent] }).approve(run.id, answer), runtime({ agents: [agent] }).approve(run.id, answer)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'CONFLICT' } });
    await (results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<RunHandle<unknown>>).value.result();
    expect(execute).toHaveBeenCalledOnce();
  });

  it('runs nothing when it cannot remove the checkpoint before the call', async () => {
    const { tool, execute } = refundTool();
    const model = priced([call('c1', 40), done('never')]);
    const failingDelete: RunCheckpointPort = { ...bound(store.runCheckpoints), delete: async () => false };
    const engine = runtime({ checkpointStore: failingDelete });
    const run = engine.submit(agentWith(model, [tool]), { input: { question: 'Refund' } });
    const digest = (await until(run, 'approval.requested')).metadata['digest'] as string;
    await until(run, 'run.paused');
    await engine.approve(run, { callId: 'c1', digest, decision: 'approved', actorId: 'm' });
    expect(await run.result()).toMatchObject({ status: 'failed', error: { code: 'CONFLICT' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('waits in memory when the store cannot save the run', async () => {
    const { tool, execute } = refundTool();
    const model = priced([call('c1', 40), done('ok')]);
    const failingPut: RunCheckpointPort = { ...bound(store.runCheckpoints), put: async () => { throw new Error('store down'); } };
    const engine = runtime({ checkpointStore: failingPut });
    const run = engine.submit(agentWith(model, [tool]), { input: { question: 'Refund' } });
    const digest = (await until(run, 'approval.requested')).metadata['digest'] as string;
    expect(engine.inspect(run).status).toBe('waiting');
    await engine.approve(run, { callId: 'c1', digest, decision: 'approved', actorId: 'm' });
    expect((await run.result()).status).toBe('succeeded');
    expect(execute).toHaveBeenCalledOnce();
    expect(await typesOf(run)).not.toContain('run.paused');
  });

  it('lets the host own expiry and returns the resumed handle for event persistence', async () => {
    // SQLite persistence may exceed the approval window on a busy runner. Control
    // the expiry clock while retaining real timers and the real checkpoint store.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { tool, execute } = refundTool(); const agent = agentWith(priced([call('c1', 40), done('expired')]), [tool]);
      const engine = runtime({ approvals: { expiresInMs: 30 }, checkpoints: { store: store.runCheckpoints, agents: [agent], autoExpire: false } });
      const run = engine.submit(agent, { input: { question: 'Refund' } }); await until(run, 'run.paused');
      const expiresAtMs = engine.inspect(run).approval!.expiresAtMs;
      vi.setSystemTime(expiresAtMs - 1);
      expect(await engine.expireApproval(run.id)).toEqual({ status: 'not_due' });
      vi.setSystemTime(expiresAtMs);
      expect(engine.inspect(run).status).toBe('waiting');
      const result = await engine.expireApproval(run.id); expect(result.status).toBe('resumed');
      if (result.status !== 'resumed') throw new Error('Missing resumed handle');
      expect(result.run).toBe(run); expect((await result.run.result()).status).toBe('succeeded');
      expect(execute).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('continues an expired request as its policy says while the process lives', async () => {
    const { tool, execute } = refundTool();
    const seen: ModelRequest[] = [];
    const model = priced([call('c1', 40), request => { seen.push(request); return done('Expired.'); }]);
    const engine = runtime({ approvals: { expiresInMs: 50 } });
    const run = engine.submit(agentWith(model, [tool]), { input: { question: 'Refund' } });
    expect((await run.result()).status).toBe('succeeded');
    expect(execute).not.toHaveBeenCalled();
    expect(resultFor(seen[0]!, 'c1')).toMatchObject({ error: 'APPROVAL_EXPIRED' });
    expect(await store.runCheckpoints.get({ runId: run.id })).toBeUndefined();

    const cancelling = runtime({ approvals: { expiresInMs: 50, onExpired: 'cancel' } });
    const second = cancelling.submit(agentWith(priced([call('c2', 40), done('never')]), [tool]), { input: { question: 'Refund' } });
    expect(await second.result()).toMatchObject({ status: 'cancelled' });
    expect(await store.runCheckpoints.get({ runId: second.id })).toBeUndefined();
  });

  it('expires a paused run even when its timer fires before the clock says so', async () => {
    const { tool } = refundTool();
    const seen: ModelRequest[] = [];
    const engine = runtime({ approvals: { expiresInMs: 50 } });
    const run = engine.submit(agentWith(priced([call('c1', 40), request => { seen.push(request); return done('Expired.'); }]), [tool]), { input: { question: 'Refund' } });
    await until(run, 'run.paused');
    // The clock reads a second behind while the timer fires: the request is not expired yet by that clock.
    vi.useFakeTimers({ toFake: ['Date'] });
    try { vi.setSystemTime(Date.now() - 1_000); await new Promise(resolve => setTimeout(resolve, 120)); }
    finally { vi.useRealTimers(); }
    expect(engine.inspect(run).status).toBe('waiting');
    expect((await run.result()).status).toBe('succeeded');
    expect(resultFor(seen[0]!, 'c1')).toMatchObject({ error: 'APPROVAL_EXPIRED' });
  });

  it('lets another runtime expire runs whose process went away', async () => {
    const { tool, execute } = refundTool();
    const seen: ModelRequest[] = [];
    const model = priced([call('c1', 40), request => { seen.push(request); return done('Expired.'); }]);
    const agent = agentWith(model, [tool]);
    const first = runtime({ approvals: { expiresInMs: 50 } });
    const run = first.submit(agent, { input: { question: 'Refund' } });
    await until(run, 'run.paused');
    await first.close();
    await new Promise(done => setTimeout(done, 80));
    const second = runtime({ agents: [agent] });
    expect(await second.expireApprovals()).toBe(1);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(resultFor(seen[0]!, 'c1')).toMatchObject({ error: 'APPROVAL_EXPIRED' });
    expect(execute).not.toHaveBeenCalled();
    expect(await second.expireApprovals()).toBe(0);
  });

  it('leaves a run waiting that the store lists as due before it expired', async () => {
    const { tool, execute } = refundTool();
    const agent = agentWith(priced([call('c1', 40), done('never')]), [tool]);
    const first = runtime();
    const run = first.submit(agent, { input: { question: 'Refund' } });
    await until(run, 'run.paused');
    await first.close();
    // Another machine's clock runs ahead: its store says the request is due, but it is not.
    const early: RunCheckpointPort = { ...bound(store.runCheckpoints), due: async () => [run.id] };
    expect(await runtime({ agents: [agent], checkpointStore: early }).expireApprovals()).toBe(0);
    expect(await store.runCheckpoints.get({ runId: run.id })).toMatchObject({ status: 'waiting' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('cancels a paused run: its checkpoint is removed and nobody can resume it', async () => {
    const { tool, execute } = refundTool();
    const engine = runtime();
    const run = engine.submit(agentWith(priced([call('c1', 40), done('never')]), [tool]), { input: { question: 'Refund' } });
    const digest = (await until(run, 'approval.requested')).metadata['digest'] as string;
    await until(run, 'run.paused');
    run.cancel();
    expect((await run.result()).status).toBe('cancelled');
    expect(await store.runCheckpoints.get({ runId: run.id })).toBeUndefined();
    await expect(engine.approve(run, { callId: 'c1', digest, decision: 'approved', actorId: 'm' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('never widens a resumed run: a runtime without the grant blocks the approved call', async () => {
    const { tool, execute } = refundTool();
    const agent = agentWith(priced([call('c1', 40), done('never')]), [tool]);
    const first = runtime();
    const run = first.submit(agent, { input: { question: 'Refund' } });
    const digest = (await until(run, 'approval.requested')).metadata['digest'] as string;
    await until(run, 'run.paused');
    await first.close();
    const narrow = runtime({ agents: [agent], permissions: { allow: ['model:scripted', 'tool:orders.refund'] } });
    const resumed = await narrow.approve(run.id, { callId: 'c1', digest, decision: 'approved', actorId: 'm' });
    expect(await resumed.result()).toMatchObject({ status: 'blocked', error: { code: 'PERMISSION_DENIED' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not count the wait against maxDurationMs', async () => {
    const { tool, execute } = refundTool();
    const engine = runtime({ limits: { maxCostMicros: 100, maxDurationMs: 150 } });
    const run = engine.submit(agentWith(priced([call('c1', 40), done('ok')]), [tool]), { input: { question: 'Refund' } });
    const digest = (await until(run, 'approval.requested')).metadata['digest'] as string;
    await until(run, 'run.paused');
    await new Promise(done => setTimeout(done, 300));
    await engine.approve(run, { callId: 'c1', digest, decision: 'approved', actorId: 'm' });
    expect((await run.result()).status).toBe('succeeded');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('finishes the paused batch from the answered call, and pauses again for a later call', async () => {
    const { tool: refund, execute } = refundTool();
    const lookup = vi.fn(() => ({ status: 'paid' }));
    const status = defineTool({ id: 'orders.get', version: '1', description: 'Look up', input: z.object({ order: z.number() }), output: z.object({ status: z.string() }),
      effects: 'read', capabilities: [], execute: lookup });
    const both: ModelResponse = { type: 'tool_calls', calls: [{ id: 'a', toolId: 'orders.get', input: { order: 7 } }, { id: 'b', toolId: 'orders.refund', input: { order: 7, amount: 3 } },
      { id: 'c', toolId: 'orders.get', input: { order: 8 } }], usage: { costMicros: 3 } };
    const model = priced([both, call('d', 9), done('ok')]);
    const agent = agentWith(model, [status, refund]);
    const allow = [...grants, 'tool:orders.get', 'effect:read'];
    const first = runtime({ permissions: { allow } });
    const run = first.submit(agent, { input: { question: 'Refund' } });
    const asked = (await until(run, 'approval.requested')).metadata;
    expect(asked['callId']).toBe('b');
    await until(run, 'run.paused');
    expect(lookup).toHaveBeenCalledOnce();
    await first.close();

    const second = runtime({ agents: [agent], permissions: { allow } });
    const resumed = await second.approve(run.id, { callId: 'b', digest: asked['digest'] as string, decision: 'approved', actorId: 'm' });
    const again = await until(resumed, 'approval.requested');
    expect(again.metadata['callId']).toBe('d');
    expect(lookup).toHaveBeenCalledTimes(2); // a once before the pause, c once after; a never again
    expect(execute).toHaveBeenCalledOnce();
    await until(resumed, 'run.paused');
    await second.approve(resumed, { callId: 'd', digest: again.metadata['digest'] as string, decision: 'approved', actorId: 'm' });
    expect((await resumed.result()).status).toBe('succeeded');
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('keeps the run within the budget it had, across a resume in another runtime', async () => {
    // 10 micros: the first model call (3) and the refund (5) fit; the final model call (3) does not.
    const { tool, execute } = refundTool();
    const agent = agentWith(priced([call('c1', 40), done('never')]), [tool]);
    const first = runtime({ limits: { maxCostMicros: 10 } });
    const run = first.submit(agent, { input: { question: 'Refund' } });
    const digest = (await until(run, 'approval.requested')).metadata['digest'] as string;
    await until(run, 'run.paused');
    await first.close();
    const resumed = await runtime({ agents: [agent], limits: { maxCostMicros: 100 } }).approve(run.id, { callId: 'c1', digest, decision: 'approved', actorId: 'm' });
    expect(await resumed.result()).toMatchObject({ status: 'blocked', error: { code: 'BUDGET_EXCEEDED' } });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('waits in memory instead of saving while a child run is still running', async () => {
    const { tool, execute } = refundTool();
    let releaseChild!: () => void; const childGate = new Promise<void>(resolve => { releaseChild = resolve; });
    let releaseParent!: () => void; const parentGate = new Promise<void>(resolve => { releaseParent = resolve; });
    const parentModel = priced([async () => { await parentGate; return call('c1', 40); }, done('ok')]);
    const child = defineAgent({ id: 'helper', version: '1', instructions: 'x', tools: [], model: scriptedModel([async () => { await childGate; return { type: 'final', output: { reply: 'child' }, usage: { costMicros: 0 } }; }], { id: 'child-model' }),
      input: z.object({ question: z.string() }), output: z.object({ reply: z.string() }) });
    const allow = [...grants, 'agent:delegate', 'model:child-model'];
    const engine = runtime({ permissions: { allow } });
    const run = engine.submit(agentWith(parentModel, [tool]), { input: { question: 'Refund' } });
    const spawned = engine.spawn(run, child, { input: { question: 'help' }, permissions: { allow } });
    releaseParent();
    const digest = (await until(run, 'approval.requested')).metadata['digest'] as string;
    expect(await store.runCheckpoints.get({ runId: run.id })).toBeUndefined();
    expect(engine.inspect(run).status).toBe('waiting');
    releaseChild(); await spawned.result();
    await engine.approve(run, { callId: 'c1', digest, decision: 'approved', actorId: 'm' });
    expect((await run.result()).status).toBe('succeeded');
    expect(execute).toHaveBeenCalledOnce();
    expect(await typesOf(run)).not.toContain('run.paused');
  });

  it('refuses a saved run it cannot read back, and a saved call that was changed', async () => {
    const { tool, execute } = refundTool();
    const agent = agentWith(priced([call('c1', 40), done('never')]), [tool]);
    const first = runtime();
    const run = first.submit(agent, { input: { question: 'Refund' } });
    const digest = (await until(run, 'approval.requested')).metadata['digest'] as string;
    await until(run, 'run.paused');
    await first.close();
    const saved = (await store.runCheckpoints.get({ runId: run.id }))!;
    const replace = async (body: Record<string, unknown>) => {
      await store.runCheckpoints.delete({ runId: run.id });
      await store.runCheckpoints.put({ runId: run.id, scope: saved.scope, expiresAtMs: saved.expiresAtMs, body: body as never });
    };
    const answer = { callId: 'c1', digest, decision: 'approved' as const, actorId: 'm' };
    await replace({ ...saved.body, format: 2 });
    await expect(runtime({ agents: [agent] }).approve(run.id, answer)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    // The call to run was changed in the store: its digest no longer matches, so it never runs.
    const calls = saved.body['calls'] as { id: string; toolId: string; input: { order: number; amount: number } }[];
    await replace({ ...saved.body, calls: [{ ...calls[0]!, input: { order: 7, amount: 4_000 } }] });
    const resumed = await runtime({ agents: [agent] }).approve(run.id, answer);
    expect(await resumed.result()).toMatchObject({ status: 'failed', error: { code: 'CONFLICT' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses invalid checkpoint options', () => {
    for (const checkpoints of [{}, { store: {} }, { store: store.runCheckpoints, leaseMs: 10 }, { store: store.runCheckpoints, replicaId: 'bad id!' },
      { store: store.runCheckpoints, extra: true }, { store: store.runCheckpoints, agents: [null] }]) {
      expect(() => createRuntime({ profile: 'ephemeral', checkpoints: checkpoints as never }), JSON.stringify(Object.keys(checkpoints))).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    }
  });
});

/** The store's methods, bound, so a test can replace one. */
function bound(port: RunCheckpointPort): RunCheckpointPort {
  return { put: command => port.put(command), get: command => port.get(command), claim: command => port.claim(command),
    delete: command => port.delete(command), due: command => port.due(command) };
}

it('keeps a saved approval unclaimed when current tool authorization is revoked, including after restart', async () => {
  let allowed = true;
  const authorization = createAuthorizer({ policy: { version: 'v1', authorize: request => request.resource.kind === 'tool' && !allowed
    ? { effect: 'deny', reason: 'explicit_deny', policyVersion: 'v1', ruleId: null } : { effect: 'allow', reason: 'allowed', policyVersion: 'v1', ruleId: null } }, permissions: { allow: ['authz:evaluate'] } });
  try {
    const { tool, execute } = refundTool(); const agent = agentWith(priced([call('authz-call', 40), done('ok')]), [tool]);
    const engine = runtime({ authorization, agents: [agent] }); const run = engine.submit(agent, { input: { question: 'Refund' } }); await until(run, 'run.paused');
    const pending = engine.inspect(run).approval!; const claim = vi.spyOn(store.runCheckpoints, 'claim'); allowed = false;
    const restarted = runtime({ authorization, agents: [agent] });
    await expect(restarted.approve(run.id, { callId: pending.callId, digest: pending.digest, decision: 'approved', actorId: 'human' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(claim).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled(); expect((await store.runCheckpoints.get({ runId: run.id }))?.status).toBe('waiting');
    allowed = true; const resumed = await restarted.approve(run.id, { callId: pending.callId, digest: pending.digest, decision: 'approved', actorId: 'human' });
    expect(await resumed.result()).toMatchObject({ status: 'succeeded' }); expect(execute).toHaveBeenCalledTimes(1);
  } finally { authorization.close(); }
});


it('does not repeat history application or approval notification when an existing candidate resumes', async () => {
  const notified = vi.fn();
  const hook = defineHook({ id: 'checkpoint-notification', version: '1', stage: 'onApprovalRequested', handler: notified });
  const { tool, execute } = refundTool(); const model = priced([call('notify-once', 40), done('ok')]);
  const agent = defineAgent({ id: 'support', version: '1', instructions: 'Handle refunds.', model, tools: [tool], hooks: [hook],
    input: z.object({ question: z.string() }), output: z.object({ reply: z.string() }) });
  const first = runtime({ agents: [agent] });
  const history = { messages: [{ role: 'user' as const, content: 'Earlier' }, { role: 'assistant' as const, output: 'Answer' }], omittedTurns: 2 };
  const run = first.submit(agent, { input: { question: 'Refund' }, history });
  const pending = await until(run, 'approval.requested'); await until(run, 'run.paused');
  const saved = await store.runCheckpoints.get({ runId: run.id });
  expect(saved?.body['counts']).toMatchObject({ hookCalls: 1 }); expect(notified).toHaveBeenCalledTimes(1);
  const initial: RunEvent[] = []; for await (const event of run.observe()) { initial.push(event); if (event.type === 'run.paused') break; }
  expect(initial.filter(event => event.type === 'history.applied')).toHaveLength(1);
  await first.close(); const restarted = runtime({ agents: [agent] });
  const resumed = await restarted.approve(run.id, { callId: 'notify-once', digest: String(pending.metadata['digest']), decision: 'approved', actorId: 'reviewer' });
  expect((await resumed.result()).status).toBe('succeeded'); expect(execute).toHaveBeenCalledTimes(1); expect(notified).toHaveBeenCalledTimes(1);
  const later: RunEvent[] = []; for await (const event of resumed.observe()) later.push(event);
  expect(later.some(event => event.type === 'history.applied')).toBe(false);
});

it('does not persist a waiting checkpoint after mandatory approval notification fails', async () => {
  const hook = defineHook({ id: 'no-checkpoint', version: '1', stage: 'onApprovalRequested', mandatory: true, handler: () => { throw new Error('PRIVATE'); } });
  const { tool, execute } = refundTool(); const model = priced([call('blocked-notify', 40)]);
  const agent = defineAgent({ id: 'support', version: '1', instructions: 'Handle refunds.', model, tools: [tool], hooks: [hook],
    input: z.object({ question: z.string() }), output: z.object({ reply: z.string() }) });
  const put = vi.spyOn(store.runCheckpoints, 'put'); const engine = runtime({ agents: [agent] });
  const run = engine.submit(agent, { input: { question: 'Refund' } });
  expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'GUARD_UNAVAILABLE' } });
  expect(put).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
});


it('notifies only once when checkpoint persistence falls back to an in-memory approval', async () => {
  const notified = vi.fn(); const hook = defineHook({ id: 'fallback-notification', version: '1', stage: 'onApprovalRequested', handler: notified });
  const { tool, execute } = refundTool(); const model = priced([call('fallback-notify', 40), done('ok')]);
  const agent = defineAgent({ id: 'support', version: '1', instructions: 'Handle refunds.', model, tools: [tool], hooks: [hook],
    input: z.object({ question: z.string() }), output: z.object({ reply: z.string() }) });
  const put = vi.fn(async () => { throw new Error('PRIVATE storage failure'); });
  const engine = runtime({ agents: [agent], checkpointStore: { ...store.runCheckpoints, put } });
  const run = engine.submit(agent, { input: { question: 'Refund' } }); const pending = await until(run, 'approval.requested');
  expect(notified).toHaveBeenCalledTimes(1); expect(put).toHaveBeenCalledTimes(1);
  await engine.approve(run, { callId: 'fallback-notify', digest: String(pending.metadata['digest']), decision: 'approved', actorId: 'reviewer' });
  expect((await run.result()).status).toBe('succeeded'); expect(execute).toHaveBeenCalledTimes(1); expect(notified).toHaveBeenCalledTimes(1);
});
