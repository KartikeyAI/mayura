import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSandboxes, type Sandbox, type Sandboxes } from 'mayura/sandbox';
import { sandboxConformance } from 'mayura/sandbox/testing';
import { modalSandboxes } from '../src/index.js';
import { fakeModal, startContainer } from './fake.js';

// The provider's commands, run for real: a ModalClient stand-in whose exec is `docker exec` in a local container,
// with binary streams as Modal's are. Needs an image already on the machine, such as alpine:3.22; never pulls one.
const image = process.env['MAYURA_TEST_DOCKER_SANDBOX_IMAGE'];

describe.skipIf(image === undefined)('Modal sandboxes, their commands run in a local container', { timeout: 120_000 }, () => {
  let sandboxes: Sandboxes; let sandbox: Sandbox; let container: Awaited<ReturnType<typeof startContainer>>;
  beforeAll(async () => {
    container = await startContainer(image!);
    sandboxes = createSandboxes(modalSandboxes({ client: fakeModal({ container: container.name }).client, image: image! }), { maxSandboxes: 1, maxLifetimeMs: 600_000 });
    sandbox = await sandboxes.create({ lifetimeMs: 300_000 });
  }, 120_000);
  afterAll(async () => { await sandboxes?.close(); await container?.stop(); });

  for (const test of sandboxConformance) it(test.name, async () => { expect(await test.run({ sandbox })).toBe('passed'); });

  it('reads back only as much output as is kept, whatever the command wrote', async () => {
    const backend = await modalSandboxes({ client: fakeModal({ container: container.name }).client, image: image! })
      .create({ lifetimeMs: 120_000, network: 'none', env: {}, ports: [], labels: {} }, { signal: AbortSignal.timeout(60_000) });
    const result = await backend.exec(['head', '-c', '200000', '/dev/zero'], { cwd: '/', env: {}, maxOutputBytes: 64, signal: AbortSignal.timeout(60_000) });
    expect(result.stdout.byteLength).toBe(64); expect(result.truncated).toBe(true);
  });
});
