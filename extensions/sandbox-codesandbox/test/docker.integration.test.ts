import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSandboxes, type Sandbox, type Sandboxes } from 'mayura/sandbox';
import { sandboxConformance } from 'mayura/sandbox/testing';
import { codeSandboxSandboxes } from '../src/index.js';
import { dockerClient, fakeSdk, startContainer } from './fake.js';

// The provider's commands and files, run for real: a stand-in for the CodeSandbox SDK whose sandbox is a local
// container, its commands shell lines as CodeSandbox runs them. Needs an image already on the machine, such as alpine:3.22.
const image = process.env['MAYURA_TEST_DOCKER_SANDBOX_IMAGE'];

describe.skipIf(image === undefined)('CodeSandbox sandboxes, their commands run in a local container', { timeout: 120_000 }, () => {
  let sandboxes: Sandboxes; let sandbox: Sandbox; let container: Awaited<ReturnType<typeof startContainer>>;
  beforeAll(async () => {
    container = await startContainer(image!);
    sandboxes = createSandboxes(codeSandboxSandboxes({ sdk: fakeSdk(() => dockerClient(container.name)).sdk }), { maxSandboxes: 1, maxLifetimeMs: 600_000, network: ['all'] });
    sandbox = await sandboxes.create({ lifetimeMs: 300_000, network: 'all' });
  }, 120_000);
  afterAll(async () => { await sandboxes?.close(); await container?.stop(); });

  for (const test of sandboxConformance) it(test.name, async () => { expect(await test.run({ sandbox })).toBe('passed'); });

  it('reads back only as much output as is kept, whatever the command wrote', async () => {
    const backend = await codeSandboxSandboxes({ sdk: fakeSdk(() => dockerClient(container.name)).sdk })
      .create({ lifetimeMs: 120_000, network: 'all', env: {}, ports: [], labels: {} }, { signal: AbortSignal.timeout(60_000) });
    const bounded = await backend.exec(['head', '-c', '200000', '/dev/zero'], { cwd: '/', env: {}, maxOutputBytes: 64, signal: AbortSignal.timeout(60_000) });
    expect(bounded.stdout.byteLength).toBe(64); expect(bounded.truncated).toBe(true);
    // A file larger than asked is refused from its size, before it is read.
    await backend.writeFile('/root/ten-bytes', new TextEncoder().encode('0123456789'), { signal: AbortSignal.timeout(60_000) });
    await expect(backend.readFile('/root/ten-bytes', { maxBytes: 4, signal: AbortSignal.timeout(60_000) })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it('cleans up the files a command used', async () => {
    await sandbox.exec(['cat'], { stdin: 'input' });
    await new Promise(resolve => setTimeout(resolve, 1_000));
    expect((await sandbox.listFiles('/tmp'))!.filter(entry => entry.name.startsWith('mayura-')).map(entry => entry.name)).toEqual([]);
  });
});
