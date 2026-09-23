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
  });

  it('has no host fallback and requires an explicit opt-in for test adapters', async () => {
    const execute = vi.fn(async () => ({ status: 'succeeded' as const, output: { value: 2 } }));
    const unqualified = adapter(execute);
    expect(() => createCodeMode({ adapter: unqualified, invokeTool: vi.fn() })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_PROFILE' }));

    const unavailable = adapter(execute, { id: 'sandbox.unavailable', isAvailable: () => false });
    const result = await createCodeMode({ adapter: unavailable, allowTestAdapter: true, invokeTool: vi.fn() })
      .execute(program(), { value: 1 }, execution());
    expect(result).toMatchObject({ status: 'failed', error: { code: 'UNSUPPORTED_PROFILE' } });
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
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence?.[0]?.receipt).toMatchObject({ callId: 'execution-1:code:1', toolId: 'number.double', execution: 'succeeded' });
    expect(broker).toHaveBeenCalledWith(double, { value: 6 }, expect.objectContaining({
      runId: 'run-1', executionId: 'execution-1', programDigest: definition.manifest.digest, scope,
    }));
    expect(budget.snapshot()).toEqual({ spentMicros: 1, reservedMicros: 0, calls: 1 });
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
    const broker = vi.fn(async (): Promise<Outcome<JsonValue>> => { await gate; return { status: 'succeeded', output: { value: 2 } }; });
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
    expect(broker).toHaveBeenCalledTimes(1);
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
    const broker = vi.fn(async (): Promise<Outcome<JsonValue>> => { started(); await gate; return { status: 'succeeded', output: { value: 2 } }; });
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
    expect(thrown).toEqual({ status: 'failed', error: { code: 'TOOL_FAILED', message: 'Code Mode execution failed; raw adapter details are withheld.' } });
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

  it('rejects duplicate execution identities in one runtime', async () => {
    const sandbox = adapter(async request => ({ status: 'succeeded', output: request.input }), { id: 'sandbox.identities' });
    const mode = createCodeMode({ adapter: sandbox, allowTestAdapter: true, invokeTool: vi.fn() });
    expect((await mode.execute(program(), { value: 1 }, execution('same'))).status).toBe('succeeded');
    await expect(mode.execute(program(), { value: 2 }, execution('same'))).resolves.toMatchObject({ status: 'failed', error: { code: 'CONFLICT' } });
  });
});
