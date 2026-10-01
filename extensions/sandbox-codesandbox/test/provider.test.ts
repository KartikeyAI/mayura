import { describe, expect, it } from 'vitest';
import { MayuraError } from 'mayura';
import { createSandboxes } from 'mayura/sandbox';
import { codeSandboxSandboxes, type CodeSandboxClientLike } from '../src/index.js';
import { ApiError, CommandError, fakeSdk } from './fake.js';

const limits = { maxSandboxes: 3, maxLifetimeMs: 600_000, network: ['all'] as const };
/** A client whose commands all exit with `code`, recording command lines. */
function scripted(code = 0, hang = false) {
  const lines: { line: string; env?: Record<string, string> }[] = []; let kills = 0;
  const finish = () => (code === 0 ? Promise.resolve('') : Promise.reject(new CommandError(code)));
  const client: CodeSandboxClientLike = {
    commands: {
      run: async (line, options) => { lines.push({ line, ...(options?.env ? { env: options.env } : {}) }); return line.includes('grep -qxF') || line.startsWith("'rm'") ? '' : finish(); },
      runBackground: async (line, options) => { lines.push({ line, ...(options?.env ? { env: options.env } : {}) });
        return { waitUntilComplete: () => (hang ? new Promise<string>(() => undefined) : finish()), kill: async () => { kills++; } }; },
    },
    fs: { readFile: async () => new Uint8Array(0), writeFile: async () => undefined, mkdir: async () => undefined, readdir: async () => [], stat: async () => ({ type: 'file', size: 0 }), remove: async () => undefined },
    dispose: () => undefined,
  };
  return { client, lines, kills: () => kills };
}

describe('codeSandboxSandboxes', () => {
  it('refuses configuration it cannot use', () => {
    expect(() => codeSandboxSandboxes({})).toThrow(/apiKey/u);
    expect(() => codeSandboxSandboxes({ apiKey: 'csb_test_key', template: '../x' })).toThrow(/template/u);
    expect(() => codeSandboxSandboxes({ apiKey: 'csb_test_key', vmTier: 'Huge' as never })).toThrow(/vmTier/u);
    expect(() => codeSandboxSandboxes({ sdk: {} as never })).toThrow(/sdk/u);
    expect(codeSandboxSandboxes({ apiKey: 'csb_test_key' })).toMatchObject({ id: 'codesandbox', workdir: '/project/sandbox', features: { stdin: true, ports: true, network: ['all'] } });
  });

  it('cannot keep sandboxes off the internet, so creates them only with the network all, allowed and asked for', async () => {
    const fake = fakeSdk(() => scripted().client);
    expect(await createSandboxes(codeSandboxSandboxes({ sdk: fake.sdk }), { ...limits, network: ['none'] }).create({ lifetimeMs: 60_000 }).catch(caught => caught))
      .toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('off the network') });
    expect(fake.created).toHaveLength(0);
  });

  it('creates a private sandbox from its template, hibernating if idle past its lifetime', async () => {
    const fake = fakeSdk(() => scripted().client);
    const box = await createSandboxes(codeSandboxSandboxes({ sdk: fake.sdk, template: 'tmpl1', vmTier: 'Small' }), limits)
      .create({ lifetimeMs: 120_000, network: 'all', labels: { run: 'r1' } });
    expect(box.id).toBe('csb-1');
    expect(fake.created[0]).toEqual({ id: 'tmpl1', privacy: 'private', title: expect.stringMatching(/^mayura-[a-f0-9]{16}$/u), tags: ['run:r1'], vmTier: 'Small', hibernationTimeoutSeconds: 120 });
  });

  it('refuses resources and too many labels, deletes a sandbox it cannot set up, and maps errors without CodeSandbox\'s text', async () => {
    const fake = fakeSdk(() => { throw new ApiError(500); });
    const sandboxes = createSandboxes(codeSandboxSandboxes({ sdk: fake.sdk }), limits);
    expect(await sandboxes.create({ lifetimeMs: 60_000, network: 'all', cpus: 2 }).catch(caught => caught)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await sandboxes.create({ lifetimeMs: 60_000, network: 'all', labels: Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`l${index}`, 'x'])) }).catch(caught => caught)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await sandboxes.create({ lifetimeMs: 60_000, network: 'all' }).catch(caught => caught)).toMatchObject({ reason: 'unavailable' });
    expect(fake.deleted).toEqual(['csb-1']);
    for (const [status, reason] of [[401, 'authentication'], [402, 'quota'], [429, 'rate_limited'], [400, 'rejected']] as const) {
      const failing = fakeSdk(() => scripted().client, { create: async () => { throw new ApiError(status); } });
      const caught = await createSandboxes(codeSandboxSandboxes({ sdk: failing.sdk }), limits).create({ lifetimeMs: 60_000, network: 'all' }).then(() => undefined, (thrown: unknown) => thrown as MayuraError);
      expect(caught).toMatchObject({ reason }); expect(caught!.message).not.toContain('secret');
    }
  });

  it('runs a command as a quoted shell line with its environment and a tag, reading the exit code from CommandError', async () => {
    const fake = scripted(3); const sdk = fakeSdk(() => fake.client);
    const box = await createSandboxes(codeSandboxSandboxes({ sdk: sdk.sdk }), limits).create({ lifetimeMs: 60_000, network: 'all', env: { SANDBOX: 'yes' } });
    expect((await box.exec(['npm', 'test', "it's"], { cwd: 'app', env: { CI: '1' } })).exitCode).toBe(3);
    const started = fake.lines.find(item => item.line.includes('exec >'))!;
    expect(started.line).toMatch(/^'sh' '-c' 'exec >"\$1" 2>"\$2"; .*' 'mayura' '\/tmp\/mayura-[a-f0-9]{24}\.out' '\/tmp\/mayura-[a-f0-9]{24}\.err' '-' '\/project\/sandbox\/app' 'npm' 'test' 'it'\\''s'$/u);
    expect(started.env).toEqual({ SANDBOX: 'yes', CI: '1', MAYURA_SANDBOX_EXEC: expect.stringMatching(/^[a-f0-9]{24}$/u) });
  });

  it('stops a command at its timeout by killing its shell and everything carrying its tag', async () => {
    const fake = scripted(0, true); const sdk = fakeSdk(() => fake.client);
    const box = await createSandboxes(codeSandboxSandboxes({ sdk: sdk.sdk }), limits).create({ lifetimeMs: 60_000, network: 'all' });
    expect((await box.exec(['sleep', '100'], { timeoutMs: 100 })).timedOut).toBe(true);
    expect(fake.kills()).toBe(1);
    const tag = fake.lines.find(item => item.line.includes('exec >'))!.env!['MAYURA_SANDBOX_EXEC'];
    expect(fake.lines.some(item => item.line.includes('grep -qxF') && item.line.endsWith(`'${tag}'`))).toBe(true);
  });

  it('gives a port\'s URL with a host token that lasts as long as the sandbox', async () => {
    const fake = fakeSdk(() => scripted().client);
    const box = await createSandboxes(codeSandboxSandboxes({ sdk: fake.sdk }), limits).create({ lifetimeMs: 600_000, network: 'all', ports: [3_000] });
    expect(await box.url(3_000)).toBe('https://csb-1-3000.csb.app/?preview_token=host-token');
    const expires = (fake.tokens[0] as { expiresAt: Date }).expiresAt.getTime();
    expect(expires - Date.now()).toBeGreaterThan(590_000);
  });
});
