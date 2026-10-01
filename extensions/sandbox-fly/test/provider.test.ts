import { describe, expect, it } from 'vitest';
import { MayuraError } from 'mayura';
import { createSandboxes } from 'mayura/sandbox';
import { flySandboxes } from '../src/index.js';

type Seen = { method: string; url: URL; headers: Headers; json?: Record<string, unknown> }[];
interface FakeOptions {
  readonly create?: () => Response;
  readonly waits?: number[];
  /** Answers an exec: Fly's JSON result, or a Response. */
  readonly exec?: (command: string[], stdin?: string) => { exit_code?: number; stdout?: string; stderr?: string } | Response;
  readonly destroy?: () => Response;
}
/** The Machines API, answering in its wire format. */
function fakeFly(options: FakeOptions = {}) {
  const seen: Seen = []; const execs: { command: string[]; stdin?: string; timeout?: number }[] = []; const waits = [...(options.waits ?? [200])];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); const url = new URL(request.url);
    const json = request.headers.get('content-type') === 'application/json' ? await request.json() as Record<string, unknown> : undefined;
    seen.push({ method: request.method, url, headers: request.headers, ...(json ? { json } : {}) });
    if (url.pathname === '/v1/apps/sandboxes/machines' && request.method === 'POST') return options.create?.() ?? Response.json({ id: '148e', instance_id: '01J', state: 'created' });
    if (url.pathname.endsWith('/wait')) return new Response(null, { status: waits.shift() ?? 200 });
    if (url.pathname.endsWith('/exec')) {
      const body = json as { command: string[]; stdin?: string; timeout?: number };
      execs.push(body);
      const answer = options.exec?.(body.command, body.stdin) ?? { exit_code: 0 };
      return answer instanceof Response ? answer : Response.json(answer);
    }
    if (request.method === 'DELETE') return options.destroy?.() ?? Response.json({ ok: true });
    return Response.json({});
  }) as typeof globalThis.fetch;
  return { fetch, seen, execs };
}
const limits = { maxSandboxes: 3, maxLifetimeMs: 600_000, network: ['all'] as const };
const config = (fake: ReturnType<typeof fakeFly>) => ({ token: 'fly_test_token_value', app: 'sandboxes', image: 'docker.io/library/alpine:3.22', fetch: fake.fetch });

