import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Guard, type JsonValue, type ModelAdapter, type ModelRequest, type ModelResponse, type RunEvent, type Schema } from '@mayura/core';
import { defineTool } from '@mayura/tools';
import { defineModerationGuard } from '../../guardrails/src/index.js';
import { createRuntime, defineAgent, defineHook, type AgentOptions, type Runtime, type RuntimeLimits } from '../src/index.js';

const jsonSchema: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'hook-execution-test', validate: value => ({ value: value as JsonValue }) } };
const scope = { principalId: 'hook-principal', projectId: 'hook-project' };
const grants = ['model:primary', 'model:moderator', 'model:child', 'tool:read', 'tool:original', 'tool:second', 'effect:read', 'effect:write', 'agent:delegate'];
const final = (output: JsonValue = 2, costMicros = 0): ModelResponse => ({ type: 'final', output, usage: { costMicros } });
const call = (input: JsonValue = 1): ModelResponse => ({ type: 'tool_calls', calls: [{ id: 'call.1', toolId: 'original', input }], usage: { costMicros: 0 } });
function model(id: string, generate: ModelAdapter['generate'], maxCostMicros = 0): ModelAdapter {
  return { id, capabilities: { tools: true, structuredOutput: true }, maxCostMicros, generate };
}
function agent(adapter = model('primary', async () => final()), extras: Partial<AgentOptions<typeof jsonSchema, typeof jsonSchema>> = {}) {
  return defineAgent({ id: 'agent', version: '1', instructions: 'PRIVATE instructions.', input: jsonSchema, output: jsonSchema, tools: [], model: adapter, ...extras });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
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

describe('required lifecycle hook execution', () => {
  it('runs admitted input guards, ordered hooks and the primary in that order', async () => {
    const seen: string[] = [];
    const guard: Guard = { id: 'input', check: () => { seen.push('guard'); return { decision: 'allow' }; } };
    const first = defineHook({ id: 'first', version: '1', stage: 'beforeExecution', tools: [], handler: (event, context) => {
      seen.push('first'); expect(event).toEqual({ stage: 'beforeExecution', input: { private: 1 } });
      expect(Object.isFrozen(event)).toBe(true); expect(Object.isFrozen(event.input)).toBe(true);
      expect(Object.isFrozen(context)).toBe(true); expect(context).toMatchObject({ agentId: 'agent', scope, step: null, attempt: 1 });
      expect(Object.keys(context).sort()).toEqual(['agentId', 'attempt', 'hookId', 'hookVersion', 'invocationId', 'rootId', 'runId', 'scope', 'signal', 'step'].sort());
      return { decision: 'continue' };
    } });
    const second = defineHook({ id: 'second', version: '1', stage: 'beforeExecution', tools: [], handler: () => { seen.push('second'); return { decision: 'continue' }; } });
    const engine = runtime({ maxHookCalls: 2, maxConcurrentOperations: 1 });
    const run = engine.submit(agent(model('primary', async () => { seen.push('primary'); return final(); }), { guards: { input: [guard] }, hooks: [first, second] }), { input: { private: 1 } });
    expect(await run.result()).toMatchObject({ status: 'succeeded', output: 2 });
    expect(seen).toEqual(['guard', 'first', 'second', 'primary']);
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 1 });
    const observed = await events(run.observe());
    expect(observed.filter(event => event.type === 'model.started')).toHaveLength(1);
    const started = observed.filter(event => event.type === 'hook.started');
    const completed = observed.filter(event => event.type === 'hook.completed');
    expect(started).toHaveLength(2); expect(completed).toHaveLength(2);
    for (const [index, event] of started.entries()) {
      expect(event.metadata).toMatchObject({ hookId: index === 0 ? 'first' : 'second', hookVersion: '1', stage: 'beforeExecution', step: 0, attempt: 1 });
      expect(event.metadata['invocationId']).toMatch(/^[0-9a-f-]{36}$/);
      expect(completed[index]?.metadata).toEqual({ ...event.metadata, status: 'continued' });
      expect(event.runId).toBe(run.id);
    }
    expect(started[0]?.metadata['invocationId']).not.toBe(started[1]?.metadata['invocationId']);
    expect(JSON.stringify(observed)).not.toContain('private');
  });

  it('does not invoke a hook or primary after required input rejection', async () => {
    const handler = vi.fn(() => ({ decision: 'continue' as const })); const generate = vi.fn(async () => final());
    const hook = defineHook({ id: 'policy', version: '1', stage: 'beforeExecution', tools: [], handler });
    const guard: Guard = { id: 'input', check: () => ({ decision: 'block' }) };
    const run = runtime().submit(agent(model('primary', generate), { hooks: [hook], guards: { input: [guard] } }), { input: 1 });
    expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'GUARD_BLOCKED' } });
    expect(handler).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
  });

  it('blocks a proposed original tool before any effects or later hook callback', async () => {
    const execute = vi.fn(async () => 1); const later = vi.fn(() => ({ decision: 'continue' as const }));
    const original = defineTool({ id: 'original', version: '1', description: 'Original write.', input: jsonSchema, output: jsonSchema, effects: 'write', capabilities: [], execute });
    const block = defineHook({ id: 'block', version: '1', stage: 'beforeToolCall', tools: [], handler: event => {
      expect(event).toEqual({ stage: 'beforeToolCall', phase: 'proposal', proposal: { callId: 'call.1', toolId: 'original', input: 1 } });
      return { decision: 'block' };
    } });
    const tail = defineHook({ id: 'tail', version: '1', stage: 'beforeToolCall', tools: [], handler: later });
    const generate = vi.fn(async () => call()); const engine = runtime();
    const run = engine.submit(agent(model('primary', generate), { tools: [original], hooks: [block, tail] }), { input: 1 });
    expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'GUARD_BLOCKED' } });
    expect(execute).not.toHaveBeenCalled(); expect(later).not.toHaveBeenCalled(); expect(generate).toHaveBeenCalledTimes(1);
    expect(engine.inspect(run).budget.reservedMicros).toBe(0);
  });

  it('runs a privately registered read action on the real account with one permit', async () => {
    const execute = vi.fn(async () => false);
    const read = defineTool({ id: 'read', version: '1', description: 'Read policy.', input: jsonSchema, output: jsonSchema, effects: 'read', capabilities: [], costMicros: 3, execute });
    const handler = vi.fn(() => ({ decision: 'continue' as const, actions: [{ toolId: 'read', input: 1 }] }));
    const hook = defineHook({ id: 'precondition', version: '1', stage: 'beforeExecution', tools: [read], handler });
    const generate = vi.fn(async (request: ModelRequest) => { expect(request.tools).toEqual([]); return final(2, 2); });
    const engine = runtime({ maxCostMicros: 5, maxConcurrentOperations: 1, maxToolCalls: 1, maxModelCalls: 1, maxHookCalls: 1 });
    const run = engine.submit(agent(model('primary', generate, 2), { hooks: [hook] }), { input: 1 });
    expect(await run.result()).toMatchObject({ status: 'succeeded', output: 2 });
    expect(handler).toHaveBeenCalledTimes(1); expect(execute).toHaveBeenCalledTimes(1); expect(generate).toHaveBeenCalledTimes(1);
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 5, reservedMicros: 0, calls: 2 });
  });

  it('exposes the frozen raw proposal rather than claiming schema-transformed executor input', async () => {
    const seen: JsonValue[] = []; const execute = vi.fn(async (input: JsonValue) => { seen.push(input); return 7; });
    const transformed: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'transform', validate: () => ({ value: 7 }) } };
    const original = defineTool({ id: 'original', version: '1', description: 'Transforming input.', input: transformed, output: jsonSchema, effects: 'none', capabilities: [], execute });
    const hook = defineHook({ id: 'proposal', version: '1', stage: 'beforeToolCall', tools: [], handler: event => {
      expect(Object.isFrozen(event.proposal)).toBe(true); expect(Object.isFrozen(event.proposal.input)).toBe(true);
      seen.push(event.proposal.input); return { decision: 'continue' };
    } });
    let calls = 0;
    const run = runtime().submit(agent(model('primary', async () => ++calls === 1 ? call({ original: 'PRIVATE proposal' }) : final()), { tools: [original], hooks: [hook] }), { input: 1 });
    expect((await run.result()).status).toBe('succeeded'); expect(seen).toEqual([{ original: 'PRIVATE proposal' }, 7]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('runs output hooks after mandatory guards and preserves a successful write as withheld', async () => {
    const seen: string[] = []; const execute = vi.fn(async () => { seen.push('execute'); return { secret: 'PRIVATE tool output' }; });
    const original = defineTool({ id: 'original', version: '1', description: 'Write.', input: jsonSchema, output: jsonSchema, effects: 'write', capabilities: [], costMicros: 3, execute });
    const guard: Guard = { id: 'output', check: () => { seen.push('guard'); return { decision: 'allow' }; } };
    const hook = defineHook({ id: 'release', version: '1', stage: 'beforeOutputRelease', tools: [], handler: event => {
      seen.push('hook'); expect(event).toMatchObject({ source: 'tool', toolId: 'original', callId: 'call.1', candidate: { secret: 'PRIVATE tool output' } });
      return { decision: 'block' };
    } });
    const generate = vi.fn(async () => call()); const engine = runtime();
    const run = engine.submit(agent(model('primary', generate), { tools: [original], guards: { output: [guard] }, hooks: [hook] }), { input: 1 });
    const result = await run.result();
    expect(result).toMatchObject({ status: 'blocked', error: { code: 'GUARD_BLOCKED' }, receipt: { toolId: 'original', execution: 'succeeded', disclosure: 'withheld' } });
    expect(result.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ runId: run.id, receipt: expect.objectContaining({ toolId: 'original', execution: 'succeeded', disclosure: 'withheld' }) })]));
    expect(seen).toEqual(['execute', 'guard', 'hook']); expect(generate).toHaveBeenCalledTimes(1);
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 3, reservedMicros: 0, calls: 2 });
    expect(JSON.stringify([result, await events(run.observe())])).not.toContain('PRIVATE tool output');
  });

  it('never invokes a release hook after an earlier output guard denies the candidate', async () => {
    const handler = vi.fn(() => ({ decision: 'continue' as const }));
    const hook = defineHook({ id: 'release', version: '1', stage: 'beforeOutputRelease', tools: [], handler });
    const run = runtime().submit(agent(undefined, { hooks: [hook], guards: { output: [{ id: 'deny', check: () => ({ decision: 'block' }) }] } }), { input: 1 });
    expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'GUARD_BLOCKED' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('keeps inspection disclosure withheld while a required output hook is still pending', async () => {
    const started = deferred<void>(); const done = deferred<void>();
    const original = defineTool({ id: 'original', version: '1', description: 'Write.', input: jsonSchema, output: jsonSchema, effects: 'write', capabilities: [], execute: async () => 1 });
    const hook = defineHook({ id: 'release', version: '1', stage: 'beforeOutputRelease', tools: [], handler: async event => {
      if (event.source === 'tool') { started.resolve(); await done.promise; }
      return { decision: 'continue' };
    } });
    let calls = 0; const engine = runtime();
    const run = engine.submit(agent(model('primary', async () => ++calls === 1 ? call() : final()), { tools: [original], hooks: [hook] }), { input: 1 });
    try {
      await started.promise;
      expect(engine.inspect(run).evidence).toEqual([{ runId: run.id, receipt: { toolId: 'original', callId: 'call.1', execution: 'succeeded', disclosure: 'withheld' } }]);
      done.resolve(); expect((await run.result()).status).toBe('succeeded');
      expect(engine.inspect(run).evidence).toEqual([{ runId: run.id, receipt: { toolId: 'original', callId: 'call.1', execution: 'succeeded', disclosure: 'released' } }]);
    } finally { done.resolve(); }
  });

  it('does not invoke before-tool hooks for a batch rejected during complete model-tool preflight', async () => {
    const handler = vi.fn(() => ({ decision: 'continue' as const })); const execute = vi.fn(async () => 1);
    const original = defineTool({ id: 'original', version: '1', description: 'Write.', input: jsonSchema, output: jsonSchema, effects: 'write', capabilities: [], execute });
    const hook = defineHook({ id: 'before', version: '1', stage: 'beforeToolCall', tools: [], handler });
    const response: ModelResponse = { type: 'tool_calls', calls: [{ id: 'first', toolId: 'original', input: 1 }, { id: 'second', toolId: 'missing', input: 1 }], usage: { costMicros: 0 } };
    const run = runtime().submit(agent(model('primary', async () => response), { tools: [original], hooks: [hook] }), { input: 1 });
    expect((await run.result()).status).not.toBe('succeeded'); expect(execute).not.toHaveBeenCalled(); expect(handler).not.toHaveBeenCalled();
  });

  it('withholds a guarded final candidate when its required release hook blocks', async () => {
    const seen: string[] = [];
    const hook = defineHook({ id: 'release', version: '1', stage: 'beforeOutputRelease', tools: [], handler: event => {
      seen.push('hook'); expect(event).toMatchObject({ source: 'agent', candidate: 'PRIVATE final' }); return { decision: 'block' };
    } });
    const run = runtime().submit(agent(model('primary', async () => final('PRIVATE final')), { hooks: [hook], guards: { output: [{ id: 'guard', check: () => { seen.push('guard'); return { decision: 'allow' }; } }] } }), { input: 1 });
    const result = await run.result(); expect(result).toMatchObject({ status: 'blocked', error: { code: 'GUARD_BLOCKED' } });
    expect('output' in result).toBe(false); expect(seen).toEqual(['guard', 'hook']); expect(JSON.stringify(await events(run.observe()))).not.toContain('PRIVATE final');
  });

  it('guards action output through the same managed barrier without recursive hooks or model-visible helper tools', async () => {
    const stages: string[] = []; const execute = vi.fn(async () => 'PRIVATE action result');
    const read = defineTool({ id: 'read', version: '1', description: 'Read.', input: jsonSchema, output: jsonSchema, effects: 'read', capabilities: [], costMicros: 2, execute });
    const start = defineHook({ id: 'start', version: '1', stage: 'beforeExecution', tools: [read], handler: () => {
      stages.push('start'); return { decision: 'continue', actions: [{ toolId: 'read', input: 'PRIVATE action input' }] };
    } });
    const before = defineHook({ id: 'before', version: '1', stage: 'beforeToolCall', tools: [], handler: () => { stages.push('before'); return { decision: 'continue' }; } });
    const output = defineHook({ id: 'output', version: '1', stage: 'beforeOutputRelease', tools: [], handler: event => { stages.push(`output:${event.source}`); return { decision: 'continue' }; } });
    const auxiliary = vi.fn(async () => final({ decision: 'allow', categories: [] }, 2));
    const guard = defineModerationGuard({ id: 'moderation', version: '1', model: model('moderator', auxiliary, 2), instructions: 'PRIVATE policy.', egressGuards: [] });
    const engine = runtime({ maxConcurrentOperations: 1, maxCostMicros: 7, maxModelCalls: 3, maxToolCalls: 1, maxSteps: 1 });
    const run = engine.submit(agent(model('primary', async (request) => { expect(request.tools).toEqual([]); return final(2, 1); }, 1), { hooks: [start, before, output], guards: { output: [guard] } }), { input: 1 });
    expect(await run.result()).toMatchObject({ status: 'succeeded', output: 2 }); expect(stages).toEqual(['start', 'output:agent']);
    expect(auxiliary).toHaveBeenCalledTimes(2); expect(execute).toHaveBeenCalledTimes(1);
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 7, reservedMicros: 0, calls: 4 });
    const evidence = engine.inspect(run).evidence; expect(evidence).toHaveLength(1);
    expect(evidence[0]?.receipt.callId).toMatch(/^hook:[0-9a-f-]+:0$/);
    expect(JSON.stringify(await events(run.observe()))).not.toContain('PRIVATE');
  });
});

