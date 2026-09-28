import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Budget, type JsonValue, type Outcome } from '@mayura/core';
import { defineTool, invokeTool, type AnyTool } from '@mayura/tools';
import {
  createCodeMode,
  defineCodeProgram,
  defineSandboxAdapter,
  isCodeProgramDigest,
  type CodeLimits,
  type CodeToolBridge,
  type SandboxExecutionRequest,
} from '../src/index.js';

const scope = Object.freeze({ principalId: 'alice', projectId: 'project-a' });
const limits: CodeLimits = Object.freeze({
  cpuMillis: 100,
  wallTimeMillis: 1_000,
  memoryBytes: 32 * 1_024 * 1_024,
  scratchBytes: 1_024,
  maxInputBytes: 4_096,
  maxOutputBytes: 4_096,
  maxToolInputBytes: 2_048,
  maxToolCalls: 4,
  maxToolConcurrency: 2,
});

const double = defineTool({
  id: 'number.double', version: '1.0.0', description: 'Double a number.', effects: 'none', capabilities: [],
  input: z.object({ value: z.number() }), output: z.object({ value: z.number() }), costMicros: 1,
  execute: ({ value }) => ({ value: value * 2 }),
});

function program(overrides: Partial<Parameters<typeof defineCodeProgram>[0]> = {}) {
  return defineCodeProgram({
    id: 'calculate', version: '1.0.0', intent: 'Calculate a bounded result.', language: 'typescript',
    source: 'export default async ({ input, tools }) => tools.call("number.double", input);',
    input: z.object({ value: z.number() }), output: z.object({ value: z.number() }),
    inputSchemaId: 'calculate.input.v1', outputSchemaId: 'calculate.output.v1', tools: [double], limits,
    ...overrides,
  });
}

function adapter(execute: (request: SandboxExecutionRequest) => Promise<{ status: 'succeeded'; output: unknown } | { status: 'failed' }>,
  overrides: Partial<Parameters<typeof defineSandboxAdapter>[0]> = {}) {
  return defineSandboxAdapter({ id: 'sandbox.test', version: '1.0.0', qualification: 'test', isAvailable: () => true, execute, ...overrides });
}

function execution(executionId = 'execution-1', signal = new AbortController().signal) {
  return { runId: 'run-1', executionId, scope, signal };
}

