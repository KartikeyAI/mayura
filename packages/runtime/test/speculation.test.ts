import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JsonValue, ModelAdapter, ModelResponse, Schema } from '@mayura/core';
import { createRuntime, defineAgent, type Runtime } from '../src/index.js';

const json: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'speculation-test', validate: value => ({ value: value as JsonValue }) } };
const model = (id: string, generate: ModelAdapter['generate']): ModelAdapter => ({ id, capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 5, generate });
const final = (output: JsonValue, costMicros = 0): ModelResponse => ({ type: 'final', output, usage: { costMicros } });
const agent = (id: string, generate: ModelAdapter['generate']) => defineAgent({ id, version: '1', instructions: 'x', input: json, output: json, tools: [], model: model(id, generate) });
const never = () => new Promise<ModelResponse>(() => {});
const runtimes: Runtime[] = [];
function runtime(): Runtime {
  const engine = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:host', 'model:fast', 'model:slow', 'model:bad', 'agent:delegate'] },
    limits: { maxDurationMs: 2_000, maxCostMicros: 100 } });
  runtimes.push(engine); return engine;
}
afterEach(async () => { await Promise.all(runtimes.splice(0).map(engine => engine.close())); });
const branch = (id: string, generate: ModelAdapter['generate'], assumptions: JsonValue = { id }) =>
  ({ id, agent: agent(id, generate), input: 1, permissions: { allow: [`model:${id}`] }, assumptions });

describe('speculative branches', () => {
  it('promotes the first verified branch, cancels the others and keeps the parent successful', async () => {
    const engine = runtime(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const parent = engine.submit(agent('host', async () => { await gate; return final('parent done'); }), { input: 0 });
    const verify = vi.fn(() => true);
    const result = await engine.speculate(parent, { verify, branches: [branch('slow', never), branch('fast', async () => final('fast answer', 2))] });
    expect(result).toMatchObject({ status: 'promoted', branchId: 'fast', output: 'fast answer' });
    expect(result.assumptionsDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.branches.map(entry => [entry.id, entry.status, entry.verified])).toEqual([['slow', 'cancelled', false], ['fast', 'succeeded', true]]);
    expect(verify).toHaveBeenCalledWith({ branchId: 'fast', assumptionsDigest: result.assumptionsDigest, output: 'fast answer' });
    release();
    expect(await parent.result()).toMatchObject({ status: 'succeeded', output: 'parent done' });
    // Branches spend from the parent's shared budget.
    expect(engine.inspect(parent).budget.spentMicros).toBe(2);
  });

  it('promotes nothing when verification rejects, throws or times out', async () => {
    const engine = runtime(); const parent = engine.submit(agent('host', never), { input: 0 });
    for (const verify of [() => false, () => { throw new Error('stale'); }, () => new Promise<boolean>(() => {}), () => 'yes' as never]) {
      const result = await engine.speculate(parent, { verify, verifyTimeoutMs: 20, branches: [branch('fast', async () => final(1))] });
      expect(result).toMatchObject({ status: 'none', branches: [{ id: 'fast', status: 'succeeded', verified: false }] });
      expect(result).not.toHaveProperty('output');
    }
    parent.cancel();
  });

  it('rejects branches holding write, host, delegation or memory-mutation grants before starting any', async () => {
    const engine = runtime(); const parent = engine.submit(agent('host', never), { input: 0 });
    const generate = vi.fn(async () => final(1));
    for (const grant of ['effect:write', 'effect:host', 'agent:delegate', 'memory:write']) {
      await expect(engine.speculate(parent, { verify: () => true, branches: [branch('fast', generate), { ...branch('bad', generate), permissions: { allow: ['model:bad', grant] } }] }))
        .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    }
    expect(generate).not.toHaveBeenCalled();
    await expect(engine.speculate(parent, { verify: () => true, branches: [] })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(engine.speculate(parent, { verify: () => true, branches: [branch('fast', generate), branch('fast', generate)] })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    parent.cancel();
  });

  it('records distinct digests for distinct assumptions and reports failed branches without failing the parent', async () => {
    const engine = runtime(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const parent = engine.submit(agent('host', async () => { await gate; return final('ok'); }), { input: 0 });
    const result = await engine.speculate(parent, { verify: () => true, branches: [
      branch('bad', async () => { throw new Error('model down'); }, { plan: 'a' }), branch('fast', async () => final(2), { plan: 'b' })] });
    expect(result.status).toBe('promoted'); expect(result.branches[0]!.status).toBe('failed');
    expect(result.branches[0]!.assumptionsDigest).not.toBe(result.branches[1]!.assumptionsDigest);
    release(); expect(await parent.result()).toMatchObject({ status: 'succeeded' });
  });
});