describe('hook action admission and protected accounting', () => {
  it('uses the exact hook registration even when the model catalog has a different tool with the same ID', async () => {
    const selected = vi.fn(async () => 1); const unrelated = vi.fn(async () => 2);
    const read = defineTool({ id: 'read', version: 'hook', description: 'Exact hook registration.', input: jsonSchema, output: jsonSchema, effects: 'read', capabilities: [], costMicros: 2, execute: selected });
    const other = defineTool({ id: 'read', version: 'model', description: 'Different model registration.', input: jsonSchema, output: jsonSchema, effects: 'read', capabilities: [], costMicros: 99, execute: unrelated });
    const hook = defineHook({ id: 'exact', version: '1', stage: 'beforeExecution', tools: [read], handler: () => ({ decision: 'continue', actions: [{ toolId: 'read', input: 1 }] }) });
    const engine = runtime({ maxCostMicros: 2 });
    const run = engine.submit(agent(undefined, { hooks: [hook], tools: [other] }), { input: 1 });
    expect((await run.result()).status).toBe('succeeded'); expect(selected).toHaveBeenCalledTimes(1); expect(unrelated).not.toHaveBeenCalled();
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 2, reservedMicros: 0, calls: 2 });
  });

  it('blocks on an action-output moderation failure without releasing content or starting later work', async () => {
    const execute = vi.fn(async () => 'PRIVATE action result'); const primary = vi.fn(async () => final());
    const read = defineTool({ id: 'read', version: '1', description: 'Read.', input: jsonSchema, output: jsonSchema, effects: 'read', capabilities: [], costMicros: 2, execute });
    const hook = defineHook({ id: 'precondition', version: '1', stage: 'beforeExecution', tools: [read], handler: () => ({ decision: 'continue', actions: [{ toolId: 'read', input: 1 }, { toolId: 'read', input: 2 }] }) });
    const auxiliary = vi.fn(async () => final({ decision: 'block', categories: [] }, 3));
    const guard = defineModerationGuard({ id: 'moderation', version: '1', model: model('moderator', auxiliary, 3), instructions: 'Policy.', egressGuards: [] });
    const engine = runtime({ maxCostMicros: 5, maxConcurrentOperations: 1 });
    const run = engine.submit(agent(model('primary', primary), { hooks: [hook], guards: { output: [guard] } }), { input: 1 });
    expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'GUARD_BLOCKED' }, receipt: { toolId: 'read', execution: 'succeeded', disclosure: 'withheld' } });
    expect(execute).toHaveBeenCalledTimes(1); expect(auxiliary).toHaveBeenCalledTimes(1); expect(primary).not.toHaveBeenCalled();
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 5, reservedMicros: 0, calls: 2 });
    expect(JSON.stringify([await run.result(), await events(run.observe())])).not.toContain('PRIVATE');
  });

  it.each(['actions', 'bytes'] as const)('rejects a result beyond the captured %s limit before dispatch', async bound => {
    const execute = vi.fn(async () => 1);
    const read = defineTool({ id: 'read', version: '1', description: 'Read.', input: jsonSchema, output: jsonSchema, effects: 'none', capabilities: [], execute });
    const hook = defineHook({ id: 'bounded', version: '1', stage: 'beforeExecution', tools: [read], maxActions: 1, maxResultBytes: 128,
      handler: () => ({ decision: 'continue', actions: bound === 'actions' ? [{ toolId: 'read', input: 1 }, { toolId: 'read', input: 2 }] : [{ toolId: 'read', input: 'x'.repeat(129) }] }) });
    const run = runtime().submit(agent(undefined, { hooks: [hook] }), { input: 1 });
    expect(await run.result()).toMatchObject({ error: { code: 'GUARD_UNAVAILABLE' } }); expect(execute).not.toHaveBeenCalled();
  });

  it.each(['missing-tool-grant', 'missing-effect-grant', 'missing-capability'] as const)('does not grant an action through catalog registration: %s', async missing => {
    const execute = vi.fn(async () => 1); const primary = vi.fn(async () => final());
    const read = defineTool({ id: 'read', version: '1', description: 'Read.', input: jsonSchema, output: jsonSchema, effects: 'read', capabilities: ['project:read'], execute });
    const hook = defineHook({ id: 'read', version: '1', stage: 'beforeExecution', tools: [read], handler: () => ({ decision: 'continue', actions: [{ toolId: 'read', input: 1 }] }) });
    const denied = missing === 'missing-tool-grant' ? 'tool:read' : missing === 'missing-effect-grant' ? 'effect:read' : 'project:read';
    const engine = runtime({}, [...grants, 'project:read'].filter(grant => grant !== denied));
    const run = engine.submit(agent(model('primary', primary), { hooks: [hook] }), { input: 1 });
    expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'PERMISSION_DENIED' } });
    expect(execute).not.toHaveBeenCalled(); expect(primary).not.toHaveBeenCalled();
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 0 });
  });

  it.each(['unknown', 'permission', 'schema'] as const)('preflights the entire action list before its first dispatch: %s', async invalid => {
    const first = vi.fn(async () => 1); const second = vi.fn(async () => 1);
    const read = defineTool({ id: 'read', version: '1', description: 'First.', input: jsonSchema, output: jsonSchema, effects: 'none', capabilities: [], execute: first });
    const bad: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'reject', validate: () => ({ issues: [{ message: 'PRIVATE schema' }] }) } };
    const other = defineTool({ id: 'second', version: '1', description: 'Second.', input: invalid === 'schema' ? bad : jsonSchema, output: jsonSchema, effects: 'none', capabilities: [], execute: second });
    const hook = defineHook({ id: 'batch', version: '1', stage: 'beforeExecution', tools: [read, other], handler: () => ({ decision: 'continue', actions: [{ toolId: 'read', input: 1 }, { toolId: invalid === 'unknown' ? 'missing' : 'second', input: 2 }] }) });
    const engine = runtime({}, grants.filter(grant => invalid !== 'permission' || grant !== 'tool:second'));
    const run = engine.submit(agent(undefined, { hooks: [hook] }), { input: 1 });
    expect((await run.result()).status).not.toBe('succeeded'); expect(first).not.toHaveBeenCalled(); expect(second).not.toHaveBeenCalled();
    expect(engine.inspect(run).budget.calls).toBe(0); expect(JSON.stringify(await run.result())).not.toContain('PRIVATE');
  });

  it.each([
    { decision: 'block', actions: [{ toolId: 'read', input: 1 }] },
    { decision: 'continue', replacement: 2, actions: [{ toolId: 'read', input: 1 }] },
    { decision: 'continue', actions: [{ toolId: 'read', input: 1 }, { toolId: 'read' }] },
    { get decision() { throw new Error('PRIVATE getter'); } },
  ])('rejects the entire malformed callback result without dispatch: %#', async result => {
    const execute = vi.fn(async () => 1);
    const read = defineTool({ id: 'read', version: '1', description: 'Read.', input: jsonSchema, output: jsonSchema, effects: 'none', capabilities: [], execute });
    const hook = defineHook({ id: 'malformed', version: '1', stage: 'beforeExecution', tools: [read], handler: () => result as never });
    const run = runtime().submit(agent(undefined, { hooks: [hook] }), { input: 1 });
    expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'GUARD_UNAVAILABLE' } });
    expect(execute).not.toHaveBeenCalled(); expect(JSON.stringify(await run.result())).not.toContain('PRIVATE');
  });

  it('does not let a hook action steal the original tool and mandatory output-check holds', async () => {
    const execute = vi.fn(async () => 1); const action = vi.fn(async () => 2); const auxiliary = vi.fn(async () => final({ decision: 'allow', categories: [] }, 2));
    const original = defineTool({ id: 'original', version: '1', description: 'Original.', input: jsonSchema, output: jsonSchema, effects: 'write', capabilities: [], costMicros: 3, execute });
    const read = defineTool({ id: 'read', version: '1', description: 'Action.', input: jsonSchema, output: jsonSchema, effects: 'read', capabilities: [], costMicros: 1, execute: action });
    const hook = defineHook({ id: 'before', version: '1', stage: 'beforeToolCall', tools: [read], handler: () => ({ decision: 'continue', actions: [{ toolId: 'read', input: 1 }] }) });
    const guard = defineModerationGuard({ id: 'moderation', version: '1', model: model('moderator', auxiliary, 2), instructions: 'Policy.', egressGuards: [] });
    const engine = runtime({ maxCostMicros: 7 });
    const run = engine.submit(agent(model('primary', async () => call()), { hooks: [hook], tools: [original], guards: { output: [guard] } }), { input: 1 });
    expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'BUDGET_EXCEEDED' } });
    expect(execute).not.toHaveBeenCalled(); expect(action).not.toHaveBeenCalled(); expect(auxiliary).not.toHaveBeenCalled();
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 1 });
  });

  it('counts free hook actions as real tool attempts while preserving the original held tool slot', async () => {
    const execute = vi.fn(async () => 1);
    const original = defineTool({ id: 'original', version: '1', description: 'Original.', input: jsonSchema, output: jsonSchema, effects: 'none', capabilities: [], execute });
    const read = defineTool({ id: 'read', version: '1', description: 'Read.', input: jsonSchema, output: jsonSchema, effects: 'none', capabilities: [], execute });
    const hook = defineHook({ id: 'before', version: '1', stage: 'beforeToolCall', tools: [read], handler: () => ({ decision: 'continue', actions: [{ toolId: 'read', input: 1 }] }) });
    const engine = runtime({ maxToolCalls: 1, maxCostMicros: 0 });
    const run = engine.submit(agent(model('primary', async () => call()), { hooks: [hook], tools: [original] }), { input: 1 });
    expect(await run.result()).toMatchObject({ error: { code: 'LIMIT_EXCEEDED' } }); expect(execute).not.toHaveBeenCalled();
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 1 });
  });
});

