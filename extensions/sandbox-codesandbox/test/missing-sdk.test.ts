import { describe, expect, it, vi } from 'vitest';
import { createSandboxes } from 'mayura/sandbox';
import { codeSandboxSandboxes } from '../src/index.js';

// The SDK is an optional peer: a project that has not installed it gets told what to install.
vi.mock('@codesandbox/sdk', () => { throw new Error("Cannot find package '@codesandbox/sdk'"); });

describe('codeSandboxSandboxes without the SDK installed', () => {
  it('says which package to install', async () => {
    const sandboxes = createSandboxes(codeSandboxSandboxes({ apiKey: 'csb_test_key' }), { maxSandboxes: 1, maxLifetimeMs: 60_000, network: ['all'] });
    expect(await sandboxes.create({ lifetimeMs: 10_000, network: 'all' }).catch(caught => caught))
      .toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('npm install @codesandbox/sdk') });
  });
});
