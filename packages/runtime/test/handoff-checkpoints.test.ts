import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { scriptedModel } from '@mayura/testing';
import { defineTool } from '@mayura/tools';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { createThreads, runInThread } from '@mayura/threads';
import type { RunEvent, RunHandle } from '@mayura/core';
import { createRuntime, defineAgent, type AgentDefinition, type Runtime } from '../src/index.js';

let directory: string; let store: ReturnType<typeof createSqliteStore>; const runtimes: Runtime[] = [];
const scope = { principalId: 'alice', projectId: 'shop' }; const grants = ['model:support', 'agent:billing'];
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'mayura-handoff-')); store = createSqliteStore({ filename: join(directory, 'runs.sqlite') }); await store.initialize(); await store.threads.initialize(); });
afterEach(async () => { await Promise.all(runtimes.splice(0).map(engine => engine.close())); await store.close();
  if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}mayura-handoff-`)) throw new Error('Unsafe cleanup path'); await rm(directory, { recursive: true, force: true }); });
async function until(run: RunHandle<unknown>, type: RunEvent['type']) {
  for await (const event of run.observe()) if (event.type === type) return event;
  throw new Error('Run ended before the expected event');
}
function fixture(edgeGrants = ['model:billing', 'tool:save', 'effect:write']) {
  const execute = vi.fn(() => ({ saved: true }));
  const tool = defineTool({ id: 'save', version: '1', description: 'Save', effects: 'write', capabilities: [], approval: 'required', input: z.object({}), output: z.object({ saved: z.boolean() }), execute });
  const billingModel = scriptedModel([{ type: 'tool_calls', calls: [{ id: 'write1', toolId: 'save', input: {} }], usage: { costMicros: 2 } },
    { type: 'final', output: { reply: 'Saved' }, usage: { costMicros: 2 } }], { id: 'billing', maxCostMicros: 2 });
  const targetCalls = vi.fn(billingModel.generate.bind(billingModel));
  const target = defineAgent({ id: 'billing', version: '1', instructions: 'Handle billing', tools: [tool], input: z.object({ message: z.string() }), output: z.object({ reply: z.string() }), model: { ...billingModel, generate: targetCalls } });
  const sourceModel = scriptedModel([{ type: 'tool_calls', calls: [{ id: 'transfer1', toolId: 'handoff.billing', input: { message: 'A note' } }], usage: { costMicros: 2 } }], { id: 'support', maxCostMicros: 2 });
  const sourceCalls = vi.fn(sourceModel.generate.bind(sourceModel));
  const source = defineAgent({ id: 'support', version: '1', instructions: 'Handle support', tools: [], input: z.object({ message: z.string() }), output: z.object({ reply: z.string() }),
    handoffs: [{ agent: target, permissions: { allow: edgeGrants } }], model: { ...sourceModel, generate: sourceCalls } });
  const threads = createThreads({ store, scope, permissions: { allow: ['thread:read', 'thread:write'] } });
  const engine = (agent: AgentDefinition = source, allow = grants) => {
    const value = createRuntime({ profile: 'ephemeral', scope, permissions: { allow }, limits: { maxCostMicros: 20 }, recorder: threads.recorder,
      checkpoints: { store: store.runCheckpoints, agents: [agent], autoExpire: false } }); runtimes.push(value); return value;
  };
  return { source, sourceCalls, targetCalls, execute, threads, engine };
}

describe('handoff approvals and thread recording', () => {
  it('resumes the active target after restart without replaying source models or writes and records one complete turn', async () => {
    const { source, sourceCalls, targetCalls, execute, threads, engine } = fixture(); const owner = engine(); await threads.create({ id: 'chat', agentId: source.id });
    const turn = await runInThread({ threads, runtime: owner, agent: source, threadId: 'chat', input: { message: 'Help' } }); await until(turn.run, 'run.paused');
    const waiting = owner.inspect(turn.run); const checkpoint = await store.runCheckpoints.get({ runId: turn.run.id });
    expect(checkpoint!.body).toMatchObject({ agent: { id: 'support' }, permissions: ['model:billing', 'tool:save', 'effect:write'], handoff: { path: ['billing'], sourcePermissions: grants } });
    expect(waiting.budget).toMatchObject({ spentMicros: 4, calls: 3 }); expect(execute).not.toHaveBeenCalled();
    await owner.close(); const resumed = await engine().approve(turn.run.id, { callId: waiting.approval!.callId, digest: waiting.approval!.digest, decision: 'approved', actorId: 'alice' });
    expect(resumed.id).toBe(turn.run.id); expect(await resumed.result()).toMatchObject({ status: 'succeeded', output: { reply: 'Saved' } });
    expect(sourceCalls).toHaveBeenCalledTimes(1); expect(targetCalls).toHaveBeenCalledTimes(2); expect(execute).toHaveBeenCalledTimes(1);
    const entries = await threads.entries('chat'); expect(entries.filter(entry => entry.kind === 'assistant')).toHaveLength(1);
    expect(entries.filter(entry => entry.kind === 'run' && entry.status === 'succeeded')).toHaveLength(1);
    expect(entries.some(entry => entry.kind === 'tool_calls' && entry.calls?.some(call => call.toolId === 'handoff.billing'))).toBe(true);
  });
  it('pins target grants and refuses changed handoff policy without executing the approved write', async () => {
    const setup = fixture(); const owner = setup.engine(); const run = owner.submit(setup.source, { input: { message: 'Help' } }); await until(run, 'run.paused'); const waiting = owner.inspect(run); await owner.close();
    const changed = defineAgent({ id: 'support', version: '1', instructions: setup.source.instructions, tools: [], input: setup.source.input, output: setup.source.output, model: setup.source.model,
      handoffs: [{ agent: setup.source.handoffs![0]!.agent, permissions: { allow: ['model:billing'] } }] });
    await expect(setup.engine(changed).approve(run.id, { callId: waiting.approval!.callId, digest: waiting.approval!.digest, decision: 'approved', actorId: 'alice' })).rejects.toMatchObject({ code: 'DEFINITION_CHANGED' });
    expect(setup.execute).not.toHaveBeenCalled(); expect(setup.sourceCalls).toHaveBeenCalledTimes(1);
  });
  it('honors revocation of the source transfer grant on a new runtime', async () => {
    const setup = fixture(); const owner = setup.engine(); const run = owner.submit(setup.source, { input: { message: 'Help' } }); await until(run, 'run.paused'); const waiting = owner.inspect(run); await owner.close();
    await expect(setup.engine(setup.source, ['model:support']).approve(run.id, { callId: waiting.approval!.callId, digest: waiting.approval!.digest, decision: 'approved', actorId: 'alice' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(setup.execute).not.toHaveBeenCalled();
  });
});