describe('Code Mode artifact and containment boundary', () => {
  it('creates immutable, content-addressed artifacts and rejects structural forgeries', async () => {
    const definition = program();
    expect(isCodeProgramDigest(definition.manifest.digest)).toBe(true);
    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.manifest.tools[0]?.capabilities)).toBe(true);
    expect(program().manifest.digest).toBe(definition.manifest.digest);
    expect(program({ source: 'export default () => ({ value: 3 });' }).manifest.digest).not.toBe(definition.manifest.digest);

    const sandbox = adapter(async () => ({ status: 'succeeded', output: { value: 2 } }));
    const mode = createCodeMode({ adapter: sandbox, allowTestAdapter: true, invokeTool: vi.fn() });
    await expect(mode.execute({ ...definition } as never, { value: 1 }, execution('forged'))).resolves.toMatchObject({
      status: 'failed', error: { code: 'INVALID_CONFIG' },
    });
    expect(() => program({ limits: { ...limits, memoryBytes: 2_147_483_649 } })).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => program({ limits: { ...limits, maxToolConcurrency: 129, maxToolCalls: 129 } })).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    const costly = defineTool({ id: 'costly', version: '1', description: 'Cost overflow fixture.', effects: 'none', capabilities: [],
      input: z.object({ value: z.number() }), output: z.object({ value: z.number() }), costMicros: Number.MAX_SAFE_INTEGER,
      execute: input => input });
    expect(() => program({ tools: [costly], limits: { ...limits, maxToolCalls: 2 } }))
      .toThrowError(expect.objectContaining({ code: 'LIMIT_EXCEEDED' }));
  });

  it('has no host fallback and requires an explicit opt-in for test adapters', async () => {
    const execute = vi.fn(async () => ({ status: 'succeeded' as const, output: { value: 2 } }));
    const unqualified = adapter(execute);
    expect(() => createCodeMode({ adapter: unqualified, invokeTool: vi.fn() })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_PROFILE',
      message: 'Sandbox adapter "sandbox.test" is qualified for tests only. Use a production adapter, or pass allowTestAdapter: true to accept its isolation.' }));
    const production = adapter(execute, { id: 'sandbox.production', qualification: 'production' });
    expect(() => createCodeMode({ adapter: production, invokeTool: vi.fn() })).not.toThrow();
    expect(() => createCodeMode({ adapter: production, allowTestAdapter: true, invokeTool: vi.fn() })).not.toThrow();
    expect(() => createCodeMode({ adapter: production, allowTestAdapter: 'yes', invokeTool: vi.fn() } as never))
      .toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG', message: 'allowTestAdapter must be a boolean.' }));

    const unavailable = adapter(execute, { id: 'sandbox.unavailable', isAvailable: () => false });
    const result = await createCodeMode({ adapter: unavailable, allowTestAdapter: true, invokeTool: vi.fn() })
      .execute(program(), { value: 1 }, execution());
    expect(result).toMatchObject({ status: 'failed', error: { code: 'UNSUPPORTED_PROFILE', message: expect.stringContaining('"sandbox.unavailable" is not available') } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('routes a permitted nested call through the ordinary tool broker with host-owned identity and evidence', async () => {
    const budget = new Budget(10, 4);
    const broker = vi.fn(async (tool: AnyTool, input: JsonValue, context: Parameters<Parameters<typeof createCodeMode>[0]['invokeTool']>[2]): Promise<Outcome<JsonValue>> =>
      invokeTool(tool, input, { runId: context.runId, callId: context.callId, scope: context.scope, signal: context.signal,
        permissions: { allow: [`tool:${tool.id}`] }, budget }) as Promise<Outcome<JsonValue>>);
    const sandbox = adapter(async request => {
      const result = await request.tools.call('number.double', request.input);
      return { status: result.status === 'succeeded' ? 'succeeded' : 'failed', output: result.output } as const;
    });
    const definition = program();
    const result = await createCodeMode({ adapter: sandbox, allowTestAdapter: true, invokeTool: broker })
      .execute(definition, { value: 6 }, execution());

    expect(result).toMatchObject({ status: 'succeeded', output: { value: 12 } });
    expect(result.usage).toEqual({ toolCalls: 1, unknownCalls: 0, knownCostMicros: 1, unknownCostMicros: 0, maximumCostMicros: 4 });
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence?.[0]?.receipt).toMatchObject({ callId: 'execution-1:code:1', toolId: 'number.double', execution: 'succeeded' });
    expect(broker).toHaveBeenCalledWith(double, { value: 6 }, expect.objectContaining({
      runId: 'run-1', executionId: 'execution-1', programDigest: definition.manifest.digest, scope,
    }));
    expect(budget.snapshot()).toEqual({ spentMicros: 1, reservedMicros: 0, calls: 1 });
  });

  it('does not retain receipt extensions outside the exact public evidence contract', async () => {
    const broker = vi.fn(async (_tool: AnyTool, input: JsonValue, context: Parameters<Parameters<typeof createCodeMode>[0]['invokeTool']>[2]) => ({
      status: 'succeeded' as const, output: input,
      receipt: { callId: context.callId, toolId: 'number.double', execution: 'succeeded' as const, disclosure: 'released' as const, secret: 'private' },
    }));
    const sandbox = adapter(async request => {
      const result = await request.tools.call('number.double', request.input);
      return result.status === 'succeeded' ? { status: 'succeeded', output: result.output } : { status: 'failed' };
    });
    const result = await createCodeMode({ adapter: sandbox, allowTestAdapter: true, invokeTool: broker })
      .execute(program(), { value: 3 }, execution());
    expect(result).toMatchObject({ status: 'outcome_unknown', error: { code: 'OUTCOME_UNKNOWN' },
      usage: { toolCalls: 1, unknownCalls: 1, knownCostMicros: 0, unknownCostMicros: 1, maximumCostMicros: 4 } });
    expect(result.evidence).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('denies unknown tools before the broker and closes retained bridges when the adapter settles', async () => {
    let retained: CodeToolBridge | undefined;
    const broker = vi.fn(async (): Promise<Outcome<JsonValue>> => ({ status: 'succeeded', output: { value: 1 } }));
    const sandbox = adapter(async request => {
      retained = request.tools;
      expect(await request.tools.call('admin.secret', {})).toMatchObject({ status: 'blocked', error: { code: 'PERMISSION_DENIED' } });
      return { status: 'succeeded', output: { value: 1 } };
    });
    const result = await createCodeMode({ adapter: sandbox, allowTestAdapter: true, invokeTool: broker })
      .execute(program(), { value: 1 }, execution());
    expect(result.status).toBe('succeeded');
    expect(await retained!.call('number.double', { value: 1 })).toMatchObject({ status: 'failed', error: { code: 'CONFLICT' } });
    expect(broker).not.toHaveBeenCalled();
  });

  it('enforces concurrent and total nested-call bounds before host dispatch', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const broker = vi.fn(async (_tool: AnyTool, _input: JsonValue, context: Parameters<Parameters<typeof createCodeMode>[0]['invokeTool']>[2]): Promise<Outcome<JsonValue>> => {
      await gate;
      return { status: 'succeeded', output: { value: 2 },
        receipt: { callId: context.callId, toolId: 'number.double', execution: 'succeeded', disclosure: 'released' } };
    });
    const sandbox = adapter(async request => {
      const first = request.tools.call('number.double', { value: 1 });
      const second = await request.tools.call('number.double', { value: 2 });
      expect(second).toMatchObject({ status: 'failed', error: { code: 'LIMIT_EXCEEDED' } });
      release();
      await first;
      return { status: 'succeeded', output: { value: 2 } };
    });
    const constrained = program({ limits: { ...limits, maxToolCalls: 1, maxToolConcurrency: 1 } });
    const result = await createCodeMode({ adapter: sandbox, allowTestAdapter: true, invokeTool: broker })
      .execute(constrained, { value: 1 }, execution());
    expect(result.status).toBe('succeeded');
    expect(result.usage).toEqual({ toolCalls: 1, unknownCalls: 0, knownCostMicros: 1, unknownCostMicros: 0, maximumCostMicros: 1 });
    expect(broker).toHaveBeenCalledTimes(1);
  });

  it('forces reconciliation when a nested receipt reports unknown execution', async () => {
    const zeroCostWrite = defineTool({ id: 'external.zero-cost-write', version: '1', description: 'Unknown zero-cost effect.', effects: 'write', capabilities: [],
      input: z.object({ value: z.number() }), output: z.object({ value: z.number() }), costMicros: 0, execute: input => input });
    const broker = vi.fn(async (_tool: AnyTool, _input: JsonValue, context: Parameters<Parameters<typeof createCodeMode>[0]['invokeTool']>[2]): Promise<Outcome<JsonValue>> => ({
      status: 'outcome_unknown', error: { code: 'OUTCOME_UNKNOWN', message: 'private provider detail' },
      receipt: { callId: context.callId, toolId: 'external.zero-cost-write', execution: 'unknown', disclosure: 'withheld' },
    }));
    const sandbox = adapter(async request => {
      await request.tools.call('external.zero-cost-write', request.input);
      return { status: 'succeeded', output: request.input };
    }, { id: 'sandbox.unknown-usage' });
    const result = await createCodeMode({ adapter: sandbox, allowTestAdapter: true, invokeTool: broker })
      .execute(program({ tools: [zeroCostWrite] }), { value: 1 }, execution('unknown-usage'));
    expect(result).toMatchObject({ status: 'outcome_unknown', error: { code: 'OUTCOME_UNKNOWN' },
      usage: { toolCalls: 1, unknownCalls: 1, knownCostMicros: 0, unknownCostMicros: 0, maximumCostMicros: 0 },
      evidence: [{ receipt: { execution: 'unknown', disclosure: 'withheld' } }],
    });
    expect(JSON.stringify(result)).not.toContain('private provider detail');
  });

  it('snapshots caller input before the first asynchronous availability boundary', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let observed: JsonValue | undefined;
    const sandbox = adapter(async request => { observed = request.input; return { status: 'succeeded', output: request.input }; }, {
      id: 'sandbox.delayed', isAvailable: async () => { await gate; return true; },
    });
    const input = { value: 7 };
    const pending = createCodeMode({ adapter: sandbox, allowTestAdapter: true, invokeTool: vi.fn() }).execute(program(), input, execution());
    input.value = 99;
    release();
    expect(await pending).toMatchObject({ status: 'succeeded', output: { value: 7 } });
    expect(observed).toEqual({ value: 7 });
    expect(Object.isFrozen(observed)).toBe(true);
  });

  it('closes the bridge at the deadline and waits for an admitted broker call to settle', async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const admitted = new Promise<void>(resolve => { started = resolve; });
    const broker = vi.fn(async (_tool: AnyTool, _input: JsonValue, context: Parameters<Parameters<typeof createCodeMode>[0]['invokeTool']>[2]): Promise<Outcome<JsonValue>> => {
      started(); await gate;
      return { status: 'succeeded', output: { value: 2 },
        receipt: { callId: context.callId, toolId: 'number.double', execution: 'succeeded', disclosure: 'released' } };
    });
    let retained: CodeToolBridge | undefined;
    const sandbox = adapter(async request => {
      retained = request.tools;
      await request.tools.call('number.double', { value: 1 });
      return { status: 'succeeded', output: { value: 2 } };
    });
    const pending = createCodeMode({ adapter: sandbox, allowTestAdapter: true, invokeTool: broker })
      .execute(program({ limits: { ...limits, wallTimeMillis: 15 } }), { value: 1 }, execution());
    await admitted;
    await new Promise(resolve => setTimeout(resolve, 30));
    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(await retained!.call('number.double', { value: 2 })).toMatchObject({ status: 'failed', error: { code: 'TIMEOUT' } });
    release();
    expect(await pending).toMatchObject({ status: 'failed', error: { code: 'TIMEOUT' } });
  });

  it('sanitizes adapter failures, hostile result accessors and invalid output', async () => {
    const throwing = adapter(async () => { throw new Error('SECRET'); }, { id: 'sandbox.throwing' });
    const thrown = await createCodeMode({ adapter: throwing, allowTestAdapter: true, invokeTool: vi.fn() })
      .execute(program(), { value: 1 }, execution('throwing'));
    expect(thrown).toEqual({ status: 'failed', error: { code: 'TOOL_FAILED', message: 'The sandbox failed before the program finished; its details are withheld.' },
      usage: { toolCalls: 0, unknownCalls: 0, knownCostMicros: 0, unknownCostMicros: 0, maximumCostMicros: 4 } });
    expect(JSON.stringify(thrown)).not.toContain('SECRET');

    const hostile = adapter(async () => Object.defineProperty({}, 'status', { enumerable: true, get: () => { throw new Error('SECRET'); } }) as never,
      { id: 'sandbox.hostile' });
    await expect(createCodeMode({ adapter: hostile, allowTestAdapter: true, invokeTool: vi.fn() })
      .execute(program(), { value: 1 }, execution('hostile'))).resolves.toMatchObject({ status: 'failed', error: { code: 'TOOL_FAILED' } });

    const invalid = adapter(async () => ({ status: 'succeeded', output: { value: 'SECRET' } }), { id: 'sandbox.invalid-output' });
    const invalidResult = await createCodeMode({ adapter: invalid, allowTestAdapter: true, invokeTool: vi.fn() })
      .execute(program(), { value: 1 }, execution('invalid-output'));
    expect(invalidResult).toMatchObject({ status: 'failed', error: { code: 'INVALID_OUTPUT' } });
    expect(JSON.stringify(invalidResult)).not.toContain('SECRET');
  });

  it('maps each sandbox failure reason to a precise code, and exposes only a bounded program error', async () => {
    const run = async (result: unknown, id: string) => createCodeMode({ adapter: adapter(async () => result as never, { id: `sandbox.${id}` }),
      allowTestAdapter: true, invokeTool: vi.fn() }).execute(program(), { value: 1 }, execution(id));
    await expect(run({ status: 'failed', reason: 'cpu_limit' }, 'cpu')).resolves.toMatchObject({ status: 'failed',
      error: { code: 'LIMIT_EXCEEDED', message: 'The program ran longer than its cpuMillis limit.' } });
    await expect(run({ status: 'failed', reason: 'memory_limit' }, 'memory')).resolves.toMatchObject({ status: 'failed',
      error: { code: 'LIMIT_EXCEEDED', message: 'The program needed more memory than its memoryBytes limit.' } });
    await expect(run({ status: 'failed', reason: 'invalid_output' }, 'output')).resolves.toMatchObject({ status: 'failed', error: { code: 'INVALID_OUTPUT' } });
    await expect(run({ status: 'failed', reason: 'unsupported_program' }, 'unsupported')).resolves.toMatchObject({ status: 'failed', error: { code: 'UNSUPPORTED_PROFILE' } });
    await expect(run({ status: 'failed', reason: 'sandbox_error' }, 'sandbox')).resolves.toMatchObject({ status: 'failed', error: { code: 'TOOL_FAILED' } });
    await expect(run({ status: 'failed' }, 'legacy')).resolves.toMatchObject({ status: 'failed',
      error: { code: 'TOOL_FAILED', message: 'The program or its sandbox failed; the adapter did not report why.' } });
    const thrown = await run({ status: 'failed', reason: 'program_error', programError: { name: 'N'.repeat(500), message: 'M'.repeat(5_000) } }, 'thrown');
    expect(thrown).toMatchObject({ status: 'failed', error: { code: 'TOOL_FAILED' } });
    expect(thrown.programError).toEqual({ name: 'N'.repeat(128), message: 'M'.repeat(1_024) });
    expect(Object.isFrozen(thrown.programError)).toBe(true);
    // A program error is attached only to program failures, and only as exact plain strings.
    expect((await run({ status: 'failed', reason: 'cpu_limit', programError: { name: 'E', message: 'm' } }, 'cpu-error')).programError).toBeUndefined();
    expect((await run({ status: 'failed', reason: 'program_error', programError: { name: 'E', message: 1 } }, 'bad-error')).programError).toBeUndefined();
    const accessor = Object.defineProperty({ name: 'E' }, 'message', { enumerable: true, get: () => 'SECRET' });
    const hostile = await run({ status: 'failed', reason: 'program_error', programError: accessor }, 'accessor-error');
    expect(hostile.programError).toBeUndefined();
    expect(JSON.stringify(hostile)).not.toContain('SECRET');
    for (const [result, id] of [[{ status: 'failed', reason: 'root' }, 'unknown-reason'], [{ status: 'failed', reason: 'cpu_limit', extra: 1 }, 'extra'],
      [{ status: 'succeeded', output: 1, reason: 'cpu_limit' }, 'mixed']] as const) {
      await expect(run(result, id)).resolves.toMatchObject({ status: 'failed', error: { code: 'TOOL_FAILED', message: 'The sandbox failed before the program finished; its details are withheld.' } });
    }
  });

  it('reports a result that is not plain JSON within maxOutputBytes as INVALID_OUTPUT', async () => {
    const run = (output: unknown, id: string) => createCodeMode({ adapter: adapter(async () => ({ status: 'succeeded', output }), { id: `sandbox.${id}` }),
      allowTestAdapter: true, invokeTool: vi.fn() }).execute(program(), { value: 1 }, execution(id));
    await expect(run({ value: 'x'.repeat(10_000) }, 'large')).resolves.toMatchObject({ status: 'failed',
      error: { code: 'INVALID_OUTPUT', message: 'The program\'s result is not plain JSON within maxOutputBytes.' } });
    await expect(run({ value: 1n }, 'bigint')).resolves.toMatchObject({ status: 'failed', error: { code: 'INVALID_OUTPUT' } });
    await expect(run({ value: 'wrong type' }, 'schema')).resolves.toMatchObject({ status: 'failed',
      error: { code: 'INVALID_OUTPUT', message: 'The program\'s result does not match its output schema.' } });
  });

  it('explains configuration and input errors precisely', async () => {
    expect(() => program({ limits: { ...limits, cpuMillis: 0 } })).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('limits.cpuMillis') }));
    expect(() => program({ limits: { ...limits, wallTimeMillis: 3_600_001 } })).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG',
      message: 'limits.wallTimeMillis exceeds the supported maximum of 3600000.' }));
    expect(() => program({ extra: true } as never)).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG', message: 'Unknown Code Mode option "extra".' }));
    expect(() => program({ id: '1-bad' })).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG', message: expect.stringContaining('Program id must start with a letter') }));
    const { source: _unused, ...withoutSource } = { source: '', id: 'calculate', version: '1.0.0', intent: 'x', language: 'javascript' as const,
      input: z.object({}), output: z.object({}), inputSchemaId: 'a', outputSchemaId: 'b', limits };
    expect(() => defineCodeProgram(withoutSource as never)).toThrowError(expect.objectContaining({ message: 'The Code Mode option "source" is required.' }));
    const mode = createCodeMode({ adapter: adapter(async request => ({ status: 'succeeded', output: request.input }), { id: 'sandbox.errors' }),
      allowTestAdapter: true, invokeTool: vi.fn() });
    await expect(mode.execute(program(), { value: 1 }, { ...execution('no-signal'), signal: undefined } as never)).resolves.toMatchObject({
      status: 'failed', error: { code: 'INVALID_CONFIG', message: 'execute options need signal to be an AbortSignal.' } });
    await expect(mode.execute(program(), { value: 'x'.repeat(10_000) } as never, execution('big-input'))).resolves.toMatchObject({
      status: 'failed', error: { code: 'INVALID_INPUT', message: 'The input is not plain JSON within the program\'s maxInputBytes limit.' } });
    await expect(mode.execute(program(), { value: 'x' } as never, execution('schema-input'))).resolves.toMatchObject({
      status: 'failed', error: { code: 'INVALID_INPUT', message: 'The input does not match the program\'s input schema.' } });
  });

  it('keeps a long-lived executor working: only running and recently finished execution ids are reserved', async () => {
    const mode = createCodeMode({ adapter: adapter(async request => ({ status: 'succeeded', output: request.input }), { id: 'sandbox.long-lived' }),
      allowTestAdapter: true, invokeTool: vi.fn() });
    const definition = program();
    for (let batch = 0; batch < 101; batch++) {
      const results = await Promise.all(Array.from({ length: 1_000 }, (_, index) => mode.execute(definition, { value: 1 }, execution(`id-${batch}-${index}`))));
      expect(results.every(result => result.status === 'succeeded')).toBe(true);
    }
    // The first ids have left the 100,000-id window; the latest are still reserved.
    await expect(mode.execute(definition, { value: 1 }, execution('id-0-0'))).resolves.toMatchObject({ status: 'succeeded' });
    await expect(mode.execute(definition, { value: 1 }, execution('id-100-999'))).resolves.toMatchObject({ status: 'failed', error: { code: 'CONFLICT' } });
  }, 60_000);

  it('rejects duplicate execution identities in one runtime', async () => {
    const sandbox = adapter(async request => ({ status: 'succeeded', output: request.input }), { id: 'sandbox.identities' });
    const mode = createCodeMode({ adapter: sandbox, allowTestAdapter: true, invokeTool: vi.fn() });
    expect((await mode.execute(program(), { value: 1 }, execution('same'))).status).toBe('succeeded');
    await expect(mode.execute(program(), { value: 2 }, execution('same'))).resolves.toMatchObject({ status: 'failed', error: { code: 'CONFLICT',
      message: 'This executionId is running or was used recently by this executor. Pass a new executionId for each execution.' } });
    let release!: () => void;
    const slow = createCodeMode({ adapter: adapter(async request => { await new Promise<void>(resolve => { release = resolve; }); return { status: 'succeeded', output: request.input }; },
      { id: 'sandbox.running' }), allowTestAdapter: true, invokeTool: vi.fn() });
    const running = slow.execute(program(), { value: 1 }, execution('running'));
    await expect(slow.execute(program(), { value: 1 }, execution('running'))).resolves.toMatchObject({ status: 'failed', error: { code: 'CONFLICT' } });
    await new Promise(resolve => setTimeout(resolve, 0));
    release();
    await expect(running).resolves.toMatchObject({ status: 'succeeded' });
  });
});
