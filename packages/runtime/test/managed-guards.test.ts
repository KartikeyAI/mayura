import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelInvocationError, type Guard, type JsonValue, type ModelAdapter, type ModelRequest, type ModelResponse, type RunEvent, type Schema } from '@mayura/core';
import { readManagedGuardDefinition, registerManagedGuardDefinition } from '@mayura/core/host';
import { defineTool } from '@mayura/tools';
import { defineModerationGuard } from '../../guardrails/src/index.js';
import { agentAsTool, createRuntime, defineAgent, type AgentOptions, type Runtime, type RuntimeLimits } from '../src/index.js';

const jsonSchema: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'managed-guard-test', validate: value => ({ value: value as JsonValue }) } };
const scope = { principalId: 'test-principal', projectId: 'test-project' };
const grants = ['model:primary', 'model:moderator', 'model:child', 'model:other-moderator', 'tool:write', 'tool:delegate', 'effect:write', 'agent:delegate'];
const permissions = { allow: grants };
const final = (output: JsonValue = 2, costMicros = 0): ModelResponse => ({ type: 'final', output, usage: { costMicros } });
const verdict = (decision: 'allow' | 'block' = 'allow', costMicros = 0): ModelResponse => final({ decision, categories: [] }, costMicros);
const call = (toolId = 'write', costMicros = 0): ModelResponse => ({ type: 'tool_calls', calls: [{ id: 'call.1', toolId, input: 1 }], usage: { costMicros } });
function model(id: string, generate: ModelAdapter['generate'], maxCostMicros = 0): ModelAdapter {
  return { id, capabilities: { tools: true, structuredOutput: true }, maxCostMicros, generate };
}
function moderation(adapter = model('moderator', async () => verdict()), extras: Partial<Parameters<typeof defineModerationGuard>[0]> = {}) {
  return defineModerationGuard({ id: 'moderation', version: '1', model: adapter, instructions: 'Private moderation policy.', egressGuards: [], ...extras });
}
function agent(adapter = model('primary', async () => final()), extras: Partial<AgentOptions<typeof jsonSchema, typeof jsonSchema>> = {}) {
  return defineAgent({ id: 'agent', version: '1', instructions: 'Private primary instructions.', input: jsonSchema, output: jsonSchema,
    tools: [], model: adapter, ...extras });
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
const runtimes: Runtime[] = [];
function runtime(limits: RuntimeLimits = {}, allow: readonly string[] = grants): Runtime {
  const engine = createRuntime({ profile: 'ephemeral', scope, permissions: { allow },
    limits: { maxDurationMs: 2_000, maxCostMicros: 100, ...limits } });
  runtimes.push(engine); return engine;
}
async function events(source: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const result: RunEvent[] = []; for await (const event of source) result.push(event); return result;
}
afterEach(async () => { await Promise.all(runtimes.splice(0).map(engine => engine.close())); vi.restoreAllMocks(); });

describe('runtime-owned managed guard admission', () => {
  it('automatically runs input and final-output checks on the real account with one operation permit', async () => {
    const seen: ModelRequest[] = [];
    const auxiliary = vi.fn(async (request: ModelRequest) => { seen.push(request); return verdict('allow', 3); });
    const primary = vi.fn(async () => final(2, 2));
    const guard = moderation(model('moderator', auxiliary, 3));
    const definition = agent(model('primary', primary, 2), { guards: { input: [guard], output: [guard] } });
    expect(definition.guards.input[0]).toBe(guard); expect(definition.guards.output[0]).toBe(guard);
    const engine = runtime({ maxCostMicros: 8, maxModelCalls: 3, maxConcurrentOperations: 1, maxSteps: 1, maxOutputTokens: 2 });
    const run = engine.submit(definition, { input: 1 });
    expect(await run.result()).toMatchObject({ status: 'succeeded', output: 2 });
    expect(primary).toHaveBeenCalledTimes(1); expect(auxiliary).toHaveBeenCalledTimes(2);
    expect(seen.map(request => request.messages)).toEqual([[{ role: 'user', content: 1 }], [{ role: 'user', content: 2 }]]);
    expect(seen.every(request => request.tools.length === 0 && request.continuation === undefined)).toBe(true);
    expect(seen.every(request => request.maxOutputTokens === 2)).toBe(true);
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 8, reservedMicros: 0, calls: 3 });
    const publicText = JSON.stringify([await run.result(), engine.inspect(run), await events(run.observe())]);
    expect(publicText).not.toContain('Private primary'); expect(publicText).not.toContain('Private moderation');
  });

  it('blocks input before any primary work and accounts the auxiliary charge', async () => {
    const primary = vi.fn(async () => final());
    const guard = moderation(model('moderator', async () => verdict('block', 3), 3));
    const engine = runtime(); const run = engine.submit(agent(model('primary', primary), { guards: { input: [guard] } }), { input: 'private input' });
    expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'GUARD_BLOCKED' } });
    expect(primary).not.toHaveBeenCalled();
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 3, reservedMicros: 0, calls: 1 });
    expect(JSON.stringify(await events(run.observe()))).not.toContain('private input');
  });

  it('executes required local input screening before auxiliary egress regardless of array order', async () => {
    const primary = vi.fn(async () => final()); const auxiliary = vi.fn(async () => verdict());
    const guard = moderation(model('moderator', auxiliary));
    const local: Guard = { id: 'local-privacy', check: () => ({ decision: 'block' }) };
    const run = runtime().submit(agent(model('primary', primary), { guards: { input: [guard, local] } }), { input: 'must stay local' });
    expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'GUARD_BLOCKED' } });
    expect(primary).not.toHaveBeenCalled(); expect(auxiliary).not.toHaveBeenCalled();
  });

  it.each(['input', 'output'] as const)('rejects missing %s-check permission before primary generation', async boundary => {
    const primary = vi.fn(async () => final()); const auxiliary = vi.fn(async () => verdict());
    const guard = moderation(model('moderator', auxiliary)); const engine = runtime({}, ['model:primary']);
    const run = engine.submit(agent(model('primary', primary), { guards: { [boundary]: [guard] } }), { input: 1 });
    expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'PERMISSION_DENIED' } });
    expect(primary).not.toHaveBeenCalled(); expect(auxiliary).not.toHaveBeenCalled();
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 0 });
  });

  it('cannot dispatch a primary call whose required output check lacks protected money', async () => {
    const primary = vi.fn(async () => final(2, 2)); const auxiliary = vi.fn(async () => verdict('allow', 3));
    const engine = runtime({ maxCostMicros: 4 });
    const run = engine.submit(agent(model('primary', primary, 2), { guards: { output: [moderation(model('moderator', auxiliary, 3))] } }), { input: 1 });
    expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'BUDGET_EXCEEDED' } });
    expect(primary).not.toHaveBeenCalled(); expect(auxiliary).not.toHaveBeenCalled();
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 0 });
  });

  it('protects model-kind capacity even when primary and required output checks are free', async () => {
    const primary = vi.fn(async () => final()); const auxiliary = vi.fn(async () => verdict());
    const engine = runtime({ maxModelCalls: 1, maxCostMicros: 0 });
    const run = engine.submit(agent(model('primary', primary), { guards: { output: [moderation(model('moderator', auxiliary))] } }), { input: 1 });
    expect((await run.result()).status).not.toBe('succeeded');
    expect(primary).not.toHaveBeenCalled(); expect(auxiliary).not.toHaveBeenCalled();
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 0 });
  });

  it('reuses definitions across independent roots without a captured budget or permission list', async () => {
    const auxiliary = vi.fn(async () => verdict('allow', 2)); const guard = moderation(model('moderator', auxiliary, 2));
    const definition = agent(model('primary', async () => final(2, 1), 1), { guards: { input: [guard] } });
    const engine = runtime({ maxCostMicros: 3 });
    const first = engine.submit(definition, { input: 1 }); const second = engine.submit(definition, { input: 2 });
    expect((await first.result()).status).toBe('succeeded'); expect((await second.result()).status).toBe('succeeded');
    expect(auxiliary).toHaveBeenCalledTimes(2);
    for (const run of [first, second]) expect(engine.inspect(run).budget).toEqual({ spentMicros: 3, reservedMicros: 0, calls: 2 });
  });

  it('admits an entire required input-check bundle atomically instead of making a partially affordable call', async () => {
    const primary = vi.fn(async () => final()); const auxiliary = vi.fn(async () => verdict('allow', 2));
    const guards = [moderation(model('moderator', auxiliary, 2)), moderation(model('moderator', auxiliary, 2), { id: 'second' })];
    const engine = runtime({ maxCostMicros: 3 });
    const run = engine.submit(agent(model('primary', primary), { guards: { input: guards } }), { input: 1 });
    expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'BUDGET_EXCEEDED' } });
    expect(auxiliary).not.toHaveBeenCalled(); expect(primary).not.toHaveBeenCalled();
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 0 });
  });
});

