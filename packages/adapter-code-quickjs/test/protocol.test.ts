import { describe, expect, it, vi } from 'vitest';
import type { JsonValue, Outcome, Schema } from '@mayura/core';
import { defineTool, type AnyTool } from '@mayura/tools';
import { createCodeMode, defineCodeProgram, type CodeLimits, type CodeToolInvocationContext } from '@mayura/code-mode';
import { createQuickJsProtocolAdapter, type QuickJsChildProcess, type QuickJsProtocolAdapterOptions } from '../src/index.js';

const anySchema: Schema<unknown, unknown> = { '~standard': { version: 1 as const, vendor: 'test', validate: (value: unknown) => ({ value }) } };
const limits: CodeLimits = { cpuMillis: 100, wallTimeMillis: 2_000, memoryBytes: 1_048_576, scratchBytes: 1_024,
  maxInputBytes: 1_024, maxOutputBytes: 1_024, maxToolInputBytes: 1_024, maxToolCalls: 2, maxToolConcurrency: 2 };
const tool = defineTool({ id: 'echo', version: '1', description: 'Echo.', input: anySchema, output: anySchema, effects: 'none',
  capabilities: [], execute: input => input });
const program = defineCodeProgram({ id: 'protocol.test', version: '1', intent: 'Protocol test.', language: 'javascript', source: '() => 1',
  input: anySchema, output: anySchema, inputSchemaId: 'any', outputSchemaId: 'any', tools: [tool], limits });

/** A scripted worker: `script` receives each line the host writes and may answer on stdout or stderr. */
class FakeWorker implements QuickJsChildProcess {
  readonly written: unknown[] = [];
  exitCode: number | null = null;
  readonly pid = 1;
  private readonly handlers = new Map<string, () => void>();
  private out: (chunk: string) => void = () => undefined;
  private err: (chunk: Uint8Array) => void = () => undefined;
  constructor(private readonly script: (message: Record<string, unknown>, worker: FakeWorker) => void) {}
  readonly stdin = { destroyed: false, write: (value: string): boolean => {
    const message = JSON.parse(value) as Record<string, unknown>;
    this.written.push(message);
    queueMicrotask(() => this.script(message, this));
    return true;
  }, destroy: (): void => { this.stdin.destroyed = true; } };
  readonly stdout = { setEncoding: (): void => undefined, on: (_event: 'data', listener: (chunk: string) => void): void => { this.out = listener; }, destroy: (): void => undefined };
  readonly stderr = { on: (_event: 'data', listener: (chunk: Uint8Array) => void): void => { this.err = listener; }, destroy: (): void => undefined };
  once(event: 'error' | 'exit', listener: () => void): void { this.handlers.set(event, listener); }
  kill(): boolean { return true; }
  send(value: unknown): void { this.out(typeof value === 'string' ? value : `${JSON.stringify(value)}\n`); }
  error(bytes: number): void { this.err(new Uint8Array(bytes)); }
  exit(): void { this.exitCode = 1; this.handlers.get('exit')?.(); }
}

function harness(script: (message: Record<string, unknown>, worker: FakeWorker) => void, options: Partial<QuickJsProtocolAdapterOptions> = {}) {
  const terminate = vi.fn();
  const workers: FakeWorker[] = [];
  const adapter = createQuickJsProtocolAdapter({ id: 'fake.worker', version: '1', qualification: 'production',
    launch: () => { const child = new FakeWorker(script); workers.push(child); return { child, terminate }; }, ...options });
  const broker = vi.fn(async (definition: AnyTool, input: JsonValue, context: CodeToolInvocationContext): Promise<Outcome<JsonValue>> => ({
    status: 'succeeded', output: input, receipt: { callId: context.callId, toolId: definition.id, execution: 'succeeded', disclosure: 'released' } }));
  const mode = createCodeMode({ adapter, invokeTool: broker });
  const run = (signal = new AbortController().signal) => mode.execute(program, { value: 1 },
    { runId: 'run', executionId: crypto.randomUUID(), scope: { principalId: 'p', projectId: 'q' }, signal });
  return { run, terminate, broker, workers };
}
const result = (fields: Record<string, unknown>) => (message: Record<string, unknown>, worker: FakeWorker): void => {
  if (message['type'] === 'start') worker.send({ v: 1, type: 'result', ...fields });
};

