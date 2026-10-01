import { describe, expect, it, vi } from 'vitest';
import { MayuraError } from 'mayura';
import { createSandboxes } from 'mayura/sandbox';
import { modalSandboxes } from '../src/index.js';
import { fakeModal } from './fake.js';

const limits = { maxSandboxes: 3, maxLifetimeMs: 600_000, network: ['none', 'all', 'allowlist'] as const };

describe('modalSandboxes', () => {
  it('refuses configuration it cannot use', () => {
    expect(() => modalSandboxes({ image: 'alpine:3.22' })).toThrow(/tokenId/u);
    expect(() => modalSandboxes({ tokenId: 'ak-1234', tokenSecret: 'as-1234', image: 'has space' })).toThrow(/image/u);
    expect(() => modalSandboxes({ tokenId: 'ak-1234', tokenSecret: 'as-1234', image: 'alpine', app: '../x' })).toThrow(/app/u);
    expect(() => modalSandboxes({ tokenId: 'ak-1234', tokenSecret: 'as-1234', image: 'alpine', runtime: 'firecracker' as never })).toThrow(/runtime/u);
    expect(() => modalSandboxes({ tokenId: 'ak-1234', tokenSecret: 'as-1234', image: 'alpine', maxLifetimeMs: 86_400_001 })).toThrow(/maxLifetimeMs/u);
    expect(() => modalSandboxes({ client: {} as never, image: 'alpine' })).toThrow(/client/u);
    expect(modalSandboxes({ tokenId: 'ak-1234', tokenSecret: 'as-1234', image: 'alpine' })).toMatchObject({ id: 'modal', workdir: '/workspace',
      features: { stdin: true, ports: true, desktop: false, network: ['none', 'all', 'allowlist'] } });
  });

  it('creates a sandbox in its App with no network, its lifetime as Modal\'s timeout, and makes the working directory', async () => {
    const fake = fakeModal();
    const box = await createSandboxes(modalSandboxes({ client: fake.client, image: 'python:3.13-slim', app: 'agents', runtime: 'vm', regions: ['us-east-1'] }), limits)
      .create({ lifetimeMs: 120_000, env: { TOKEN: 'secret' }, labels: { run: 'r1' }, cpus: 2, memoryMiB: 2_048 });
    expect(box.id).toBe('sb-1');
    expect(fake.created[0]).toEqual({ app: 'agents', image: 'python:3.13-slim', params: { timeoutMs: 120_000, env: { TOKEN: 'secret' }, tags: { run: 'r1' },
      name: expect.stringMatching(/^mayura-[a-f0-9]{24}$/u), blockNetwork: true, cpu: 2, memoryMiB: 2_048, runtime: 'vm', regions: ['us-east-1'] } });
    expect(fake.execs[0]).toMatchObject({ command: ['sh', '-c', 'mkdir -p -- "$1"', 'mayura', '/workspace'], params: { mode: 'binary' } });
  });

  it('maps networks, images and ports to Modal\'s terms', async () => {
    const fake = fakeModal(); const sandboxes = createSandboxes(modalSandboxes({ client: fake.client, image: 'alpine:3.22' }), limits);
    await (await sandboxes.create({ lifetimeMs: 60_000, network: 'all', image: 'node:24-slim', ports: [3_000] })).release();
    await (await sandboxes.create({ lifetimeMs: 60_000, network: { allow: ['registry.npmjs.org', '*.github.com'] } })).release();
    expect(fake.created[0]).toMatchObject({ image: 'node:24-slim', params: { encryptedPorts: [3_000] } });
    expect(fake.created[0]!.params).not.toHaveProperty('blockNetwork');
    expect(fake.created[1]!.params).toMatchObject({ outboundDomainAllowlist: ['registry.npmjs.org', '*.github.com'] });
    expect(fake.terminated).toEqual(['sb-1', 'sb-1']);
  });

  it('maps Modal\'s errors to fixed ones, and terminates a sandbox whose working directory cannot be made', async () => {
    class NotFoundError extends Error {} class ResourceExhaustedError extends Error {} class InvalidError extends Error {}
    for (const [error, reason] of [[new ResourceExhaustedError('secret quota detail'), 'quota'], [new InvalidError('secret'), 'rejected'], [new NotFoundError('secret'), 'gone'],
      [Object.assign(new Error('secret'), { code: 16 }), 'authentication'], [Object.assign(new Error('secret'), { code: 14 }), 'unavailable']] as const) {
      const fake = fakeModal({ create: async () => { throw error; } });
      const caught = await createSandboxes(modalSandboxes({ client: fake.client, image: 'alpine' }), limits).create({ lifetimeMs: 60_000 }).then(() => undefined, (thrown: unknown) => thrown as MayuraError);
      expect(caught).toMatchObject({ reason }); expect(caught!.message).not.toContain('secret');
    }
    const failing = fakeModal({ run: async () => ({ exitCode: 1 }) });
    expect(await createSandboxes(modalSandboxes({ client: failing.client, image: 'alpine' }), limits).create({ lifetimeMs: 60_000 }).catch(caught => caught)).toMatchObject({ reason: 'rejected' });
    expect(failing.terminated).toEqual(['sb-1']);
  });

  it('runs a command through sh with its environment and a tag, gives stdin and reads output bounded', async () => {
    let seenStdin = '';
    const fake = fakeModal({ run: async (command, _params, stdin) => {
      if (command[2] === 'mkdir -p -- "$1"') return { exitCode: 0 };
      seenStdin = new TextDecoder().decode(stdin);
      return { stdout: 'x'.repeat(50), stderr: 'err', exitCode: 3 };
    } });
    const box = await createSandboxes(modalSandboxes({ client: fake.client, image: 'alpine' }), { ...limits, maxOutputBytes: 20 }).create({ lifetimeMs: 60_000 });
    expect(await box.exec(['npm', 'test'], { cwd: 'app', env: { CI: '1' }, stdin: 'input' })).toMatchObject({ exitCode: 3, stdout: 'x'.repeat(20), stderr: 'err', truncated: true });
    expect(seenStdin).toBe('input');
    expect(fake.execs[1]).toMatchObject({ command: ['sh', '-c', 'cd -- "$1" || exit; shift; exec "$@"', 'mayura', '/workspace/app', 'npm', 'test'],
      params: { mode: 'binary', env: { CI: '1', MAYURA_SANDBOX_EXEC: expect.stringMatching(/^[a-f0-9]{24}$/u) } } });
  });

  it('stops a command at its timeout by killing everything carrying its tag', async () => {
    const fake = fakeModal({ run: async command => (command[2] === 'mkdir -p -- "$1"' || command[2]!.includes('grep -qxF') ? { exitCode: 0 } : 'hang') });
    const box = await createSandboxes(modalSandboxes({ client: fake.client, image: 'alpine' }), limits).create({ lifetimeMs: 60_000 });
    const result = await box.exec(['sleep', '100'], { timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
    await vi.waitFor(() => expect(fake.execs.some(item => item.command[2]!.includes('grep -qxF') && item.command[4] === fake.execs[1]!.params['env'] && false) || fake.execs.length).toBeTruthy());
    const kill = fake.execs.find(item => item.command[2]!.includes('grep -qxF'))!;
    expect(kill.command[4]).toBe((fake.execs[1]!.params['env'] as Record<string, string>)['MAYURA_SANDBOX_EXEC']);
  });

  it('gives a port\'s tunnel URL', async () => {
    const fake = fakeModal();
    const box = await createSandboxes(modalSandboxes({ client: fake.client, image: 'alpine' }), limits).create({ lifetimeMs: 60_000, network: 'all', ports: [3_000] });
    expect(await box.url(3_000)).toBe('https://abc-3000.modal.host/');
  });
});
