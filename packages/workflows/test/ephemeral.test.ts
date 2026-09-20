import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import { ModelInvocationError, type JsonValue, type ModelMessage, type ModelRequest, type RunEvent, type Schema } from '@mayura/core';
import { createRuntime, type Runtime, type RuntimeLimits } from '@mayura/runtime';
import { defineTool, type AnyTool } from '@mayura/tools';
import { defineWorkflow, type WorkflowDefinition } from '@mayura/workflows';
import { workflowAsAgent, workflowAsTool } from '@mayura/workflows/ephemeral';

const number = z.number();
const json: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'workflow-test', validate: value => ({ value: value as JsonValue }) } };
const grants = ['model:mayura.workflow', 'model:custom.planner', 'tool:increment', 'tool:other', 'tool:delegate', 'effect:write', 'agent:delegate'];
const runtimes: Runtime[] = [];
function runtime(limits: RuntimeLimits = {}, allow: readonly string[] = grants): Runtime {
  const engine = createRuntime({ profile: 'ephemeral', permissions: { allow }, limits: { maxDurationMs: 2_000, maxCostMicros: 100, ...limits } });
  runtimes.push(engine); return engine;
}
function tool(execute: (value: number) => number | Promise<number> = value => value + 1, options: { costMicros?: number; outputGuard?: 'allow' | 'block'; effects?: 'none' | 'write'; id?: string; version?: string } = {}) {
  return defineTool({ id: options.id ?? 'increment', version: options.version ?? '1', description: 'Controlled number transformation.',
    input: number, output: number, effects: options.effects ?? 'none', capabilities: [], costMicros: options.costMicros ?? 0, execute,
    ...(options.outputGuard ? { guards: { output: [{ id: 'output-check', check: () => ({ decision: options.outputGuard! }) }] } } : {}),
  });
}
function single(selected: AnyTool = tool(), approval = false) {
  return defineWorkflow({ id: 'single', version: '1', input: number, output: number,
    nodes: [{ kind: 'tool', id: 'first', tool: selected, input: { kind: 'input', path: [] }, approval }],
    result: { kind: 'step', stepId: 'first', path: [] },
  });
}
function wrapped(definition: WorkflowDefinition = single(), allow: readonly string[] = grants) {
  const delegate = workflowAsTool(definition, { profile: 'ephemeral', id: 'delegate', description: 'Required workflow child.', permissions: { allow } });
  return single(delegate);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
async function events(source: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const values: RunEvent[] = []; for await (const value of source) values.push(value); return values;
}
function request(messages: readonly ModelMessage[]): ModelRequest {
  return { instructions: 'Unused local planner instructions.', messages, tools: [], signal: new AbortController().signal, maxOutputTokens: 1_024 };
}
afterEach(async () => { await Promise.all(runtimes.splice(0).map(engine => engine.close())); });

describe('public ephemeral workflow composition', () => {
  it('executes a chain with one registered tool reused across nodes', async () => {
    const execute = vi.fn((value: number) => value + 1); const increment = tool(execute);
    const definition = defineWorkflow({ id: 'chain', version: '1', input: number, output: number,
      nodes: [
        { kind: 'tool', id: 'first', tool: increment, input: { kind: 'input', path: [] } },
        { kind: 'tool', id: 'second', tool: increment, dependsOn: ['first'], input: { kind: 'step', stepId: 'first', path: [] } },
      ], result: { kind: 'step', stepId: 'second', path: [] },
    });
    const agent = workflowAsAgent(definition, { profile: 'ephemeral' }); const engine = runtime(); const run = engine.submit(agent, { input: 4 });
    expect(await run.result()).toMatchObject({ status: 'succeeded', output: 6 });
    expect(execute.mock.calls.map(call => call[0])).toEqual([4, 5]); expect(agent.tools).toHaveLength(1);
    const trace = await events(run.observe()); expect(trace.filter(item => item.type === 'model.started')).toHaveLength(3);
    expect(trace.filter(item => item.type === 'tool.started').map(item => item.metadata['callId'])).toEqual(['first', 'second']);
    expect(engine.inspect(run).budget).toMatchObject({ spentMicros: 0, reservedMicros: 0, calls: 5 });
  });

  it('supports fan-in, nested input/step paths, literal bindings and reverse-declared join chains', async () => {
    const definition = defineWorkflow({ id: 'join', version: '1', input: json, output: json,
      nodes: [
        { kind: 'join', id: 'outer', dependsOn: ['inner'] },
        { kind: 'join', id: 'inner', dependsOn: ['left', 'right'] },
        { kind: 'tool', id: 'left', tool: tool(), input: { kind: 'input', path: ['nested', 'value'] } },
        { kind: 'tool', id: 'right', tool: tool(undefined, { id: 'other' }), input: { kind: 'literal', value: 7 } },
      ], result: { kind: 'step', stepId: 'outer', path: ['0'] },
    });
    const engine = runtime(); const run = engine.submit(workflowAsAgent(definition, { profile: 'ephemeral' }), { input: { nested: { value: 2 } } });
    expect(await run.result()).toMatchObject({ status: 'succeeded', output: [3, 8] });
    expect((await events(run.observe())).filter(item => item.type === 'model.started')).toHaveLength(2);
  });

  it.each(['input', 'literal'] as const)('projects a %s result only after all required effects finish', async kind => {
    const execute = vi.fn((value: number) => value); const definition = defineWorkflow({ id: 'result', version: '1', input: number, output: number,
      nodes: [{ kind: 'tool', id: 'first', tool: tool(execute), input: { kind: 'literal', value: 3 } }],
      result: kind === 'input' ? { kind, path: [] } : { kind, value: 9 },
    });
    const run = runtime().submit(workflowAsAgent(definition, { profile: 'ephemeral' }), { input: 5 });
    expect(await run.result()).toMatchObject({ status: 'succeeded', output: kind === 'input' ? 5 : 9 }); expect(execute).toHaveBeenCalledOnce();
  });

  it('projects an effect-free join graph in one visible planning call', async () => {
    const definition = defineWorkflow({ id: 'joins', version: '1', input: number, output: json,
      nodes: [{ kind: 'join', id: 'later', dependsOn: ['empty'] }, { kind: 'join', id: 'empty', dependsOn: [] }],
      result: { kind: 'step', stepId: 'later', path: [] },
    });
    const engine = runtime(); const run = engine.submit(workflowAsAgent(definition, { profile: 'ephemeral' }), { input: 1 });
    expect(await run.result()).toMatchObject({ status: 'succeeded', output: [[]] }); expect(engine.inspect(run).budget.calls).toBe(1);
  });

  it('reuses one compiled definition concurrently without leaking input or completion state', async () => {
    const agent = workflowAsAgent(single(), { profile: 'ephemeral' }); const engine = runtime();
    const runs = Array.from({ length: 12 }, (_, value) => engine.submit(agent, { input: value }));
    const outcomes = await Promise.all(runs.map(run => run.result()));
    expect(outcomes.map(outcome => outcome.status === 'succeeded' ? outcome.output : null)).toEqual(Array.from({ length: 12 }, (_, value) => value + 1));
    expect(runs.every(run => engine.inspect(run).budget.calls === 3)).toBe(true);
  });

  it('reuses one child-workflow wrapper concurrently without mixing run-qualified receipts', async () => {
    const agent = workflowAsAgent(wrapped(single(tool(undefined, { effects: 'write' }))), { profile: 'ephemeral' });
    const engine = runtime({ maxConcurrentOperations: 1 }); const runs = [2, 8].map(input => engine.submit(agent, { input }));
    const outcomes = await Promise.all(runs.map(run => run.result()));
    expect(outcomes.map(outcome => outcome.status === 'succeeded' ? outcome.output : null)).toEqual([3, 9]);
    const inspections = runs.map(run => engine.inspect(run));
    const childIds = inspections.map(inspection => inspection.runs.find(run => run.parentId === inspection.id)?.id);
    expect(childIds[0]).not.toBe(childIds[1]);
    for (let index = 0; index < inspections.length; index++) {
      expect(inspections[index]?.evidence.find(item => item.receipt.toolId === 'increment')?.runId).toBe(childIds[index]);
      expect(inspections[index]?.evidence.some(item => item.runId === childIds[1 - index])).toBe(false);
    }
  });

  it.each(['agent', 'tool'] as const)('retains input/output schema transformation and inferred public types through %s', async path => {
    const execute = vi.fn((value: number) => value + 1);
    const definition = defineWorkflow({ id: 'transforms', version: '1', input: z.string().transform(value => Number(value)),
      output: z.number().transform(value => ({ total: value })),
      nodes: [{ kind: 'tool', id: 'first', tool: tool(execute), input: { kind: 'input', path: [] } }],
      result: { kind: 'step', stepId: 'first', path: [] },
    });
    const child = workflowAsAgent(definition, { profile: 'ephemeral' }); const engine = runtime();
    if (path === 'agent') {
      const run = engine.submit(child, { input: '5' }); const outcome = await run.result();
      if (outcome.status === 'succeeded') expectTypeOf(outcome.output).toEqualTypeOf<{ total: number }>();
      expect(outcome).toMatchObject({ status: 'succeeded', output: { total: 6 } });
    } else {
      const delegate = workflowAsTool(definition, { profile: 'ephemeral', id: 'delegate', description: 'Transform child.', permissions: { allow: grants } });
      const parent = defineWorkflow({ id: 'transform-parent', version: '1', input: z.string(), output: z.object({ total: z.number() }),
        nodes: [{ kind: 'tool', id: 'child', tool: delegate, input: { kind: 'input', path: [] } }], result: { kind: 'step', stepId: 'child', path: [] },
      });
      expect(await engine.submit(workflowAsAgent(parent, { profile: 'ephemeral' }), { input: '5' }).result()).toMatchObject({ status: 'succeeded', output: { total: 6 } });
    }
    expect(execute).toHaveBeenCalledOnce(); expect(execute.mock.calls[0]?.[0]).toBe(5);
  });

  it('rejects malformed submitted input and unresolved paths before dispatch', async () => {
    const execute = vi.fn((value: number) => value); const engine = runtime(); const agent = workflowAsAgent(single(tool(execute)), { profile: 'ephemeral' });
    expect((await engine.submit(agent, { input: 'SECRET' as unknown as number }).result()).status).not.toBe('succeeded');
    const getter = vi.fn(() => { throw new Error('SECRET'); });
    expect(() => engine.submit(agent, { input: Object.defineProperty({}, 'secret', { enumerable: true, get: getter }) as number })).toThrow();
    expect(getter).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    const invalidPath = defineWorkflow({ id: 'path', version: '1', input: json, output: number,
      nodes: [{ kind: 'tool', id: 'first', tool: tool(execute), input: { kind: 'input', path: ['missing'] } }], result: { kind: 'step', stepId: 'first', path: [] },
    });
    const outcome = await engine.submit(workflowAsAgent(invalidPath, { profile: 'ephemeral' }), { input: {} }).result();
    expect(outcome.status).not.toBe('succeeded'); expect(JSON.stringify(outcome)).not.toContain('SECRET'); expect(execute).not.toHaveBeenCalled();
  });

  it.each(['model:mayura.workflow', 'tool:increment', 'effect:write'] as const)('requires the explicit %s grant', async missing => {
    const execute = vi.fn((value: number) => value); const engine = runtime({}, grants.filter(grant => grant !== missing));
    const run = engine.submit(workflowAsAgent(single(tool(execute, { effects: 'write' })), { profile: 'ephemeral' }), { input: 1 });
    expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'PERMISSION_DENIED' } }); expect(execute).not.toHaveBeenCalled();
  });

  it('supports a custom planner identity only with its exact explicit grant', async () => {
    const agent = workflowAsAgent(single(), { profile: 'ephemeral', plannerId: 'custom.planner' });
    expect(await runtime().submit(agent, { input: 1 }).result()).toMatchObject({ status: 'succeeded', output: 2 });
    expect(await runtime({}, grants.filter(grant => grant !== 'model:custom.planner')).submit(agent, { input: 1 }).result()).toMatchObject({ status: 'blocked' });
  });

  it('rejects forged definitions, non-ephemeral profiles, approvals and ambiguous tool identities before effects', () => {
    const execute = vi.fn((value: number) => value); const genuine = single(tool(execute));
    expect(() => workflowAsAgent({ ...genuine }, { profile: 'ephemeral' })).toThrow();
    expect(() => workflowAsAgent(genuine, { profile: 'durable' as 'ephemeral' })).toThrow();
    expect(() => workflowAsAgent(single(tool(execute), true), { profile: 'ephemeral' })).toThrow();
    const ambiguous = defineWorkflow({ id: 'ambiguous', version: '1', input: number, output: number,
      nodes: [
        { kind: 'tool', id: 'first', tool: tool(execute), input: { kind: 'input', path: [] } },
        { kind: 'tool', id: 'second', tool: tool(execute, { version: '2' }), input: { kind: 'input', path: [] } },
      ], result: { kind: 'input', path: [] },
    });
    expect(() => workflowAsAgent(ambiguous, { profile: 'ephemeral' })).toThrow(); expect(execute).not.toHaveBeenCalled();
  });

  it('runs workflow-as-tool through one execution slot with shared ancestor accounting and receipts', async () => {
    const execute = vi.fn((value: number) => value + 1); const engine = runtime({ maxConcurrentOperations: 1 });
    const run = engine.submit(workflowAsAgent(wrapped(single(tool(execute, { effects: 'write', costMicros: 3 }))), { profile: 'ephemeral' }), { input: 1 });
    expect(await run.result()).toMatchObject({ status: 'succeeded', output: 2 });
    const inspection = engine.inspect(run); expect(inspection.runs).toHaveLength(2); expect(inspection.budget).toMatchObject({ spentMicros: 3, reservedMicros: 0, calls: 6 });
    expect(inspection.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ receipt: expect.objectContaining({ toolId: 'increment', execution: 'succeeded', disclosure: 'released' }) })]));
  });

  it.each(['agent:delegate', 'tool:delegate'] as const)('requires wrapper authority %s before starting a child', async missing => {
    const execute = vi.fn((value: number) => value); const engine = runtime({}, grants.filter(grant => grant !== missing));
    const run = engine.submit(workflowAsAgent(wrapped(single(tool(execute))), { profile: 'ephemeral' }), { input: 1 });
    expect((await run.result()).status).not.toBe('succeeded'); expect(engine.inspect(run).runs).toHaveLength(1); expect(execute).not.toHaveBeenCalled();
  });

  it.each(['parent', 'child'] as const)('cannot recover a missing effect grant from %s authority', async boundary => {
    const execute = vi.fn((value: number) => value); const narrowed = grants.filter(grant => grant !== 'effect:write');
    const engine = runtime({}, boundary === 'parent' ? narrowed : grants);
    const run = engine.submit(workflowAsAgent(wrapped(single(tool(execute, { effects: 'write' })), boundary === 'child' ? narrowed : grants), { profile: 'ephemeral' }), { input: 1 });
    expect((await run.result()).status).not.toBe('succeeded'); expect(execute).not.toHaveBeenCalled();
  });

  it.each([{ maxCostMicros: 2 }, { maxToolCalls: 1 }] as RuntimeLimits[])('does not mint child cost or call capacity (%j)', async limits => {
    const execute = vi.fn((value: number) => value); const engine = runtime(limits);
    const run = engine.submit(workflowAsAgent(wrapped(single(tool(execute, { effects: 'write', costMicros: 3 }))), { profile: 'ephemeral' }), { input: 1 });
    expect((await run.result()).status).not.toBe('succeeded'); expect(execute).not.toHaveBeenCalled(); expect(engine.inspect(run).budget.spentMicros).toBe(0);
  });

  it('charges free planner calls against the shared tree cap without hiding prior effects', async () => {
    const execute = vi.fn((value: number) => value); const engine = runtime({ maxModelCalls: 2 });
    const run = engine.submit(workflowAsAgent(wrapped(single(tool(execute, { effects: 'write' }))), { profile: 'ephemeral' }), { input: 1 });
    expect((await run.result()).status).not.toBe('succeeded'); expect(execute).toHaveBeenCalledOnce();
    expect(engine.inspect(run).evidence).toEqual(expect.arrayContaining([expect.objectContaining({ receipt: expect.objectContaining({ toolId: 'increment', execution: 'succeeded' }) })]));
  });

  it.each(['throw', 'guard', 'schema'] as const)('never reports parent success or releases blocked child output after %s', async failure => {
    const execute = vi.fn((value: number) => { if (failure === 'throw') throw new Error('SECRET tool token'); return value; });
    const child = single(tool(execute, { effects: 'write', ...(failure === 'guard' ? { outputGuard: 'block' } : {}) }));
    const altered = failure === 'schema' ? defineWorkflow({ id: 'reject', version: '1', input: number, output: z.number().min(100), nodes: child.nodes, result: child.result }) : child;
    const engine = runtime(); const run = engine.submit(workflowAsAgent(wrapped(altered), { profile: 'ephemeral' }), { input: 1 });
    const outcome = await run.result(); expect(outcome.status).not.toBe('succeeded'); expect(JSON.stringify(outcome)).not.toContain('SECRET');
    expect(execute).toHaveBeenCalledOnce(); expect('output' in outcome).toBe(false);
    const evidence = engine.inspect(run).evidence.find(item => item.receipt.toolId === 'increment');
    expect(evidence?.receipt.execution).toBe(failure === 'throw' ? 'unknown' : 'succeeded');
    if (failure === 'guard') expect(evidence?.receipt.disclosure).toBe('withheld');
  });

  it('applies workflow input/output guards without exposing blocked final content', async () => {
    const execute = vi.fn((value: number) => value); const engine = runtime();
    for (const boundary of ['input', 'output'] as const) {
      const agent = workflowAsAgent(single(tool(execute)), { profile: 'ephemeral', guards: { [boundary]: [{ id: 'block', check: () => ({ decision: 'block', reason: 'SECRET' }) }] } });
      const outcome = await engine.submit(agent, { input: 1 }).result(); expect(outcome.status).toBe('blocked'); expect(JSON.stringify(outcome)).not.toContain('SECRET');
    }
    expect(execute).toHaveBeenCalledOnce();
  });

  it('cancels before dispatch without any tool effect', async () => {
    const execute = vi.fn((value: number) => value); const run = runtime().submit(workflowAsAgent(wrapped(single(tool(execute))), { profile: 'ephemeral' }), { input: 1 });
    run.cancel(); expect((await run.result()).status).toBe('cancelled'); expect(execute).not.toHaveBeenCalled();
  });

  it('propagates cancellation and late receipt reconciliation through a required workflow child', async () => {
    const started = deferred<void>(); const finish = deferred<number>();
    const execute = vi.fn(() => { started.resolve(); return finish.promise; }); const engine = runtime({ maxConcurrentOperations: 1 });
    const run = engine.submit(workflowAsAgent(wrapped(single(tool(execute, { effects: 'write', costMicros: 3 }))), { profile: 'ephemeral' }), { input: 1 });
    await started.promise; run.cancel(); const outcome = await run.result();
    expect(outcome.status).toBe('outcome_unknown'); expect('output' in outcome).toBe(false);
    expect(engine.inspect(run).evidence).toEqual(expect.arrayContaining([expect.objectContaining({ receipt: expect.objectContaining({ toolId: 'increment', execution: 'unknown', disclosure: 'withheld' }) })]));
    finish.resolve(10);
    await vi.waitFor(() => expect(engine.inspect(run).evidence).toEqual(expect.arrayContaining([expect.objectContaining({ receipt: expect.objectContaining({ toolId: 'increment', execution: 'succeeded', disclosure: 'withheld' }) })])));
    expect(execute).toHaveBeenCalledOnce(); expect(engine.inspect(run).budget).toMatchObject({ spentMicros: 3, reservedMicros: 0 });
  });

  it('propagates the owning deadline to a hanging effect without replaying it', async () => {
    const execute = vi.fn(() => new Promise<number>(() => {})); const engine = runtime({ maxDurationMs: 30 });
    const run = engine.submit(workflowAsAgent(wrapped(single(tool(execute, { effects: 'write' }))), { profile: 'ephemeral' }), { input: 1 });
    expect((await run.result()).status).toBe('outcome_unknown'); expect(execute).toHaveBeenCalledOnce();
  });

  it('does not silently raise a caller step bound for a valid long chain', async () => {
    const increment = tool(); const definition = defineWorkflow({ id: 'bounded', version: '1', input: number, output: number,
      nodes: [
        { kind: 'tool', id: 'first', tool: increment, input: { kind: 'input', path: [] } },
        { kind: 'tool', id: 'second', tool: increment, dependsOn: ['first'], input: { kind: 'step', stepId: 'first', path: [] } },
      ], result: { kind: 'step', stepId: 'second', path: [] },
    });
    expect((await runtime({ maxSteps: 2 }).submit(workflowAsAgent(definition, { profile: 'ephemeral' }), { input: 1 }).result()).status).not.toBe('succeeded');
  });
});