describe('managed barriers and honest model accounting', () => {
  it('requires all parallel checks to allow before primary dispatch', async () => {
    const first = deferred<ModelResponse>(); const second = deferred<ModelResponse>();
    const entered = [deferred<void>(), deferred<void>()];
    const primary = vi.fn(async () => final());
    const guards = [
      moderation(model('moderator', () => { entered[0]!.resolve(); return first.promise; }), { id: 'first' }),
      moderation(model('other-moderator', () => { entered[1]!.resolve(); return second.promise; }), { id: 'second' }),
    ];
    const run = runtime({ maxConcurrentOperations: 2 }).submit(agent(model('primary', primary), { guards: { input: guards } }), { input: 1 });
    try {
      await Promise.all(entered.map(item => item.promise));
      first.resolve(verdict()); await nextTurn(); expect(primary).not.toHaveBeenCalled();
      second.resolve(verdict('block'));
      expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'GUARD_BLOCKED' } });
      expect(primary).not.toHaveBeenCalled();
    } finally { first.resolve(verdict()); second.resolve(verdict()); }
  });

  it('sends the admitted immutable candidate, never transcript, continuation, tools or primary instructions', async () => {
    const requests: ModelRequest[] = []; const contexts: unknown[] = [];
    const guard = moderation(model('moderator', async request => { requests.push(request); return verdict(); }), {
      egressGuards: [{ id: 'local-egress', check: (value, context) => {
        contexts.push(context); expect(Object.isFrozen(value)).toBe(true);
        return { decision: 'allow' };
      } }],
    });
    const input: JsonValue = { nested: { value: 'original input' } };
    const engine = runtime();
    const definition = agent(model('primary', async () => ({ ...final({ safe: 'released output' }), continuation: { secret: 'private continuation' } })),
      { guards: { input: [guard], output: [guard] } });
    const run = engine.submit(definition, { input });
    (input as { nested: { value: string } }).nested.value = 'mutated source';
    expect((await run.result()).status).toBe('succeeded');
    expect(requests.map(request => request.messages)).toEqual([
      [{ role: 'user', content: { nested: { value: 'original input' } } }],
      [{ role: 'user', content: { safe: 'released output' } }],
    ]);
    for (const request of requests) {
      expect(request.tools).toEqual([]); expect(request.continuation).toBeUndefined();
      expect(JSON.stringify(request)).not.toContain('Private primary');
      expect(JSON.stringify(request)).not.toContain('private continuation');
    }
    for (const context of contexts) expect(Object.keys(context as object).sort()).toEqual(['boundary', 'callId', 'runId', 'scope', 'signal']);
    expect(JSON.stringify(await events(run.observe()))).not.toContain('original input');
    expect(JSON.stringify(await events(run.observe()))).not.toContain('released output');
  });

  it('releases unused output-check holds when primary output fails its schema', async () => {
    const auxiliary = vi.fn(async () => verdict('allow', 3));
    const invalidOutput: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'test', validate: () => ({ issues: [{ message: 'Private schema failure.' }] }) } };
    const engine = runtime({ maxCostMicros: 5 });
    const run = engine.submit(agent(model('primary', async () => final(2, 2), 2),
      { output: invalidOutput, guards: { output: [moderation(model('moderator', auxiliary, 3))] } }), { input: 1 });
    expect(await run.result()).toMatchObject({ status: 'failed', error: { code: 'INVALID_OUTPUT' } });
    expect(auxiliary).not.toHaveBeenCalled();
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 2, reservedMicros: 0, calls: 1 });
  });

  it.each([
    { label: 'tool proposal', response: call('write', 2) },
    { label: 'continuation', response: { ...verdict('allow', 2), continuation: { private: 'forbidden' } } },
    { label: 'unknown decision', response: final({ decision: 'maybe', categories: [] }, 2) },
    { label: 'extra reason', response: final({ decision: 'allow', categories: [], reason: 'private provider reason' }, 2) },
    { label: 'duplicate categories', response: final({ decision: 'allow', categories: ['same', 'same'] }, 2) },
  ])('charges known usage before rejecting auxiliary $label', async ({ response }) => {
    const primary = vi.fn(async () => final());
    const guard = moderation(model('moderator', async () => response, 3));
    const engine = runtime(); const run = engine.submit(agent(model('primary', primary), { guards: { input: [guard] } }), { input: 1 });
    expect((await run.result()).status).not.toBe('succeeded'); expect(primary).not.toHaveBeenCalled();
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 2, reservedMicros: 0, calls: 1 });
    const publicText = JSON.stringify([await run.result(), await events(run.observe())]);
    expect(publicText).not.toContain('private provider reason'); expect(publicText).not.toContain('forbidden');
  });

  it.each([2, 4])('records confirmed failed auxiliary usage %i without exposing raw exceptions', async costMicros => {
    const primary = vi.fn(async () => final());
    const guard = moderation(model('moderator', async () => { throw new ModelInvocationError(costMicros); }, 3));
    const engine = runtime(); const run = engine.submit(agent(model('primary', primary), { guards: { input: [guard] } }), { input: 1 });
    expect((await run.result()).status).not.toBe('succeeded'); expect(primary).not.toHaveBeenCalled();
    expect(engine.inspect(run).budget).toEqual({ spentMicros: costMicros, reservedMicros: 0, calls: 1 });
  });

  it('retains unknown auxiliary cost on a raw failure instead of reporting a free invocation', async () => {
    const primary = vi.fn(async () => final());
    const guard = moderation(model('moderator', async () => { throw new Error('private provider failure'); }, 3));
    const engine = runtime(); const run = engine.submit(agent(model('primary', primary), { guards: { input: [guard] } }), { input: 1 });
    expect((await run.result()).status).not.toBe('succeeded'); expect(primary).not.toHaveBeenCalled();
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 0, reservedMicros: 3, calls: 1 });
    expect(JSON.stringify([await run.result(), await events(run.observe())])).not.toContain('private provider failure');
  });

  it.each(['input-transform', 'block-transform', 'malformed-coercion'] as const)('does not permit host-schema %s to replace the checked candidate or verdict', async variant => {
    const primary = vi.fn(async () => final());
    const auxiliary = vi.fn(async () => variant === 'malformed-coercion'
      ? final({ decision: true, categories: [] }, 2) : verdict('block', 2));
    const captured = readManagedGuardDefinition(moderation(model('moderator', auxiliary, 2)))!;
    const guard = registerManagedGuardDefinition({ ...captured,
      ...(variant === 'input-transform'
        ? { input: { '~standard': { version: 1 as const, vendor: 'test-transform', validate: () => ({ value: 999 }) } } }
        : { output: { '~standard': { version: 1 as const, vendor: 'test-transform', validate: () => ({ value: { decision: 'allow' as const, categories: [] } }) } } }),
    });
    const engine = runtime(); const run = engine.submit(agent(model('primary', primary), { guards: { input: [guard] } }), { input: 1 });
    expect((await run.result()).status).not.toBe('succeeded'); expect(primary).not.toHaveBeenCalled();
    expect(auxiliary).toHaveBeenCalledTimes(variant === 'input-transform' ? 0 : 1);
    expect(engine.inspect(run).budget).toEqual(variant === 'input-transform'
      ? { spentMicros: 0, reservedMicros: 0, calls: 0 }
      : { spentMicros: 2, reservedMicros: 0, calls: 1 });
  });
});

