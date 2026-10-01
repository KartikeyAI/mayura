import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSandboxes, type Sandbox, type Sandboxes } from 'mayura/sandbox';
import { sandboxConformance } from 'mayura/sandbox/testing';
import { appleContainerSandboxes } from '../src/index.js';

// The provider's command lines, run for real: Apple's `container` is a macOS tool, so a stand-in runs the same
// command lines through Docker (whose flags match). Needs an image already on the machine, such as alpine:3.22.
const image = process.env['MAYURA_TEST_DOCKER_SANDBOX_IMAGE'];
const cli = [process.execPath, fileURLToPath(new URL('./fake-container.mjs', import.meta.url))];

describe.skipIf(image === undefined)('Apple container sandboxes, their command lines run through Docker', { timeout: 120_000 }, () => {
  let sandboxes: Sandboxes; let sandbox: Sandbox; let directory: string;
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'mayura-apple-'));
    process.env['MAYURA_FAKE_CONTAINER_LOG'] = join(directory, 'calls.log');
    sandboxes = createSandboxes(appleContainerSandboxes({ image: image!, cli, hostOnlyNetwork: 'mayura-apple-test-offline', cpus: 1, memoryMiB: 256 }),
      { maxSandboxes: 2, maxLifetimeMs: 600_000 });
    sandbox = await sandboxes.create({ lifetimeMs: 300_000, env: { SANDBOX_SECRET: 'sandbox-secret-value' }, labels: { run: 'r1' } });
  }, 120_000);
  afterAll(async () => {
    await sandboxes?.close();
    const { execFile } = await import('node:child_process');
    await new Promise(resolve => execFile('docker', ['network', 'rm', 'mayura-apple-test-offline'], { windowsHide: true }, resolve));
    rmSync(directory, { recursive: true, force: true });
  });

  for (const test of sandboxConformance) it(test.name, async () => { expect(await test.run({ sandbox })).toBe('passed'); });

  it('runs the image only when it is here, on the host-only network, with the environment off every command line', async () => {
    expect((await sandbox.exec(['sh', '-c', 'printf %s "$SANDBOX_SECRET"'])).stdout).toBe('sandbox-secret-value');
    expect((await sandbox.exec(['sh', '-c', 'printf %s "$CALL"'], { env: { CALL: 'call-secret-value' } })).stdout).toBe('call-secret-value');
    const calls = readFileSync(process.env['MAYURA_FAKE_CONTAINER_LOG']!, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
    expect(calls[0]).toEqual(['image', 'inspect', image]);
    expect(calls.some(call => call[0] === 'network' && call[1] === 'create' && call.includes('--internal'))).toBe(true);
    const run = calls.find(call => call[0] === 'run')!;
    expect(run).toEqual(expect.arrayContaining(['--detach', '--rm', '--init', '--network', 'mayura-apple-test-offline', '--cpus', '1', '--memory', '256M', '--label', 'run=r1']));
    expect(JSON.stringify(calls)).not.toMatch(/secret-value/u);
    await expect(sandboxes.create({ lifetimeMs: 60_000, image: 'mayura-test/not-pulled:never' })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('refuses to write over a directory', async () => {
    await sandbox.exec(['mkdir', '-p', '/tmp/a-directory']);
    await expect(sandbox.writeFile('/tmp/a-directory', 'data')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('leaves no command environment behind', async () => {
    await sandbox.exec(['true'], { env: { CALL: 'value' } });
    expect((await sandbox.listFiles('/tmp/.mayura'))!.map(entry => entry.name)).toEqual(['env']);
  });

  it('deletes a sandbox whose setup failed', async () => {
    const provider = appleContainerSandboxes({ image: image!, cli, user: 'nobody', cpus: 1, memoryMiB: 256 });
    await expect(provider.create({ lifetimeMs: 120_000, network: 'all', env: {}, ports: [], labels: { setup: 'fails' } }, { signal: AbortSignal.timeout(60_000) }))
      .rejects.toMatchObject({ reason: 'rejected' });
    const { execFile } = await import('node:child_process');
    const listed = await new Promise<string>(resolve => execFile('docker', ['ps', '-aq', '--filter', 'label=setup=fails'], { windowsHide: true }, (_error, stdout) => resolve(stdout)));
    expect(listed.trim()).toBe('');
  });

  it('keeps a sandbox created without the network off the internet', async () => {
    const result = await sandbox.exec(['sh', '-c', 'wget -q -T 3 -O /dev/null http://1.1.1.1/ && echo reached || echo offline']);
    expect(result.stdout).toBe('offline\n');
  });

  it('reads back only as much output as is kept, and removes the container when released', async () => {
    const provider = appleContainerSandboxes({ image: image!, cli, cpus: 1, memoryMiB: 256 });
    const backend = await provider.create({ lifetimeMs: 120_000, network: 'all', env: {}, ports: [], labels: {} }, { signal: AbortSignal.timeout(60_000) });
    try {
      const result = await backend.exec(['head', '-c', '200000', '/dev/zero'], { cwd: '/', env: {}, maxOutputBytes: 64, signal: AbortSignal.timeout(60_000) });
      expect(result.stdout.byteLength).toBe(64); expect(result.truncated).toBe(true);
    } finally { await backend.release({ signal: AbortSignal.timeout(60_000) }); }
    const { execFile } = await import('node:child_process');
    const listed = await new Promise<string>(resolve => execFile('docker', ['ps', '-aq', '--filter', `name=^${backend.id}$`], { windowsHide: true }, (_error, stdout) => resolve(stdout)));
    expect(listed.trim()).toBe('');
    // Releasing again finds nothing to remove, which is not a failure.
    await backend.release({ signal: AbortSignal.timeout(60_000) });
  });
});
