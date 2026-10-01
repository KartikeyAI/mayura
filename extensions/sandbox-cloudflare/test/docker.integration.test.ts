import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSandboxes, type Sandbox, type Sandboxes } from 'mayura/sandbox';
import { sandboxConformance } from 'mayura/sandbox/testing';
import { cloudflareSandboxes } from '../src/index.js';
import { fakeBridge, startContainer } from './fake.js';

// The provider's commands and files, run for real: a stand-in for the sandbox bridge whose sandbox is a local container,
// exec streamed as the bridge's base64 events. Needs an image already on the machine, such as alpine:3.22.
const image = process.env['MAYURA_TEST_DOCKER_SANDBOX_IMAGE'];
const base = { bridgeUrl: 'https://sandbox-bridge.example.workers.dev', apiKey: 'bridge_test_key' };

describe.skipIf(image === undefined)('Cloudflare sandboxes, their commands run in a local container', { timeout: 120_000 }, () => {
  let sandboxes: Sandboxes; let sandbox: Sandbox; let container: Awaited<ReturnType<typeof startContainer>>;
  beforeAll(async () => {
    container = await startContainer(image!);
    sandboxes = createSandboxes(cloudflareSandboxes({ ...base, fetch: fakeBridge({ container: container.name }).fetch }), { maxSandboxes: 1, maxLifetimeMs: 600_000, network: ['all'] });
    sandbox = await sandboxes.create({ lifetimeMs: 300_000, network: 'all', env: { SANDBOX_VALUE: "it's the sandbox's" } });
  }, 120_000);
  afterAll(async () => { await sandboxes?.close(); await container?.stop(); });

  for (const test of sandboxConformance) it(test.name, async () => { expect(await test.run({ sandbox })).toBe('passed'); });

  it('gives commands the sandbox\'s environment, and writes outside /workspace by moving a staged upload', async () => {
    expect((await sandbox.exec(['sh', '-c', 'printf %s "$SANDBOX_VALUE"'])).stdout).toBe("it's the sandbox's");
    await sandbox.writeFile('/tmp/elsewhere/data.txt', 'placed');
    expect(new TextDecoder().decode(await sandbox.readFile('/tmp/elsewhere/data.txt'))).toBe('placed');
    expect((await sandbox.listFiles('/workspace'))!.filter(entry => entry.name.startsWith('.mayura-upload-'))).toEqual([]);
  });

  it('refuses to write over a directory, and keeps a command\'s environment file from the command', async () => {
    await sandbox.exec(['mkdir', '-p', '/tmp/a-directory']);
    await expect(sandbox.writeFile('/tmp/a-directory', 'data')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await sandbox.listFiles('/tmp/a-directory'))!).toEqual([]);
    const seen = await sandbox.exec(['sh', '-c', 'ls -a /tmp'], { env: { CALL: 'value' } });
    expect(seen.stdout.split('\n').filter(name => name.endsWith('.env'))).toEqual([]);
  });

  it('cleans up the files a command used', async () => {
    await sandbox.exec(['cat'], { stdin: 'input', env: { CALL: 'value' } });
    await new Promise(resolve => setTimeout(resolve, 1_000));
    expect((await sandbox.listFiles('/tmp'))!.filter(entry => entry.name.startsWith('mayura-')).map(entry => entry.name)).toEqual([]);
  });

  it('reads back only as much output as is kept, whatever the command wrote', async () => {
    const backend = await cloudflareSandboxes({ ...base, fetch: fakeBridge({ container: container.name }).fetch })
      .create({ lifetimeMs: 120_000, network: 'all', env: {}, ports: [], labels: {} }, { signal: AbortSignal.timeout(60_000) });
    const result = await backend.exec(['head', '-c', '200000', '/dev/zero'], { cwd: '/', env: {}, maxOutputBytes: 64, signal: AbortSignal.timeout(60_000) });
    expect(result.stdout.byteLength).toBe(64); expect(result.truncated).toBe(true);
  });
});