describe('managed checks share child capacity and broker authority', () => {
  it.each(['money', 'model-calls'] as const)('protects primary output-check %s from a competing child', async constraint => {
    const primaryStarted = deferred<void>(); const primaryDone = deferred<ModelResponse>();
    const auxiliary = vi.fn(async () => verdict('allow', constraint === 'money' ? 3 : 0));
    const childModel = vi.fn(async () => final(2, constraint === 'money' ? 2 : 0));
    const guard = moderation(model('moderator', auxiliary, constraint === 'money' ? 3 : 0));
    const engine = runtime(constraint === 'money' ? { maxCostMicros: 6 } : { maxCostMicros: 0, maxModelCalls: 2 });
    const parent = engine.submit(agent(model('primary', () => { primaryStarted.resolve(); return primaryDone.promise; }, constraint === 'money' ? 2 : 0),
      { id: 'parent', guards: { output: [guard] } }), { input: 1 });
    try {
      await primaryStarted.promise;
      const child = engine.spawn(parent, agent(model('child', childModel, constraint === 'money' ? 2 : 0), { id: 'child' }), { input: 1, permissions });
      expect((await child.result()).status).not.toBe('succeeded'); expect(childModel).not.toHaveBeenCalled();
      expect(engine.inspect(parent).budget.reservedMicros).toBe(constraint === 'money' ? 5 : 0);
      primaryDone.resolve(final(2, constraint === 'money' ? 2 : 0));
      expect((await parent.result()).status).not.toBe('succeeded'); // Required child failure is not optional.
      expect(auxiliary).toHaveBeenCalledTimes(1);
      expect(engine.inspect(parent).budget).toEqual({ spentMicros: constraint === 'money' ? 5 : 0, reservedMicros: 0, calls: 2 });
    } finally { primaryDone.resolve(final(2, constraint === 'money' ? 2 : 0)); }
  });

  it('counts auxiliary calls against an intermediate ancestor model ceiling', async () => {
    const gate = deferred<ModelResponse>(); const started = deferred<void>();
    const auxiliary = vi.fn(async () => verdict('allow', 1)); const leafModel = vi.fn(async () => final());
    const guard = moderation(model('moderator', auxiliary, 1)); const engine = runtime();
    const root = engine.submit(agent(undefined, { id: 'root' }), { input: 1 });
    const middle = engine.spawn(root, agent(model('child', () => { started.resolve(); return gate.promise; }), { id: 'middle' }),
      { input: 1, permissions, limits: { maxModelCalls: 2 } });
    try {
      await started.promise;
      const leaf = engine.spawn(middle, agent(model('primary', leafModel), { id: 'leaf', guards: { input: [guard], output: [guard] } }), { input: 1, permissions });
      expect((await leaf.result()).status).not.toBe('succeeded');
      expect(auxiliary).toHaveBeenCalledTimes(1); expect(leafModel).not.toHaveBeenCalled();
      gate.resolve(final()); await middle.result(); await root.result();
      expect(engine.inspect(middle).budget).toEqual({ spentMicros: 1, reservedMicros: 0, calls: 2 });
    } finally { gate.resolve(final()); }
  });

  it('composes agents as tools under one permit without double-paying or holding wrapper execution capacity', async () => {
    const auxiliary = vi.fn(async () => verdict('allow', 2)); const guard = moderation(model('moderator', auxiliary, 2));
    const child = agent(model('child', async () => final(2, 1), 1), { id: 'child', guards: { output: [guard] } });
    const delegated = agentAsTool(child, { id: 'delegate', description: 'Required child.', permissions });
    let generation = 0;
    const parentModel = model('primary', async () => ++generation === 1 ? call('delegate', 1) : final(3, 1), 1);
    const engine = runtime({ maxCostMicros: 9, maxModelCalls: 6, maxToolCalls: 1, maxConcurrentOperations: 1 });
    const run = engine.submit(agent(parentModel, { tools: [delegated], guards: { output: [guard] } }), { input: 1 });
    expect(await run.result()).toMatchObject({ status: 'succeeded', output: 3 });
    expect(auxiliary).toHaveBeenCalledTimes(3);
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 9, reservedMicros: 0, calls: 7 });
    expect(engine.inspect(run).runs).toHaveLength(2);
  });

  it('refuses a write before dispatch if its managed output check cannot be reserved', async () => {
    const execute = vi.fn(() => 2); const auxiliary = vi.fn(async () => verdict('allow', 2));
    const tool = defineTool({ id: 'write', version: '1', description: 'Controlled write.', input: jsonSchema, output: jsonSchema,
      effects: 'write', capabilities: [], costMicros: 2, execute });
    const primary = vi.fn(async () => call('write', 1)); const engine = runtime({ maxCostMicros: 3 });
    const run = engine.submit(agent(model('primary', primary, 1), { tools: [tool], guards: { output: [moderation(model('moderator', auxiliary, 2))] } }), { input: 1 });
    expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'BUDGET_EXCEEDED' } });
    expect(primary).toHaveBeenCalledTimes(1); expect(execute).not.toHaveBeenCalled(); expect(auxiliary).not.toHaveBeenCalled();
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 1, reservedMicros: 0, calls: 1 });
  });

  it('withholds a successful write result before model history while retaining its receipt and cost', async () => {
    const execute = vi.fn(() => ({ private: 'write result' }));
    const tool = defineTool({ id: 'write', version: '1', description: 'Controlled write.', input: jsonSchema, output: jsonSchema,
      effects: 'write', capabilities: [], costMicros: 2, execute });
    const primary = vi.fn(async () => call('write', 1)); const engine = runtime({ maxCostMicros: 6 });
    const guard = moderation(model('moderator', async () => verdict('block', 3), 3));
    const run = engine.submit(agent(model('primary', primary, 1), { tools: [tool], guards: { output: [guard] } }), { input: 1 });
    expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'GUARD_BLOCKED' }, receipt: { execution: 'succeeded', disclosure: 'withheld' } });
    expect(execute).toHaveBeenCalledTimes(1); expect(primary).toHaveBeenCalledTimes(1);
    expect(engine.inspect(run).budget).toEqual({ spentMicros: 6, reservedMicros: 0, calls: 3 });
    expect(JSON.stringify([await run.result(), await events(run.observe())])).not.toContain('write result');
  });

  it('retains a failed broker attempt in ancestor tool-call limits without charging an undispatched financial ticket', async () => {
    const rootGate = deferred<void>(); const auxiliary = vi.fn(async () => verdict());
    const guard = moderation(model('moderator', auxiliary)); const execute = vi.fn(() => 2);
    const deniedTool = defineTool({ id: 'write', version: '1', description: 'Input denied.', input: jsonSchema, output: jsonSchema,
      effects: 'write', capabilities: [], costMicros: 2, execute,
      guards: { input: [{ id: 'deny-input', check: () => ({ decision: 'block' }) }] } });
    const allowedTool = defineTool({ id: 'write', version: '2', description: 'Cannot become a second attempt.', input: jsonSchema, output: jsonSchema,
      effects: 'write', capabilities: [], costMicros: 2, execute });
    const engine = runtime({ maxToolCalls: 1 });
    const root = engine.submit(agent(undefined, { id: 'root', guards: { input: [{ id: 'root-gate', check: async () => { await rootGate.promise; return { decision: 'allow' }; } }] } }), { input: 1 });
    try {
      const first = engine.spawn(root, agent(model('child', async () => call()), { id: 'first', tools: [deniedTool], guards: { output: [guard] } }), { input: 1, permissions });
      expect((await first.result()).status).not.toBe('succeeded');
      expect(engine.inspect(root).budget).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 1 });
      const second = engine.spawn(root, agent(model('child', async () => call()), { id: 'second', tools: [allowedTool], guards: { output: [guard] } }), { input: 1, permissions });
      expect((await second.result()).status).not.toBe('succeeded');
      expect(execute).not.toHaveBeenCalled(); expect(auxiliary).not.toHaveBeenCalled();
      expect(engine.inspect(root).budget).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 2 });
    } finally { rootGate.resolve(); await root.result(); }
  });
});

