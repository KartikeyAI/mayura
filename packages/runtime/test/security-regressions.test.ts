import { afterEach, describe, expect, it, vi } from 'vitest';
import { MayuraError, ModelInvocationError, type Guard, type GuardVerdict, type ModelAdapter, type ModelResponse, type RunEvent, type Schema } from '@mayura/core';
import { defineTool } from '@mayura/tools';
import { createRuntime, defineAgent, type Runtime } from '../src/index.js';

const numberSchema: Schema<number> = {
  '~standard': { version: 1, vendor: 'regression', validate: (value) => typeof value === 'number' && Number.isFinite(value)
    ? { value } : { issues: [{ message: 'Number required.' }] } },
};
const runtimes: Runtime[] = [];
function runtime(maxCostMicros = 5, maxDurationMs = 5_000) {
  const value = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:fixture', 'tool:write', 'effect:write'] },
    limits: { maxCostMicros, maxDurationMs } });
  runtimes.push(value);
  return value;
}
function model(generate: ModelAdapter['generate'], maxCostMicros = 0): ModelAdapter {
  return { id: 'fixture', capabilities: { tools: true, structuredOutput: true }, maxCostMicros, generate };
}
async function collect(source: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const values: RunEvent[] = [];
  for await (const value of source) values.push(value);
  return values;
}
afterEach(async () => { await Promise.all(runtimes.splice(0).map((value) => value.close())); });

