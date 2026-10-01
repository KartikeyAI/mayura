import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commandSandboxBackend, createSandboxes, type CommandTransport, type Sandbox, type Sandboxes, type SandboxProvider } from '../src/index.js';
import { sandboxConformance } from '../src/testing.js';

// commandSandboxBackend's scripts, run for real in local containers through `docker exec`, with and without stdin.
// Needs an image already on the machine, such as alpine:3.22; never pulls one.
const image = process.env['MAYURA_TEST_DOCKER_SANDBOX_IMAGE'];
const docker = promisify(execFile);

function dockerTransport(container: string, stdin: boolean, maxCommandBytes?: number): CommandTransport & { longest: number } {
  const transport = {
    stdin, longest: 0, ...(maxCommandBytes === undefined ? {} : { maxCommandBytes }),
    run: (command: readonly string[], options: { readonly stdin?: string; readonly signal: AbortSignal }) => new Promise<{ exitCode: number; stdout: string }>((resolve, reject) => {
      expect(stdin || options.stdin === undefined).toBe(true);
      const length = command.reduce((total, item) => total + new TextEncoder().encode(item).byteLength + 1, 0);
      transport.longest = Math.max(transport.longest, length);
      if (maxCommandBytes !== undefined) expect(length).toBeLessThanOrEqual(maxCommandBytes);
      const child = spawn('docker', ['exec', ...(options.stdin === undefined ? [] : ['-i']), container, ...command], { windowsHide: true, signal: options.signal });
      const out: Buffer[] = [];
      child.stdout.on('data', chunk => out.push(chunk)); child.stderr.resume();
      child.on('error', reject);
      child.on('close', code => resolve({ exitCode: code ?? -1, stdout: Buffer.concat(out).toString('utf8') }));
      if (options.stdin !== undefined) child.stdin.end(options.stdin);
    }),
  };
  return transport;
}
function provider(stdin: boolean, maxCommandBytes?: number): SandboxProvider & { transports: ReturnType<typeof dockerTransport>[] } {
  const transports: ReturnType<typeof dockerTransport>[] = [];
  return {
    id: 'docker-commands', workdir: '/workspace', maxLifetimeMs: 3_600_000, transports,
    features: { stdin: true, ports: false, desktop: false, network: ['none'] },
    create: async spec => {
      const name = `mayura-command-test-${Math.random().toString(16).slice(2, 10)}`;
      await docker('docker', ['run', '-d', '--rm', '--pull', 'never', '--network', 'none', '--name', name, '--label', 'mayura.sandbox=command-test',
        ...Object.entries(spec.env).flatMap(([key, value]) => ['-e', `${key}=${value}`]), image!, 'sh', '-c', `mkdir -p /workspace && sleep ${Math.ceil(spec.lifetimeMs / 1_000)}`], { windowsHide: true });
      const transport = dockerTransport(name, stdin, maxCommandBytes); transports.push(transport);
      return commandSandboxBackend(name, transport, async () => { await docker('docker', ['rm', '-f', name], { windowsHide: true }).catch(() => undefined); });
    },
  };
}

describe.skipIf(image === undefined)('commandSandboxBackend with stdin', { timeout: 120_000 }, () => {
  let sandboxes: Sandboxes; let sandbox: Sandbox;
  beforeAll(async () => {
    sandboxes = createSandboxes(provider(true), { maxSandboxes: 1, maxLifetimeMs: 600_000 });
    sandbox = await sandboxes.create({ lifetimeMs: 300_000 });
  }, 120_000);
  afterAll(async () => { await sandboxes?.close(); });

  for (const test of sandboxConformance) it(test.name, async () => { expect(await test.run({ sandbox })).toBe('passed'); });

  it('runs each command in a session of its own, so it outlives the run that started it', async () => {
    // The session leader of the command's processes is the background shell setsid started.
    const result = await sandbox.exec(['sh', '-c', 'set -- $(cat /proc/self/stat); tr "\\000" " " < "/proc/$6/cmdline"']);
    expect(result.stdout).toContain('_mayura_in=$2');
  });

  it('cleans up the files a command used', async () => {
    await sandbox.exec(['cat'], { stdin: 'input', env: { CALL: 'x' } });
    await new Promise(resolve => setTimeout(resolve, 1_000));
    // Listed without running a command, which would have files of its own.
    expect((await sandbox.listFiles('/tmp'))!.filter(entry => entry.name.startsWith('mayura-'))).toEqual([]);
  });

  it('reads back only as much output as is kept, whatever the command wrote', async () => {
    const backend = await provider(true).create({ lifetimeMs: 120_000, network: 'none', env: {}, ports: [], labels: {} }, { signal: AbortSignal.timeout(60_000) });
    try {
      const result = await backend.exec(['head', '-c', '200000', '/dev/zero'], { cwd: '/', env: {}, maxOutputBytes: 64, signal: AbortSignal.timeout(60_000) });
      expect(result.stdout.byteLength).toBe(64); expect(result.truncated).toBe(true);
    } finally { await backend.release({ signal: AbortSignal.timeout(30_000) }); }
  });
});

// Without stdin every piece of a file is a command of its own, so this is slow for large files: the cases here keep
// to what shows the pieces fit together.
describe.skipIf(image === undefined)('commandSandboxBackend without stdin, files in the command line', { timeout: 120_000 }, () => {
  let sandboxes: Sandboxes; let sandbox: Sandbox; let source: ReturnType<typeof provider>;
  beforeAll(async () => {
    source = provider(false, 16_384);
    sandboxes = createSandboxes(source, { maxSandboxes: 1, maxLifetimeMs: 600_000 });
    sandbox = await sandboxes.create({ lifetimeMs: 300_000 });
  }, 120_000);
  afterAll(async () => { await sandboxes?.close(); });

  it('writes a file in pieces that fit the command line, and reads it back intact', async () => {
    const data = new Uint8Array(200_000).map((_, index) => (index * 7 + 3) % 256);
    await sandbox.writeFile('pieces/data.bin', data);
    const back = await sandbox.readFile('pieces/data.bin');
    expect(back?.byteLength).toBe(data.byteLength);
    expect(back!.every((byte, index) => byte === data[index])).toBe(true);
    expect(source.transports[0]!.longest).toBeLessThanOrEqual(16_384);
    // Pieces use most of the command line, leaving room for the script and the path.
    expect(source.transports[0]!.longest).toBeGreaterThan(8_000);
  });

  it('gives a command its input and environment through files', async () => {
    const result = await sandbox.exec(['sh', '-c', 'tr a-z A-Z; printf %s "$VALUE"'], { stdin: 'line one\n', env: { VALUE: "it's" } });
    expect(result).toMatchObject({ exitCode: 0, stdout: "LINE ONE\nit's" });
  });
});