describe('managed cancellation, retained permits and immutable terminal results', () => {
  it.each(['resolve', 'known-error'] as const)('settles late auxiliary %s after cancellation without resurrecting output', async completion => {
    const started = deferred<void>(); const pending = deferred<ModelResponse>();
    const primary = vi.fn(async () => final());
    const guard = moderation(model('moderator', () => { started.resolve(); return pending.promise; }, 3));
    const engine = runtime(); const run = engine.submit(agent(model('primary', primary), { guards: { input: [guard] } }), { input: 1 });
    try {
      await started.promise; run.cancel(); const initial = await run.result();
      expect(initial).toMatchObject({ status: 'cancelled', error: { code: 'CANCELLED' } });
      const before = JSON.stringify(initial);
      expect(engine.inspect(run).budget).toEqual({ spentMicros: 0, reservedMicros: 3, calls: 1 });
      if (completion === 'resolve') pending.resolve(verdict('allow', 2)); else pending.reject(new ModelInvocationError(2));
      await nextTurn(); await nextTurn();
      expect(engine.inspect(run).budget).toEqual({ spentMicros: 2, reservedMicros: 0, calls: 1 });
      expect(await run.result()).toBe(initial); expect(JSON.stringify(initial)).toBe(before);
      expect(primary).not.toHaveBeenCalled(); expect('output' in initial).toBe(false);
    } finally { pending.resolve(verdict('allow', 2)); }
  });

  it('retains a timed-out auxiliary operation permit until the actual callback settles', async () => {
    const rootStarted = deferred<void>(); const rootDone = deferred<ModelResponse>();
    const firstStarted = deferred<void>(); const firstDone = deferred<ModelResponse>();
    const secondStarted = deferred<void>();
    const secondModel = vi.fn(async () => { secondStarted.resolve(); return verdict(); });
    const firstGuard = moderation(model('moderator', () => { firstStarted.resolve(); return firstDone.promise; }), { limits: { timeoutMs: 25 } });
    const secondGuard = moderation(model('other-moderator', secondModel), { id: 'second-check' });
    const engine = runtime({ maxConcurrentOperations: 2 });
    const root = engine.submit(agent(model('primary', () => { rootStarted.resolve(); return rootDone.promise; }), { id: 'root' }), { input: 1 });
    try {
      await rootStarted.promise;
      const first = engine.spawn(root, agent(undefined, { id: 'first', guards: { input: [firstGuard] } }), { input: 1, permissions, limits: { maxConcurrentOperations: 1 } });
      await firstStarted.promise;
      const second = engine.spawn(root, agent(undefined, { id: 'second', guards: { input: [secondGuard] } }), { input: 1, permissions, limits: { maxConcurrentOperations: 1 } });
      expect((await first.result()).status).not.toBe('succeeded');
      await delay(35); expect(secondModel).not.toHaveBeenCalled();
      firstDone.resolve(verdict()); await secondStarted.promise;
      expect((await second.result()).status).toBe('succeeded');
    } finally { firstDone.resolve(verdict()); rootDone.resolve(final()); await root.result(); }
  });

  it.each(['input-schema', 'output-schema', 'egress'] as const)('retains bounded capacity for a noncooperative managed %s callback after its deadline', async stage => {
    const rootStarted = deferred<void>(); const rootDone = deferred<ModelResponse>();
    const pending = deferred<void>(); const callbackStarted = deferred<void>();
    const secondModel = vi.fn(async () => verdict());
    const definition = readManagedGuardDefinition(moderation(undefined, { limits: { timeoutMs: 25 } }))!;
    const local: Guard = { id: 'hanging-egress', check: async () => { callbackStarted.resolve(); await pending.promise; return { decision: 'allow' }; } };
    const firstGuard = registerManagedGuardDefinition({ ...definition,
      ...(stage === 'input-schema' ? { input: { '~standard': { ...definition.input['~standard'], validate: async (value: unknown) => {
        callbackStarted.resolve(); await pending.promise; return definition.input['~standard'].validate(value);
      } } } } : {}),
      ...(stage === 'output-schema' ? { output: { '~standard': { ...definition.output['~standard'], validate: async (value: unknown) => {
        callbackStarted.resolve(); await pending.promise; return definition.output['~standard'].validate(value);
      } } } } : {}),
      ...(stage === 'egress' ? { egressGuards: [local] } : {}),
    });
    const secondGuard = moderation(model('other-moderator', secondModel), { id: 'second-check' });
    const engine = runtime({ maxConcurrentOperations: 2 });
    const root = engine.submit(agent(model('primary', () => { rootStarted.resolve(); return rootDone.promise; }), { id: 'root' }), { input: 1 });
    try {
      await rootStarted.promise;
      const first = engine.spawn(root, agent(undefined, { id: 'first', guards: { input: [firstGuard] } }),
        { input: 1, permissions, limits: { maxConcurrentOperations: 1 } });
      await callbackStarted.promise;
      const second = engine.spawn(root, agent(undefined, { id: 'second', guards: { input: [secondGuard] } }),
        { input: 1, permissions, limits: { maxConcurrentOperations: 1 } });
      expect((await first.result()).status).not.toBe('succeeded');
      await delay(35); expect(secondModel).not.toHaveBeenCalled();
      pending.resolve(); expect((await second.result()).status).toBe('succeeded');
      expect(secondModel).toHaveBeenCalledTimes(1);
    } finally { pending.resolve(); rootDone.resolve(final()); await root.result(); }
  });

  it('cancels a queued check before consuming its financial ticket or invoking its model', async () => {
    const parentStarted = deferred<void>(); const parentDone = deferred<ModelResponse>();
    const auxiliary = vi.fn(async () => verdict('allow', 2));
    const engine = runtime({ maxConcurrentOperations: 1 });
    const parent = engine.submit(agent(model('primary', () => { parentStarted.resolve(); return parentDone.promise; }, 1), { id: 'parent' }), { input: 1 });
    try {
      await parentStarted.promise;
      const child = engine.spawn(parent, agent(undefined, { id: 'child', guards: { input: [moderation(model('moderator', auxiliary, 2))] } }), { input: 1, permissions });
      await nextTurn(); child.cancel();
      expect(await child.result()).toMatchObject({ status: 'cancelled' }); expect(auxiliary).not.toHaveBeenCalled();
      expect(engine.inspect(parent).budget).toEqual({ spentMicros: 0, reservedMicros: 1, calls: 1 });
      parentDone.resolve(final(2, 1)); await parent.result();
      expect(engine.inspect(parent).budget).toEqual({ spentMicros: 1, reservedMicros: 0, calls: 1 });
    } finally { parentDone.resolve(final(2, 1)); }
  });

  it('cancels held output checks while preserving an unknown write and its later known receipt', async () => {
    const started = deferred<void>(); const completed = deferred<JsonValue>();
    const auxiliary = vi.fn(async () => verdict('allow', 2));
    const tool = defineTool({ id: 'write', version: '1', description: 'Late effect.', input: jsonSchema, output: jsonSchema,
      effects: 'write', capabilities: [], costMicros: 2, execute: () => { started.resolve(); return completed.promise; } });
    const engine = runtime();
    const run = engine.submit(agent(model('primary', async () => call('write', 1), 1), { tools: [tool], guards: { output: [moderation(model('moderator', auxiliary, 2))] } }), { input: 1 });
    try {
      await started.promise; run.cancel(); const initial = await run.result();
      expect(initial).toMatchObject({ status: 'outcome_unknown', receipt: { execution: 'unknown', disclosure: 'withheld' } });
      const before = JSON.stringify(initial);
      expect(engine.inspect(run).budget).toEqual({ spentMicros: 1, reservedMicros: 2, calls: 2 });
      completed.resolve({ private: 'late result' }); await nextTurn(); await nextTurn();
      expect(engine.inspect(run).budget).toEqual({ spentMicros: 3, reservedMicros: 0, calls: 2 });
      expect(engine.inspect(run).evidence).toEqual(expect.arrayContaining([expect.objectContaining({ receipt: expect.objectContaining({ execution: 'succeeded', disclosure: 'withheld' }) })]));
      expect(JSON.stringify(initial)).toBe(before); expect(auxiliary).not.toHaveBeenCalled();
      expect(JSON.stringify(await events(run.observe()))).not.toContain('late result');
    } finally { completed.resolve(2); }
  });
});

describe('managed handles cannot become unmediated local callbacks', () => {
  it('rejects copied and proxied handles, duplicate IDs and marker fallback without invoking check', () => {
    const guard = moderation(); const check = vi.fn(() => ({ decision: 'allow' as const }));
    for (const invalid of [{ ...guard }, new Proxy(guard, {}), { ...guard, check }]) {
      expect(() => agent(undefined, { guards: { input: [invalid as typeof guard] } })).toThrow();
    }
    expect(() => agent(undefined, { guards: { input: [guard, { id: guard.id, check }] } })).toThrow();
    expect(check).not.toHaveBeenCalled(); expect('check' in guard).toBe(false); expect('evaluate' in guard).toBe(false);
  });

  it('rejects a managed handle in unsupported standalone tool and local egress positions', () => {
    const guard = moderation(); const execute = vi.fn(() => 2);
    expect(() => defineTool({ id: 'write', version: '1', description: 'Unsupported managed position.', input: jsonSchema, output: jsonSchema,
      effects: 'write', capabilities: [], execute, guards: { input: [guard as unknown as Guard] } })).toThrow();
    expect(() => moderation(undefined, { egressGuards: [guard as unknown as Guard] })).toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
});