describe('runtime boundary security regressions', () => {
  it.each(['input', 'output'] as const)('uses one %s guard decision even when later reads would authorize', async (boundary) => {
    let reads = 0;
    const guard: Guard = { id: 'changing-decision', check: () => ({
      get decision(): GuardVerdict['decision'] { return ++reads < 3 ? 'block' : 'allow'; },
    }) };
    const generate = vi.fn(async (): Promise<ModelResponse> => ({ type: 'final', output: 2, usage: { costMicros: 0 } }));
    const agent = defineAgent({ id: 'regression', version: '1', instructions: 'test', input: numberSchema, output: numberSchema,
      tools: [], model: model(generate), guards: { [boundary]: [guard] } });
    const run = runtime().submit(agent, { input: 1 });
    expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'GUARD_BLOCKED' } });
    expect(reads).toBe(1);
    expect(generate).toHaveBeenCalledTimes(boundary === 'input' ? 0 : 1);
    expect('output' in await run.result()).toBe(false);
  });

  it.each([
    { label: 'empty tool batch', response: { type: 'tool_calls', calls: [] } },
    { label: 'non-JSON continuation', response: { type: 'final', output: 2, continuation: { secret: undefined } } },
    { label: 'accessor continuation', response: { type: 'final', output: 2, get continuation() { throw new Error('private-continuation'); } } },
  ])('records known over-bound usage before rejecting $label', async ({ response }) => {
    const generate = vi.fn(async () => {
      // Preserve accessors so this exercises malformed provider data, not fixture construction.
      return Object.defineProperty(response, 'usage', { value: { costMicros: 6 }, configurable: true, enumerable: true }) as unknown as ModelResponse;
    });
    const execute = vi.fn(() => 2);
    const tool = defineTool({ id: 'write', version: '1', description: 'Must not dispatch.', input: numberSchema, output: numberSchema,
      effects: 'write', capabilities: [], execute });
    const agent = defineAgent({ id: 'regression', version: '1', instructions: 'test', input: numberSchema, output: numberSchema,
      tools: [tool], model: model(generate, 5) });
    const run = runtime().submit(agent, { input: 1 });
    const outcome = await run.result();
    expect(outcome).toMatchObject({ status: 'blocked', error: { code: 'BUDGET_EXCEEDED' } });
    expect(execute).not.toHaveBeenCalled();
    expect(generate).toHaveBeenCalledTimes(1);
    const events = await collect(run.observe());
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', metadata: { spentMicros: 6, reservedMicros: 0, calls: 1 } });
    expect(events.some((event) => event.type === 'model.completed' || event.type === 'tool.started')).toBe(false);
    expect(JSON.stringify([outcome, events])).not.toContain('private-continuation');
    expect('output' in outcome).toBe(false);
  });

  it.each([
    { label: 'empty tool batch', response: { type: 'tool_calls', calls: [] } },
    { label: 'non-JSON continuation', response: { type: 'final', output: 2, continuation: { secret: undefined } } },
  ])('settles valid within-bound usage before rejecting $label', async ({ response }) => {
    const generate = vi.fn(async () => ({ ...response, usage: { costMicros: 4 } }) as ModelResponse);
    const agent = defineAgent({ id: 'regression', version: '1', instructions: 'test', input: numberSchema, output: numberSchema,
      tools: [], model: model(generate, 5) });
    const run = runtime().submit(agent, { input: 1 });
    expect(await run.result()).toMatchObject({ status: 'failed', error: { code: 'MODEL_FAILED' } });
    const events = await collect(run.observe());
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', metadata: { spentMicros: 4, reservedMicros: 0, calls: 1 } });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it.each(['none', 'write'] as const)('preserves run deadline classification while a %s tool is pending', async (effects) => {
    const tool = defineTool({ id: 'write', version: '1', description: 'Pending callback.', input: numberSchema, output: numberSchema,
      effects, capabilities: [], timeoutMs: 10_000, execute: () => new Promise<number>(() => {}) });
    const generate = vi.fn(async (): Promise<ModelResponse> => ({ type: 'tool_calls', calls: [{ id: 'call.1', toolId: 'write', input: 1 }], usage: { costMicros: 0 } }));
    const agent = defineAgent({ id: 'regression', version: '1', instructions: 'test', input: numberSchema, output: numberSchema,
      tools: [tool], model: model(generate) });
    const run = runtime(5, 25).submit(agent, { input: 1 });
    expect(await run.result()).toMatchObject(effects === 'none'
      ? { status: 'failed', error: { code: 'TIMEOUT' }, receipt: { execution: 'unknown', disclosure: 'withheld' } }
      : { status: 'outcome_unknown', error: { code: 'OUTCOME_UNKNOWN' }, receipt: { execution: 'unknown', disclosure: 'withheld' } });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it.each([0, 4, 5, 6])('reconciles confirmed failure usage %i against the reservation before terminating', async (costMicros) => {
    const error = new ModelInvocationError(costMicros);
    expect(Object.isFrozen(error)).toBe(true);
    const generate = vi.fn(async (): Promise<ModelResponse> => { throw error; });
    const agent = defineAgent({ id: 'regression', version: '1', instructions: 'test', input: numberSchema, output: numberSchema,
      tools: [], model: model(generate, 5) });
    const run = runtime().submit(agent, { input: 1 });
    const outcome = await run.result();
    expect(outcome).toMatchObject(costMicros > 5
      ? { status: 'blocked', error: { code: 'BUDGET_EXCEEDED' } }
      : { status: 'failed', error: { code: 'MODEL_FAILED' } });
    const events = await collect(run.observe());
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', metadata: { spentMicros: costMicros, reservedMicros: 0, calls: 1 } });
    expect(events.filter((event) => event.type === 'model.started')).toHaveLength(1);
    expect(events.some((event) => event.type === 'model.completed' || event.type === 'tool.started')).toBe(false);
    expect(generate).toHaveBeenCalledTimes(1);
    expect('output' in outcome).toBe(false);
  });

  it.each([
    { label: 'ordinary exception', error: new Error('private-provider-failure') },
    { label: 'framework-shaped exception', error: new MayuraError('MODEL_FAILED', 'private-provider-failure') },
    { label: 'structural known-cost impostor', error: { code: 'MODEL_FAILED', costMicros: 4, message: 'private-provider-failure' } },
  ])('redacts $label without treating unconfirmed usage as settled', async ({ error }) => {
    const generate = vi.fn(async (): Promise<ModelResponse> => { throw error; });
    const agent = defineAgent({ id: 'regression', version: '1', instructions: 'test', input: numberSchema, output: numberSchema,
      tools: [], model: model(generate, 5) });
    const run = runtime().submit(agent, { input: 1 });
    const outcome = await run.result();
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'MODEL_FAILED' } });
    const events = await collect(run.observe());
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', metadata: { spentMicros: 0, reservedMicros: 5, calls: 1 } });
    expect(JSON.stringify([outcome, events])).not.toContain('private-provider-failure');
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
