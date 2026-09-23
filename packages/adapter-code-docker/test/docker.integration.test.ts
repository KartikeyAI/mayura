import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { Budget, type JsonValue, type Outcome, type Schema } from '@mayura/core';
import { defineTool, invokeTool, type AnyTool } from '@mayura/tools';
import { createCodeMode, defineCodeProgram } from '@mayura/code-mode';
import { createDockerQuickJsSandboxAdapter } from '../src/index.js';

const dockerPath = process.env['MAYURA_TEST_DOCKER_PATH'];
const image = process.env['MAYURA_TEST_CODE_SANDBOX_IMAGE'];
const available = dockerPath !== undefined && image !== undefined;
const executeFile = promisify(execFile);
async function containerIds(): Promise<string[]> {
  const listed = await executeFile(dockerPath!, ['ps', '--quiet', '--filter', `ancestor=${image!}`, '--filter', 'name=mayura-code-'],
    { windowsHide: true, timeout: 10_000, maxBuffer: 4_096, env: Object.freeze({}) });
  return listed.stdout.trim().split(/\r?\n/u).filter(Boolean);
}
async function waitForContainerCount(count: number): Promise<string[]> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const ids = await containerIds();
    if (ids.length === count) return ids;
    if (Date.now() >= deadline) throw new Error(`Expected ${count} Mayura sandbox containers; observed ${ids.length}.`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
const schema: Schema<{ value: number }, { value: number }> = { '~standard': { version: 1, vendor: 'test', validate: value => value && typeof value === 'object'
  && typeof (value as { value?: unknown }).value === 'number' ? { value: value as { value: number } } : { issues: [{ message: 'invalid' }] } } };
const limits = { cpuMillis: 250, wallTimeMillis: 10_000, memoryBytes: 32 * 1_024 * 1_024, scratchBytes: 1_024 * 1_024,
  maxInputBytes: 1_024, maxOutputBytes: 1_024, maxToolInputBytes: 1_024, maxToolCalls: 2, maxToolConcurrency: 2 };
const tool = defineTool({ id: 'number.double', version: '1', description: 'Double.', input: schema, output: schema,
  effects: 'none', capabilities: [], execute: input => ({ value: input.value * 2 }) });

describe.skipIf(!available)('Docker QuickJS containment profile', () => {
  it('executes brokered tools inside the hardened exact image', async () => {
    const budget = new Budget(0, 2);
    const broker = vi.fn(async (definition: AnyTool, input: JsonValue, context: Parameters<Parameters<typeof createCodeMode>[0]['invokeTool']>[2]): Promise<Outcome<JsonValue>> =>
      invokeTool(definition, input, { runId: context.runId, callId: context.callId, scope: context.scope, signal: context.signal,
        permissions: { allow: [`tool:${definition.id}`] }, budget }) as Promise<Outcome<JsonValue>>);
    const mode = createCodeMode({ adapter: createDockerQuickJsSandboxAdapter({ dockerPath: dockerPath!, image: image! }), allowTestAdapter: true, invokeTool: broker });
    const program = defineCodeProgram({ id: 'docker.tool', version: '1', intent: 'Docker tool test.', language: 'javascript',
      source: 'async (input, tools) => (await tools.call("number.double", input)).output', input: schema, output: schema,
      inputSchemaId: 'value.input.v1', outputSchemaId: 'value.output.v1', tools: [tool], limits });
    const result = await mode.execute(program, { value: 5 }, { runId: 'run', executionId: 'docker-tool',
      scope: { principalId: 'alice', projectId: 'project' }, signal: new AbortController().signal });
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'succeeded', output: { value: 10 } }); expect(broker).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('interrupts hostile CPU work and removes the container', async () => {
    const mode = createCodeMode({ adapter: createDockerQuickJsSandboxAdapter({ dockerPath: dockerPath!, image: image! }), allowTestAdapter: true, invokeTool: vi.fn() });
    const program = defineCodeProgram({ id: 'docker.cpu', version: '1', intent: 'Docker CPU test.', language: 'javascript', source: '() => { while (true) {} }',
      input: schema, output: schema, inputSchemaId: 'value.input.v1', outputSchemaId: 'value.output.v1', limits: { ...limits, cpuMillis: 20 } });
    await expect(mode.execute(program, { value: 1 }, { runId: 'run', executionId: 'docker-cpu', scope: { principalId: 'alice', projectId: 'project' },
      signal: new AbortController().signal })).resolves.toMatchObject({ status: 'failed', error: { code: 'TOOL_FAILED' } });
  }, 30_000);

  it('applies the declared outer-container confinement controls', async () => {
    let admit!: () => void;
    let release!: () => void;
    const admitted = new Promise<void>(resolve => { admit = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const holdingTool = defineTool({ id: 'number.hold', version: '1', description: 'Hold for inspection.', input: schema, output: schema,
      effects: 'none', capabilities: [], execute: async input => { admit(); await blocked; return input; } });
    const budget = new Budget(0, 1);
    const mode = createCodeMode({ adapter: createDockerQuickJsSandboxAdapter({ dockerPath: dockerPath!, image: image! }), allowTestAdapter: true,
      invokeTool: (definition, input, context) => invokeTool(definition, input, { runId: context.runId, callId: context.callId,
        scope: context.scope, signal: context.signal, permissions: { allow: [`tool:${definition.id}`] }, budget }) as Promise<Outcome<JsonValue>> });
    const program = defineCodeProgram({ id: 'docker.inspect', version: '1', intent: 'Docker confinement inspection.', language: 'javascript',
      source: 'async (input, tools) => (await tools.call("number.hold", input)).output', input: schema, output: schema,
      inputSchemaId: 'value.input.v1', outputSchemaId: 'value.output.v1', tools: [holdingTool], limits });
    const execution = mode.execute(program, { value: 1 }, { runId: 'run', executionId: 'docker-inspect',
      scope: { principalId: 'alice', projectId: 'project' }, signal: new AbortController().signal });
    await admitted;
    try {
      const ids = await waitForContainerCount(1);
      const inspected = await executeFile(dockerPath!, ['container', 'inspect', ids[0]!],
        { windowsHide: true, timeout: 10_000, maxBuffer: 128 * 1_024, env: Object.freeze({}) });
      const value = JSON.parse(inspected.stdout) as Array<{ Config: { User: string }; HostConfig: Record<string, unknown>; Mounts: Array<{ Type: string }> }>;
      expect(value).toHaveLength(1);
      expect(value[0]!.Config.User).toBe('65532:65532');
      expect(value[0]!.HostConfig).toMatchObject({ NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], PidsLimit: 16,
        MemorySwap: value[0]!.HostConfig['Memory'], NanoCpus: 1_000_000_000, IpcMode: 'none', Binds: null,
        Ulimits: [{ Name: 'nofile', Hard: 64, Soft: 64 }] });
      expect(value[0]!.HostConfig['SecurityOpt']).toEqual(expect.arrayContaining(['no-new-privileges=true', 'seccomp=builtin']));
      expect(value[0]!.HostConfig['Tmpfs']).toEqual({ '/tmp': expect.stringContaining('size=1048576') });
      expect(value[0]!.Mounts.every(mount => mount.Type === 'tmpfs')).toBe(true);
    } finally { release(); }
    await expect(execution).resolves.toMatchObject({ status: 'succeeded', output: { value: 1 } });
  }, 30_000);

  it('force-removes the disposable container when the caller cancels', async () => {
    const controller = new AbortController();
    const mode = createCodeMode({ adapter: createDockerQuickJsSandboxAdapter({ dockerPath: dockerPath!, image: image! }), allowTestAdapter: true, invokeTool: vi.fn() });
    const program = defineCodeProgram({ id: 'docker.cancel', version: '1', intent: 'Docker cancellation test.', language: 'javascript',
      source: '() => { while (true) {} }', input: schema, output: schema, inputSchemaId: 'value.input.v1', outputSchemaId: 'value.output.v1',
      limits: { ...limits, cpuMillis: 10_000 } });
    const execution = mode.execute(program, { value: 1 }, { runId: 'run', executionId: 'docker-cancel',
      scope: { principalId: 'alice', projectId: 'project' }, signal: controller.signal });
    await waitForContainerCount(1);
    controller.abort();
    await expect(execution).resolves.toMatchObject({ status: 'cancelled' });
    await expect(waitForContainerCount(0)).resolves.toEqual([]);
  }, 30_000);
});
