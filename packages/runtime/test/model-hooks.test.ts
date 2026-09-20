import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type JsonValue, type ModelAdapter, type ModelRequest, type ModelResponse, type RunEvent, type Schema } from '@mayura/core';
import { defineTool } from '@mayura/tools';
import { defineModerationGuard } from '../../guardrails/src/index.js';
import { createRuntime, defineAgent, defineHook, type AgentOptions, type HookEvent, type Runtime, type RuntimeLimits } from '../src/index.js';

const schema: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'model-hook-test', validate: value => ({ value: value as JsonValue }) } };
const scope = { principalId: 'principal', projectId: 'project' };
const grants = ['model:primary', 'model:moderator', 'model:child', 'tool:read', 'tool:original', 'effect:read', 'effect:write', 'agent:delegate'];
const final = (output: JsonValue = 2, costMicros = 0): ModelResponse => ({ type: 'final', output, usage: { costMicros } });
function model(id: string, generate: ModelAdapter['generate'], maxCostMicros = 0): ModelAdapter {
  return { id, capabilities: { tools: true, structuredOutput: true }, maxCostMicros, generate };
}
function agent(adapter = model('primary', async () => final()), extras: Partial<AgentOptions<typeof schema, typeof schema>> = {}) {
  return defineAgent({ id: 'agent', version: '1', instructions: 'PRIVATE SYSTEM PROMPT', input: schema, output: schema, tools: [], model: adapter, ...extras });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve };
}
const runtimes: Runtime[] = [];
function runtime(limits: RuntimeLimits = {}, allow: readonly string[] = grants): Runtime {
  const engine = createRuntime({ profile: 'ephemeral', scope, permissions: { allow }, limits: { maxDurationMs: 2_000, maxCostMicros: 100, ...limits } });
  runtimes.push(engine); return engine;
}
async function events(source: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const result: RunEvent[] = []; for await (const event of source) result.push(event); return result;
}
afterEach(async () => { await Promise.all(runtimes.splice(0).map(engine => engine.close())); vi.restoreAllMocks(); });

