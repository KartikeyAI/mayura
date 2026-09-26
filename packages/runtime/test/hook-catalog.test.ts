import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Guard, type JsonValue, type ModelAdapter, type ModelResponse, type RunEvent, type Schema } from '@mayura/core';
import { defineTool } from '@mayura/tools';
import { agentAsTool, createRuntime, defineAgent, defineHook, type AgentOptions, type HookStage, type Runtime, type RuntimeLimits } from '../src/index.js';

const jsonSchema: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'hook-catalog-test', validate: value => ({ value: value as JsonValue }) } };
const scope = { principalId: 'catalog-principal', projectId: 'catalog-project' };
const grants = ['model:primary', 'model:child', 'tool:original', 'tool:delegate', 'agent:delegate'];
const final = (output: JsonValue = 2): ModelResponse => ({ type: 'final', output, usage: { costMicros: 0 } });
const call = (toolId = 'original', input: JsonValue = 1): ModelResponse => ({ type: 'tool_calls', calls: [{ id: `call.${toolId}`, toolId, input }], usage: { costMicros: 0 } });
function scripted(id: string, responses: readonly ModelResponse[]): ModelAdapter {
  let index = 0;
  return { id, capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0, generate: async () => responses[Math.min(index++, responses.length - 1)]! };
}
function agent(id: string, model: ModelAdapter, extras: Partial<AgentOptions<typeof jsonSchema, typeof jsonSchema>> = {}) {
  return defineAgent({ id, version: '1', instructions: 'PRIVATE instructions.', input: jsonSchema, output: jsonSchema, tools: [], model, ...extras });
}
const original = (execute: (value: number) => number | Promise<number> = value => value * 2) => defineTool({ id: 'original', version: '1', description: 'Original.',
  input: jsonSchema as unknown as Schema<number>, output: jsonSchema as unknown as Schema<number>, effects: 'none', capabilities: [], execute });
const runtimes: Runtime[] = [];
function runtime(limits: RuntimeLimits = {}, allow: readonly string[] = grants): Runtime {
  const engine = createRuntime({ profile: 'ephemeral', scope, permissions: { allow }, limits: { maxDurationMs: 2_000, ...limits } });
  runtimes.push(engine); return engine;
}
async function events(source: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const result: RunEvent[] = []; for await (const event of source) result.push(event); return result;
}
afterEach(async () => { await Promise.all(runtimes.splice(0).map(engine => engine.close())); vi.restoreAllMocks(); });

/** One observer per stage, recording the frozen view each receives. */
function recorder(stages: readonly HookStage[], options: { readonly mandatory?: boolean } = {}) {
  const seen: { stage: string; event: Record<string, unknown> }[] = [];
  const hooks = stages.map(stage => stage.startsWith('before')
    ? defineHook({ id: `record.${stage}`, version: '1', stage: stage as 'beforeStep', tools: [], handler: event => {
      seen.push({ stage, event: event as unknown as Record<string, unknown> }); return { decision: 'continue' };
    } })
    : defineHook({ id: `record.${stage}`, version: '1', stage: stage as 'afterStep', ...(options.mandatory ? { mandatory: true } : {}), handler: event => {
      expect(Object.isFrozen(event)).toBe(true);
      seen.push({ stage, event: event as unknown as Record<string, unknown> });
    } }));
  return { seen, hooks };
}

