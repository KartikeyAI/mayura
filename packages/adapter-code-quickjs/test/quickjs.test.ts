import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { Budget, type JsonValue, type Outcome, type Schema } from '@mayura/core';
import { defineTool, invokeTool, type AnyTool } from '@mayura/tools';
import { createCodeMode, defineCodeProgram, type CodeLimits, type CodeToolInvocationContext, type CreateCodeModeOptions } from '@mayura/code-mode';
import { createQuickJsSandboxAdapter } from '../src/index.js';
import { workerCommand, workerPath } from '../src/worker-command.js';

const valueSchema: Schema<{ value: number }, { value: number }> = {
  '~standard': { version: 1 as const, vendor: 'test', validate: (value: unknown) => value !== null && typeof value === 'object'
    && typeof (value as { value?: unknown }).value === 'number' ? { value: value as { value: number } } : { issues: [{ message: 'invalid' }] } },
};
const anySchema: Schema<unknown, unknown> = { '~standard': { version: 1 as const, vendor: 'test', validate: (value: unknown) => ({ value }) } };
const limits: CodeLimits = { cpuMillis: 500, wallTimeMillis: 8_000, memoryBytes: 16 * 1_024 * 1_024, scratchBytes: 1_024,
  maxInputBytes: 4_096, maxOutputBytes: 4_096, maxToolInputBytes: 4_096, maxToolCalls: 4, maxToolConcurrency: 2 };
const scope = { principalId: 'alice', projectId: 'project' };
const double = defineTool({ id: 'number.double', version: '1', description: 'Double.', input: valueSchema, output: valueSchema,
  effects: 'none', capabilities: [], costMicros: 1, execute: ({ value }) => ({ value: value * 2 }) });
const unused = vi.fn(async (): Promise<Outcome<JsonValue>> => ({ status: 'failed', error: { code: 'TOOL_FAILED', message: 'failed' } }));
const echo = vi.fn(async (tool: AnyTool, input: JsonValue, context: CodeToolInvocationContext): Promise<Outcome<JsonValue>> => ({
  status: 'succeeded', output: input, receipt: { callId: context.callId, toolId: tool.id, execution: 'succeeded', disclosure: 'released' } }));

function program(source: string, overrides: Record<string, unknown> = {}) {
  return defineCodeProgram({ id: 'quickjs.test', version: '1', intent: 'Test the QuickJS adapter.', language: 'javascript', source,
    input: valueSchema, output: anySchema, inputSchemaId: 'value.input.v1', outputSchemaId: 'any.output.v1', limits, ...overrides });
}
function execute(source: string, invoke: CreateCodeModeOptions['invokeTool'] = unused, overrides: Record<string, unknown> = {},
  signal = new AbortController().signal) {
  const mode = createCodeMode({ adapter: createQuickJsSandboxAdapter(), invokeTool: invoke });
  return mode.execute(program(source, overrides), { value: 3 }, { runId: 'run', executionId: crypto.randomUUID(), scope, signal });
}

