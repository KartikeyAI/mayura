import { afterEach, describe, expect, it, vi } from 'vitest';
import { MayuraError, type Guard, type ModelAdapter, type ModelRequest, type ModelResponse, type Schema } from '@mayura/core';
import { defineTool } from '@mayura/tools';
import { createRuntime, defineAgent, type Runtime } from '../src/index.js';

const numberSchema: Schema<number> = {
  '~standard': { version: 1, vendor: 'test', validate: (value) => typeof value === 'number' && Number.isFinite(value)
    ? { value } : { issues: [{ message: 'number required' }] } },
};
const identitySchema: Schema<unknown> = { '~standard': { version: 1, vendor: 'test', validate: (value) => ({ value }) } };
const final = (output: number, costMicros = 0): ModelResponse => ({ type: 'final', output, usage: { costMicros } });
const call = (id = 'call.1', toolId = 'double', input = 2): ModelResponse => ({ type: 'tool_calls', calls: [{ id, toolId, input }], usage: { costMicros: 0 } });

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

function scripted(responses: readonly unknown[], options: { maxCostMicros?: number; inspect?: (request: ModelRequest) => void } = {}): ModelAdapter {
  let position = 0;
  return { id: 'fixture', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: options.maxCostMicros ?? 0,
    generate: async (request) => { options.inspect?.(request); return responses[position++] as ModelResponse; } };
}
function agent(model: ModelAdapter = scripted([final(4)]), extras: Partial<Parameters<typeof defineAgent<typeof numberSchema, typeof numberSchema>>[0]> = {}) {
  return defineAgent({ id: 'test', version: '1.0.0', instructions: 'test', model, tools: [], input: numberSchema, output: numberSchema, ...extras });
}
const runtimes: Runtime[] = [];
function runtime(options: Parameters<typeof createRuntime>[0] = { profile: 'ephemeral', permissions: { allow: ['model:fixture', 'tool:double'] } }) {
  const value = createRuntime(options); runtimes.push(value); return value;
}
afterEach(async () => { await Promise.all(runtimes.splice(0).map((value) => value.close())); vi.useRealTimers(); });