describe('QuickJS worker protocol adapter', () => {
  it('defaults to the test qualification, so a custom launcher must be accepted explicitly', () => {
    const adapter = createQuickJsProtocolAdapter({ id: 'custom.launcher', version: '1', launch: () => { throw new Error('unused'); } });
    expect(adapter.qualification).toBe('test');
    expect(() => createCodeMode({ adapter, invokeTool: vi.fn() })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_PROFILE',
      message: expect.stringContaining('"custom.launcher" is qualified for tests only') }));
    expect(() => createCodeMode({ adapter, allowTestAdapter: true, invokeTool: vi.fn() })).not.toThrow();
    const production = createQuickJsProtocolAdapter({ id: 'custom.production', version: '1', qualification: 'production', launch: () => { throw new Error('unused'); } });
    expect(() => createCodeMode({ adapter: production, invokeTool: vi.fn() })).not.toThrow();
  });

  it('rejects invalid options with INVALID_CONFIG', () => {
    const launch = () => { throw new Error('unused'); };
    for (const options of [undefined, {}, { id: 'x', version: '1', launch: 'no' }, { id: 'x', version: '1', launch, qualification: 'trusted' },
      { id: 'x', version: '1', launch, isAvailable: true }, { id: '1bad', version: '1', launch }]) {
      expect(() => createQuickJsProtocolAdapter(options as never)).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    }
  });

  it('maps worker failure reasons to precise public codes and passes the program error through', async () => {
    await expect(harness(result({ status: 'failed', reason: 'cpu_limit' })).run()).resolves.toMatchObject({ error: { code: 'LIMIT_EXCEEDED' } });
    await expect(harness(result({ status: 'failed', reason: 'memory_limit' })).run()).resolves.toMatchObject({ error: { code: 'LIMIT_EXCEEDED' } });
    await expect(harness(result({ status: 'failed', reason: 'invalid_output' })).run()).resolves.toMatchObject({ error: { code: 'INVALID_OUTPUT' } });
    await expect(harness(result({ status: 'failed', reason: 'program_error', programError: { name: 'TypeError', message: 'x is undefined' } })).run())
      .resolves.toMatchObject({ error: { code: 'TOOL_FAILED' }, programError: { name: 'TypeError', message: 'x is undefined' } });
    const forged = await harness(result({ status: 'failed', reason: 'root_shell' })).run();
    expect(forged).toMatchObject({ error: { code: 'TOOL_FAILED', message: 'The sandbox failed before the program finished; its details are withheld.' } });
    await expect(harness(result({ status: 'succeeded', output: { ok: true } })).run()).resolves.toMatchObject({ status: 'succeeded', output: { ok: true } });
  });

  it('terminates the worker exactly once, however the execution ends', async () => {
    const success = harness(result({ status: 'succeeded', output: 1 }));
    await success.run();
    expect(success.terminate).toHaveBeenCalledTimes(1);
    const silent = harness(() => undefined);
    await expect(silent.run(AbortSignal.timeout(50))).resolves.toMatchObject({ status: 'cancelled' });
    expect(silent.terminate).toHaveBeenCalledTimes(1);
    const exited = harness((_message, worker) => worker.exit());
    await expect(exited.run()).resolves.toMatchObject({ error: { code: 'TOOL_FAILED' } });
    expect(exited.terminate).toHaveBeenCalledTimes(1);
    const failedLaunch = createCodeMode({ adapter: createQuickJsProtocolAdapter({ id: 'fake.launch', version: '1', qualification: 'production',
      launch: () => { throw new Error('SECRET launch detail'); } }), invokeTool: vi.fn() });
    const launched = await failedLaunch.execute(program, 1, { runId: 'run', executionId: 'launch', scope: { principalId: 'p', projectId: 'q' },
      signal: new AbortController().signal });
    expect(launched).toMatchObject({ error: { code: 'TOOL_FAILED' } });
    expect(JSON.stringify(launched)).not.toContain('SECRET');
  });

  it('fails closed on protocol abuse: duplicate requests, too many requests, oversized lines, stderr floods and garbage', async () => {
    const duplicate = harness((message, worker) => {
      if (message['type'] !== 'start') return;
      worker.send({ v: 1, type: 'tool', requestId: 1, toolId: 'echo', input: 1 });
      worker.send({ v: 1, type: 'tool', requestId: 1, toolId: 'echo', input: 2 });
    });
    await expect(duplicate.run()).resolves.toMatchObject({ error: { code: 'TOOL_FAILED' } });
    const flood = harness((message, worker) => {
      if (message['type'] === 'start') for (let id = 1; id <= 5; id++) worker.send({ v: 1, type: 'tool', requestId: id, toolId: 'echo', input: id });
    });
    await expect(flood.run()).resolves.toMatchObject({ error: { code: 'TOOL_FAILED' } });
    expect(flood.broker.mock.calls.length).toBeLessThanOrEqual(limits.maxToolCalls);
    const long = harness((message, worker) => { if (message['type'] === 'start') worker.send('x'.repeat(200_000)); });
    await expect(long.run()).resolves.toMatchObject({ error: { code: 'TOOL_FAILED' } });
    expect(long.terminate).toHaveBeenCalledTimes(1);
    const noisy = harness((message, worker) => { if (message['type'] === 'start') worker.error(65 * 1_024); });
    await expect(noisy.run()).resolves.toMatchObject({ error: { code: 'TOOL_FAILED' } });
    const garbage = harness((message, worker) => { if (message['type'] === 'start') worker.send('{"v":2}\n'); });
    await expect(garbage.run()).resolves.toMatchObject({ error: { code: 'TOOL_FAILED' } });
  });

  it('relays tool calls through the host bridge and answers each request once', async () => {
    const relay = harness((message, worker) => {
      if (message['type'] === 'start') worker.send({ v: 1, type: 'tool', requestId: 7, toolId: 'echo', input: { value: 1 } });
      if (message['type'] === 'toolResult') worker.send({ v: 1, type: 'result', status: 'succeeded', output: message['outcome'] as JsonValue });
    });
    const outcome = await relay.run();
    expect(outcome).toMatchObject({ status: 'succeeded', output: { status: 'succeeded', output: { value: 1 } } });
    expect(relay.broker).toHaveBeenCalledTimes(1);
    expect(relay.workers[0]!.written.filter(message => (message as Record<string, unknown>)['type'] === 'toolResult')).toEqual([
      { v: 1, type: 'toolResult', requestId: 7, outcome: { status: 'succeeded', output: { value: 1 } } }]);
  });
});
