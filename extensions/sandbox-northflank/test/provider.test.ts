import { describe, expect, it } from 'vitest';
import { MayuraError } from 'mayura';
import { createSandboxes } from 'mayura/sandbox';
import { northflankSandboxes } from '../src/index.js';
import { fakeNorthflank, NorthflankApiCallError } from './fake.js';

const base = { projectId: 'sandboxes', image: 'ubuntu:24.04' };
const limits = { maxSandboxes: 3, maxLifetimeMs: 600_000, network: ['all'] as const };

describe('northflankSandboxes', () => {
  it('refuses configuration it cannot use', () => {
    expect(() => northflankSandboxes({ ...base })).toThrow(/token/u);
    expect(() => northflankSandboxes({ ...base, token: 'nf_test_token', projectId: 'Bad Id' })).toThrow(/projectId/u);
    expect(() => northflankSandboxes({ ...base, token: 'nf_test_token', image: 'has space' })).toThrow(/image/u);
    expect(() => northflankSandboxes({ ...base, client: {} as never })).toThrow(/client/u);
    expect(northflankSandboxes({ ...base, token: 'nf_test_token' })).toMatchObject({ id: 'northflank', workdir: '/workspace', features: { stdin: true, ports: false, network: ['all'] } });
  });

  it('cannot keep sandboxes off the internet, so creates them only with the network all, allowed and asked for', async () => {
    const fake = fakeNorthflank();
    expect(await createSandboxes(northflankSandboxes({ ...base, client: fake.client }), { ...limits, network: ['none'] }).create({ lifetimeMs: 60_000 }).catch(caught => caught))
      .toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('off the network') });
    expect(fake.created).toHaveLength(0);
  });

  it('creates a sleeping service on its plan, waits until a command runs in it, and makes the working directory', async () => {
    let attempts = 0;
    const fake = fakeNorthflank({ run: command => (command[2] === 'mkdir -p -- "$1"' && ++attempts < 3 ? 'unavailable' : { exitCode: 0 }) });
    const box = await createSandboxes(northflankSandboxes({ ...base, client: fake.client, teamId: 'acme', deploymentPlan: 'nf-compute-200' }), limits)
      .create({ lifetimeMs: 120_000, network: 'all', env: { TOKEN: 'secret' }, labels: { run: 'r1' } });
    expect(box.id).toBe('mayura-svc-1');
    expect(fake.created[0]).toEqual({ parameters: { projectId: 'sandboxes', teamId: 'acme' }, data: {
      name: expect.stringMatching(/^mayura-[a-f0-9]{16}$/u), tags: ['run-r1'], billing: { deploymentPlan: 'nf-compute-200' },
      deployment: { instances: 1, external: { imagePath: 'ubuntu:24.04' }, docker: { configType: 'customEntrypointCustomCommand', customEntrypoint: '/bin/sh', customCommand: "-c 'sleep infinity'" } },
      runtimeEnvironment: { TOKEN: 'secret' } } });
    expect(attempts).toBe(3);
    expect(fake.commands[0]).toEqual(['sh', '-c', 'mkdir -p -- "$1"', 'mayura', '/workspace']);
  }, 30_000);

  it('refuses resources, deletes a service whose working directory cannot be made, and maps errors without Northflank\'s text', async () => {
    const failing = fakeNorthflank({ run: () => ({ exitCode: 1 }) });
    const sandboxes = createSandboxes(northflankSandboxes({ ...base, client: failing.client }), limits);
    expect(await sandboxes.create({ lifetimeMs: 60_000, network: 'all', cpus: 2 }).catch(caught => caught)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await sandboxes.create({ lifetimeMs: 60_000, network: 'all' }).catch(caught => caught)).toMatchObject({ reason: 'rejected' });
    expect(failing.deleted).toEqual([{ projectId: 'sandboxes', serviceId: 'mayura-svc-1' }]);
    for (const [status, reason] of [[401, 'authentication'], [402, 'quota'], [429, 'rate_limited'], [500, 'unavailable'], [409, 'rejected']] as const) {
      const fake = fakeNorthflank({ create: async () => { throw new NorthflankApiCallError(status); } });
      const caught = await createSandboxes(northflankSandboxes({ ...base, client: fake.client }), limits).create({ lifetimeMs: 60_000, network: 'all' })
        .then(() => undefined, (thrown: unknown) => thrown as MayuraError);
      expect(caught).toMatchObject({ reason }); expect(caught!.message).not.toContain('secret');
    }
  });

  it('runs a command in its directory with its environment and a tag set by env, and gives it stdin', async () => {
    let stdin = '';
    const fake = fakeNorthflank({ run: (command, input) => { if (!command[2]!.startsWith('cd')) return { exitCode: 0 }; stdin = new TextDecoder().decode(input); return { stdout: 'out', exitCode: 3 }; } });
    const box = await createSandboxes(northflankSandboxes({ ...base, client: fake.client }), limits).create({ lifetimeMs: 60_000, network: 'all' });
    expect(await box.exec(['npm', 'test'], { cwd: 'app', env: { CI: '1' }, stdin: 'input' })).toMatchObject({ exitCode: 3, stdout: 'out' });
    expect(stdin).toBe('input');
    expect(fake.commands[1]).toEqual(['sh', '-c', 'cd -- "$1" || exit; shift; exec env "$@"', 'mayura', '/workspace/app', 'CI=1', expect.stringMatching(/^MAYURA_SANDBOX_EXEC=[a-f0-9]{24}$/u), 'npm', 'test']);
  });

  it('stops a command at its timeout by killing everything carrying its tag', async () => {
    const fake = fakeNorthflank({ run: command => (command[2]!.startsWith('cd') ? 'hang' : { exitCode: 0 }) });
    const box = await createSandboxes(northflankSandboxes({ ...base, client: fake.client }), limits).create({ lifetimeMs: 60_000, network: 'all' });
    expect((await box.exec(['sleep', '100'], { timeoutMs: 100 })).timedOut).toBe(true);
    const tag = fake.commands[1]!.find(item => item.startsWith('MAYURA_SANDBOX_EXEC='))!.split('=')[1];
    expect(fake.commands.find(command => command[2]!.includes('grep -qxF'))!.at(-1)).toBe(tag);
  });

  it('deletes the service on release; one already gone counts as released', async () => {
    let fail: number | undefined;
    const fake = fakeNorthflank({ delete: async () => { if (fail) throw new NorthflankApiCallError(fail); } });
    const sandboxes = createSandboxes(northflankSandboxes({ ...base, client: fake.client }), limits);
    await (await sandboxes.create({ lifetimeMs: 60_000, network: 'all' })).release();
    expect(fake.deleted).toHaveLength(1);
    fail = 404; await (await sandboxes.create({ lifetimeMs: 60_000, network: 'all' })).release();
    fail = 500; expect(await (await sandboxes.create({ lifetimeMs: 60_000, network: 'all' })).release().catch(caught => caught)).toMatchObject({ reason: 'unavailable' });
  });
});
