import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import { Budget, ModelInvocationError, type JsonValue, type ModelAdapter, type ModelRequest, type ModelResponse, type RunEvent, type Schema } from '@mayura/core';
import { defineTool, invokeTool, type AnyTool } from '@mayura/tools';
import { agentAsTool, createRuntime, defineAgent, type AgentOptions, type Runtime, type RuntimeLimits } from '../src/index.js';

const numberSchema: Schema<number> = {
  '~standard': { version: 1, vendor: 'orchestration-test', validate: (value) => typeof value === 'number' && Number.isFinite(value)
    ? { value } : { issues: [{ message: 'Number required.' }] } },
};
const identitySchema: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'orchestration-test', validate: (value) => ({ value: value as JsonValue }) } };
const allow = ['agent:delegate', 'model:fixture', 'tool:write', 'effect:write', 'tool:delegate', 'tool:grandchild'];
const permissions = { allow };
const final = (output: JsonValue = 1, costMicros = 0): ModelResponse => ({ type: 'final', output, usage: { costMicros } });
const call = (toolId = 'write', input: JsonValue = 1, id = 'call.1'): ModelResponse => ({ type: 'tool_calls', calls: [{ id, toolId, input }], usage: { costMicros: 0 } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
function model(generate: ModelAdapter['generate'] = async () => final(), maxCostMicros = 0): ModelAdapter {
  return { id: 'fixture', capabilities: { tools: true, structuredOutput: true }, maxCostMicros, generate };
}
function scripted(responses: readonly ModelResponse[]): ModelAdapter {
  let index = 0;
  return model(async () => {
    const response = responses[index++];
    if (!response) throw new Error('Unexpected fixture model continuation.');
    return response;
  });
}
function agent(id: string, adapter = model(), extras: Partial<Omit<AgentOptions<typeof numberSchema, typeof numberSchema>, 'id' | 'model'>> = {}) {
  return defineAgent({ id, version: '1', instructions: `${id} instructions`, tools: [], input: numberSchema, output: numberSchema, ...extras, model: adapter });
}
function write(execute: (value: number) => number | Promise<number>, options: { costMicros?: number; outputGuard?: () => { decision: 'allow' | 'block' } } = {}) {
  return defineTool({ id: 'write', version: '1', description: 'Controlled test write.', input: numberSchema, output: numberSchema,
    effects: 'write', capabilities: [], costMicros: options.costMicros ?? 0, execute,
    ...(options.outputGuard ? { guards: { output: [{ id: 'output-check', check: options.outputGuard }] } } : {}),
  });
}
const runtimes: Runtime[] = [];
function runtime(limits: RuntimeLimits = {}, grants: readonly string[] = allow) {
  const value = createRuntime({ profile: 'ephemeral', permissions: { allow: grants }, scope: { principalId: 'principal', projectId: 'project' },
    limits: { maxCostMicros: 100, maxDurationMs: 2_000, ...limits } });
  runtimes.push(value);
  return value;
}
async function events(source: AsyncIterable<RunEvent>) {
  const result: RunEvent[] = [];
  for await (const item of source) result.push(item);
  return result;
}
afterEach(async () => { await Promise.all(runtimes.splice(0).map((value) => value.close())); vi.restoreAllMocks(); });

describe('required child ownership and authorization', () => {
  it('joins an accepted child before releasing parent success and returns immutable lineage without output', async () => {
    const completion = deferred<ModelResponse>();
    const started = deferred<void>();
    const engine = runtime();
    const parent = engine.submit(agent('parent'), { input: 1 });
    const child = engine.spawn(parent, agent('child', model(() => { started.resolve(); return completion.promise; })), { input: 2, permissions });
    let parentFinished = false;
    void parent.result().then(() => { parentFinished = true; });
    await started.promise;
    await nextTurn();
    expect(parentFinished).toBe(false);
    const snapshot = engine.inspect(parent);
    expect(snapshot).toMatchObject({ id: parent.id, rootId: parent.id, agentId: 'parent' });
    expect(snapshot.runs).toEqual(expect.arrayContaining([{ id: child.id, parentId: parent.id, agentId: 'child', status: expect.any(String) }]));
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.runs)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('instructions');
    completion.resolve(final(2));
    expect(await child.result()).toMatchObject({ status: 'succeeded', output: 2 });
    expect(await parent.result()).toMatchObject({ status: 'succeeded', output: 1 });
    expect(engine.inspect(child)).toMatchObject({ id: child.id, parentId: parent.id, rootId: parent.id, status: 'succeeded' });
  });

  it('rejects copied, foreign, completed and cancelled parent handles without child admission', async () => {
    const first = runtime(); const second = runtime();
    const parent = first.submit(agent('parent'), { input: 1 });
    const candidate = agent('child');
    expect(() => first.spawn({ ...parent }, candidate, { input: 1, permissions })).toThrow();
    expect(() => second.spawn(parent, candidate, { input: 1, permissions })).toThrow();
    expect(() => second.inspect(parent)).toThrow();
    expect(() => first.inspect({ ...parent })).toThrow();
    await parent.result();
    expect(() => first.spawn(parent, candidate, { input: 1, permissions })).toThrow();
    const cancelled = first.submit(agent('cancelled-parent'), { input: 1 });
    cancelled.cancel();
    expect(() => first.spawn(cancelled, candidate, { input: 1, permissions })).toThrow();
    expect(first.inspect(parent).runs).toHaveLength(1);
  });

  it.each(['direct', 'tool'] as const)('requires delegation authority on the %s path', async (path) => {
    const generate = vi.fn(async () => final());
    const child = agent('child', model(generate));
    const composed = agentAsTool(child, { id: 'delegate', description: 'Child.', permissions });
    const engine = runtime({}, allow.filter((grant) => grant !== 'agent:delegate'));
    const parent = engine.submit(agent('parent', path === 'tool' ? scripted([call('delegate')]) : model(), { tools: path === 'tool' ? [composed] : [] }), { input: 1 });
    if (path === 'direct') expect(() => engine.spawn(parent, child, { input: 1, permissions })).toThrow();
    else expect(await parent.result()).toMatchObject({ status: 'blocked' });
    expect(generate).not.toHaveBeenCalled();
    expect(engine.inspect(parent).runs).toHaveLength(1);
  });

  it.each(['direct', 'tool'] as const)('intersects child model/tool grants with the parent on the %s path', async (path) => {
    const execute = vi.fn((value: number) => value);
    const child = agent('child', scripted([call()]), { tools: [write(execute)] });
    const composed = agentAsTool(child, { id: 'delegate', description: 'Child.', permissions });
    const engine = runtime({}, allow.filter((grant) => grant !== 'effect:write'));
    const parent = engine.submit(agent('parent', path === 'tool' ? scripted([call('delegate')]) : model(), { tools: path === 'tool' ? [composed] : [] }), { input: 1 });
    if (path === 'direct') engine.spawn(parent, child, { input: 1, permissions });
    expect((await parent.result()).status).not.toBe('succeeded');
    expect(execute).not.toHaveBeenCalled();
  });

  it('snapshots narrowed child grants and inherited scope before asynchronous dispatch', async () => {
    const generate = vi.fn(async () => final());
    const engine = runtime();
    const parent = engine.submit(agent('parent'), { input: 1 });
    const narrowed = { allow: [] as string[] };
    const child = engine.spawn(parent, agent('child', model(generate)), { input: 1, permissions: narrowed });
    narrowed.allow.push('model:fixture');
    expect(await child.result()).toMatchObject({ status: 'blocked' });
    expect(generate).not.toHaveBeenCalled();

    const capture = vi.fn((_value: number, context: { scope: { principalId: string; projectId: string } }) => {
      expect(context.scope).toEqual({ principalId: 'principal', projectId: 'project' });
      expect(Object.isFrozen(context.scope)).toBe(true);
      return 2;
    });
    const tool = defineTool({ id: 'write', version: '1', description: 'Scope.', input: numberSchema, output: numberSchema,
      effects: 'write', capabilities: [], execute: capture });
    const nextParent = engine.submit(agent('next-parent'), { input: 1 });
    const allowed = engine.spawn(nextParent, agent('allowed', scripted([call(), final(2)]), { tools: [tool] }), { input: 1, permissions });
    expect(await allowed.result()).toMatchObject({ status: 'succeeded' });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('rejects explicitly widened child limits instead of silently creating greater authority', async () => {
    const engine = runtime({ maxCostMicros: 5, maxDurationMs: 1_000, maxModelCalls: 2 });
    const parent = engine.submit(agent('parent'), { input: 1 });
    for (const limits of [{ maxCostMicros: 6 }, { maxDurationMs: 5_000 }, { maxModelCalls: 3 }]) {
      expect(() => engine.spawn(parent, agent('child'), { input: 1, permissions, limits })).toThrow();
    }
    expect(engine.inspect(parent).runs).toHaveLength(1);
    await parent.result();
  });

  it('rejects standalone composed-tool invocation instead of minting a new root budget', async () => {
    const generate = vi.fn(async () => final());
    const composed = agentAsTool(agent('child', model(generate)), { id: 'delegate', description: 'Child.', permissions });
    const budget = new Budget(100, 10);
    const outcome = await invokeTool(composed, 1, { runId: 'forged-parent', callId: 'forged-call',
      scope: { principalId: 'principal', projectId: 'project' }, signal: new AbortController().signal, permissions, budget });
    expect(outcome.status).not.toBe('succeeded');
    expect(generate).not.toHaveBeenCalled();
    expect('execute' in composed).toBe(false);
  });
});

describe('shared budgets and bounded ancestry', () => {
  it('admits only one competing child reservation and charges confirmed usage once to each ancestor', async () => {
    const completion = deferred<ModelResponse>();
    const started = deferred<void>();
    const generate = vi.fn(() => { started.resolve(); return completion.promise; });
    const engine = runtime({ maxCostMicros: 8 });
    const parent = engine.submit(agent('parent'), { input: 1 });
    const left = engine.spawn(parent, agent('left', model(generate, 5)), { input: 1, permissions });
    const right = engine.spawn(parent, agent('right', model(generate, 5)), { input: 1, permissions });
    await started.promise;
    await nextTurn();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(engine.inspect(parent).budget).toMatchObject({ spentMicros: 0, reservedMicros: 5 });
    completion.resolve(final(2, 3));
    const outcomes = await Promise.all([left.result(), right.result()]);
    expect(outcomes.map((value) => value.status).sort()).toEqual(['blocked', 'succeeded']);
    expect((await parent.result()).status).not.toBe('succeeded');
    expect(engine.inspect(parent).budget).toMatchObject({ spentMicros: 3, reservedMicros: 0 });
  });

  it('enforces an intermediate ceiling for grandchildren without reserving the ceiling as additional spend', async () => {
    const generate = vi.fn(async () => final(2, 4));
    const engine = runtime({ maxCostMicros: 20 });
    const parent = engine.submit(agent('parent'), { input: 1 });
    const middle = engine.spawn(parent, agent('middle'), { input: 1, permissions, limits: { maxCostMicros: 5 } });
    engine.spawn(middle, agent('left', model(generate, 4)), { input: 1, permissions });
    engine.spawn(middle, agent('right', model(generate, 4)), { input: 1, permissions });
    expect((await parent.result()).status).not.toBe('succeeded');
    expect(generate).toHaveBeenCalledTimes(1);
    expect(engine.inspect(parent).budget).toMatchObject({ spentMicros: 4, reservedMicros: 0 });
    expect(engine.inspect(middle).budget).toMatchObject({ spentMicros: 4, reservedMicros: 0 });
  });

  it.each(['envelope', 'known-error'] as const)('records an overrun from child %s and prevents subsequent admission', async (kind) => {
    const engine = runtime({ maxCostMicros: 5 });
    const parentCompletion = deferred<ModelResponse>();
    const parent = engine.submit(agent('parent', model(() => parentCompletion.promise)), { input: 1 });
    const child = engine.spawn(parent, agent('child', model(async () => {
      if (kind === 'known-error') throw new ModelInvocationError(6);
      return { type: 'tool_calls', calls: [], usage: { costMicros: 6 } };
    }, 5)), { input: 1, permissions });
    expect(await child.result()).toMatchObject({ status: 'blocked', error: { code: 'BUDGET_EXCEEDED' } });
    expect(engine.inspect(parent).budget).toMatchObject({ spentMicros: 6, reservedMicros: 0 });
    const generate = vi.fn(async () => final());
    let rejection: unknown;
    try { engine.spawn(parent, agent('later', model(generate)), { input: 1, permissions }); }
    catch (error) { rejection = error; }
    expect(rejection).toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(generate).not.toHaveBeenCalled();
    parentCompletion.resolve(final());
    expect((await parent.result()).status).not.toBe('succeeded');
  });

  it('caps free model calls across the tree instead of resetting the counter for every child', async () => {
    const generate = vi.fn(async () => final());
    const engine = runtime({ maxModelCalls: 2 });
    const parent = engine.submit(agent('parent', model(generate)), { input: 1 });
    engine.spawn(parent, agent('left', model(generate)), { input: 1, permissions });
    engine.spawn(parent, agent('right', model(generate)), { input: 1, permissions });
    expect((await parent.result()).status).not.toBe('succeeded');
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('caps ordinary tool calls across siblings independently of model-call capacity', async () => {
    const execute = vi.fn((value: number) => value);
    const tool = write(execute);
    const engine = runtime({ maxToolCalls: 1, maxModelCalls: 10 });
    const parent = engine.submit(agent('parent'), { input: 1 });
    engine.spawn(parent, agent('left', scripted([call(), final()] ), { tools: [tool] }), { input: 1, permissions });
    engine.spawn(parent, agent('right', scripted([call(), final()] ), { tools: [tool] }), { input: 1, permissions });
    expect((await parent.result()).status).not.toBe('succeeded');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('enforces total descendant and depth boundaries synchronously', async () => {
    const countEngine = runtime({ maxDescendantRuns: 1 });
    const parent = countEngine.submit(agent('parent'), { input: 1 });
    countEngine.spawn(parent, agent('child'), { input: 1, permissions });
    expect(() => countEngine.spawn(parent, agent('excess'), { input: 1, permissions })).toThrow();
    expect(countEngine.inspect(parent).runs).toHaveLength(2);
    const depthEngine = runtime({ maxDepth: 2 });
    const root = depthEngine.submit(agent('root'), { input: 1 });
    const middle = depthEngine.spawn(root, agent('middle'), { input: 1, permissions });
    const leaf = depthEngine.spawn(middle, agent('leaf'), { input: 1, permissions });
    expect(() => depthEngine.spawn(leaf, agent('too-deep'), { input: 1, permissions })).toThrow();
    expect(depthEngine.inspect(root).runs).toHaveLength(3);
    await Promise.all([parent.result(), root.result()]);
  });

  it('rejects identity and repeated-ID ancestry cycles but allows independent sibling definitions', async () => {
    const definition = agent('parent');
    const engine = runtime();
    const parent = engine.submit(definition, { input: 1 });
    expect(() => engine.spawn(parent, definition, { input: 1, permissions })).toThrow();
    expect(() => engine.spawn(parent, agent('parent'), { input: 1, permissions })).toThrow();
    const child = engine.spawn(parent, agent('child'), { input: 1, permissions });
    expect(() => engine.spawn(child, agent('parent'), { input: 1, permissions })).toThrow();
    engine.spawn(parent, agent('child'), { input: 1, permissions });
    expect(await parent.result()).toMatchObject({ status: 'succeeded' });
  });

  it.each(['depth', 'cycle', 'descendants'] as const)('does not bypass the %s bound through nested agent tools', async (boundary) => {
    const generate = vi.fn(async () => final());
    const leaf = agent(boundary === 'cycle' ? 'parent' : 'leaf', model(generate));
    const leafTool = agentAsTool(leaf, { id: 'grandchild', description: 'Leaf.', permissions });
    const middle = agent('middle', scripted([call('grandchild')]), { tools: [leafTool] });
    const middleTool = agentAsTool(middle, { id: 'delegate', description: 'Middle.', permissions });
    const engine = runtime(boundary === 'depth' ? { maxDepth: 1 } : boundary === 'descendants' ? { maxDescendantRuns: 1 } : {});
    const parent = engine.submit(agent('parent', scripted([call('delegate')]), { tools: [middleTool] }), { input: 1 });
    expect((await parent.result()).status).not.toBe('succeeded');
    expect(generate).not.toHaveBeenCalled();
    expect(engine.inspect(parent).runs).toHaveLength(2);
  });
});

describe('composition, scheduler ownership and privacy', () => {
  it('enforces a narrowed intermediate operation ceiling for simultaneous grandchildren', async () => {
    const completion = deferred<ModelResponse>();
    const started = deferred<void>();
    let active = 0; let maximum = 0;
    const generate = vi.fn(async () => {
      active++; maximum = Math.max(maximum, active); started.resolve();
      try { return await completion.promise; } finally { active--; }
    });
    const engine = runtime({ maxConcurrentOperations: 4 });
    const parent = engine.submit(agent('parent'), { input: 1 });
    const middle = engine.spawn(parent, agent('middle'), { input: 1, permissions, limits: { maxConcurrentOperations: 1 } });
    engine.spawn(middle, agent('left', model(generate)), { input: 1, permissions });
    engine.spawn(middle, agent('right', model(generate)), { input: 1, permissions });
    await started.promise;
    await nextTurn();
    const beforeRelease = generate.mock.calls.length;
    completion.resolve(final());
    expect(await parent.result()).toMatchObject({ status: 'succeeded' });
    expect(beforeRelease).toBe(1);
    expect(maximum).toBe(1);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('does not hold partial ancestor capacity while a narrower branch waits for its permit', async () => {
    const active = deferred<void>(); const completion = deferred<ModelResponse>();
    const waitingInputs = vi.fn(value => ({ value: value as number }));
    const admittedSchema: Schema<number> = { '~standard': { version: 1, vendor: 'orchestration-test', validate: waitingInputs } };
    const waitingModels = vi.fn(async () => final(1, 1));
    const unrelated = vi.fn(async () => final());
    const engine = runtime({ maxConcurrentOperations: 2 });
    const parent = engine.submit(agent('parent'), { input: 1 });
    const middle = engine.spawn(parent, agent('middle'), { input: 1, permissions, limits: { maxConcurrentOperations: 1 } });
    engine.spawn(middle, agent('active', model(() => { active.resolve(); return completion.promise; })), { input: 1, permissions });
    engine.spawn(middle, agent('waiting-left', model(waitingModels, 1), { input: admittedSchema }), { input: 1, permissions });
    engine.spawn(middle, agent('waiting-right', model(waitingModels, 1), { input: admittedSchema }), { input: 1, permissions });
    engine.spawn(parent, agent('unrelated', model(unrelated)), { input: 1, permissions });
    try {
      await active.promise; await nextTurn(); await nextTurn();
      // All schemas are finite and have settled. Two actual model requests now wait
      // on the occupied middle branch, without reserving the remaining root slot.
      expect(waitingInputs).toHaveBeenCalledTimes(2);
      expect(waitingModels).not.toHaveBeenCalled();
      expect(engine.inspect(parent).budget.reservedMicros).toBe(2); // Both model bundles are admitted, not still validating inputs.
      expect(unrelated).toHaveBeenCalledTimes(1);
      completion.resolve(final());
      expect(await parent.result()).toMatchObject({ status: 'succeeded' });
      expect(waitingModels).toHaveBeenCalledTimes(2);
      expect(engine.inspect(parent).budget).toMatchObject({ spentMicros: 2, reservedMicros: 0 });
    } finally { completion.resolve(final()); }
  });

  it('completes nested agent tools with one execution slot and a single admitted root', async () => {
    const grandchild = agent('grandchild');
    const grandTool = agentAsTool(grandchild, { id: 'grandchild', description: 'Grandchild.', permissions });
    const middle = agent('middle', scripted([call('grandchild'), final(2)]), { tools: [grandTool] });
    const childTool = agentAsTool(middle, { id: 'delegate', description: 'Child.', permissions });
    const engine = runtime({ maxConcurrentOperations: 1, maxConcurrentRuns: 1 });
    const parent = engine.submit(agent('parent', scripted([call('delegate'), final(3)]), { tools: [childTool] }), { input: 1 });
    expect(await parent.result()).toMatchObject({ status: 'succeeded', output: 3 });
    expect(engine.inspect(parent).runs).toHaveLength(3);
    expect(engine.inspect(parent).budget).toMatchObject({ spentMicros: 0, reservedMicros: 0, calls: 7 });
  });

  it('applies input/output transforms at the correct domain on both direct and tool paths', async () => {
    const seen: JsonValue[] = [];
    const child = defineAgent({ id: 'child', version: '1', instructions: 'child', tools: [],
      input: z.string().transform((value) => value.length), output: z.number().transform((value) => ({ length: value })),
      model: model(async (request) => { const first = request.messages[0]; if (!first || first.role !== 'user') throw new Error('Missing input.'); seen.push(first.content); return final(first.content); }),
    });
    const composed = agentAsTool(child, { id: 'delegate', description: 'Length.', permissions });
    const engine = runtime();
    const parent = engine.submit(agent('parent'), { input: 1 });
    const direct = engine.spawn(parent, child, { input: 'abc', permissions });
    const directOutcome = await direct.result();
    if (directOutcome.status === 'succeeded') expectTypeOf(directOutcome.output).toEqualTypeOf<{ length: number }>();
    expect(directOutcome).toMatchObject({ status: 'succeeded', output: { length: 3 } });
    let step = 0;
    const wrapped = defineAgent({ id: 'wrapper-parent', version: '1', instructions: 'parent', tools: [composed], input: numberSchema, output: identitySchema,
      model: model(async (request) => {
        if (step++ === 0) return call('delegate', 'abc');
        const result = request.messages.at(-1); if (result?.role !== 'tool') throw new Error('Missing admitted child output.');
        return final(result.result);
      }),
    });
    const run = engine.submit(wrapped, { input: 1 });
    expect(await run.result()).toMatchObject({ status: 'succeeded', output: { length: 3 } });
    expect(seen).toEqual([3, 3]);
  });

  it('preserves the child raw-input byte ceiling when the composed schema shrinks its input', async () => {
    const generate = vi.fn(async () => final(1));
    const child = defineAgent({ id: 'child', version: '1', instructions: 'child', tools: [],
      input: z.string().transform((value) => value.length), output: z.number(), model: model(generate) });
    const limits = { maxInputBytes: 16 };
    const input = 'x'.repeat(64);
    const engine = runtime();
    const directParent = engine.submit(agent('direct-parent'), { input: 1 });
    expect(() => engine.spawn(directParent, child, { input, permissions, limits })).toThrow();
    await directParent.result();
    const composed = agentAsTool(child, { id: 'delegate', description: 'Bounded child.', permissions, limits });
    const wrapped = engine.submit(agent('wrapped-parent', scripted([call('delegate', input), final()]), { tools: [composed] }), { input: 1 });
    expect((await wrapped.result()).status).not.toBe('succeeded');
    expect(generate).not.toHaveBeenCalled();
  });

  it('does not forward parent/child transcripts or opaque continuation across the child boundary', async () => {
    const childRequests: ModelRequest[] = []; const parentRequests: ModelRequest[] = [];
    let childStep = 0; let parentStep = 0;
    const child = agent('child', model(async (request) => {
      childRequests.push(request);
      return childStep++ === 0 ? { ...call(), continuation: { private: 'CHILD_PRIVATE_CONTINUATION' } } : final(7);
    }), { instructions: 'CHILD_PRIVATE_INSTRUCTIONS', tools: [write(() => 5)] });
    const composed = agentAsTool(child, { id: 'delegate', description: 'Child.', permissions });
    const parent = agent('parent', model(async (request) => {
      parentRequests.push(request);
      return parentStep++ === 0 ? { ...call('delegate', 17), continuation: { private: 'PARENT_PRIVATE_CONTINUATION' } } : final(9);
    }), { instructions: 'PARENT_PRIVATE_INSTRUCTIONS', tools: [composed] });
    const engine = runtime();
    const run = engine.submit(parent, { input: 999 });
    expect(await run.result()).toMatchObject({ status: 'succeeded', output: 9 });
    expect(childRequests[0]?.messages).toEqual([{ role: 'user', content: 17 }]);
    expect(JSON.stringify(childRequests)).not.toContain('PARENT_PRIVATE');
    expect(JSON.stringify(parentRequests)).not.toContain('CHILD_PRIVATE');
    expect(parentRequests[1]?.messages.at(-1)).toMatchObject({ role: 'tool', result: 7 });
    expect(JSON.stringify([await events(run.observe()), engine.inspect(run), await run.result()])).not.toContain('PRIVATE');
  });

  it('retains an operation permit until a cancelled noncooperative model actually settles', async () => {
    const started = deferred<void>(); const completion = deferred<ModelResponse>();
    const next = vi.fn(async () => final(3, 1));
    const engine = runtime({ maxConcurrentOperations: 1 });
    const parent = engine.submit(agent('parent'), { input: 1 });
    const first = engine.spawn(parent, agent('first', model(() => { started.resolve(); return completion.promise; }, 1)), { input: 1, permissions });
    const sibling = engine.spawn(parent, agent('sibling', model(next, 1)), { input: 1, permissions });
    await started.promise;
    first.cancel();
    expect(await first.result()).toMatchObject({ status: 'cancelled' });
    await nextTurn();
    expect(next).not.toHaveBeenCalled();
    // One unknown started charge plus the sibling's protected, not-yet-dispatched bundle.
    // Financial admission does not free or acquire an actual execution permit.
    expect(engine.inspect(first).budget.reservedMicros).toBe(1);
    expect(engine.inspect(sibling).budget).toMatchObject({ reservedMicros: 1, calls: 0 });
    expect(engine.inspect(parent).budget.reservedMicros).toBe(2);
    completion.resolve(final(2, 1));
    expect(await sibling.result()).toMatchObject({ status: 'succeeded' });
    expect((await parent.result()).status).not.toBe('succeeded');
    expect(next).toHaveBeenCalledTimes(1);
    expect(engine.inspect(parent).budget).toMatchObject({ spentMicros: 2, reservedMicros: 0 });
  });

  it('does not independently cancel a sibling when one child is cancelled', async () => {
    const leftStarted = deferred<void>(); const rightStarted = deferred<void>();
    const leftCompletion = deferred<ModelResponse>(); const rightCompletion = deferred<ModelResponse>();
    let siblingSignal: AbortSignal | undefined;
    const engine = runtime(); const parent = engine.submit(agent('parent'), { input: 1 });
    const left = engine.spawn(parent, agent('left', model(() => { leftStarted.resolve(); return leftCompletion.promise; })), { input: 1, permissions });
    const right = engine.spawn(parent, agent('right', model((request) => { siblingSignal = request.signal; rightStarted.resolve(); return rightCompletion.promise; })), { input: 1, permissions });
    await Promise.all([leftStarted.promise, rightStarted.promise]);
    left.cancel();
    await left.result();
    expect(siblingSignal?.aborted).toBe(false);
    rightCompletion.resolve(final(3)); leftCompletion.resolve(final(2));
    expect(await right.result()).toMatchObject({ status: 'succeeded' });
    expect((await parent.result()).status).not.toBe('succeeded');
  });

  it('cancels queued descendants without waiting for a noncooperative holder to release capacity', async () => {
    const started = deferred<void>(); const completion = deferred<ModelResponse>();
    const queued = vi.fn(async () => final());
    let activeSignal: AbortSignal | undefined;
    const engine = runtime({ maxConcurrentOperations: 1 });
    const parent = engine.submit(agent('parent'), { input: 1 });
    const active = engine.spawn(parent, agent('active', model((request) => { activeSignal = request.signal; started.resolve(); return completion.promise; })), { input: 1, permissions });
    const waiting = engine.spawn(parent, agent('waiting', model(queued)), { input: 1, permissions });
    await started.promise;
    parent.cancel();
    expect(await waiting.result()).toMatchObject({ status: 'cancelled' });
    expect(await active.result()).toMatchObject({ status: 'cancelled' });
    expect(await parent.result()).toMatchObject({ status: 'cancelled' });
    expect(activeSignal?.aborted).toBe(true);
    expect(queued).not.toHaveBeenCalled();
    completion.resolve(final());
    await nextTurn();
    expect(queued).not.toHaveBeenCalled();
  });
});

describe('descendant outcome and evidence integrity', () => {
  it('preserves successful-but-withheld child writes through an agent tool and stops parent continuation', async () => {
    const execute = vi.fn(() => 2);
    const child = agent('child', scripted([call()]), { tools: [write(execute, { outputGuard: () => ({ decision: 'block' }) })] });
    const composed = agentAsTool(child, { id: 'delegate', description: 'Child.', permissions });
    const generate = vi.fn(async () => call('delegate'));
    const engine = runtime();
    const parent = engine.submit(agent('parent', model(generate), { tools: [composed] }), { input: 1 });
    const result = await parent.result();
    expect(result).toMatchObject({ status: 'blocked' });
    expect(result.evidence).toEqual(expect.arrayContaining([{ runId: expect.any(String), receipt: {
      callId: 'call.1', toolId: 'write', execution: 'succeeded', disclosure: 'withheld',
    } }]));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect('output' in result).toBe(false);
  });

  it('preserves mixed known/unknown child writes and updates only inspection after late completion', async () => {
    const pending = deferred<number>(); const started = deferred<void>();
    const outputGuard = vi.fn(() => ({ decision: 'allow' as const }));
    const knownTool = write(() => 2, { costMicros: 1 });
    const unknownTool = write(() => { started.resolve(); return pending.promise; }, { costMicros: 1, outputGuard });
    const engine = runtime(); const parent = engine.submit(agent('parent'), { input: 1 });
    const known = engine.spawn(parent, agent('known', scripted([call(), final(2)]), { tools: [knownTool] }), { input: 1, permissions });
    const unknown = engine.spawn(parent, agent('unknown', scripted([call()]), { tools: [unknownTool] }), { input: 1, permissions });
    await Promise.all([known.result(), started.promise]);
    parent.cancel();
    const initial = await parent.result();
    const initialJson = JSON.stringify(initial);
    expect(initial).toMatchObject({ status: 'outcome_unknown' });
    expect(initial.evidence).toEqual(expect.arrayContaining([
      { runId: known.id, receipt: { callId: 'call.1', toolId: 'write', execution: 'succeeded', disclosure: 'released' } },
      { runId: unknown.id, receipt: { callId: 'call.1', toolId: 'write', execution: 'unknown', disclosure: 'withheld' } },
    ]));
    expect(engine.inspect(parent).budget).toMatchObject({ spentMicros: 1, reservedMicros: 1 });
    pending.resolve(999);
    await nextTurn(); await nextTurn();
    expect(engine.inspect(parent).evidence).toEqual(expect.arrayContaining([
      { runId: unknown.id, receipt: { callId: 'call.1', toolId: 'write', execution: 'succeeded', disclosure: 'withheld' } },
    ]));
    expect(engine.inspect(parent).budget).toMatchObject({ spentMicros: 2, reservedMicros: 0 });
    expect(outputGuard).not.toHaveBeenCalled();
    expect(JSON.stringify(await parent.result())).toBe(initialJson);
    expect('output' in initial).toBe(false);
  });

  it.each(['none', 'write'] as const)('inherits the parent deadline for an in-flight %s descendant', async (effects) => {
    const tool: AnyTool = defineTool({ id: 'write', version: '1', description: 'Pending.', input: numberSchema, output: numberSchema,
      effects, capabilities: [], timeoutMs: 10_000, execute: () => new Promise<number>(() => {}) });
    const engine = runtime({ maxDurationMs: 30 });
    const parent = engine.submit(agent('parent'), { input: 1 });
    const child = engine.spawn(parent, agent('child', scripted([call()]), { tools: [tool] }), { input: 1, permissions });
    expect(await child.result()).toMatchObject(effects === 'write'
      ? { status: 'outcome_unknown', error: { code: 'OUTCOME_UNKNOWN' } }
      : { status: 'failed', error: { code: 'TIMEOUT' } });
    expect((await parent.result()).status).toBe(effects === 'write' ? 'outcome_unknown' : 'failed');
    expect(engine.inspect(parent).evidence).toEqual(expect.arrayContaining([{ runId: child.id,
      receipt: { callId: 'call.1', toolId: 'write', execution: 'unknown', disclosure: 'withheld' } }]));
  });
});
