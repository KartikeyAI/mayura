import { describe, expect, it, vi } from 'vitest';
import { createSandboxes } from 'mayura/sandbox';
import { railwaySandboxes } from '../src/index.js';

// The SDK is an optional peer: a project that has not installed it gets told what to install.
vi.mock('railway', () => { throw new Error("Cannot find package 'railway'"); });

describe('railwaySandboxes without the SDK installed', () => {
  it('says which package to install', async () => {
    const sandboxes = createSandboxes(railwaySandboxes({ token: 'railway_test_token', environmentId: 'env-1' }), { maxSandboxes: 1, maxLifetimeMs: 600_000, network: ['all'] });
    expect(await sandboxes.create({ lifetimeMs: 120_000, network: 'all' }).catch(caught => caught))
      .toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('npm install railway') });
  });
});