describe('hook ownership and finite ancestor limits', () => {
  it('counts actual callbacks against every ancestor while reusing exact definitions with fresh contexts', async () => {
    const parentStarted = deferred<void>(); const parentDone = deferred<ModelResponse>(); const contexts: { runId: string; rootId: string; parentId?: string }[] = [];
    const hook = defineHook({ id: 'shared', version: '1', stage: 'beforeExecution', tools: [], handler: (_event, context) => {
      contexts.push(context); return { decision: 'continue' };
    } });
    const engine = runtime({ maxHookCalls: 2 });
    const parent = engine.submit(agent(model('primary', () => { parentStarted.resolve(); return parentDone.promise; }), { id: 'parent', hooks: [hook] }), { input: 1 });
    try {
      await parentStarted.promise;
      const first = engine.spawn(parent, agent(model('child', async () => final()), { id: 'first', hooks: [hook] }), { input: 1, permissions: { allow: grants }, limits: { maxHookCalls: 1 } });
      expect((await first.result()).status).toBe('succeeded');
      const generate = vi.fn(async () => final());
      const second = engine.spawn(parent, agent(model('child', generate), { id: 'second', hooks: [hook] }), { input: 1, permissions: { allow: grants } });
      expect(await second.result()).toMatchObject({ error: { code: 'LIMIT_EXCEEDED' } }); expect(generate).not.toHaveBeenCalled();
      expect(contexts).toHaveLength(2);
      expect(contexts[0]).toMatchObject({ runId: parent.id, rootId: parent.id });
      expect(contexts[1]).toMatchObject({ runId: first.id, rootId: parent.id, parentId: parent.id });
      expect(engine.inspect(parent).budget.calls).toBe(2);
    } finally { parentDone.resolve(final()); await parent.result(); }
  });

  it('does not reuse broader hook action authority in a child with narrower grants', async () => {
    const parentStarted = deferred<void>(); const parentDone = deferred<ModelResponse>(); const executions: { runId: string; scope: typeof scope }[] = [];
    const read = defineTool({ id: 'read', version: '1', description: 'Read.', input: jsonSchema, output: jsonSchema, effects: 'read', capabilities: [], costMicros: 2,
      execute: (_input, context) => { executions.push({ runId: context.runId, scope: context.scope }); return 1; } });
    const hook = defineHook({ id: 'shared', version: '1', stage: 'beforeExecution', tools: [read], handler: () => ({ decision: 'continue', actions: [{ toolId: 'read', input: 1 }] }) });
    const engine = runtime();
    const parent = engine.submit(agent(model('primary', () => { parentStarted.resolve(); return parentDone.promise; }), { id: 'parent' }), { input: 1 });
    try {
      await parentStarted.promise;
      const first = engine.spawn(parent, agent(model('child', async () => final()), { id: 'first', hooks: [hook] }), { input: 1, permissions: { allow: grants } });
      expect((await first.result()).status).toBe('succeeded');
      const second = engine.spawn(parent, agent(model('child', async () => final()), { id: 'second', hooks: [hook] }), { input: 1, permissions: { allow: ['model:child'] } });
      expect(await second.result()).toMatchObject({ error: { code: 'PERMISSION_DENIED' } });
      expect(executions).toEqual([{ runId: first.id, scope }]);
      expect(engine.inspect(parent).budget).toEqual({ spentMicros: 2, reservedMicros: 0, calls: 3 });
    } finally { parentDone.resolve(final()); await parent.result(); }
  });

  it('does not mint money or model capacity for action-output moderation below a narrowed child ceiling', async () => {
    const parentStarted = deferred<void>(); const parentDone = deferred<ModelResponse>(); const execute = vi.fn(async () => 1);
    const auxiliary = vi.fn(async () => final({ decision: 'allow', categories: [] }, 2));
    const read = defineTool({ id: 'read', version: '1', description: 'Read.', input: jsonSchema, output: jsonSchema, effects: 'read', capabilities: [], costMicros: 2, execute });
    const hook = defineHook({ id: 'read', version: '1', stage: 'beforeExecution', tools: [read], handler: () => ({ decision: 'continue', actions: [{ toolId: 'read', input: 1 }] }) });
    const guard = defineModerationGuard({ id: 'moderation', version: '1', model: model('moderator', auxiliary, 2), instructions: 'Policy.', egressGuards: [] });
    const engine = runtime();
    const parent = engine.submit(agent(model('primary', () => { parentStarted.resolve(); return parentDone.promise; }), { id: 'parent' }), { input: 1 });
    try {
      await parentStarted.promise;
      const child = engine.spawn(parent, agent(model('child', async () => final()), { id: 'child', hooks: [hook], guards: { output: [guard] } }),
        { input: 1, permissions: { allow: grants }, limits: { maxCostMicros: 3 } });
      expect(await child.result()).toMatchObject({ error: { code: 'BUDGET_EXCEEDED' } });
      expect(execute).not.toHaveBeenCalled(); expect(auxiliary).not.toHaveBeenCalled();
      expect(engine.inspect(parent).budget).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 1 });
    } finally { parentDone.resolve(final()); await parent.result(); }
  });

  it('rejects widened child hook ceilings and unsupported finite root bounds', async () => {
    for (const maxHookCalls of [0, -1, 4097, Number.NaN, Infinity, 1.5]) expect(() => runtime({ maxHookCalls })).toThrow();
    const started = deferred<void>(); const done = deferred<ModelResponse>(); const engine = runtime({ maxHookCalls: 1 });
    const parent = engine.submit(agent(model('primary', () => { started.resolve(); return done.promise; })), { input: 1 });
    try {
      await started.promise;
      expect(() => engine.spawn(parent, agent(undefined, { id: 'child' }), { input: 1, permissions: { allow: grants }, limits: { maxHookCalls: 2 } })).toThrow();
    } finally { done.resolve(final()); await parent.result(); }
  });
});

