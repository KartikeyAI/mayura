import { describe, expect, it, vi } from 'vitest';
import { Budget, type JsonValue, type Outcome, type Schema } from '@mayura/core';
import { defineTool, invokeTool, type AnyTool } from '@mayura/tools';
import { createCodeMode, defineCodeProgram, type CodeLimits, type CreateCodeModeOptions } from '@mayura/code-mode';
import { createQuickJsSandboxAdapter } from '../src/index.js';

const valueSchema: Schema<{ value: number }, { value: number }> = {
  '~standard': { version: 1 as const, vendor: 'test', validate: (value: unknown) => value !== null && typeof value === 'object'
    && typeof (value as { value?: unknown }).value === 'number' ? { value: value as { value: number } } : { issues: [{ message: 'invalid' }] } },
};
const textSchema: Schema<{ value: string }, { value: string }> = {
  '~standard': { version: 1 as const, vendor: 'test', validate: (value: unknown) => value !== null && typeof value === 'object'
    && typeof (value as { value?: unknown }).value === 'string' ? { value: value as { value: string } } : { issues: [{ message: 'invalid' }] } },
};
const limits: CodeLimits = { cpuMillis: 500, wallTimeMillis: 3_000, memoryBytes: 32 * 1_024 * 1_024, scratchBytes: 1_024,
  maxInputBytes: 4_096, maxOutputBytes: 4_096, maxToolInputBytes: 4_096, maxToolCalls: 4, maxToolConcurrency: 2 };
const scope = { principalId: 'alice', projectId: 'project' };
const double = defineTool({ id: 'number.double', version: '1', description: 'Double.', input: valueSchema, output: valueSchema,
  effects: 'none', capabilities: [], costMicros: 1, execute: ({ value }) => ({ value: value * 2 }) });

function program(source: string, overrides: Record<string, unknown> = {}) {
  return defineCodeProgram({ id: 'quickjs.test', version: '1', intent: 'Test the QuickJS adapter.', language: 'javascript', source,
    input: valueSchema, output: valueSchema, inputSchemaId: 'value.input.v1', outputSchemaId: 'value.output.v1', limits, ...overrides });
}
function execute(source: string, invokeTool: CreateCodeModeOptions['invokeTool'] = vi.fn(async (): Promise<Outcome<JsonValue>> => ({ status: 'failed', error: { code: 'TOOL_FAILED', message: 'failed' } })),
  overrides: Record<string, unknown> = {}) {
  const mode = createCodeMode({ adapter: createQuickJsSandboxAdapter(), allowTestAdapter: true, invokeTool });
  return mode.execute(program(source, overrides), { value: 3 }, { runId: 'run', executionId: crypto.randomUUID(), scope, signal: new AbortController().signal });
}