describe('ephemeral agent runtime', () => {
  it('validates final output, reuses a terminal promise, and exposes only metadata events', async () => {
    const run = runtime().submit(agent(), { input: 2 });
    expect(run.profile).toBe('ephemeral');
    expect(run.result()).toBe(run.result());
    expect(await run.result()).toEqual({ status: 'succeeded', output: 4 });
    const events = await collect(run.observe());
    expect(events.map((event) => event.type)).toEqual(['run.started', 'model.started', 'model.completed', 'run.completed']);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(JSON.stringify(events)).not.toContain('instructions');
    expect(await collect(run.observe({ after: 3 }))).toHaveLength(1);
  });

  it('invokes registered tools through the broker and returns guarded results to the next model call', async () => {
    const execute = vi.fn(async (input: number) => input * 2);
    const tool = defineTool({ id: 'double', version: '1', description: 'double', input: numberSchema, output: numberSchema, effects: 'none', capabilities: [], execute });
    const requests: ModelRequest[] = [];
    const run = runtime().submit(agent(scripted([call(), final(4)], { inspect: (request) => requests.push(request) }), { tools: [tool] }), { input: 2 });
    expect(await run.result()).toEqual({ status: 'succeeded', output: 4 });
    expect(execute).toHaveBeenCalledOnce();
    expect(requests[1]?.messages.at(-1)).toEqual({ role: 'tool', callId: 'call.1', toolId: 'double', result: 4 });
    expect(Object.isFrozen(requests[0]?.messages)).toBe(true);
  });

  it('denies a model unless explicitly granted and never invokes it', async () => {
    const model = scripted([final(4)]); const generate = vi.spyOn(model, 'generate');
    expect(await runtime({ profile: 'ephemeral' }).submit(agent(model), { input: 2 }).result()).toMatchObject({ status: 'blocked', error: { code: 'PERMISSION_DENIED' } });
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects invalid input before invoking a model, including schema-invalid JSON', async () => {
    const model = scripted([final(4)]); const generate = vi.spyOn(model, 'generate');
    const value = runtime();
    expect(() => value.submit(agent(model), { input: undefined as unknown as number })).toThrow(MayuraError);
    expect(await value.submit(agent(model), { input: 'secret' as unknown as number }).result()).toMatchObject({ status: 'failed', error: { code: 'INVALID_INPUT' } });
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects invalid final output and never echoes its contents', async () => {
    const run = runtime().submit(agent(scripted([{ type: 'final', output: 'SECRET', usage: { costMicros: 0 } }])), { input: 2 });
    expect(await run.result()).toMatchObject({ status: 'failed', error: { code: 'INVALID_OUTPUT' } });
    expect(JSON.stringify(await run.result())).not.toContain('SECRET');
  });

  it.each([
    undefined,
    { type: 'final', output: 4 },
    { type: 'final', output: 4, usage: { costMicros: -1 } },
    { type: 'final', output: 4, usage: { costMicros: 0 }, unexpected: true },
    { type: 'final', output: Infinity, usage: { costMicros: 0 } },
    { type: 'tool_calls', calls: [], usage: { costMicros: 0 } },
    { type: 'tool_calls', calls: [{ id: 'same', toolId: 'double', input: 2 }, { id: 'same', toolId: 'double', input: 2 }], usage: { costMicros: 0 } },
  ])('rejects malformed complete model envelope %# before tool dispatch', async (response) => {
    expect(await runtime().submit(agent(scripted([response])), { input: 2 }).result()).toMatchObject({ status: 'failed', error: { code: 'MODEL_FAILED' } });
  });

  it('sanitizes even framework-shaped exceptions thrown by model code', async () => {
    const model = scripted([]); model.generate = async () => { throw new MayuraError('MODEL_FAILED', 'SECRET API KEY'); };
    const result = await runtime().submit(agent(model), { input: 2 }).result();
    expect(result).toMatchObject({ status: 'failed', error: { code: 'MODEL_FAILED' } });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('rejects a complete batch before any effect if a later tool is unknown', async () => {
    const execute = vi.fn(async (input: number) => input);
    const tool = defineTool({ id: 'double', version: '1', description: 'tool', input: numberSchema, output: numberSchema, effects: 'none', capabilities: [], execute });
    const response = { type: 'tool_calls', calls: [{ id: 'one', toolId: 'double', input: 2 }, { id: 'two', toolId: 'missing', input: 2 }], usage: { costMicros: 0 } };
    expect(await runtime().submit(agent(scripted([response]), { tools: [tool] }), { input: 2 }).result()).toMatchObject({ status: 'failed', error: { code: 'NOT_FOUND' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a complete batch before any effect if later input fails its schema', async () => {
    const execute = vi.fn(async (input: number) => input);
    const tool = defineTool({ id: 'double', version: '1', description: 'tool', input: numberSchema, output: numberSchema, effects: 'none', capabilities: [], execute });
    const response = { type: 'tool_calls', calls: [{ id: 'one', toolId: 'double', input: 2 }, { id: 'two', toolId: 'double', input: 'bad' }], usage: { costMicros: 0 } };
    expect(await runtime().submit(agent(scripted([response]), { tools: [tool] }), { input: 2 }).result()).toMatchObject({ status: 'failed', error: { code: 'INVALID_INPUT' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('requires exact tool, effect, and additional capability grants', async () => {
    const execute = vi.fn(async (input: number) => input);
    const tool = defineTool({ id: 'double', version: '1', description: 'tool', input: numberSchema, output: numberSchema, effects: 'write', capabilities: ['database:write'], execute });
    expect(await runtime().submit(agent(scripted([call()]), { tools: [tool] }), { input: 2 }).result()).toMatchObject({ status: 'blocked', error: { code: 'PERMISSION_DENIED' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects repeated call ids across model turns', async () => {
    const execute = vi.fn(async (input: number) => input);
    const tool = defineTool({ id: 'double', version: '1', description: 'tool', input: numberSchema, output: numberSchema, effects: 'none', capabilities: [], execute });
    expect(await runtime().submit(agent(scripted([call(), call()]), { tools: [tool] }), { input: 2 }).result()).toMatchObject({ status: 'failed', error: { code: 'CONFLICT' } });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('charges model and tool calls against the same budget', async () => {
    const execute = vi.fn(async (input: number) => input);
    const tool = defineTool({ id: 'double', version: '1', description: 'tool', input: numberSchema, output: numberSchema, effects: 'none', capabilities: [], costMicros: 4, execute });
    const response = { ...call(), usage: { costMicros: 3 } };
    const run = runtime({ profile: 'ephemeral', permissions: { allow: ['model:fixture', 'tool:double'] }, limits: { maxCostMicros: 6 } })
      .submit(agent(scripted([response], { maxCostMicros: 3 }), { tools: [tool] }), { input: 2 });
    expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'BUDGET_EXCEEDED' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('records actual overrun and blocks when reported model cost exceeds its bound', async () => {
    const run = runtime({ profile: 'ephemeral', permissions: { allow: ['model:fixture'] }, limits: { maxCostMicros: 5 } })
      .submit(agent(scripted([final(4, 6)], { maxCostMicros: 5 })), { input: 2 });
    expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'BUDGET_EXCEEDED' } });
    expect((await collect(run.observe())).at(-1)?.metadata).toMatchObject({ reservedMicros: 0, spentMicros: 6 });
  });

  it('input guards block before model dispatch and redact reasons', async () => {
    const model = scripted([final(4)]); const generate = vi.spyOn(model, 'generate');
    const blocker: Guard = { id: 'blocker', check: () => ({ decision: 'block', reason: 'SECRET' }) };
    const result = await runtime().submit(agent(model, { guards: { input: [blocker] } }), { input: 2 }).result();
    expect(result).toMatchObject({ status: 'blocked', error: { code: 'GUARD_BLOCKED' } });
    expect(generate).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('unavailable guards fail closed without leaking exceptions', async () => {
    const unavailable: Guard = { id: 'unavailable', check: () => { throw new MayuraError('INVALID_INPUT', 'SECRET'); } };
    const result = await runtime().submit(agent(undefined, { guards: { input: [unavailable] } }), { input: 2 }).result();
    expect(result).toMatchObject({ status: 'blocked', error: { code: 'GUARD_UNAVAILABLE' } });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('withholds tool results from model and preserves successful execution receipts when agent output guard blocks', async () => {
    const tool = defineTool({ id: 'double', version: '1', description: 'tool', input: numberSchema, output: numberSchema, effects: 'write', capabilities: [], execute: async (input) => input });
    const model = scripted([call(), final(4)]); const generate = vi.spyOn(model, 'generate');
    const blocker: Guard = { id: 'blocker', check: () => ({ decision: 'block' }) };
    const run = runtime({ profile: 'ephemeral', permissions: { allow: ['model:fixture', 'tool:double', 'effect:write'] } })
      .submit(agent(model, { tools: [tool], guards: { output: [blocker] } }), { input: 2 });
    expect(await run.result()).toMatchObject({ status: 'blocked', receipt: { execution: 'succeeded', disclosure: 'withheld' } });
    expect(generate).toHaveBeenCalledOnce();
    const event = (await collect(run.observe())).find((entry) => entry.type === 'tool.completed');
    expect(event?.metadata).toMatchObject({ execution: 'succeeded', disclosure: 'withheld' });
  });

  it('enforces bounded step and model-call counts', async () => {
    const tool = defineTool({ id: 'double', version: '1', description: 'tool', input: numberSchema, output: numberSchema, effects: 'none', capabilities: [], execute: async (input) => input });
    for (const limits of [{ maxSteps: 1 }, { maxModelCalls: 1 }]) {
      expect(await runtime({ profile: 'ephemeral', permissions: { allow: ['model:fixture', 'tool:double'] }, limits })
        .submit(agent(scripted([call(), final(4)]), { tools: [tool] }), { input: 2 }).result()).toMatchObject({ status: 'failed', error: { code: 'LIMIT_EXCEEDED' } });
    }
  });

  it('enforces tool-call counts on a batch before dispatch', async () => {
    const tool = defineTool({ id: 'double', version: '1', description: 'tool', input: numberSchema, output: numberSchema, effects: 'none', capabilities: [], execute: async (input) => input });
    const response = { type: 'tool_calls', calls: [{ id: 'one', toolId: 'double', input: 2 }, { id: 'two', toolId: 'double', input: 2 }], usage: { costMicros: 0 } };
    const result = await runtime({ profile: 'ephemeral', permissions: { allow: ['model:fixture', 'tool:double'] }, limits: { maxToolCalls: 1 } })
      .submit(agent(scripted([response]), { tools: [tool] }), { input: 2 }).result();
    expect(result.status).toBe('failed');
  });

  it('cancels a hanging model and does not dispatch after pre-start cancellation', async () => {
    const model = scripted([]); const generate = vi.fn(() => new Promise<ModelResponse>(() => {})); model.generate = generate;
    const value = runtime();
    const immediate = value.submit(agent(model), { input: 2 }); immediate.cancel();
    expect(await immediate.result()).toMatchObject({ status: 'cancelled' });
    expect(generate).not.toHaveBeenCalled();
    const pending = value.submit(agent(model), { input: 2 });
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce());
    pending.cancel(); pending.cancel();
    expect(await pending.result()).toMatchObject({ status: 'cancelled' });
  });

  it('deadline bounds a hanging asynchronous model call', async () => {
    vi.useFakeTimers();
    const model = scripted([]); model.generate = () => new Promise<ModelResponse>(() => {});
    const run = runtime({ profile: 'ephemeral', permissions: { allow: ['model:fixture'] }, limits: { maxDurationMs: 10 } }).submit(agent(model), { input: 2 });
    await vi.advanceTimersByTimeAsync(11);
    expect(await run.result()).toMatchObject({ status: 'failed', error: { code: 'TIMEOUT' } });
  });

  it('returns unknown outcome when cancellation races a dispatched external tool', async () => {
    let started = false;
    const tool = defineTool({ id: 'double', version: '1', description: 'tool', input: numberSchema, output: numberSchema, effects: 'write', capabilities: [], execute: () => { started = true; return new Promise<number>(() => {}); } });
    const run = runtime({ profile: 'ephemeral', permissions: { allow: ['model:fixture', 'tool:double', 'effect:write'] } }).submit(agent(scripted([call()]), { tools: [tool] }), { input: 2 });
    await vi.waitFor(() => expect(started).toBe(true)); run.cancel();
    expect(await run.result()).toMatchObject({ status: 'outcome_unknown', receipt: { execution: 'unknown', disclosure: 'withheld' } });
  });

  it('bounds retained events, reports explicit gaps, and allows observer cancellation without run cancellation', async () => {
    const run = runtime({ profile: 'ephemeral', permissions: { allow: ['model:fixture'] }, limits: { maxEventRetention: 2 } }).submit(agent(), { input: 2 });
    await run.result();
    const events = await collect(run.observe());
    expect(events[0]).toMatchObject({ type: 'events.gap', sequence: 2, metadata: { from: 1, to: 2 } });
    expect(events.map((event) => event.sequence)).toEqual([2, 3, 4]);
    const cancelled = new AbortController(); cancelled.abort();
    expect(await collect(run.observe({ signal: cancelled.signal }))).toEqual([]);
    expect(await run.result()).toMatchObject({ status: 'succeeded' });
    await expect(collect(run.observe({ after: 999 }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('bounds concurrent runs and closes idempotently', async () => {
    const model = scripted([]); model.generate = () => new Promise<ModelResponse>(() => {});
    const value = runtime({ profile: 'ephemeral', permissions: { allow: ['model:fixture'] }, limits: { maxConcurrentRuns: 1 } });
    const run = value.submit(agent(model), { input: 2 });
    expect(() => value.submit(agent(model), { input: 2 })).toThrow(MayuraError);
    await value.close(); await value.close();
    expect(await run.result()).toMatchObject({ status: 'cancelled' });
    expect(() => value.submit(agent(), { input: 2 })).toThrow(MayuraError);
  });

  it('snapshots submitted input and definition adapter references', async () => {
    const input = { value: 1 };
    const model = scripted([{ type: 'final', output: { value: 1 }, usage: { costMicros: 0 } }], { inspect: (request) => expect(request.messages[0]).toEqual({ role: 'user', content: { value: 1 } }) });
    const definition = defineAgent({ id: 'test', version: '1', instructions: 'test', model, tools: [], input: identitySchema, output: identitySchema });
    model.generate = async () => { throw new Error('mutated'); };
    const run = runtime().submit(definition, { input }); input.value = 9;
    expect(await run.result()).toEqual({ status: 'succeeded', output: { value: 1 } });
  });

  it('rejects unsupported profile and invalid finite configuration', () => {
    expect(() => createRuntime({ profile: 'durable' as 'ephemeral' })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_PROFILE' }));
    for (const maxDurationMs of [0, -1, Infinity, 2_147_483_648]) expect(() => createRuntime({ profile: 'ephemeral', limits: { maxDurationMs } })).toThrow(MayuraError);
    expect(() => createRuntime({ profile: 'ephemeral', limits: { maxCostMicros: -1 } })).toThrow(MayuraError);
  });

  it('enforces input, model envelope, and total model context byte limits', async () => {
    const inputLimited = runtime({ profile: 'ephemeral', permissions: { allow: ['model:fixture'] }, limits: { maxInputBytes: 1 } });
    expect(() => inputLimited.submit(agent(), { input: 123 })).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
    const outputLimited = runtime({ profile: 'ephemeral', permissions: { allow: ['model:fixture'] }, limits: { maxOutputBytes: 5 } });
    expect(await outputLimited.submit(agent(), { input: 2 }).result()).toMatchObject({ status: 'failed', error: { code: 'MODEL_FAILED' } });
    const model = scripted([final(4)]); const generate = vi.spyOn(model, 'generate');
    const contextLimited = runtime({ profile: 'ephemeral', permissions: { allow: ['model:fixture'] }, limits: { maxContextBytes: 10 } });
    expect(await contextLimited.submit(agent(model), { input: 2 }).result()).toMatchObject({ status: 'failed', error: { code: 'INVALID_JSON' } });
    expect(generate).not.toHaveBeenCalled();
  });

  it.each(['schema', 'guard'])('bounds a hanging asynchronous %s at the whole-run deadline', async (boundary) => {
    vi.useFakeTimers();
    const neverSchema: Schema<number> = { '~standard': { version: 1, vendor: 'test', validate: () => new Promise<{ value: number }>(() => {}) } };
    const neverGuard: Guard = { id: 'never', check: () => new Promise(() => {}) };
    const definition = agent(undefined, boundary === 'schema' ? { input: neverSchema } : { guards: { input: [neverGuard] } });
    const run = runtime({ profile: 'ephemeral', permissions: { allow: ['model:fixture'] }, limits: { maxDurationMs: 10 } }).submit(definition, { input: 2 });
    await vi.advanceTimersByTimeAsync(11);
    expect(await run.result()).toMatchObject({ status: 'failed', error: { code: 'TIMEOUT' } });
  });

  it('isolates histories for concurrent submissions using a stateless trusted adapter', async () => {
    const model = scripted([]); model.generate = async (request) => {
      const message = request.messages[0];
      if (message?.role !== 'user' || typeof message.content !== 'number') throw new Error('unexpected fixture input');
      return final(message.content * 2);
    };
    const definition = agent(model); const value = runtime();
    const one = value.submit(definition, { input: 2 }); const two = value.submit(definition, { input: 3 });
    expect(await Promise.all([one.result(), two.result()])).toEqual([{ status: 'succeeded', output: 4 }, { status: 'succeeded', output: 6 }]);
    expect(one.id).not.toBe(two.id);
  });

  it('snapshots schema validator functions without promising vendor-specific methods', async () => {
    const schema = { '~standard': { version: 1 as const, vendor: 'test', validate: (value: unknown) => ({ value: value as number }) } };
    const definition = agent(undefined, { input: schema, output: schema });
    schema['~standard'].validate = () => { throw new Error('later mutation'); };
    expect(await runtime().submit(definition, { input: 2 }).result()).toEqual({ status: 'succeeded', output: 4 });
  });

  it('rejects unregistered tools, duplicate registries, and incompatible model capabilities at definition time', () => {
    const tool = defineTool({ id: 'double', version: '1', description: 'tool', input: numberSchema, output: numberSchema, effects: 'none', capabilities: [], execute: (value) => value });
    expect(() => agent(undefined, { tools: [{ ...tool }] })).toThrow(MayuraError);
    expect(() => agent(undefined, { tools: [tool, tool] })).toThrow(MayuraError);
    const incompatible = { ...scripted([]), capabilities: { tools: false, structuredOutput: true } };
    expect(() => agent(incompatible, { tools: [tool] })).toThrow(MayuraError);
  });

  it('delivers live events and terminates an aborted observer without cancelling execution', async () => {
    let complete!: (response: ModelResponse) => void;
    const model = scripted([]); model.generate = () => new Promise((resolve) => { complete = resolve; });
    const run = runtime().submit(agent(model), { input: 2 });
    const controller = new AbortController();
    const iterator = run.observe({ signal: controller.signal })[Symbol.asyncIterator]();
    expect((await iterator.next()).value.type).toBe('run.started');
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    controller.abort();
    expect((await iterator.next()).done).toBe(true);
    complete(final(4));
    expect(await run.result()).toEqual({ status: 'succeeded', output: 4 });
  });

  it('redacts an exception thrown while reading an adapter-owned guard verdict', async () => {
    const guard: Guard = { id: 'accessor', check: () => ({ get decision(): 'allow' { throw new MayuraError('MODEL_FAILED', 'SECRET'); } }) };
    const result = await runtime().submit(agent(undefined, { guards: { input: [guard] } }), { input: 2 }).result();
    expect(result).toMatchObject({ status: 'blocked', error: { code: 'GUARD_UNAVAILABLE' } });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('bounds an endless final-output guard without releasing the result', async () => {
    vi.useFakeTimers();
    const guard: Guard = { id: 'endless', check: () => new Promise(() => {}) };
    const run = runtime({ profile: 'ephemeral', permissions: { allow: ['model:fixture'] }, limits: { maxDurationMs: 10 } })
      .submit(agent(undefined, { guards: { output: [guard] } }), { input: 2 });
    await vi.advanceTimersByTimeAsync(11);
    expect(await run.result()).toMatchObject({ status: 'failed', error: { code: 'TIMEOUT' } });
    expect(await run.result()).not.toHaveProperty('output');
  });

  it('bounds an endless final-output schema without releasing the result', async () => {
    vi.useFakeTimers();
    const output: Schema<number> = { '~standard': { version: 1, vendor: 'test', validate: () => new Promise<{ value: number }>(() => {}) } };
    const run = runtime({ profile: 'ephemeral', permissions: { allow: ['model:fixture'] }, limits: { maxDurationMs: 10 } })
      .submit(agent(undefined, { output }), { input: 2 });
    await vi.advanceTimersByTimeAsync(11);
    expect(await run.result()).toMatchObject({ status: 'failed', error: { code: 'TIMEOUT' } });
    expect(await run.result()).not.toHaveProperty('output');
  });

  it('copies only declared scope and model capability fields into execution metadata', async () => {
    const model = { ...scripted([final(4)]), capabilities: { tools: true, structuredOutput: true, secret: 'SECRET' } };
    const guard: Guard = { id: 'scope', check: (_value, context) => {
      expect(context.scope).toEqual({ principalId: 'alice', projectId: 'project' });
      expect(Object.isFrozen(context)).toBe(true);
      return { decision: 'allow' };
    } };
    const definition = agent(model, { guards: { input: [guard] } });
    expect(definition.model.capabilities).not.toHaveProperty('secret');
    const suppliedScope = { principalId: 'alice', projectId: 'project', secret: 'SECRET' };
    const value = runtime({ profile: 'ephemeral', permissions: { allow: ['model:fixture'] }, scope: suppliedScope });
    expect(await value.submit(definition, { input: 2 }).result()).toMatchObject({ status: 'succeeded' });
  });
});