describe('hook deadlines and actual callback lifetimes', () => {
  it('retains a timed-out callback permit and never dispatches its late returned actions', async () => {
    const started = deferred<void>(); const done = deferred<void>(); const execute = vi.fn(async () => 1);
    const read = defineTool({ id: 'read', version: '1', description: 'Read.', input: jsonSchema, output: jsonSchema, effects: 'read', capabilities: [], execute });
    const firstHook = defineHook({ id: 'first', version: '1', stage: 'beforeExecution', tools: [read], timeoutMs: 25, handler: async () => {
      started.resolve(); await done.promise; return { decision: 'continue', actions: [{ toolId: 'read', input: 1 }] };
    } });
    const nextHandler = vi.fn(() => ({ decision: 'continue' as const }));
    const secondHook = defineHook({ id: 'second', version: '1', stage: 'beforeExecution', tools: [], handler: nextHandler });
    const engine = runtime({ maxConcurrentOperations: 1, maxConcurrentRuns: 1 });
    const first = engine.submit(agent(undefined, { hooks: [firstHook] }), { input: 1 });
    try {
      await started.promise; const initial = await first.result(); expect(initial).toMatchObject({ error: { code: 'TIMEOUT' } });
      const second = engine.submit(agent(undefined, { hooks: [secondHook] }), { input: 1 });
      await delay(35); expect(nextHandler).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
      done.resolve(); expect((await second.result()).status).toBe('succeeded');
      expect(execute).not.toHaveBeenCalled(); expect(await first.result()).toBe(initial);
      const completed = (await events(first.observe())).filter(event => event.type === 'hook.completed');
      expect(completed).toHaveLength(1); expect(JSON.stringify(completed)).not.toContain('continued');
      expect(engine.inspect(first).budget).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 0 });
    } finally { done.resolve(); }
  });

  it('cancels a queued hook without consuming a callback slot or dispatching tools', async () => {
    const parentStarted = deferred<void>(); const parentDone = deferred<ModelResponse>(); const handler = vi.fn(() => ({ decision: 'continue' as const }));
    const hook = defineHook({ id: 'queued', version: '1', stage: 'beforeExecution', tools: [], handler });
    const engine = runtime({ maxConcurrentOperations: 1, maxHookCalls: 1 });
    const parent = engine.submit(agent(model('primary', () => { parentStarted.resolve(); return parentDone.promise; }), { id: 'parent' }), { input: 1 });
    try {
      await parentStarted.promise;
      const child = engine.spawn(parent, agent(undefined, { id: 'child', hooks: [hook] }), { input: 1, permissions: { allow: grants } });
      await nextTurn(); child.cancel(); expect(await child.result()).toMatchObject({ status: 'cancelled', error: { code: 'CANCELLED' } });
      expect(handler).not.toHaveBeenCalled(); parentDone.resolve(final()); await parent.result();
      expect(handler).not.toHaveBeenCalled();
    } finally { parentDone.resolve(final()); }
  });

  it('keeps a timed-out read action unknown, settles a late known receipt and never releases its output', async () => {
    const started = deferred<void>(); const done = deferred<JsonValue>(); const primary = vi.fn(async () => final());
    const outputGuard = vi.fn(() => ({ decision: 'allow' as const }));
    const read = defineTool({ id: 'read', version: '1', description: 'Read.', input: jsonSchema, output: jsonSchema, effects: 'read', capabilities: [], costMicros: 3,
      execute: () => { started.resolve(); return done.promise; } });
    const hook = defineHook({ id: 'late', version: '1', stage: 'beforeExecution', tools: [read], timeoutMs: 25, handler: () => ({ decision: 'continue', actions: [{ toolId: 'read', input: 1 }] }) });
    const engine = runtime();
    const run = engine.submit(agent(model('primary', primary), { hooks: [hook], guards: { output: [{ id: 'output', check: outputGuard }] } }), { input: 1 });
    try {
      await started.promise; const initial = await run.result(); const serialized = JSON.stringify(initial);
      expect(initial).toMatchObject({ status: 'outcome_unknown', receipt: { toolId: 'read', execution: 'unknown', disclosure: 'withheld' } });
      expect(initial.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ runId: run.id, receipt: expect.objectContaining({ toolId: 'read', execution: 'unknown' }) })]));
      expect(engine.inspect(run).budget).toEqual({ spentMicros: 0, reservedMicros: 3, calls: 1 });
      done.resolve('PRIVATE late result'); await nextTurn(); await nextTurn();
      expect(engine.inspect(run).budget).toEqual({ spentMicros: 3, reservedMicros: 0, calls: 1 });
      expect(engine.inspect(run).evidence).toEqual(expect.arrayContaining([expect.objectContaining({ receipt: expect.objectContaining({ execution: 'succeeded', disclosure: 'withheld' }) })]));
      expect(await run.result()).toBe(initial); expect(JSON.stringify(initial)).toBe(serialized);
      expect(primary).not.toHaveBeenCalled(); expect(outputGuard).not.toHaveBeenCalled();
      expect(JSON.stringify(await events(run.observe()))).not.toContain('PRIVATE');
    } finally { done.resolve(1); }
  });

  it('sanitizes callback errors and does not leak private input, policy or callback output through events', async () => {
    const hook = defineHook({ id: 'secret', version: '1', stage: 'beforeExecution', tools: [], handler: () => { throw new Error('PRIVATE exception'); } });
    const engine = runtime(); const run = engine.submit(agent(undefined, { hooks: [hook] }), { input: 'PRIVATE input' });
    expect(await run.result()).toMatchObject({ error: { code: 'GUARD_UNAVAILABLE' } });
    const observed = await events(run.observe()); expect(observed.filter(event => event.type === 'hook.started')).toHaveLength(1);
    expect(observed.filter(event => event.type === 'hook.completed')).toHaveLength(1);
    expect(JSON.stringify([await run.result(), engine.inspect(run), observed])).not.toContain('PRIVATE');
  });
});