describe('lifecycle hook catalog: agent stages', () => {
  it('fires step, model, tool and terminal stages in the documented order with metadata-only views', async () => {
    const { seen, hooks } = recorder(['beforeStep', 'afterStep', 'afterModelCall', 'afterToolCall', 'afterExecution', 'onError', 'onFinally']);
    const run = runtime().submit(agent('parent', scripted('primary', [call(), final(7)]), { tools: [original()], hooks }), { input: 1 });
    expect(await run.result()).toMatchObject({ status: 'succeeded', output: 7 });
    expect(seen.map(entry => entry.stage)).toEqual([
      'beforeStep', 'afterModelCall', 'afterToolCall', 'afterStep',
      'beforeStep', 'afterModelCall', 'afterStep',
      'afterExecution', 'onFinally',
    ]);
    expect(seen[0]!.event).toEqual({ stage: 'beforeStep', step: 0 });
    expect(seen[1]!.event).toEqual({ stage: 'afterModelCall', step: 0, modelId: 'primary', response: 'tool_calls', toolCalls: 1 });
    expect(seen[2]!.event).toEqual({ stage: 'afterToolCall', step: 0, callId: 'call.original', toolId: 'original', status: 'succeeded', execution: 'succeeded', disclosure: 'released' });
    expect(seen[3]!.event).toEqual({ stage: 'afterStep', step: 0, result: 'tool_calls' });
    expect(seen[6]!.event).toEqual({ stage: 'afterStep', step: 1, result: 'final' });
    expect(seen[7]!.event).toEqual({ stage: 'afterExecution', status: 'succeeded' });
    expect(JSON.stringify(seen)).not.toContain('PRIVATE');
    const observed = await events(run.observe());
    expect(observed.filter(event => event.type.startsWith('step.')).map(event => [event.type, event.metadata])).toEqual([
      ['step.started', { step: 0 }], ['step.completed', { step: 0, result: 'tool_calls' }],
      ['step.started', { step: 1 }], ['step.completed', { step: 1, result: 'final' }],
    ]);
    const hookStages = observed.filter(event => event.type === 'hook.completed').map(event => event.metadata['stage']);
    expect(hookStages).toEqual(seen.map(entry => entry.stage));
    expect(observed.at(-1)!.type).toBe('run.completed');
  });

  it('reports failures through onError, cancellation through onCancel and blocks through onBlocked, always then onFinally', async () => {
    const failing = recorder(['afterExecution', 'onError', 'onCancel', 'onBlocked', 'onFinally']);
    const failed = runtime().submit(agent('failing', { ...scripted('primary', []), generate: async () => { throw new Error('boom'); } }, { hooks: failing.hooks }), { input: 1 });
    expect(await failed.result()).toMatchObject({ status: 'failed' });
    expect(failing.seen.map(entry => entry.event)).toEqual([
      { stage: 'onError', status: 'failed', error: { code: 'MODEL_FAILED' } }, { stage: 'onFinally', status: 'failed', error: { code: 'MODEL_FAILED' } }]);

    const cancelling = recorder(['onCancel', 'onFinally']);
    const pending = runtime().submit(agent('slow', { ...scripted('primary', []), generate: () => new Promise<ModelResponse>(() => {}) }, { hooks: cancelling.hooks }), { input: 1 });
    await new Promise(resolve => setTimeout(resolve, 10)); pending.cancel();
    expect(await pending.result()).toMatchObject({ status: 'cancelled' });
    expect(cancelling.seen.map(entry => entry.stage)).toEqual(['onCancel', 'onFinally']);
    const cancelEvents = await events(pending.observe());
    expect(cancelEvents.filter(event => event.type === 'hook.completed').map(event => event.metadata['status'])).toEqual(['continued', 'continued']);

    const blocking = recorder(['onBlocked', 'onFinally', 'onViolation']);
    const guard: Guard = { id: 'deny', check: () => ({ decision: 'block' }) };
    const blocked = runtime().submit(agent('blocked', scripted('primary', [final()]), { guards: { input: [guard] }, hooks: blocking.hooks }), { input: 1 });
    expect(await blocked.result()).toMatchObject({ status: 'blocked' });
    expect(blocking.seen.map(entry => entry.event)).toEqual([
      { stage: 'onViolation', source: 'guard', boundary: 'input', code: 'GUARD_BLOCKED', callId: 'input' },
      { stage: 'onBlocked', status: 'blocked', error: { code: 'GUARD_BLOCKED' } },
      { stage: 'onFinally', status: 'blocked', error: { code: 'GUARD_BLOCKED' } },
    ]);
  });

  it('keeps optional observer failures visible but harmless, and makes mandatory ones fail closed', async () => {
    const optional = defineHook({ id: 'optional', version: '1', stage: 'afterModelCall', handler: () => { throw new Error('sink down'); } });
    const run = runtime().submit(agent('optional', scripted('primary', [final(5)]), { hooks: [optional] }), { input: 1 });
    expect(await run.result()).toMatchObject({ status: 'succeeded', output: 5 });
    expect((await events(run.observe())).find(event => event.type === 'hook.completed')?.metadata).toMatchObject({ stage: 'afterModelCall', status: 'failed' });

    for (const stage of ['afterModelCall', 'afterStep', 'afterExecution'] as const) {
      const mandatory = defineHook({ id: 'audit', version: '1', stage, mandatory: true, handler: () => new Promise<void>(() => {}), timeoutMs: 20 });
      const audited = runtime().submit(agent('audited', scripted('primary', [final(5)]), { hooks: [mandatory] }), { input: 1 });
      const outcome = await audited.result();
      expect(outcome).toMatchObject({ status: 'blocked', error: { code: 'GUARD_UNAVAILABLE' } });
      expect(outcome).not.toHaveProperty('output');
    }
    const returning = defineHook({ id: 'returns', version: '1', stage: 'afterExecution', mandatory: true, handler: (() => ({ decision: 'continue' })) as never });
    expect(await runtime().submit(agent('returns', scripted('primary', [final()]), { hooks: [returning] }), { input: 1 }).result()).toMatchObject({ status: 'blocked' });
  });

  it('never lets afterToolCall upgrade a failure, and withholds a successful tool result on mandatory failure', async () => {
    const seen: unknown[] = [];
    const observer = defineHook({ id: 'tool-audit', version: '1', stage: 'afterToolCall', handler: event => { seen.push(event); } });
    const failing = original(() => { throw new Error('tool failed'); });
    const run = runtime().submit(agent('tools', scripted('primary', [call(), final()]), { tools: [failing], hooks: [observer] }), { input: 1 });
    expect(await run.result()).toMatchObject({ status: 'failed' });
    expect(seen).toEqual([expect.objectContaining({ stage: 'afterToolCall', status: 'failed', toolId: 'original' })]);

    const execute = vi.fn((value: number) => value * 2);
    const models: string[] = [];
    const mandatory = defineHook({ id: 'tool-audit', version: '1', stage: 'afterToolCall', mandatory: true, handler: () => { throw new Error('x'); } });
    const withheld = runtime().submit(agent('withheld', { ...scripted('primary', [call(), final()]), generate: async request => {
      models.push(JSON.stringify(request.messages)); return models.length === 1 ? call() : final(); } }, { tools: [original(execute)], hooks: [mandatory] }), { input: 1 });
    expect(await withheld.result()).toMatchObject({ status: 'blocked', error: { code: 'GUARD_UNAVAILABLE' } });
    expect(execute).toHaveBeenCalledTimes(1); expect(models).toHaveLength(1);
    const completed = (await events(withheld.observe())).find(event => event.type === 'tool.completed');
    expect(completed?.metadata).toMatchObject({ status: 'blocked', execution: 'succeeded', disclosure: 'withheld' });
  });

  it('reports hook blocks and permission denials to onViolation without reversing them', async () => {
    const violations: unknown[] = [];
    const onViolation = defineHook({ id: 'violations', version: '1', stage: 'onViolation', mandatory: true, handler: event => { violations.push(event); throw new Error('cannot unblock'); } });
    const deny = defineHook({ id: 'deny-step', version: '1', stage: 'beforeStep', tools: [], handler: () => ({ decision: 'block' }) });
    const blocked = runtime().submit(agent('denied', scripted('primary', [final()]), { hooks: [deny, onViolation] }), { input: 1 });
    expect(await blocked.result()).toMatchObject({ status: 'blocked', error: { code: 'GUARD_BLOCKED' } });
    expect(violations).toEqual([{ stage: 'onViolation', source: 'hook', boundary: 'execution', code: 'GUARD_BLOCKED' }]);

    violations.length = 0;
    const noTool = runtime({}, grants.filter(grant => grant !== 'tool:original'))
      .submit(agent('no-tool', scripted('primary', [call(), final()]), { tools: [original()], hooks: [onViolation] }), { input: 1 });
    expect(await noTool.result()).toMatchObject({ status: 'blocked', error: { code: 'PERMISSION_DENIED' } });
    expect(violations).toEqual([{ stage: 'onViolation', source: 'permission', boundary: 'tool', code: 'PERMISSION_DENIED' }]);
  });

  it('runs the parent beforeDelegate/afterDelegate hooks around agent-tool and spawned children', async () => {
    const seen: { stage: string; runId: string; event: unknown }[] = [];
    const before = defineHook({ id: 'delegate-policy', version: '1', stage: 'beforeDelegate', tools: [], handler: (event, context) => {
      seen.push({ stage: 'before', runId: context.runId, event }); return { decision: 'continue' }; } });
    const after = defineHook({ id: 'delegate-audit', version: '1', stage: 'afterDelegate', handler: (event, context) => { seen.push({ stage: 'after', runId: context.runId, event }); } });
    const child = agent('child', scripted('child', [final(11)]));
    const composed = agentAsTool(child, { id: 'delegate', description: 'Child.', permissions: { allow: ['model:child'] } });
    const parent = runtime().submit(agent('parent', scripted('primary', [call('delegate', 3), final(12)]), { tools: [composed], hooks: [before, after] }), { input: 1 });
    expect(await parent.result()).toMatchObject({ status: 'succeeded', output: 12 });
    expect(seen.map(entry => entry.stage)).toEqual(['before', 'after']);
    expect(seen.every(entry => entry.runId === parent.id)).toBe(true);
    const childRunId = (seen[0]!.event as { childRunId: string }).childRunId;
    expect(seen[0]!.event).toEqual({ stage: 'beforeDelegate', childRunId, childAgentId: 'child', input: 3 });
    expect(seen[1]!.event).toEqual({ stage: 'afterDelegate', childRunId, childAgentId: 'child', status: 'succeeded' });
    const parentEvents = await events(parent.observe());
    expect(parentEvents.filter(event => event.type.startsWith('delegate.')).map(event => [event.type, event.metadata])).toEqual([
      ['delegate.started', { childRunId, childAgentId: 'child' }], ['delegate.completed', { childRunId, status: 'succeeded' }]]);

    const denyAll = defineHook({ id: 'no-delegation', version: '1', stage: 'beforeDelegate', tools: [], handler: () => ({ decision: 'block' }) });
    const generate = vi.fn(async () => final());
    const engine = runtime();
    const host = engine.submit(agent('host', { ...scripted('primary', []), generate: () => new Promise<ModelResponse>(() => {}) }, { hooks: [denyAll] }), { input: 1 });
    const spawned = engine.spawn(host, agent('spawned', { ...scripted('child', []), generate }), { input: 1, permissions: { allow: ['model:child'] } });
    expect(await spawned.result()).toMatchObject({ status: 'blocked', error: { code: 'GUARD_BLOCKED' } });
    expect(generate).not.toHaveBeenCalled();
    host.cancel();

    const withhold = defineHook({ id: 'withhold', version: '1', stage: 'afterDelegate', mandatory: true, handler: () => { throw new Error('x'); } });
    const strict = runtime().submit(agent('strict', scripted('primary', [call('delegate', 3), final(12)]), { tools: [composed], hooks: [withhold] }), { input: 1 });
    expect(await strict.result()).not.toMatchObject({ status: 'succeeded' });
  });

  it('counts observers against the hook-call ceiling and never lets a skipped mandatory observer pass', async () => {
    const hook = (id: string) => defineHook({ id, version: '1', stage: 'afterModelCall', mandatory: true, handler: () => {} });
    const run = runtime({ maxHookCalls: 1 }).submit(agent('ceiling', scripted('primary', [final()]), { hooks: [hook('one'), hook('two')] }), { input: 1 });
    expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'GUARD_UNAVAILABLE' } });
    expect((await events(run.observe())).filter(event => event.type === 'hook.started')).toHaveLength(1);
  });

  it('validates observer definitions', () => {
    expect(() => defineHook({ id: 'x', version: '1', stage: 'afterStep', tools: [original()] as never, handler: () => {} })).toThrow(/Lifecycle hooks/);
    expect(() => defineHook({ id: 'x', version: '1', stage: 'afterStep', mandatory: 'yes' as never, handler: () => {} })).toThrow();
    expect(() => defineHook({ id: 'x', version: '1', stage: 'beforeStep', tools: [], mandatory: true, handler: () => ({ decision: 'continue' }) } as never)).toThrow();
    expect(() => defineHook({ id: 'x', version: '1', stage: 'beforeContextBuild', tools: [], handler: () => ({ decision: 'continue' }) } as never)).toThrow();
    expect(defineHook({ id: 'x', version: '1', stage: 'onFinally', handler: () => {} })).toMatchObject({ kind: 'mayura.observer-hook', stage: 'onFinally' });
    expect(defineHook({ id: 'x', version: '1', stage: 'beforeDelegate', tools: [], handler: () => ({ decision: 'continue' }) })).toMatchObject({ kind: 'mayura.control-hook' });
  });
});