describe('direct deterministic planner transcript admission', () => {
  const user: ModelMessage = { role: 'user', content: 1 };
  const assistant: ModelMessage = { role: 'assistant', calls: [{ id: 'first', toolId: 'increment', input: 1 }] };
  const result: ModelMessage = { role: 'tool', callId: 'first', toolId: 'increment', result: 2 };
  it('returns immutable declared calls and final released-result projection', async () => {
    const planner = workflowAsAgent(single(), { profile: 'ephemeral' }).model;
    const first = await planner.generate(request([user])); expect(first).toEqual({ type: 'tool_calls', calls: [{ id: 'first', toolId: 'increment', input: 1 }], usage: { costMicros: 0 } });
    expect(Object.isFrozen(first)).toBe(true); if (first.type === 'tool_calls') expect(Object.isFrozen(first.calls[0]?.input)).toBe(true);
    expect(await planner.generate(request([user, assistant, result]))).toEqual({ type: 'final', output: 2, usage: { costMicros: 0 } });
  });
  it.each<readonly unknown[]>([
    [], [result], [user, result], [user, assistant], [user, assistant, result, result],
    [{ role: 'user', content: 1, secret: 'SECRET' }],
    [user, { role: 'assistant', calls: [{ id: 'other', toolId: 'increment', input: 1 }] }, result],
    [user, { role: 'assistant', calls: [{ id: 'first', toolId: 'other', input: 1 }] }, result],
    [user, { role: 'assistant', calls: [{ id: 'first', toolId: 'increment', input: 2 }] }, result],
    [user, { role: 'assistant', calls: [{ id: 'first', toolId: 'increment', input: 1, secret: 'SECRET' }] }, result],
    [user, assistant, { role: 'tool', callId: 'other', toolId: 'increment', result: 2 }],
    [user, assistant, { role: 'tool', callId: 'first', toolId: 'other', result: 2 }],
    [user, assistant, { role: 'tool', callId: 'first', toolId: 'increment', result: 2, secret: 'SECRET' }],
    [user, assistant, result, assistant, result],
  ])('rejects missing/forged/duplicate/out-of-wave transcript structure (%#)', async values => {
    const execute = vi.fn((value: number) => value); const planner = workflowAsAgent(single(tool(execute)), { profile: 'ephemeral' }).model;
    const rejection = await planner.generate(request(values as readonly ModelMessage[])).then(() => undefined, (error: unknown) => error);
    expect(rejection).toBeInstanceOf(ModelInvocationError); expect(rejection).toMatchObject({ costMicros: 0 });
    expect(String(rejection)).not.toContain('SECRET'); expect(execute).not.toHaveBeenCalled();
  });
  it('rejects accessors and pre-aborted requests without execution', async () => {
    const getter = vi.fn(() => { throw new Error('SECRET'); }); const execute = vi.fn((value: number) => value);
    const planner = workflowAsAgent(single(tool(execute)), { profile: 'ephemeral' }).model;
    const raw = Object.defineProperty({ role: 'user' }, 'content', { enumerable: true, get: getter });
    await expect(planner.generate(request([raw as ModelMessage]))).rejects.toBeInstanceOf(ModelInvocationError); expect(getter).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort(); await expect(planner.generate({ ...request([user]), signal: controller.signal })).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['partial', 'reordered-calls', 'reordered-results', 'early-dependent'] as const)('rejects %s when reconstructing dependency-ready waves', async malformed => {
    const increment = tool(); const definition = defineWorkflow({ id: 'waves', version: '1', input: number, output: number,
      nodes: [
        { kind: 'tool', id: 'left', tool: increment, input: { kind: 'input', path: [] } },
        { kind: 'tool', id: 'right', tool: increment, input: { kind: 'literal', value: 7 } },
        { kind: 'tool', id: 'later', tool: increment, dependsOn: ['left', 'right'], input: { kind: 'step', stepId: 'left', path: [] } },
      ], result: { kind: 'step', stepId: 'later', path: [] },
    });
    const planner = workflowAsAgent(definition, { profile: 'ephemeral' }).model;
    const left = { id: 'left', toolId: 'increment', input: 1 }; const right = { id: 'right', toolId: 'increment', input: 7 };
    const results: ModelMessage[] = [{ role: 'tool', callId: 'left', toolId: 'increment', result: 2 }, { role: 'tool', callId: 'right', toolId: 'increment', result: 8 }];
    const calls = malformed === 'partial' ? [left] : malformed === 'reordered-calls' ? [right, left]
      : malformed === 'early-dependent' ? [left, { id: 'later', toolId: 'increment', input: 2 }] : [left, right];
    const supplied = [user, { role: 'assistant' as const, calls }, ...(malformed === 'reordered-results' ? results.reverse() : results)];
    await expect(planner.generate(request(supplied))).rejects.toBeInstanceOf(ModelInvocationError);
  });
});
