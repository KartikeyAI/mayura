import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { createRuntime, defineAgent, type Runtime } from '@mayura/runtime';
import { defineTool } from '@mayura/tools';
import { registerToolContinuation } from '@mayura/tools/host';
import { scriptedModel } from '@mayura/testing';

const scope = { principalId: 'alice', projectId: 'shop' };
let directory: string; let store: ReturnType<typeof createSqliteStore>; const runtimes: Runtime[] = [];
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'mayura-native-tool-recovery-'));
  store = createSqliteStore({ filename: join(directory, 'runs.sqlite') }); await store.initialize(); await store.runCheckpoints.initialize(); });
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); await store.close();
  if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}mayura-native-tool-recovery-`)) throw new Error('Unsafe cleanup path');
  await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const inputGuard = vi.fn(async () => ({ decision: 'allow' as const })); const execute = vi.fn(async () => ({ selected: 7 }));
  let ready = false;
  const tool = defineTool({ id: 'ui.select', version: '1', description: 'Select.', input: z.object({ item: z.number() }), output: z.object({ selected: z.number() }),
    capabilities: ['frontend:ui.select'], effects: 'none', costMicros: 2, timeoutMs: 10_000, guards: { input: [{ id: 'admit', check: inputGuard }] }, execute });
  const prepare = vi.fn(async () => ({ digest: 'a'.repeat(64), expiresAtMs: Date.now() + 10_000 })); const publish = vi.fn(async () => {});
  registerToolContinuation(tool, { prepare, publish, ready: async () => ready });
  const model = scriptedModel([{ type: 'tool_calls', calls: [{ id: 'c1', toolId: 'ui.select', input: { item: 7 } }], usage: { costMicros: 1 } },
    { type: 'final', output: { reply: 'done' }, usage: { costMicros: 1 } }], { maxCostMicros: 1 });
  const generate = vi.fn(model.generate.bind(model));
  const agent = defineAgent({ id: 'support', version: '1', instructions: 'Help.', model: { ...model, generate }, tools: [tool],
    input: z.object({ message: z.string() }), output: z.object({ reply: z.string() }) });
  const allow = ['model:scripted', 'tool:ui.select', 'frontend:ui.select'];
  const runtime = (grants = allow, checkpointStore = store.runCheckpoints) => { const result = createRuntime({ profile: 'ephemeral', scope, permissions: { allow: grants },
    limits: { maxCostMicros: 10 }, checkpoints: { store: checkpointStore, agents: [agent], autoExpire: false } }); runtimes.push(result); return result; };
  const owner = runtime(); const handle = owner.submit(agent, { input: { message: 'select' } });
  await vi.waitFor(() => expect(owner.inspect(handle).toolWait).toMatchObject({ callId: 'c1' }));
  const digest = owner.inspect(handle).toolWait!.digest; await owner.close();
  return { runtime, owner, handle, inputGuard, prepare, publish, execute, generate, allow, command: { callId: 'c1', digest }, ready: () => { ready = true; } };
}
describe('safe native external-result continuation (offline)', () => {
  it('continues once with the original budget and transcript, without repeating input guards or the paid model proposal', async () => {
    const f = await fixture(); const next = f.runtime(); expect(await next.resumeTool(f.handle.id, f.command)).toBeUndefined(); f.ready();
    const outcomes = await Promise.allSettled([next.resumeTool(f.handle.id, f.command), next.resumeTool(f.handle.id, f.command)]);
    const resumed = outcomes.find(item => item.status === 'fulfilled' && item.value)! as PromiseFulfilledResult<NonNullable<Awaited<ReturnType<Runtime['resumeTool']>>>>;
    expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(await resumed.value.result()).toMatchObject({ status: 'succeeded' });
    expect(next.inspect(resumed.value).budget.spentMicros).toBe(4);
    expect(f.generate).toHaveBeenCalledTimes(2); expect(f.inputGuard).toHaveBeenCalledTimes(1); expect(f.prepare).toHaveBeenCalledTimes(1); expect(f.execute).toHaveBeenCalledTimes(1);
    await expect(f.runtime().resumeTool(f.handle.id, f.command)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('denies wrong digest, revoked capabilities and human-approval substitution before consuming the checkpoint', async () => {
    const f = await fixture(); f.ready(); const next = f.runtime();
    await expect(next.resumeTool(f.handle.id, { ...f.command, digest: 'b'.repeat(64) })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(f.runtime(f.allow.filter(grant => !grant.startsWith('frontend:'))).resumeTool(f.handle.id, f.command)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(next.approve(f.handle.id, { ...f.command, decision: 'approved', actorId: 'alice' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await store.runCheckpoints.get({ runId: f.handle.id }))?.status).toBe('waiting'); expect(f.execute).not.toHaveBeenCalled();
    await next.cancelSaved(f.handle.id); await expect(next.resumeTool(f.handle.id, f.command)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it('does not replay execution after an uncertain checkpoint-consumption reply', async () => {
    const f = await fixture(); f.ready();
    const broken = { ...store.runCheckpoints, delete: async (command: Parameters<typeof store.runCheckpoints.delete>[0]) => {
      await store.runCheckpoints.delete(command); throw new Error('PRIVATE commit reply');
    } };
    await expect(f.runtime(f.allow, broken).resumeTool(f.handle.id, f.command)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(await store.runCheckpoints.get({ runId: f.handle.id })).toBeUndefined();
    await expect(f.runtime().resumeTool(f.handle.id, f.command)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(f.generate).toHaveBeenCalledTimes(1); expect(f.execute).not.toHaveBeenCalled();
  });
});