describe('flySandboxes', () => {
  it('refuses configuration it cannot use', () => {
    const base = { token: 'fly_test_token_value', app: 'sandboxes', image: 'alpine:3.22' };
    expect(() => flySandboxes({ ...base, token: '' })).toThrow(/token/u);
    expect(() => flySandboxes({ ...base, app: 'Bad App' })).toThrow(/app/u);
    expect(() => flySandboxes({ ...base, image: 'has space' })).toThrow(/image/u);
    expect(() => flySandboxes({ ...base, region: 'virginia' })).toThrow(/region/u);
    expect(() => flySandboxes({ ...base, cpuKind: 'fast' as never })).toThrow(/cpuKind/u);
    expect(flySandboxes(base)).toMatchObject({ id: 'fly', workdir: '/workspace', features: { stdin: true, ports: false, desktop: false, network: ['all'] } });
  });

  it('cannot keep Machines off the network, so it creates them only with the network all, allowed and asked for', async () => {
    const fake = fakeFly();
    expect(await createSandboxes(flySandboxes(config(fake)), { ...limits, network: ['none'] }).create({ lifetimeMs: 60_000 }).catch(caught => caught))
      .toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('off the network') });
    expect(await createSandboxes(flySandboxes(config(fake)), { ...limits, network: ['none'] }).create({ lifetimeMs: 60_000, network: 'all' }).catch(caught => caught))
      .toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(fake.seen).toHaveLength(0);
  });

  it('creates a Machine that sleeps out its lifetime and destroys itself, waits for it, and makes the working directory', async () => {
    const fake = fakeFly({ waits: [408, 200] });
    const box = await createSandboxes(flySandboxes({ ...config(fake), region: 'iad', cpuKind: 'performance' }), limits)
      .create({ lifetimeMs: 90_500, network: 'all', env: { TOKEN: 'secret' }, labels: { run: 'r1' }, cpus: 2, memoryMiB: 2_048 });
    expect(box.id).toBe('148e');
    const created = fake.seen[0]!;
    expect(created.url.href).toBe('https://api.machines.dev/v1/apps/sandboxes/machines');
    expect(created.headers.get('authorization')).toBe('Bearer fly_test_token_value');
    expect(created.json).toEqual({ name: expect.stringMatching(/^mayura-[a-f0-9]{24}$/u), region: 'iad', config: {
      image: 'docker.io/library/alpine:3.22', env: { TOKEN: 'secret' }, metadata: { run: 'r1' }, guest: { cpu_kind: 'performance', cpus: 2, memory_mb: 2_048 },
      init: { exec: ['sleep', '96'] }, auto_destroy: true, restart: { policy: 'no' } } });
    expect(fake.seen.filter(item => item.url.pathname.endsWith('/wait')).map(item => [item.url.searchParams.get('state'), item.url.searchParams.get('timeout')])).toEqual([['started', '30'], ['started', '30']]);
    expect(fake.execs[0]).toMatchObject({ command: ['mkdir', '-p', '/workspace'], timeout: 55 });
  });

  it('keeps a FlyV1 token as it is', async () => {
    const fake = fakeFly();
    await createSandboxes(flySandboxes({ ...config(fake), token: 'FlyV1 fm2_abcdefgh' }), limits).create({ lifetimeMs: 60_000, network: 'all' });
    expect(fake.seen[0]!.headers.get('authorization')).toBe('FlyV1 fm2_abcdefgh');
  });

  it('refuses memory Fly cannot give, and maps refusals without Fly\'s text', async () => {
    const fake = fakeFly(); const sandboxes = createSandboxes(flySandboxes(config(fake)), limits);
    expect(await sandboxes.create({ lifetimeMs: 60_000, network: 'all', memoryMiB: 300 }).catch(caught => caught)).toMatchObject({ code: 'INVALID_INPUT' });
    for (const [status, reason] of [[401, 'authentication'], [404, 'rejected'], [422, 'rejected'], [429, 'rate_limited'], [500, 'unavailable']] as const) {
      const failing = fakeFly({ create: () => Response.json({ error: 'secret detail from fly' }, { status }) });
      const error = await createSandboxes(flySandboxes(config(failing)), limits).create({ lifetimeMs: 60_000, network: 'all' }).then(() => undefined, (caught: unknown) => caught as MayuraError);
      expect(error).toMatchObject({ reason }); expect(error!.message).not.toContain('secret');
    }
  });

  it('destroys a Machine that does not start, or whose working directory cannot be made', async () => {
    for (const fake of [fakeFly({ waits: [500] }), fakeFly({ exec: () => ({ exit_code: 1 }) })]) {
      expect(await createSandboxes(flySandboxes(config(fake)), limits).create({ lifetimeMs: 60_000, network: 'all' }).catch(caught => caught)).toBeInstanceOf(MayuraError);
      const destroyed = fake.seen.at(-1)!;
      expect([destroyed.method, destroyed.url.pathname, destroyed.url.searchParams.get('force')]).toEqual(['DELETE', '/v1/apps/sandboxes/machines/148e', 'true']);
    }
  });

  it('destroys the Machine on release; one already gone counts as released', async () => {
    let status = 200;
    const fake = fakeFly({ destroy: () => new Response(null, { status }) }); const sandboxes = createSandboxes(flySandboxes(config(fake)), limits);
    await (await sandboxes.create({ lifetimeMs: 60_000, network: 'all' })).release();
    expect(fake.seen.at(-1)).toMatchObject({ method: 'DELETE' });
    status = 404; await (await sandboxes.create({ lifetimeMs: 60_000, network: 'all' })).release();
    status = 500; expect(await (await sandboxes.create({ lifetimeMs: 60_000, network: 'all' })).release().catch(caught => caught)).toMatchObject({ reason: 'unavailable' });
  });

  it('fails a command when Fly\'s exec fails or answers what is not valid', async () => {
    let answer: { exit_code?: number; stdout?: string } | Response = { exit_code: 0 };
    const fake = fakeFly({ exec: command => command[0] === 'mkdir' ? { exit_code: 0 } : answer });
    const box = await createSandboxes(flySandboxes(config(fake)), limits).create({ lifetimeMs: 60_000, network: 'all' });
    answer = Response.json({ error: 'secret' }, { status: 500 });
    expect(await box.readFile('a').catch(caught => caught)).toMatchObject({ reason: 'unavailable' });
    answer = { exit_code: 0, stdout: 'not a size' };
    expect(await box.readFile('a').catch(caught => caught)).toMatchObject({ reason: 'rejected' });
    answer = { exit_code: 1.5 } as never;
    expect(await box.readFile('a').catch(caught => caught)).toMatchObject({ reason: 'invalid_response' });
  });
});