describe('QuickJS sandbox adapter', () => {
  it('is qualified for production, so no test opt-in is needed', async () => {
    const adapter = createQuickJsSandboxAdapter();
    expect(adapter).toEqual({ id: 'mayura.quickjs-child', version: '1.0.0', qualification: 'production' });
    await expect(execute('(input) => ({ value: input.value + 4 })')).resolves.toEqual({ status: 'succeeded', output: { value: 7 },
      usage: { toolCalls: 0, unknownCalls: 0, knownCostMicros: 0, unknownCostMicros: 0, maximumCostMicros: 0 } });
  });

  it('mediates asynchronous tool calls through the ordinary Mayura broker', async () => {
    const budget = new Budget(10, 4);
    const broker = vi.fn(async (tool: AnyTool, input: JsonValue, context: CodeToolInvocationContext): Promise<Outcome<JsonValue>> =>
      invokeTool(tool, input, { runId: context.runId, callId: context.callId, scope: context.scope, signal: context.signal,
        permissions: { allow: [`tool:${tool.id}`] }, budget }) as Promise<Outcome<JsonValue>>);
    const result = await execute('async (input, tools) => { const result = await tools.call("number.double", input); return result.output; }', broker, { tools: [double] });
    expect(result).toMatchObject({ status: 'succeeded', output: { value: 6 } });
    expect(broker).toHaveBeenCalledTimes(1);
    expect(result.evidence?.[0]?.receipt).toMatchObject({ toolId: 'number.double', execution: 'succeeded' });
  });

  it('supports bounded parallel guest calls without bypassing the host bridge', async () => {
    const broker = vi.fn(async (_tool: AnyTool, input: JsonValue, context: CodeToolInvocationContext): Promise<Outcome<JsonValue>> => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return { status: 'succeeded', output: { value: (input as { value: number }).value * 2 },
        receipt: { callId: context.callId, toolId: 'number.double', execution: 'succeeded', disclosure: 'released' } };
    });
    const result = await execute('async (input, tools) => { const values = await Promise.all([tools.call("number.double", input), tools.call("number.double", { value: input.value + 1 })]); return { value: values[0].output.value + values[1].output.value }; }', broker, { tools: [double] });
    expect(result).toMatchObject({ status: 'succeeded', output: { value: 14 } });
    expect(result.usage).toEqual({ toolCalls: 2, unknownCalls: 0, knownCostMicros: 2, unknownCostMicros: 0, maximumCostMicros: 4 });
    expect(broker).toHaveBeenCalledTimes(2);
  });

  describe('hostile programs', () => {
    it('reaches no host API: globals, the Function constructor, eval and dynamic import all stay inside QuickJS', async () => {
      const result = await execute(`async () => {
        const names = ['process', 'require', 'module', 'fetch', 'console', 'setTimeout', 'setInterval', 'XMLHttpRequest', 'WebAssembly',
          'Buffer', 'global', 'std', 'os', 'Deno', 'Bun', '__mayuraToolCall'];
        const found = names.filter(name => typeof globalThis[name] !== 'undefined');
        const viaFunction = Function('return typeof process')();
        const viaConstructor = (() => {}).constructor.constructor('return typeof require')();
        const viaEval = eval('typeof fetch');
        let imported;
        try { await import('node:fs'); imported = 'loaded'; } catch (error) { imported = error.name; }
        return { found, viaFunction, viaConstructor, viaEval, imported };
      }`);
      expect(result).toMatchObject({ status: 'succeeded', output: { found: [], viaFunction: 'undefined', viaConstructor: 'undefined',
        viaEval: 'undefined', imported: expect.not.stringMatching(/^loaded$/u) } });
    });

    it('stops an infinite loop at cpuMillis, long before the wall deadline', async () => {
      const started = performance.now();
      const result = await execute('() => { while (true) {} }', unused, { limits: { ...limits, cpuMillis: 50, wallTimeMillis: 8_000 } });
      expect(result).toMatchObject({ status: 'failed', error: { code: 'LIMIT_EXCEEDED', message: 'The program ran longer than its cpuMillis limit.' } });
      expect(result.programError).toBeUndefined();
      expect(performance.now() - started).toBeLessThan(7_000);
    });

    it('does not let the program catch the CPU interrupt or keep running in a finally block or a microtask loop', async () => {
      const tight = { limits: { ...limits, cpuMillis: 50 } };
      await expect(execute('() => { try { while (true) {} } catch { return { value: 1 }; } }', unused, tight))
        .resolves.toMatchObject({ status: 'failed', error: { code: 'LIMIT_EXCEEDED' } });
      await expect(execute('() => { try { while (true) {} } finally { while (true) {} } }', unused, tight))
        .resolves.toMatchObject({ status: 'failed', error: { code: 'LIMIT_EXCEEDED' } });
      await expect(execute('async () => { for (;;) await null; }', unused, tight))
        .resolves.toMatchObject({ status: 'failed', error: { code: 'LIMIT_EXCEEDED' } });
    });

    it('counts only interpreter time against cpuMillis, not time spent waiting for tools', async () => {
      const slow = vi.fn(async (tool: AnyTool, input: JsonValue, context: CodeToolInvocationContext): Promise<Outcome<JsonValue>> => {
        await new Promise(resolve => setTimeout(resolve, 400));
        return { status: 'succeeded', output: input, receipt: { callId: context.callId, toolId: tool.id, execution: 'succeeded', disclosure: 'released' } };
      });
      // After ~800 ms of waiting, the program still does real work; only that work counts against the 400 ms. Were the
      // waiting counted, 800 ms would exceed the limit. The work stays well under it even on a loaded CI runner (a
      // 300,000-step loop once took over 150 ms on macOS CI).
      const result = await execute(`async (input, tools) => {
        const first = await tools.call("number.double", input);
        const second = await tools.call("number.double", first.output);
        let sum = 0; for (let i = 0; i < 50000; i++) sum += i % 7;
        return { value: second.output.value, sum };
      }`, slow, { tools: [double], limits: { ...limits, cpuMillis: 400 } });
      expect(result).toMatchObject({ status: 'succeeded', output: { value: 3 } });
    });

    it('bounds memory with a hard WebAssembly limit, whether the program keeps the memory local or global', async () => {
      const memory = { limits: { ...limits, cpuMillis: 5_000 } };
      const expected = { status: 'failed', error: { code: 'LIMIT_EXCEEDED', message: 'The program needed more memory than its memoryBytes limit.' } };
      await expect(execute('() => { const values = []; for (;;) values.push("x".repeat(65536) + values.length); }', unused, memory)).resolves.toMatchObject(expected);
      await expect(execute('() => { globalThis.hog = []; for (;;) globalThis.hog.push(new Array(10000).fill(1)); }', unused, memory)).resolves.toMatchObject(expected);
      await expect(execute('() => "x".repeat(1e9)', unused, memory)).resolves.toMatchObject(expected);
      await expect(execute('() => { const values = []; for (;;) values.push({}); }', unused, memory)).resolves.toMatchObject(expected);
      // Only a refused allocation counts: a program cannot fake the limit by throwing a look-alike error.
      await expect(execute('() => { throw new InternalError("out of memory"); }', unused, memory))
        .resolves.toMatchObject({ status: 'failed', error: { code: 'TOOL_FAILED' }, programError: { name: 'InternalError', message: 'out of memory' } });
      // A program that catches the allocation failure sees it and can recover, but never gets more than its limit.
      const caught = await execute('() => { const values = []; try { for (;;) values.push("x".repeat(65536) + values.length); } catch (error) { return [values.length, String(error)]; } }', unused, memory);
      expect(caught).toMatchObject({ status: 'succeeded', output: [expect.any(Number), 'InternalError: out of memory'] });
      expect((caught.status === 'succeeded' ? caught.output as [number] : [Infinity])[0]).toBeLessThan((16 + 16) * 1_024 * 1_024 / 65_536);
    });

    it('reports deep recursion as a stack overflow the program can see, in JavaScript and in native recursion', async () => {
      const overflow = { status: 'failed', error: { code: 'TOOL_FAILED' }, programError: { name: 'InternalError', message: 'stack overflow' } };
      await expect(execute('() => { const down = n => down(n + 1) + 1; return down(0); }')).resolves.toMatchObject(overflow);
      await expect(execute('() => { let nested = []; for (let i = 0; i < 200000; i++) nested = [nested]; return nested; }')).resolves.toMatchObject(overflow);
      await expect(execute('() => { let nested = []; for (let i = 0; i < 200000; i++) nested = [nested]; JSON.stringify(nested); return 1; }')).resolves.toMatchObject(overflow);
      await expect(execute('() => { const down = n => { try { return down(n + 1); } catch { return n; } }; return down(0) > 100; }'))
        .resolves.toMatchObject({ status: 'succeeded', output: true });
    });

    it('rejects oversized and non-JSON results before copying them out of the interpreter', async () => {
      const invalid = { status: 'failed', error: { code: 'INVALID_OUTPUT', message: 'The program\'s result is not plain JSON within maxOutputBytes.' } };
      await expect(execute('() => "x".repeat(10_000_000)', unused, { limits: { ...limits, memoryBytes: 64 * 1_024 * 1_024 } })).resolves.toMatchObject(invalid);
      await expect(execute('() => undefined')).resolves.toMatchObject(invalid);
      await expect(execute('() => 1n')).resolves.toMatchObject(invalid);
      await expect(execute('() => { const loop = {}; loop.self = loop; return loop; }')).resolves.toMatchObject(invalid);
    });

    it('returns what the program threw, bounded, and never in error.message', async () => {
      const thrown = await execute('() => { throw new TypeError("secret tool data " + "y".repeat(5000)); }');
      expect(thrown).toMatchObject({ status: 'failed', error: { code: 'TOOL_FAILED' }, programError: { name: 'TypeError' } });
      expect(thrown.programError?.message).toHaveLength(1_024);
      expect(thrown.status !== 'succeeded' && thrown.error.message).not.toContain('secret');
      await expect(execute('() => { throw "plain"; }')).resolves.toMatchObject({ programError: { name: 'Error', message: 'plain' } });
      await expect(execute('() => { throw { get name() { throw 1; }, message: 7 }; }')).resolves.toMatchObject({ programError: { name: 'Error', message: '' } });
      await expect(execute('(input) => input)//')).resolves.toMatchObject({ error: { code: 'TOOL_FAILED' }, programError: { name: 'SyntaxError' } });
      await expect(execute('42')).resolves.toMatchObject({ programError: { name: 'TypeError', message: expect.stringContaining('function expression') } });
    });

    it('fails a program whose promise can never settle at once, instead of waiting for the deadline', async () => {
      const started = performance.now();
      const result = await execute('() => new Promise(() => {})', unused, { limits: { ...limits, wallTimeMillis: 8_000 } });
      expect(result).toMatchObject({ status: 'failed', error: { code: 'TOOL_FAILED' } });
      expect(result.programError).toBeUndefined();
      expect(performance.now() - started).toBeLessThan(5_000);
    });

    it('answers a tool-call flood inside the sandbox; the broker sees at most maxToolCalls', async () => {
      echo.mockClear();
      const result = await execute(`async (input, tools) => {
        const calls = [];
        for (let i = 0; i < 20000; i++) calls.push(tools.call("number.double", { value: i }));
        const outcomes = await Promise.all(calls);
        return { value: outcomes.filter(outcome => outcome.status === 'succeeded').length,
          limited: outcomes.filter(outcome => outcome.error && outcome.error.code === 'LIMIT_EXCEEDED').length };
      }`, echo, { tools: [double], limits: { ...limits, cpuMillis: 5_000, memoryBytes: 64 * 1_024 * 1_024, maxToolCalls: 4, maxToolConcurrency: 4 } });
      expect(result).toMatchObject({ status: 'succeeded', output: { value: 4, limited: 19_996 } });
      expect(echo).toHaveBeenCalledTimes(4);
    });

    it('rejects oversized and unknown tool calls before the broker', async () => {
      echo.mockClear();
      const result = await execute(`async (input, tools) => {
        const big = await tools.call("number.double", { value: 1, pad: "x".repeat(10000) });
        const unknown = await tools.call("admin.secret", { value: 1 });
        return { big: big.error.code, unknown: unknown.error.code };
      }`, echo, { tools: [double] });
      expect(result).toMatchObject({ status: 'succeeded', output: { big: 'INVALID_INPUT', unknown: 'PERMISSION_DENIED' } });
      expect(echo).not.toHaveBeenCalled();
    });

    it('keeps the bridge intact when the program replaces JSON, Promise, Object and Array intrinsics', async () => {
      echo.mockClear();
      const result = await execute(`async (input, tools) => {
        JSON.stringify = () => '{"toolId":"number.double","input":{"value":999}}';
        JSON.parse = () => ({ status: 'succeeded', output: { value: -1 } });
        Array.prototype.push = () => { throw new Error('no'); };
        Promise.prototype.then = function () { throw new Error('no'); };
        Object.freeze = value => value;
        try { tools.call = async () => ({ status: 'succeeded', output: { value: -2 } }); } catch {}
        const outcome = await tools.call("number.double", { value: 5 });
        return outcome;
      }`, echo, { tools: [double] });
      expect(result).toMatchObject({ status: 'succeeded', output: { status: 'succeeded', output: { value: 5 } } });
      expect(echo).toHaveBeenCalledTimes(1);
      expect(echo.mock.calls[0]![1]).toEqual({ value: 5 });
    });

    it('cannot pollute host prototypes through tool input or output', async () => {
      echo.mockClear();
      const input = await execute(`async (input, tools) => {
        const outcome = await tools.call("number.double", JSON.parse('{"value":1,"__proto__":{"polluted":true}}'));
        return outcome.error.code;
      }`, echo, { tools: [double] });
      expect(input).toMatchObject({ status: 'succeeded', output: 'INVALID_INPUT' });
      expect(echo).not.toHaveBeenCalled();
      const output = await execute(`() => JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}')`);
      expect(output).toMatchObject({ status: 'failed', error: { code: 'INVALID_OUTPUT' } });
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
      expect(Object.prototype).not.toHaveProperty('polluted');
    });

    it('isolates executions: nothing one program changes is visible to the next', async () => {
      const mode = createCodeMode({ adapter: createQuickJsSandboxAdapter(), invokeTool: unused });
      const run = (source: string, executionId: string) => mode.execute(program(source), { value: 1 },
        { runId: 'run', executionId, scope, signal: new AbortController().signal });
      await expect(run('() => { globalThis.leak = 1; Object.prototype.leak = 2; Math.random = () => 4; return 1; }', 'first'))
        .resolves.toMatchObject({ status: 'succeeded' });
      await expect(run('() => [typeof globalThis.leak, typeof ({}).leak, Math.random() === 4]', 'second'))
        .resolves.toMatchObject({ status: 'succeeded', output: ['undefined', 'undefined', false] });
    });
  });

  it('reports TypeScript and imports as unsupported instead of running them', async () => {
    const unsupported = { status: 'failed', error: { code: 'UNSUPPORTED_PROFILE', message: 'This sandbox cannot run the program\'s language or approved imports.' } };
    await expect(execute('(input: { value: number }) => input', unused, { language: 'typescript' })).resolves.toMatchObject(unsupported);
    await expect(execute('(input) => input', unused, { approvedImports: ['safe-package'] })).resolves.toMatchObject(unsupported);
  });

  it('kills the disposable worker on cancellation and at the wall deadline', async () => {
    const controller = new AbortController();
    const pending = execute('() => { while (true) {} }', unused, { limits: { ...limits, cpuMillis: 5_000 } }, controller.signal);
    setTimeout(() => controller.abort(), 300);
    await expect(pending).resolves.toMatchObject({ status: 'cancelled', error: { code: 'CANCELLED' } });
    // A broker that honours the signal and reports that nothing started lets the deadline surface as TIMEOUT.
    const waiting = vi.fn(async (tool: AnyTool, _input: JsonValue, context: CodeToolInvocationContext): Promise<Outcome<JsonValue>> =>
      new Promise(resolve => context.signal.addEventListener('abort', () => resolve({ status: 'cancelled', error: { code: 'CANCELLED', message: 'cancelled' },
        receipt: { callId: context.callId, toolId: tool.id, execution: 'not_started', disclosure: 'withheld' } }))));
    await expect(execute('async (input, tools) => tools.call("number.double", input)', waiting, { tools: [double], limits: { ...limits, wallTimeMillis: 1_500 } }))
      .resolves.toMatchObject({ status: 'failed', error: { code: 'TIMEOUT' } });
  });

  it('runs the worker process under the Node.js permission model, with an empty environment and no code generation', async () => {
    // An escaped program would run as the worker process. This probe runs with the worker's exact flags.
    const command = workerCommand(limits)!;
    expect(command.args.at(-1)).toBe(workerPath);
    expect(command.args).toEqual(expect.arrayContaining(['--disallow-code-generation-from-strings', expect.stringMatching(/^--(?:experimental-)?permission$/u)]));
    const probe = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'escape-probe.mjs');
    const outside = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json');
    expect(existsSync(outside)).toBe(true);
    const run = await promisify(execFile)(command.command, [...command.args.slice(0, -1), probe, outside, workerPath],
      { ...command.options, timeout: 10_000 });
    const probed = JSON.parse(run.stdout) as Record<string, unknown>;
    expect(probed).toEqual({ readOutside: 'denied', readAllowed: 'read', writeTemp: 'denied', spawn: 'denied',
      worker: 'denied', evaluate: 'denied', functionConstructor: 'denied', environment: expect.any(Array) });
    // The operating system adds a few variables to an empty environment: Windows those it requires to start a process
    // (libuv adds them), macOS the text encoding CoreFoundation sets in every process. Nothing is inherited.
    const added = process.platform === 'win32' ? ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR']
      : process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : [];
    expect((probed['environment'] as string[]).filter(name => !added.includes(process.platform === 'win32' ? name.toUpperCase() : name))).toEqual([]);
  });
});