describe('primary-model admission hooks', () => {
  it('runs before each primary iteration with its exact frozen content projection and no private protocol fields', async () => {
    const projections: HookEvent<'beforeModelCall'>[] = []; const steps: (number | null)[] = []; const requests: ModelRequest[] = []; const order: string[] = [];
    const original = defineTool({ id: 'original', version: '1', description: 'Visible metadata.', input: schema, output: schema, inputJsonSchema: { type: 'number' }, effects: 'none', capabilities: [], execute: async () => 'PRIVATE tool result' });
    const hook = defineHook({ id: 'admission', version: '1', stage: 'beforeModelCall', tools: [], handler: (event, context) => {
      order.push(`hook:${context.step}`); projections.push(event); steps.push(context.step);
      expect(Object.isFrozen(event)).toBe(true); expect(Object.isFrozen(event.request)).toBe(true);
      expect(Object.isFrozen(event.request.messages)).toBe(true); expect(Object.isFrozen(event.request.messages[0])).toBe(true);
      expect(Object.isFrozen(event.request.tools)).toBe(true); expect(Object.isFrozen(event.request.tools[0]?.inputJsonSchema)).toBe(true);
      expect(Object.keys(event).sort()).toEqual(['modelId', 'purpose', 'request', 'stage']);
      expect(Object.keys(event.request).sort()).toEqual(['maxOutputTokens', 'messages', 'tools']);
      return { decision: 'continue' };
    } });
    const adapter = model('primary', async request => {
      order.push(`model:${requests.length}`); requests.push(request);
      return requests.length === 1 ? { type: 'tool_calls', calls: [{ id: 'first', toolId: 'original', input: 1 }], usage: { costMicros: 0 }, continuation: { secret: 'PRIVATE CONTINUATION' } } : final();
    });
    const engine = runtime({ maxSteps: 2, maxModelCalls: 2, maxHookCalls: 2, maxOutputTokens: 17 });
    const run = engine.submit(agent(adapter, { hooks: [hook], tools: [original] }), { input: { nested: 'PRIVATE input' } });
    expect((await run.result()).status).toBe('succeeded'); expect(steps).toEqual([0, 1]); expect(order).toEqual(['hook:0', 'model:0', 'hook:1', 'model:1']);
    expect(projections).toHaveLength(2);
    for (const [index, projection] of projections.entries()) {
      expect(projection).toMatchObject({ stage: 'beforeModelCall', purpose: 'primary', modelId: 'primary' });
      expect(projection.request).toEqual({ messages: requests[index]?.messages, tools: requests[index]?.tools, maxOutputTokens: 17 });
    }
    expect(projections[1]?.request.messages).toEqual(expect.arrayContaining([{ role: 'tool', callId: 'first', toolId: 'original', result: 'PRIVATE tool result' }]));
    expect(requests[1]?.continuation).toEqual({ secret: 'PRIVATE CONTINUATION' });
    expect(JSON.stringify(projections)).not.toContain('PRIVATE SYSTEM PROMPT'); expect(JSON.stringify(projections)).not.toContain('PRIVATE CONTINUATION');
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 3 });
    expect(JSON.stringify(await events(run.observe()))).not.toContain('PRIVATE');
  });

  it('blocks before the primary dispatch and refunds only its unstarted protected reservations', async () => {
    const generate = vi.fn(async () => final(2, 3));
    const hook = defineHook({ id: 'deny', version: '1', stage: 'beforeModelCall', tools: [], handler: () => ({ decision: 'block' }) });
    const engine = runtime({ maxCostMicros: 3 }); const run = engine.submit(agent(model('primary', generate, 3), { hooks: [hook] }), { input: 1 });
    expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'GUARD_BLOCKED' } }); expect(generate).not.toHaveBeenCalled();
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 0 });
  });

  it.each(['input', 'grant', 'request-bound'] as const)('does not invoke model hooks when earlier %s admission fails', async denial => {
    const handler = vi.fn(() => ({ decision: 'continue' as const })); const generate = vi.fn(async () => final());
    const hook = defineHook({ id: 'admission', version: '1', stage: 'beforeModelCall', tools: [], handler });
    const definition = agent(model('primary', generate), { hooks: [hook], ...(denial === 'input' ? { guards: { input: [{ id: 'deny', check: () => ({ decision: 'block' as const }) }] } } : {}) });
    const engine = runtime(denial === 'request-bound' ? { maxContextBytes: 64 } : {}, denial === 'grant' ? [] : grants);
    const run = engine.submit(definition, { input: 1 });
    expect((await run.result()).status).not.toBe('succeeded'); expect(handler).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 0 });
  });

  it.each(['throw', 'malformed'] as const)('fails closed on %s without later hooks or primary dispatch', async failure => {
    const generate = vi.fn(async () => final()); const later = vi.fn(() => ({ decision: 'continue' as const }));
    const first = defineHook({ id: 'first', version: '1', stage: 'beforeModelCall', tools: [], handler: () => {
      if (failure === 'throw') throw new Error('PRIVATE hook exception');
      return { decision: 'continue', replacement: { instructions: 'PRIVATE replacement' } } as never;
    } });
    const second = defineHook({ id: 'second', version: '1', stage: 'beforeModelCall', tools: [], handler: later });
    const engine = runtime(); const run = engine.submit(agent(model('primary', generate, 2), { hooks: [first, second] }), { input: 1 });
    expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'GUARD_UNAVAILABLE' } });
    expect(later).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 0 });
    expect(JSON.stringify([await run.result(), await events(run.observe())])).not.toContain('PRIVATE');
  });

  it('makes one-permit progress without recursing through input or hook-action output moderation', async () => {
    const order: string[] = []; const read = defineTool({ id: 'read', version: '1', description: 'Private read.', input: schema, output: schema, effects: 'read', capabilities: [], costMicros: 1,
      execute: async () => { order.push('action'); return 'PRIVATE discarded action result'; } });
    const handler = vi.fn(() => { order.push('hook'); return { decision: 'continue' as const, actions: [{ toolId: 'read', input: 1 }] }; });
    const hook = defineHook({ id: 'primary-policy', version: '1', stage: 'beforeModelCall', tools: [read], handler });
    const auxiliary = vi.fn(async () => { order.push('auxiliary'); return final({ decision: 'allow', categories: [] }, 1); });
    const moderation = defineModerationGuard({ id: 'moderation', version: '1', model: model('moderator', auxiliary, 1), instructions: 'PRIVATE moderation policy', egressGuards: [] });
    const generate = vi.fn(async (request: ModelRequest) => {
      order.push('primary'); expect(request.messages).toEqual([{ role: 'user', content: 1 }]); expect(request.tools).toEqual([]); return final(2, 1);
    });
    const engine = runtime({ maxConcurrentOperations: 1, maxSteps: 1, maxHookCalls: 1, maxModelCalls: 4, maxToolCalls: 1, maxCostMicros: 5 });
    const run = engine.submit(agent(model('primary', generate, 1), { hooks: [hook], guards: { input: [moderation], output: [moderation] } }), { input: 1 });
    expect(await run.result()).toMatchObject({ status: 'succeeded', output: 2 });
    expect(order).toEqual(['auxiliary', 'hook', 'action', 'auxiliary', 'primary', 'auxiliary']); expect(handler).toHaveBeenCalledTimes(1);
    expect(auxiliary).toHaveBeenCalledTimes(3); expect(generate).toHaveBeenCalledTimes(1);
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 5, reservedMicros: 0, calls: 5 });
    const observed = await events(run.observe()); const hookEvents = observed.filter(event => event.type === 'hook.started' || event.type === 'hook.completed');
    expect(hookEvents).toHaveLength(2); expect(hookEvents[0]?.metadata).toMatchObject({ stage: 'beforeModelCall', step: 0, attempt: 1 });
    expect(hookEvents[1]?.metadata).toEqual({ ...hookEvents[0]?.metadata, status: 'continued' });
    expect(JSON.stringify(observed)).not.toContain('PRIVATE');
  });

  it('protects primary and output-check money against hook actions before their executor starts', async () => {
    const execute = vi.fn(async () => 1); const generate = vi.fn(async () => final(2, 3)); const auxiliary = vi.fn(async () => final({ decision: 'allow', categories: [] }, 2));
    const read = defineTool({ id: 'read', version: '1', description: 'Read.', input: schema, output: schema, effects: 'read', capabilities: [], costMicros: 1, execute });
    const handler = vi.fn(() => ({ decision: 'continue' as const, actions: [{ toolId: 'read', input: 1 }] }));
    const hook = defineHook({ id: 'policy', version: '1', stage: 'beforeModelCall', tools: [read], handler });
    const moderation = defineModerationGuard({ id: 'moderation', version: '1', model: model('moderator', auxiliary, 2), instructions: 'Policy.', egressGuards: [] });
    const engine = runtime({ maxCostMicros: 7 });
    const run = engine.submit(agent(model('primary', generate, 3), { hooks: [hook], guards: { output: [moderation] } }), { input: 1 });
    expect(await run.result()).toMatchObject({ error: { code: 'BUDGET_EXCEEDED' } }); expect(handler).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled(); expect(auxiliary).not.toHaveBeenCalled();
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 0 });
  });

  it('protects free primary and output-check model slots from a hook action requiring another check', async () => {
    const execute = vi.fn(async () => 1); const generate = vi.fn(async () => final()); const auxiliary = vi.fn(async () => final({ decision: 'allow', categories: [] }));
    const read = defineTool({ id: 'read', version: '1', description: 'Read.', input: schema, output: schema, effects: 'none', capabilities: [], execute });
    const hook = defineHook({ id: 'policy', version: '1', stage: 'beforeModelCall', tools: [read], handler: () => ({ decision: 'continue', actions: [{ toolId: 'read', input: 1 }] }) });
    const moderation = defineModerationGuard({ id: 'moderation', version: '1', model: model('moderator', auxiliary), instructions: 'Policy.', egressGuards: [] });
    const engine = runtime({ maxCostMicros: 0, maxModelCalls: 2 });
    const run = engine.submit(agent(model('primary', generate), { hooks: [hook], guards: { output: [moderation] } }), { input: 1 });
    expect(await run.result()).toMatchObject({ error: { code: 'LIMIT_EXCEEDED' } });
    expect(execute).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled(); expect(auxiliary).not.toHaveBeenCalled();
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 0 });
  });

  it('shares ancestor hook limits without turning a child hold into a dispatched model call', async () => {
    const started = deferred<void>(); const done = deferred<ModelResponse>(); const handler = vi.fn(() => ({ decision: 'continue' as const }));
    const hook = defineHook({ id: 'shared', version: '1', stage: 'beforeModelCall', tools: [], handler });
    const engine = runtime({ maxHookCalls: 1 });
    const parent = engine.submit(agent(model('primary', () => { started.resolve(); return done.promise; }), { id: 'parent', hooks: [hook] }), { input: 1 });
    try {
      await started.promise; const generate = vi.fn(async () => final(2, 3));
      const child = engine.spawn(parent, agent(model('child', generate, 3), { id: 'child', hooks: [hook] }), { input: 1, permissions: { allow: grants } });
      expect(await child.result()).toMatchObject({ error: { code: 'LIMIT_EXCEEDED' } }); expect(handler).toHaveBeenCalledTimes(1); expect(generate).not.toHaveBeenCalled();
      expect(engine.inspect(parent).budget).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 1 });
    } finally { done.resolve(final()); await parent.result(); }
  });

  it('reserves under the narrowed child money ceiling before invoking its reused hook', async () => {
    const started = deferred<void>(); const done = deferred<ModelResponse>(); const handler = vi.fn(() => ({ decision: 'continue' as const }));
    const hook = defineHook({ id: 'shared', version: '1', stage: 'beforeModelCall', tools: [], handler });
    const engine = runtime();
    const parent = engine.submit(agent(model('primary', () => { started.resolve(); return done.promise; }), { id: 'parent', hooks: [hook] }), { input: 1 });
    try {
      await started.promise; const generate = vi.fn(async () => final(2, 2));
      const child = engine.spawn(parent, agent(model('child', generate, 2), { id: 'child', hooks: [hook] }), { input: 1, permissions: { allow: grants }, limits: { maxCostMicros: 1 } });
      expect(await child.result()).toMatchObject({ error: { code: 'BUDGET_EXCEEDED' } }); expect(handler).toHaveBeenCalledTimes(1); expect(generate).not.toHaveBeenCalled();
      expect(engine.inspect(parent).budget).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 1 });
    } finally { done.resolve(final()); await parent.result(); }
  });

  it('retains callback capacity after timeout but cancels primary holds and suppresses all late actions', async () => {
    const started = deferred<void>(); const done = deferred<void>(); const execute = vi.fn(async () => 1); const generate = vi.fn(async () => final(2, 3));
    const read = defineTool({ id: 'read', version: '1', description: 'Read.', input: schema, output: schema, effects: 'read', capabilities: [], execute });
    const firstHook = defineHook({ id: 'first', version: '1', stage: 'beforeModelCall', tools: [read], timeoutMs: 25, handler: async () => {
      started.resolve(); await done.promise; return { decision: 'continue', actions: [{ toolId: 'read', input: 1 }] };
    } });
    const secondHandler = vi.fn(() => ({ decision: 'continue' as const }));
    const secondHook = defineHook({ id: 'second', version: '1', stage: 'beforeModelCall', tools: [], handler: secondHandler });
    const engine = runtime({ maxConcurrentOperations: 1, maxConcurrentRuns: 1 });
    const first = engine.submit(agent(model('primary', generate, 3), { hooks: [firstHook] }), { input: 1 });
    try {
      await started.promise; const initial = await first.result(); expect(initial).toMatchObject({ error: { code: 'TIMEOUT' } });
      expect(engine.inspect(first).budget).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 0 });
      const second = engine.submit(agent(undefined, { hooks: [secondHook] }), { input: 1 });
      await delay(35); expect(secondHandler).not.toHaveBeenCalled();
      done.resolve(); expect((await second.result()).status).toBe('succeeded');
      expect(execute).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled(); expect(await first.result()).toBe(initial);
      const completed = (await events(first.observe())).filter(event => event.type === 'hook.completed');
      expect(completed).toHaveLength(1); expect(completed[0]?.metadata['status']).not.toBe('continued');
    } finally { done.resolve(); }
  });

  it('preserves an uncertain hook read and its late cost while cancelling only never-started primary holds', async () => {
    const started = deferred<void>(); const done = deferred<JsonValue>(); const generate = vi.fn(async () => final(2, 4));
    const read = defineTool({ id: 'read', version: '1', description: 'Read.', input: schema, output: schema, effects: 'read', capabilities: [], costMicros: 3,
      execute: () => { started.resolve(); return done.promise; } });
    const hook = defineHook({ id: 'read', version: '1', stage: 'beforeModelCall', tools: [read], timeoutMs: 25, handler: () => ({ decision: 'continue', actions: [{ toolId: 'read', input: 1 }] }) });
    const engine = runtime({ maxCostMicros: 7 }); const run = engine.submit(agent(model('primary', generate, 4), { hooks: [hook] }), { input: 1 });
    try {
      await started.promise; const initial = await run.result(); const serialized = JSON.stringify(initial);
      expect(initial).toMatchObject({ status: 'outcome_unknown', receipt: { toolId: 'read', execution: 'unknown', disclosure: 'withheld' } });
      expect(initial.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ runId: run.id, receipt: expect.objectContaining({ toolId: 'read', execution: 'unknown' }) })]));
      expect(engine.inspect(run).budget).toEqual({ spentMicros: 0, reservedMicros: 3, calls: 1 });
      done.resolve('PRIVATE late content'); await nextTurn(); await nextTurn();
      expect(engine.inspect(run).budget).toEqual({ spentMicros: 3, reservedMicros: 0, calls: 1 });
      expect(engine.inspect(run).evidence).toEqual(expect.arrayContaining([expect.objectContaining({ receipt: expect.objectContaining({ execution: 'succeeded', disclosure: 'withheld' }) })]));
      expect(await run.result()).toBe(initial); expect(JSON.stringify(initial)).toBe(serialized); expect(generate).not.toHaveBeenCalled();
      expect(JSON.stringify(await events(run.observe()))).not.toContain('PRIVATE');
    } finally { done.resolve(1); }
  });

  it('keeps completed action cost and evidence if a later model hook blocks the still-unstarted primary', async () => {
    const generate = vi.fn(async () => final(2, 3));
    const read = defineTool({ id: 'read', version: '1', description: 'Read.', input: schema, output: schema, effects: 'read', capabilities: [], costMicros: 2, execute: async () => 1 });
    const first = defineHook({ id: 'first', version: '1', stage: 'beforeModelCall', tools: [read], handler: () => ({ decision: 'continue', actions: [{ toolId: 'read', input: 1 }] }) });
    const second = defineHook({ id: 'second', version: '1', stage: 'beforeModelCall', tools: [], handler: () => ({ decision: 'block' }) });
    const engine = runtime({ maxCostMicros: 5 }); const run = engine.submit(agent(model('primary', generate, 3), { hooks: [first, second] }), { input: 1 });
    const outcome = await run.result(); expect(outcome).toMatchObject({ status: 'blocked', error: { code: 'GUARD_BLOCKED' } });
    expect(outcome.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ runId: run.id, receipt: expect.objectContaining({ toolId: 'read', execution: 'succeeded' }) })]));
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 2, reservedMicros: 0, calls: 1 }); expect(generate).not.toHaveBeenCalled();
  });
});
