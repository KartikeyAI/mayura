import { describe, expect, it } from 'vitest';
import { MayuraError } from 'mayura';
import { createSandboxes } from 'mayura/sandbox';
import { railwaySandboxes, type RailwaySandboxLike } from '../src/index.js';
import { RailwayAuthError, RailwayGraphQLError } from './fake.js';

const base = { token: 'railway_test_token', environmentId: 'env-1234' };
const limits = { maxSandboxes: 3, maxLifetimeMs: 600_000, network: ['all'] as const };
/** A Railway sandbox whose commands all succeed, recording what is asked of it. */
function scripted(exitCode: number | null = 0) {
  const commands: { command: string; env?: Record<string, string> }[] = []; const kills: string[] = []; let destroyed = 0;
  const sandbox: RailwaySandboxLike = {
    id: 'sbx-1', domains: [{ port: 3000, domain: 'sbx-1-3000.up.railway.app' }],
    exec: (command, options = {}) => {
      commands.push({ command, ...(options.env ? { env: options.env } : {}) });
      return Object.assign(Promise.resolve({ exitCode }), { kill: async (signal?: string) => { kills.push(signal ?? 'TERM'); return true; } });
    },
    files: { read: async () => new Uint8Array(0), write: async () => undefined, list: async () => [], stat: async () => ({ size: 0, isDir: false }), remove: async () => undefined },
    destroy: async () => { destroyed++; },
  };
  const created: Record<string, unknown>[] = [];
  return { api: { create: async (options: Record<string, unknown>) => { created.push(options); return sandbox; } }, created, commands, kills, destroyed: () => destroyed };
}

describe('railwaySandboxes', () => {
  it('refuses configuration it cannot use', () => {
    expect(() => railwaySandboxes({ ...base, token: '' })).toThrow(/token/u);
    expect(() => railwaySandboxes({ ...base, environmentId: 'env/1' })).toThrow(/environmentId/u);
    expect(() => railwaySandboxes({ ...base, authType: 'oauth' as never })).toThrow(/authType/u);
    expect(railwaySandboxes(base)).toMatchObject({ id: 'railway', workdir: '/workspace', features: { stdin: true, ports: true, network: ['all'] } });
  });

  it('cannot keep sandboxes off the internet, so creates them only with the network all, allowed and asked for', async () => {
    const fake = scripted();
    expect(await createSandboxes(railwaySandboxes({ ...base, sandboxApi: fake.api }), { ...limits, network: ['none'] }).create({ lifetimeMs: 60_000 }).catch(caught => caught))
      .toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('off the network') });
    expect(fake.created).toHaveLength(0);
  });

  it('creates an isolated sandbox with explicit credentials, an idle timeout as a backstop, and its working directory', async () => {
    const fake = scripted();
    const box = await createSandboxes(railwaySandboxes({ ...base, authType: 'project-token', region: 'us-west2', sandboxApi: fake.api }), limits)
      .create({ lifetimeMs: 600_000, network: 'all', env: { TOKEN: 'secret' } });
    expect(box.id).toBe('sbx-1');
    expect(fake.created[0]).toEqual({ token: 'railway_test_token', authType: 'project-token', environmentId: 'env-1234', region: 'us-west2', env: { TOKEN: 'secret' },
      idleTimeoutMinutes: 10, networkIsolation: 'ISOLATED' });
    expect(fake.commands[0]!.command).toBe("'mkdir' '-p' '/workspace'");
  });

  it('joins the private network only to publish ports, and gives their URLs', async () => {
    const fake = scripted();
    const box = await createSandboxes(railwaySandboxes({ ...base, sandboxApi: fake.api }), limits).create({ lifetimeMs: 60_000, network: 'all', ports: [3_000] });
    expect(fake.created[0]).toMatchObject({ networkIsolation: 'PRIVATE', domains: [{ port: 3_000 }] });
    expect(await box.url(3_000)).toBe('https://sbx-1-3000.up.railway.app/');
  });

  it('refuses images and resources, and destroys a sandbox whose working directory cannot be made', async () => {
    const fake = scripted(1);
    const sandboxes = createSandboxes(railwaySandboxes({ ...base, sandboxApi: fake.api }), limits);
    expect(await sandboxes.create({ lifetimeMs: 60_000, network: 'all', image: 'node' }).catch(caught => caught)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await sandboxes.create({ lifetimeMs: 60_000, network: 'all' }).catch(caught => caught)).toMatchObject({ reason: 'rejected' });
    expect(fake.destroyed()).toBe(1);
  });

  it('maps Railway\'s errors to fixed ones, without its text', async () => {
    for (const [error, reason] of [[new RailwayAuthError('secret'), 'authentication'], [new RailwayGraphQLError(429), 'rate_limited'], [new RailwayGraphQLError(503), 'unavailable'],
      [new RailwayGraphQLError(400), 'rejected']] as const) {
      const caught = await createSandboxes(railwaySandboxes({ ...base, sandboxApi: { create: async () => { throw error; } } }), limits).create({ lifetimeMs: 60_000, network: 'all' })
        .then(() => undefined, (thrown: unknown) => thrown as MayuraError);
      expect(caught).toMatchObject({ reason }); expect(caught!.message).not.toContain('secret');
    }
  });

  it('runs a command through sh with its environment and a tag, its output in files', async () => {
    const fake = scripted();
    const box = await createSandboxes(railwaySandboxes({ ...base, sandboxApi: fake.api }), limits).create({ lifetimeMs: 60_000, network: 'all' });
    await box.exec(['npm', 'test'], { cwd: 'app', env: { CI: '1' } });
    const run = fake.commands[1]!;
    expect(run.command).toMatch(/^'sh' '-c' 'exec >"\$1" 2>"\$2"; .*' 'mayura' '\/tmp\/mayura-[a-f0-9]{24}\.out' '\/tmp\/mayura-[a-f0-9]{24}\.err' '-' '\/workspace\/app' 'npm' 'test'$/u);
    expect(run.env).toEqual({ CI: '1', MAYURA_SANDBOX_EXEC: expect.stringMatching(/^[a-f0-9]{24}$/u) });
  });

  it('stops a command at its timeout through Railway\'s kill and the tag', async () => {
    const fake = scripted();
    const never: RailwaySandboxLike['exec'] = (command, options = {}) => {
      fake.commands.push({ command, ...(options.env ? { env: options.env } : {}) });
      return Object.assign(command.includes('grep -qxF') || command.startsWith("'rm'") || command.startsWith("'mkdir'") ? Promise.resolve({ exitCode: 0 }) : new Promise<{ exitCode: number | null }>(() => undefined),
        { kill: async (signal?: string) => { fake.kills.push(signal ?? 'TERM'); return true; } });
    };
    const api = { create: async (options: Record<string, unknown>) => ({ ...(await fake.api.create(options)), exec: never }) };
    const box = await createSandboxes(railwaySandboxes({ ...base, sandboxApi: api }), limits).create({ lifetimeMs: 60_000, network: 'all' });
    const result = await box.exec(['sleep', '100'], { timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
    expect(fake.kills).toEqual(['KILL']);
    const tag = fake.commands[1]!.env!['MAYURA_SANDBOX_EXEC'];
    expect(fake.commands.some(item => item.command.includes('grep -qxF') && item.command.endsWith(`'${tag}'`))).toBe(true);
  });
});
