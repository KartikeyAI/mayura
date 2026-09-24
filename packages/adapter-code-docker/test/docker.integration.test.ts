import { execFile } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { Budget, type JsonValue, type Outcome, type Schema } from '@mayura/core';
import { defineTool, invokeTool, type AnyTool } from '@mayura/tools';
import { createCodeMode, defineCodeProgram } from '@mayura/code-mode';
import { createDockerQuickJsSandboxAdapter, createPromotedDockerQuickJsSandboxAdapter, serializeDockerImagePromotion,
  type DockerImagePromotionStatement } from '../src/index.js';

const dockerPath = process.env['MAYURA_TEST_DOCKER_PATH'];
const image = process.env['MAYURA_TEST_CODE_SANDBOX_IMAGE'];
const provenance = process.env['MAYURA_TEST_CODE_SANDBOX_PROVENANCE'];
const available = dockerPath !== undefined && image !== undefined && provenance !== undefined;
const executeFile = promisify(execFile);
function promotionProof() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519'); const now = Date.now();
  const statement: DockerImagePromotionStatement = { format: 'mayura-docker-promotion-v1', subject: { image: image!, provenance: provenance! },
    builderId: 'mayura-live-test', scan: { scannerId: 'controlled-test-scanner', scannerVersion: '1', reportDigest: `sha256:${'d'.repeat(64)}`,
      completedAt: new Date(now - 2_000).toISOString(), critical: 0, high: 0, unknown: 0 },
    issuedAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString() };
  return { statement, signature: `base64:${sign(null, Buffer.from(serializeDockerImagePromotion(statement)), privateKey).toString('base64')}`,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}
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
  it('rejects an exact image whose retained provenance digest does not match its label', async () => {
    const mode = createCodeMode({ adapter: createDockerQuickJsSandboxAdapter({ dockerPath: dockerPath!, image: image!,
      provenance: `sha256:${'0'.repeat(64)}` }), allowTestAdapter: true, invokeTool: vi.fn() });
    const program = defineCodeProgram({ id: 'docker.provenance', version: '1', intent: 'Docker provenance test.', language: 'javascript',
      source: 'input => input', input: schema, output: schema, inputSchemaId: 'value.input.v1', outputSchemaId: 'value.output.v1', limits });
    await expect(mode.execute(program, { value: 1 }, { runId: 'run', executionId: 'docker-provenance',
      scope: { principalId: 'alice', projectId: 'project' }, signal: new AbortController().signal }))
      .resolves.toMatchObject({ status: 'failed', error: { code: 'UNSUPPORTED_PROFILE' } });
  }, 30_000);

  it('executes brokered tools inside the hardened exact image', async () => {
    const budget = new Budget(0, 2);
    const broker = vi.fn(async (definition: AnyTool, input: JsonValue, context: Parameters<Parameters<typeof createCodeMode>[0]['invokeTool']>[2]): Promise<Outcome<JsonValue>> =>
      invokeTool(definition, input, { runId: context.runId, callId: context.callId, scope: context.scope, signal: context.signal,
        permissions: { allow: [`tool:${definition.id}`] }, budget }) as Promise<Outcome<JsonValue>>);
    const mode = createCodeMode({ adapter: createPromotedDockerQuickJsSandboxAdapter({ dockerPath: dockerPath!, image: image!, provenance: provenance!,
      promotion: promotionProof() }), allowTestAdapter: true, invokeTool: broker });
    const program = defineCodeProgram({ id: 'docker.tool', version: '1', intent: 'Docker tool test.', language: 'javascript',
      source: 'async (input, tools) => (await tools.call("number.double", input)).output', input: schema, output: schema,
      inputSchemaId: 'value.input.v1', outputSchemaId: 'value.output.v1', tools: [tool], limits });
    const result = await mode.execute(program, { value: 5 }, { runId: 'run', executionId: 'docker-tool',
      scope: { principalId: 'alice', projectId: 'project' }, signal: new AbortController().signal });
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'succeeded', output: { value: 10 } }); expect(broker).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('interrupts hostile CPU work and removes the container', async () => {
    const mode = createCodeMode({ adapter: createDockerQuickJsSandboxAdapter({ dockerPath: dockerPath!, image: image!, provenance: provenance! }), allowTestAdapter: true, invokeTool: vi.fn() });
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
    const mode = createCodeMode({ adapter: createDockerQuickJsSandboxAdapter({ dockerPath: dockerPath!, image: image!, provenance: provenance! }), allowTestAdapter: true,
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

  it('denies filesystem, privilege, network and executable-scratch escape primitives', async () => {
    let admit!: () => void;
    let release!: () => void;
    const admitted = new Promise<void>(resolve => { admit = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const holdingTool = defineTool({ id: 'number.escape-hold', version: '1', description: 'Hold for escape probes.', input: schema, output: schema,
      effects: 'none', capabilities: [], execute: async input => { admit(); await blocked; return input; } });
    const budget = new Budget(0, 1);
    const mode = createCodeMode({ adapter: createDockerQuickJsSandboxAdapter({ dockerPath: dockerPath!, image: image!, provenance: provenance! }),
      allowTestAdapter: true, invokeTool: (definition, input, context) => invokeTool(definition, input, { runId: context.runId,
        callId: context.callId, scope: context.scope, signal: context.signal, permissions: { allow: [`tool:${definition.id}`] }, budget }) as Promise<Outcome<JsonValue>> });
    const program = defineCodeProgram({ id: 'docker.escape', version: '1', intent: 'Docker escape boundary test.', language: 'javascript',
      source: 'async (input, tools) => (await tools.call("number.escape-hold", input)).output', input: schema, output: schema,
      inputSchemaId: 'value.input.v1', outputSchemaId: 'value.output.v1', tools: [holdingTool], limits });
    const execution = mode.execute(program, { value: 1 }, { runId: 'run', executionId: 'docker-escape',
      scope: { principalId: 'alice', projectId: 'project' }, signal: new AbortController().signal });
    await admitted;
    try {
      const ids = await waitForContainerCount(1);
      const probe = [
        'set -eu',
        'test "$(id -u):$(id -g)" = "65532:65532"',
        'test ! -w /sandbox',
        '! touch /sandbox/mayura-escape-probe',
        'test ! -e /var/run/docker.sock',
        'test "$(ls -1 /sys/class/net)" = "lo"',
        `awk '/^CapEff:/ { if ($2 != "0000000000000000") exit 1; found=1 } END { if (!found) exit 1 }' /proc/self/status`,
        `awk '/^NoNewPrivs:/ { if ($2 != "1") exit 1; found=1 } END { if (!found) exit 1 }' /proc/self/status`,
        `awk '$2=="/" { if ($4 !~ /(^|,)ro(,|$)/) exit 1; found=1 } END { if (!found) exit 1 }' /proc/mounts`,
        `awk '$2=="/tmp" { if ($3 != "tmpfs" || $4 !~ /(^|,)noexec(,|$)/ || $4 !~ /(^|,)nosuid(,|$)/ || $4 !~ /(^|,)nodev(,|$)/) exit 1; found=1 } END { if (!found) exit 1 }' /proc/mounts`,
        `printf '#!/bin/sh\\nexit 0\\n' > /tmp/mayura-exec-probe`,
        'chmod 700 /tmp/mayura-exec-probe',
        'if /tmp/mayura-exec-probe 2>/dev/null; then exit 1; fi',
        'rm /tmp/mayura-exec-probe',
        'printf mayura-boundary-denied',
      ].join('; ');
      const checked = await executeFile(dockerPath!, ['exec', ids[0]!, '/bin/sh', '-c', probe],
        { windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1_024, env: Object.freeze({}) });
      expect(checked.stdout).toBe('mayura-boundary-denied');
    } finally { release(); }
    await expect(execution).resolves.toMatchObject({ status: 'succeeded', output: { value: 1 } });
  }, 30_000);

  it('force-removes the disposable container when the caller cancels', async () => {
    const controller = new AbortController();
    const mode = createCodeMode({ adapter: createDockerQuickJsSandboxAdapter({ dockerPath: dockerPath!, image: image!, provenance: provenance! }), allowTestAdapter: true, invokeTool: vi.fn() });
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
