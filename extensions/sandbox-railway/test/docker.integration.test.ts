import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSandboxes, type Sandbox, type Sandboxes } from 'mayura/sandbox';
import { sandboxConformance } from 'mayura/sandbox/testing';
import { railwaySandboxes } from '../src/index.js';
import { dockerRailwaySandbox, startContainer } from './fake.js';

// The provider's commands and files, run for real: a stand-in for Railway's SDK whose sandbox is a local container.
// Needs an image already on the machine, such as alpine:3.22; never pulls one.
const image = process.env['MAYURA_TEST_DOCKER_SANDBOX_IMAGE'];
const config = { token: 'railway_test_token', environmentId: 'env-1234' };

describe.skipIf(image === undefined)('Railway sandboxes, their commands run in a local container', { timeout: 120_000 }, () => {
  let sandboxes: Sandboxes; let sandbox: Sandbox; let container: Awaited<ReturnType<typeof startContainer>>;
  beforeAll(async () => {
    container = await startContainer(image!);
    sandboxes = createSandboxes(railwaySandboxes({ ...config, sandboxApi: { create: async () => dockerRailwaySandbox(container.name) } }), { maxSandboxes: 1, maxLifetimeMs: 600_000, network: ['all'] });
    sandbox = await sandboxes.create({ lifetimeMs: 300_000, network: 'all' });
  }, 120_000);
  afterAll(async () => { await sandboxes?.close(); await container?.stop(); });

  for (const test of sandboxConformance) it(test.name, async () => { expect(await test.run({ sandbox })).toBe('passed'); });

  it('cleans up the files a command used', async () => {
    await sandbox.exec(['cat'], { stdin: 'input' });
    await new Promise(resolve => setTimeout(resolve, 1_000));
    // Listed without running a command, which would have files of its own.
    expect((await sandbox.listFiles('/tmp'))!.filter(entry => entry.name.startsWith('mayura-'))).toEqual([]);
  });

  it('reads back only as much output as is kept, whatever the command wrote', async () => {
    const backend = await railwaySandboxes({ ...config, sandboxApi: { create: async () => dockerRailwaySandbox(container.name) } })
      .create({ lifetimeMs: 120_000, network: 'all', env: {}, ports: [], labels: {} }, { signal: AbortSignal.timeout(60_000) });
    const result = await backend.exec(['head', '-c', '200000', '/dev/zero'], { cwd: '/', env: {}, maxOutputBytes: 64, signal: AbortSignal.timeout(60_000) });
    expect(result.stdout.byteLength).toBe(64); expect(result.truncated).toBe(true);
  });
});
