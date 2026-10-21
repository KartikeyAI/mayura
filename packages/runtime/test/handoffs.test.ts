import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { scriptedModel } from '@mayura/testing';
import { defineTool } from '@mayura/tools';
import type { ModelRequest, ModelResponse } from '@mayura/core';
import { createRuntime, defineAgent, type AgentDefinition, type AgentHandoff, type Runtime, type RuntimeLimits } from '../src/index.js';

const runtimes: Runtime[] = []; afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.close())); });
const final = (reply = 'Handled', costMicros = 0): ModelResponse => ({ type: 'final', output: { reply }, usage: { costMicros } });
const call = (toolId: string, input: unknown = { message: 'Billing question' }, id = 'h1', costMicros = 0): ModelResponse => ({ type: 'tool_calls', calls: [{ id, toolId, input: input as never }], usage: { costMicros } });
function agent(id: string, responses: readonly (ModelResponse | ((request: ModelRequest) => ModelResponse | Promise<ModelResponse>))[], edges: readonly AgentHandoff[] = [], tools: readonly ReturnType<typeof defineTool>[] = [], maxCostMicros = 0) {
  const adapter = scriptedModel(responses, { maxCostMicros }); const generate = vi.fn(adapter.generate.bind(adapter));
  const value = defineAgent({ id, version: '1', instructions: `Private instructions for ${id}`, tools, handoffs: edges,
    input: z.object({ message: z.string() }), output: z.object({ reply: z.string() }), model: { ...adapter, id, generate } });
  return { value, generate };
}
function runtime(allow = ['model:support', 'agent:billing'], limits: RuntimeLimits = {}) {
  const value = createRuntime({ profile: 'ephemeral', permissions: { allow }, limits }); runtimes.push(value); return value;
}
const edge = (value: AgentDefinition, allow = ['model:billing']): AgentHandoff => ({ agent: value, permissions: { allow } });
function writeTool() {
  const execute = vi.fn(() => ({ saved: true }));
  return { execute, tool: defineTool({ id: 'save', version: '1', description: 'Save', input: z.object({}), output: z.object({ saved: z.boolean() }), effects: 'write', capabilities: [], execute }) };
}

