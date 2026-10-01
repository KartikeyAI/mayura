import { describe, expect, it } from 'vitest';
import { MayuraError } from 'mayura';
import { createSandboxes } from 'mayura/sandbox';
import { cloudflareSandboxes } from '../src/index.js';
import { fakeBridge } from './fake.js';

const base = { bridgeUrl: 'https://sandbox-bridge.example.workers.dev', apiKey: 'bridge_test_key' };
const limits = { maxSandboxes: 3, maxLifetimeMs: 600_000, network: ['all'] as const };

describe('cloudflareSandboxes', () => {
  it('refuses configuration it cannot use', () => {
    expect(() => cloudflareSandboxes({ ...base, apiKey: '' })).toThrow(/apiKey/u);
    expect(() => cloudflareSandboxes({ ...base, bridgeUrl: 'http://bridge.example' })).toThrow(/bridgeUrl/u);
    expect(cloudflareSandboxes(base)).toMatchObject({ id: 'cloudflare', workdir: '/workspace', features: { stdin: true, ports: false, network: ['all'] } });
  });

  it('cannot keep sandboxes off the internet, so creates them only with the network all, allowed and asked for', async () => {
    const fake = fakeBridge();
    expect(await createSandboxes(cloudflareSandboxes({ ...base, fetch: fake.fetch }), { ...limits, network: ['none'] }).create({ lifetimeMs: 60_000 }).catch(caught => caught))
      .toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('off the network') });
    expect(fake.seen).toHaveLength(0);
  });

  it('creates a sandbox with the bridge\'s key and waits for a command to run in it', async () => {
    const fake = fakeBridge();
    const box = await createSandboxes(cloudflareSandboxes({ ...base, fetch: fake.fetch }), limits).create({ lifetimeMs: 60_000, network: 'all' });
    expect(box.id).toBe('sbx-cf-1');
    expect([fake.seen[0]!.method, fake.seen[0]!.url.href, fake.seen[0]!.headers.get('authorization')]).toEqual(['POST', 'https://sandbox-bridge.example.workers.dev/v1/sandbox', 'Bearer bridge_test_key']);
    expect(fake.execs[0]).toEqual({ argv: ['sh', '-c', 'true', 'mayura'], cwd: '/workspace' });
  });

  it('refuses image and resources, and maps refusals without the bridge\'s text', async () => {
    const fake = fakeBridge(); const sandboxes = createSandboxes(cloudflareSandboxes({ ...base, fetch: fake.fetch }), limits);
    expect(await sandboxes.create({ lifetimeMs: 60_000, network: 'all', cpus: 1 }).catch(caught => caught)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await createSandboxes(cloudflareSandboxes({ ...base, apiKey: 'wrong_key_value', fetch: fake.fetch }), limits).create({ lifetimeMs: 60_000, network: 'all' }).catch(caught => caught))
      .toMatchObject({ reason: 'authentication' });
    for (const [status, reason] of [[429, 'rate_limited'], [503, 'unavailable'], [404, 'rejected']] as const) {
      const failing = fakeBridge({ create: () => Response.json({ error: 'secret detail' }, { status }) });
      const caught = await createSandboxes(cloudflareSandboxes({ ...base, fetch: failing.fetch }), limits).create({ lifetimeMs: 60_000, network: 'all' }).then(() => undefined, (thrown: unknown) => thrown as MayuraError);
      expect(caught).toMatchObject({ reason }); expect(caught!.message).not.toContain('secret');
    }
  });

  it('gives a command its environment and a tag through a staged file, never in the command', async () => {
    const fake = fakeBridge({ run: argv => (argv[2]!.startsWith('cd') ? { stdout: 'out', stderr: 'err', exitCode: 3 } : { exitCode: 0 }) });
    const box = await createSandboxes(cloudflareSandboxes({ ...base, fetch: fake.fetch }), limits).create({ lifetimeMs: 60_000, network: 'all', env: { SANDBOX: 'yes' } });
    expect(await box.exec(['npm', 'test'], { cwd: 'app', env: { SECRET: "Sekr1t'value" } })).toMatchObject({ exitCode: 3, stdout: 'out', stderr: 'err' });
    const staged = [...fake.files.entries()].find(([path]) => path.startsWith('/workspace/.mayura-upload-'))!;
    expect(new TextDecoder().decode(staged[1])).toMatch(/^export SANDBOX='yes'\nexport SECRET='Sekr1t'\\''value'\nexport MAYURA_SANDBOX_EXEC='[a-f0-9]{24}'\n$/u);
    const run = fake.execs.find(item => item.argv[2]!.startsWith('cd'))!;
    expect(run.argv.slice(3)).toEqual(['mayura', '/workspace/app', expect.stringMatching(/^\/tmp\/mayura-[a-f0-9]{24}\.env$/u), '-', 'npm', 'test']);
    expect(JSON.stringify(fake.execs)).not.toContain('Sekr1t');
  });

  it('fails a command the bridge reports an error for, without its text', async () => {
    const fake = fakeBridge({ run: argv => (argv[2]!.startsWith('cd') ? { error: true } : { exitCode: 0 }) });
    const box = await createSandboxes(cloudflareSandboxes({ ...base, fetch: fake.fetch }), limits).create({ lifetimeMs: 60_000, network: 'all' });
    const caught = await box.exec(['x']).then(() => undefined, (thrown: unknown) => thrown as MayuraError);
    expect(caught).toMatchObject({ reason: 'rejected' }); expect(caught!.message).not.toContain('secret');
  });

  it('stops a command at its timeout by killing everything carrying its tag', async () => {
    const fake = fakeBridge({ run: argv => (argv[2]!.startsWith('cd') ? { stdout: 'partial', hang: true } : { exitCode: 0 }) });
    const box = await createSandboxes(cloudflareSandboxes({ ...base, fetch: fake.fetch }), limits).create({ lifetimeMs: 60_000, network: 'all' });
    const result = await box.exec(['sleep', '100'], { timeoutMs: 100 });
    expect(result.timedOut).toBe(true);
    const tag = new TextDecoder().decode([...fake.files.values()][0]).match(/MAYURA_SANDBOX_EXEC='([a-f0-9]{24})'/u)![1];
    expect(fake.execs.some(item => item.argv[2]!.includes('grep -qxF') && item.argv.at(-1) === tag)).toBe(true);
  });

  it('refuses replies it cannot trust, and deletes a sandbox that never became ready', async () => {
    const badId = fakeBridge({ create: () => Response.json({ id: '../sbx' }) });
    expect(await createSandboxes(cloudflareSandboxes({ ...base, fetch: badId.fetch }), limits).create({ lifetimeMs: 60_000, network: 'all' }).catch(caught => caught)).toMatchObject({ reason: 'invalid_response' });
    expect(badId.seen).toHaveLength(1);
    const notReady = fakeBridge({ run: () => ({ exitCode: 1 }) });
    expect(await createSandboxes(cloudflareSandboxes({ ...base, fetch: notReady.fetch }), limits).create({ lifetimeMs: 60_000, network: 'all' }).catch(caught => caught)).toMatchObject({ reason: 'rejected' });
    expect([notReady.seen.at(-1)!.method, notReady.seen.at(-1)!.url.pathname]).toEqual(['DELETE', '/v1/sandbox/sbx-cf-1']);
    // An exit code that is not one, output that is not base64, and an event that never ends (the stream stays open).
    for (const [raw, hang] of [['event: exit\ndata: {"exit_code":"0"}\n\n', false], ['event: stdout\ndata: not*base64\n\n', false], ['event: stdout\ndata: '.padEnd(17 * 1_048_576, 'A'), true]] as const) {
      const fake = fakeBridge({ run: argv => (argv[2]!.startsWith('cd') ? { raw, hang } : { exitCode: 0 }) });
      const box = await createSandboxes(cloudflareSandboxes({ ...base, fetch: fake.fetch }), limits).create({ lifetimeMs: 60_000, network: 'all' });
      expect(await box.exec(['x'], { timeoutMs: 10_000 }).catch(caught => caught)).toMatchObject({ reason: 'invalid_response' });
    }
  });

  it('deletes the sandbox on release; one already gone counts as released', async () => {
    const fake = fakeBridge();
    const box = await createSandboxes(cloudflareSandboxes({ ...base, fetch: fake.fetch }), limits).create({ lifetimeMs: 60_000, network: 'all' });
    await box.release();
    expect([fake.seen.at(-1)!.method, fake.seen.at(-1)!.url.pathname]).toEqual(['DELETE', '/v1/sandbox/sbx-cf-1']);
    const goneFetch = (async (input: RequestInfo | URL, init?: RequestInit) => (init?.method === 'DELETE' ? Response.json({ error: 'not found' }, { status: 404 }) : fake.fetch(input, init))) as typeof fetch;
    await createSandboxes(cloudflareSandboxes({ ...base, fetch: goneFetch }), limits).create({ lifetimeMs: 60_000, network: 'all' }).then(gone => gone.release());
    // A sandbox the bridge could not delete may still be running: that is reported, so releasing can be tried again.
    const failingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => (init?.method === 'DELETE' ? Response.json({ error: 'busy' }, { status: 503 }) : fake.fetch(input, init))) as typeof fetch;
    const stuck = await createSandboxes(cloudflareSandboxes({ ...base, fetch: failingFetch }), limits).create({ lifetimeMs: 60_000, network: 'all' });
    expect(await stuck.release().catch(caught => caught)).toMatchObject({ reason: 'unavailable' });
  });
});
