import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawnSync: spawn }));
const argv = process.argv;
const exitCode = process.exitCode;
let trust: unknown[];
const publisher = {
  type: 'github', repository: 'KartikeyAI/mayura', file: 'release.yml', environment: 'release',
  permissions: ['createPackage'],
};

beforeEach(() => {
  vi.resetModules();
  trust = [];
  process.exitCode = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
  spawn.mockReset().mockImplementation((_node: string, args: string[]) => {
    if (args.includes('--version')) return { status: 0, stdout: '11.21.1' };
    if (args.includes('github')) trust = [publisher];
    return { status: 0, stdout: trust.map((config) => JSON.stringify(config, null, 2)).join('\n\n') };
  });
});

afterEach(() => {
  process.argv = argv;
  process.exitCode = exitCode;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function run(...args: string[]) {
  process.argv = [process.execPath, 'npm-trusted-publishing.mjs', '--npm-cli', import.meta.filename,
    '--package', '@mayurajs/provider-openai', ...args];
  // @ts-expect-error Release scripts are JavaScript modules without declarations.
  await import('../../../scripts/npm-trusted-publishing.mjs');
}

describe('npm trusted publishing setup', () => {
  it('uses scoped package names and defaults to a read-only plan', async () => {
    await run();
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('%40mayurajs%2Fprovider-openai/latest'), expect.anything());
    expect(spawn.mock.calls.some((call) => call[1].includes('github'))).toBe(false);
  });

  it('creates only the requested publisher and reads it back after creation', async () => {
    await run('--apply');
    const commands = spawn.mock.calls.map((call) => call[1] as string[]);
    expect(commands.find((args) => args.includes('github'))).toEqual(expect.arrayContaining([
      '@mayurajs/provider-openai', '--repository', 'KartikeyAI/mayura', '--file', 'release.yml',
      '--environment', 'release', '--allow-publish', '--yes',
    ]));
    expect(commands.filter((args) => args.includes('list'))).toHaveLength(2);
    expect(commands.some((args) => args.includes('publish') || args.includes('revoke'))).toBe(false);
  });

  it('preserves conflicting trust configurations', async () => {
    trust = [{ ...publisher, environment: 'production' }];
    await run('--apply');
    expect(process.exitCode).toBe(1);
    expect(spawn.mock.calls.some((call) => call[1].includes('github'))).toBe(false);
  });

  it('accepts matching trust among multiple JSON configurations without changing them', async () => {
    trust = [{ ...publisher, environment: 'other' }, publisher];
    await run('--apply');
    expect(process.exitCode).toBe(0);
    expect(spawn.mock.calls.some((call) => call[1].includes('github'))).toBe(false);
  });

  it('reports missing public packages without creating or publishing them', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 404 } as Response);
    await run('--apply');
    expect(process.exitCode).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1); // version check only
  });

  it('fails closed on registry errors instead of treating them as missing packages', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 503 } as Response);
    await run('--apply');
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Registry lookup failed (503)'));
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('stops on denied npm access without printing captured verification data', async () => {
    spawn.mockImplementation((_node: string, args: string[]) => args.includes('--version')
      ? { status: 0, stdout: '11.21.1' }
      : { status: 1, stderr: 'EOTP private-verification-challenge' });
    await run('--apply');
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.not.stringContaining('private-verification-challenge'));
    expect(spawn.mock.calls.some((call) => call[1].includes('github'))).toBe(false);
  });

  it('does not count an unverified creation as success', async () => {
    spawn.mockImplementation((_node: string, args: string[]) => ({
      status: 0, stdout: args.includes('--version') ? '11.21.1' : '',
    }));
    await run('--apply');
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('could not be verified'));
  });
});