describe('root agent handoffs', () => {
  it('keeps one handle, shared history, transcript and counters while replacing private instructions and continuation', async () => {
    let observed: ModelRequest | undefined;
    const billing = agent('billing', [request => { observed = request; return final(); }]);
    const support = agent('support', [{ ...call('handoff.billing'), continuation: { private: 'source-token' } }], [edge(billing.value)]);
    const engine = runtime(); const run = engine.submit(support.value, { input: { message: 'Help' }, history: [{ role: 'user', content: 'Earlier thread context' }] });
    expect(await run.result()).toMatchObject({ status: 'succeeded', output: { reply: 'Handled' } });
    expect(observed?.history).toEqual([{ role: 'user', content: 'Earlier thread context' }]);
    expect(observed?.instructions).toBe('Private instructions for billing'); expect(observed?.continuation).toBeUndefined();
    expect(observed?.messages).toEqual(expect.arrayContaining([{ role: 'user', content: { message: 'Help' } },
      { role: 'tool', toolId: 'handoff.billing', callId: 'h1', result: { handedOff: true, agentId: 'billing' } }, { role: 'user', content: { message: 'Billing question' } }]));
    expect(engine.inspect(run).runs).toHaveLength(1); expect(engine.inspect(run).budget.calls).toBe(3);
    const events = []; for await (const event of run.observe()) events.push(event);
    expect(events.filter(event => event.type === 'run.started')).toHaveLength(1);
    expect(events.find(event => event.type === 'tool.completed')?.metadata).toMatchObject({ fromAgentId: 'support', toAgentId: 'billing', handoffs: 1 });
    expect(support.generate).toHaveBeenCalledTimes(1); expect(billing.generate).toHaveBeenCalledTimes(1);
  });
  it('snapshots target authority and refuses duplicate or colliding handoff identities', () => {
    const billing = agent('billing', [final()]); const allow = ['model:billing']; const edges = [edge(billing.value, allow)];
    const support = agent('support', [final()], edges); allow.push('effect:write'); edges.length = 0;
    expect(support.value.handoffs![0]!.permissions.allow).toEqual(['model:billing']); expect(Object.isFrozen(support.value.handoffs)).toBe(true);
    expect(() => agent('support', [final()], [edge(billing.value), edge(billing.value)])).toThrow();
    const collision = defineTool({ id: 'handoff.billing', version: '1', description: 'Collision', input: z.object({}), output: z.object({}), effects: 'none', capabilities: [], execute: () => ({}) });
    expect(() => agent('support', [final()], [edge(billing.value)], [collision])).toThrow();
  });
  it('replaces grants at every hop and refuses child-run transfers', async () => {
    const billing = agent('billing', [final()]); const triage = agent('triage', [call('handoff.billing', { message: 'Help' }, 'h2')], [edge(billing.value)]);
    const support = agent('support', [call('handoff.triage')], [edge(triage.value, ['model:triage', 'agent:billing'])]);
    const engine = runtime(['model:support', 'agent:triage']); const run = engine.submit(support.value, { input: { message: 'Help' } });
    expect(await run.result()).toMatchObject({ status: 'succeeded' }); expect(engine.inspect(run).budget.calls).toBe(5);
    const childBilling = agent('billing', [final()]); const childSupport = agent('support', [call('handoff.billing')], [edge(childBilling.value)]);
    let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
    const parent = agent('parent', [async () => { await hold; return final(); }]); const owner = runtime(['model:parent', 'model:support', 'agent:delegate', 'agent:billing']);
    const parentRun = owner.submit(parent.value, { input: { message: 'Parent' } });
    const childRun = owner.spawn(parentRun, childSupport.value, { input: { message: 'Child' }, permissions: { allow: ['model:support', 'agent:billing'] } });
    try { expect(await childRun.result()).toMatchObject({ status: 'blocked', error: { code: 'PERMISSION_DENIED' } }); } finally { release(); }
    await parentRun.result(); expect(childBilling.generate).not.toHaveBeenCalled();
  });
  it('requires the exact source transfer grant and does not dispatch the target when denied', async () => {
    const billing = agent('billing', [final()]); const support = agent('support', [call('handoff.billing')], [edge(billing.value)]);
    const run = runtime(['model:support']).submit(support.value, { input: { message: 'Help' } });
    expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'PERMISSION_DENIED' } }); expect(billing.generate).not.toHaveBeenCalled();
  });
  it('uses target-only tool grants, even when the source cannot perform the write', async () => {
    const { tool, execute } = writeTool(); const billing = agent('billing', [call('save', {}, 'save1'), final()], [], [tool]);
    const support = agent('support', [call('handoff.billing')], [edge(billing.value, ['model:billing', 'tool:save', 'effect:write'])]);
    expect(await runtime().submit(support.value, { input: { message: 'Help' } }).result()).toMatchObject({ status: 'succeeded' }); expect(execute).toHaveBeenCalledTimes(1);
  });
  it('does not inherit source write permissions or source tools', async () => {
    const { tool, execute } = writeTool(); const billing = agent('billing', [call('save', {}, 'save1')], [], [tool]);
    const support = agent('support', [call('handoff.billing')], [edge(billing.value, ['model:billing', 'tool:save'])], [tool]);
    const run = runtime(['model:support', 'agent:billing', 'tool:save', 'effect:write']).submit(support.value, { input: { message: 'Help' } });
    expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'PERMISSION_DENIED' } }); expect(execute).not.toHaveBeenCalled();
  });
  it('shares the cost ceiling and never grants a fresh model-call allowance', async () => {
    const billing = agent('billing', [final('Handled', 3)], [], [], 3); const support = agent('support', [call('handoff.billing', undefined, 'h1', 3)], [edge(billing.value)], [], 3);
    const engine = runtime(undefined, { maxCostMicros: 5 }); const run = engine.submit(support.value, { input: { message: 'Help' } });
    expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'BUDGET_EXCEEDED' } }); expect(engine.inspect(run).budget.spentMicros).toBe(3); expect(billing.generate).not.toHaveBeenCalled();
    const second = agent('support', [call('handoff.billing')], [edge(billing.value)]);
    expect(await runtime(undefined, { maxCostMicros: 100, maxModelCalls: 1 }).submit(second.value, { input: { message: 'Help' } }).result()).toMatchObject({ status: 'failed', error: { code: 'LIMIT_EXCEEDED' } });
    expect(billing.generate).not.toHaveBeenCalled();
  });
  it.each([{ maxHandoffs: 0 }, { maxToolCalls: 0 }, { maxSteps: 1 }])('enforces the continuing handoff/step/tool bounds %j', async limits => {
    const billing = agent('billing', [final()]); const support = agent('support', [call('handoff.billing')], [edge(billing.value)]);
    expect(await runtime(undefined, limits).submit(support.value, { input: { message: 'Help' } }).result()).toMatchObject({ status: 'failed', error: { code: 'LIMIT_EXCEEDED' } }); expect(billing.generate).not.toHaveBeenCalled();
  });
  it('rejects mixed tool batches before any write and validates target input before transfer', async () => {
    const { tool, execute } = writeTool(); const billing = agent('billing', [final()]);
    const support = agent('support', [{ type: 'tool_calls', calls: [{ id: 'w1', toolId: 'save', input: {} }, { id: 'h1', toolId: 'handoff.billing', input: { message: 'Help' } }], usage: { costMicros: 0 } }], [edge(billing.value)], [tool]);
    expect(await runtime(['model:support', 'agent:billing', 'tool:save', 'effect:write']).submit(support.value, { input: { message: 'Help' } }).result()).toMatchObject({ status: 'failed', error: { code: 'INVALID_INPUT' } });
    const invalid = agent('support', [call('handoff.billing', { wrong: true })], [edge(billing.value)]);
    expect(await runtime().submit(invalid.value, { input: { message: 'Help' } }).result()).toMatchObject({ status: 'failed', error: { code: 'INVALID_INPUT' } });
    expect(execute).not.toHaveBeenCalled(); expect(billing.generate).not.toHaveBeenCalled();
  });
  it('cancels the active target without returning to the source', async () => {
    let started!: () => void; const waiting = new Promise<void>(resolve => { started = resolve; });
    const billing = agent('billing', [request => new Promise((_resolve, reject) => { started(); request.signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true }); })]);
    const support = agent('support', [call('handoff.billing')], [edge(billing.value)]); const run = runtime().submit(support.value, { input: { message: 'Help' } });
    await waiting; run.cancel(); expect(await run.result()).toMatchObject({ status: 'cancelled' }); expect(support.generate).toHaveBeenCalledTimes(1);
  });
  it('refuses incompatible target output and ambiguous target failures without replaying the source', async () => {
    const model = scriptedModel([{ type: 'final', output: { different: true }, usage: { costMicros: 0 } }]);
    const billing = defineAgent({ id: 'billing', version: '1', instructions: 'Help', tools: [], input: z.object({ message: z.string() }), output: z.object({ different: z.boolean() }), model: { ...model, id: 'billing' } });
    const support = agent('support', [call('handoff.billing')], [edge(billing)]);
    expect(await runtime().submit(support.value, { input: { message: 'Help' } }).result()).toMatchObject({ status: 'failed', error: { code: 'INVALID_OUTPUT' } }); expect(support.generate).toHaveBeenCalledTimes(1);
  });
});
