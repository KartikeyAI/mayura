import { describe, expect, it } from 'vitest';
import { createSandboxes } from 'mayura/sandbox';
import { appleContainerSandboxes } from '../src/index.js';

describe('appleContainerSandboxes', () => {
  it('refuses configuration it cannot use', () => {
    expect(() => appleContainerSandboxes({ image: 'has space' })).toThrow(/image/u);
    expect(() => appleContainerSandboxes({ image: 'alpine', cli: [] })).toThrow(/cli/u);
    expect(() => appleContainerSandboxes({ image: 'alpine', hostOnlyNetwork: 'Bad Name' })).toThrow(/hostOnlyNetwork/u);
    expect(() => appleContainerSandboxes({ image: 'alpine', user: 'a b' })).toThrow(/user/u);
    expect(() => appleContainerSandboxes({ image: 'alpine', cpus: 0 })).toThrow(/cpus/u);
  });

  it('claims no network it cannot keep: none only on a host-only network you name', async () => {
    expect(appleContainerSandboxes({ image: 'alpine' }).features.network).toEqual(['all']);
    expect(appleContainerSandboxes({ image: 'alpine', hostOnlyNetwork: 'mayura-offline' }).features.network).toEqual(['none', 'all']);
    expect(await createSandboxes(appleContainerSandboxes({ image: 'alpine', cli: ['mayura-missing-container-cli'] }), { maxSandboxes: 1, maxLifetimeMs: 60_000 })
      .create({ lifetimeMs: 10_000 }).catch(caught => caught)).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('off the network') });
  });

  it('refuses ports and more than its CPUs or memory, before running anything', async () => {
    const sandboxes = createSandboxes(appleContainerSandboxes({ image: 'alpine', cli: ['mayura-missing-container-cli'], cpus: 2, memoryMiB: 512 }), { maxSandboxes: 1, maxLifetimeMs: 60_000, network: ['all'] });
    for (const options of [{ ports: [3_000] }, { cpus: 4 }, { memoryMiB: 1_024 }]) {
      expect(await sandboxes.create({ lifetimeMs: 10_000, network: 'all', ...options }).catch(caught => caught)).toMatchObject({ code: 'INVALID_INPUT' });
    }
  });

  it('reports a command line that is not there as a configuration mistake', async () => {
    expect(await createSandboxes(appleContainerSandboxes({ image: 'alpine', cli: ['mayura-missing-container-cli'] }), { maxSandboxes: 1, maxLifetimeMs: 60_000, network: ['all'] })
      .create({ lifetimeMs: 10_000, network: 'all' }).catch(caught => caught)).toMatchObject({ code: 'INVALID_CONFIG' });
  });
});