describe('QuickJS child-process adapter', () => {
  it('executes a plain JavaScript expression in a fresh interpreter', async () => {
    await expect(execute('(input) => ({ value: input.value + 4 })')).resolves.toEqual({ status: 'succeeded', output: { value: 7 },
      usage: { toolCalls: 0, unknownCalls: 0, knownCostMicros: 0, unknownCostMicros: 0, maximumCostMicros: 0 } });
  });

  it('mediates asynchronous tool calls through the ordinary Mayura broker', async () => {
    const budget = new Budget(10, 4);
    const broker = vi.fn(async (tool: AnyTool, input: JsonValue, context: Parameters<Parameters<typeof createCodeMode>[0]['invokeTool']>[2]): Promise<Outcome<JsonValue>> =>
      invokeTool(tool, input, { runId: context.runId, callId: context.callId, scope: context.scope, signal: context.signal,
        permissions: { allow: [`tool:${tool.id}`] }, budget }) as Promise<Outcome<JsonValue>>);
    const result = await execute('async (input, tools) => { const result = await tools.call("number.double", input); return result.output; }', broker, { tools: [double] });
    expect(result).toMatchObject({ status: 'succeeded', output: { value: 6 } });
    expect(broker).toHaveBeenCalledTimes(1);
    expect(result.evidence?.[0]?.receipt).toMatchObject({ toolId: 'number.double', execution: 'succeeded' });
  });

  it('supports bounded parallel guest calls without bypassing the host bridge', async () => {
    const broker = vi.fn(async (_tool: AnyTool, input: JsonValue, context: Parameters<Parameters<typeof createCodeMode>[0]['invokeTool']>[2]): Promise<Outcome<JsonValue>> => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return { status: 'succeeded', output: { value: (input as { value: number }).value * 2 },
        receipt: { callId: context.callId, toolId: 'number.double', execution: 'succeeded', disclosure: 'released' } };
    });
    const result = await execute('async (input, tools) => { const values = await Promise.all([tools.call("number.double", input), tools.call("number.double", { value: input.value + 1 })]); return { value: values[0].output.value + values[1].output.value }; }', broker, { tools: [double] });
    expect(result).toMatchObject({ status: 'succeeded', output: { value: 14 } });
    expect(result.usage).toEqual({ toolCalls: 2, unknownCalls: 0, knownCostMicros: 2, unknownCostMicros: 0, maximumCostMicros: 4 });
    expect(broker).toHaveBeenCalledTimes(2);
  });

  it('does not expose Node process, require, filesystem, network or console globals', async () => {
    const definition = defineCodeProgram({ id: 'quickjs.globals', version: '1', intent: 'Inspect globals.', language: 'javascript',
      source: '() => ({ value: [typeof process, typeof require, typeof fetch, typeof console].join(",") })',
      input: valueSchema, output: textSchema, inputSchemaId: 'value.input.v1', outputSchemaId: 'text.output.v1', limits });
    const mode = createCodeMode({ adapter: createQuickJsSandboxAdapter(), allowTestAdapter: true, invokeTool: vi.fn() });
    const result = await mode.execute(definition, { value: 1 }, { runId: 'run', executionId: 'globals', scope, signal: new AbortController().signal });
    expect(result).toEqual({ status: 'succeeded', output: { value: 'undefined,undefined,undefined,undefined' },
      usage: { toolCalls: 0, unknownCalls: 0, knownCostMicros: 0, unknownCostMicros: 0, maximumCostMicros: 0 } });
  });

  it('interrupts infinite CPU work inside QuickJS before the host wall deadline', async () => {
    const started = performance.now();
    const result = await execute('() => { while (true) {} }', undefined, { limits: { ...limits, cpuMillis: 20, wallTimeMillis: 2_000 } });
    expect(result).toMatchObject({ status: 'failed', error: { code: 'TOOL_FAILED' } });
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it('terminates allocation-heavy guest work at the QuickJS heap boundary', async () => {
    const result = await execute('() => { const values = []; while (true) values.push("x".repeat(65536)); }', undefined,
      { limits: { ...limits, cpuMillis: 1_000, wallTimeMillis: 2_000, memoryBytes: 8 * 1_024 * 1_024 } });
    expect(result).toMatchObject({ status: 'failed', error: { code: 'TOOL_FAILED' } });
  });

  it('fails closed when generated TypeScript or imports are requested', async () => {
    await expect(execute('(input: { value: number }) => input', undefined, { language: 'typescript' }))
      .resolves.toMatchObject({ status: 'failed', error: { code: 'TOOL_FAILED' } });
    await expect(execute('(input) => input', undefined, { approvedImports: ['safe-package'] }))
      .resolves.toMatchObject({ status: 'failed', error: { code: 'TOOL_FAILED' } });
  });

  it('kills the disposable child process on caller cancellation', async () => {
    const controller = new AbortController();
    const mode = createCodeMode({ adapter: createQuickJsSandboxAdapter(), allowTestAdapter: true, invokeTool: vi.fn() });
    const pending = mode.execute(program('() => { while (true) {} }', { limits: { ...limits, cpuMillis: 2_000, wallTimeMillis: 3_000 } }),
      { value: 1 }, { runId: 'run', executionId: 'cancel', scope, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await expect(pending).resolves.toMatchObject({ status: 'cancelled', error: { code: 'CANCELLED' } });
  });
});
