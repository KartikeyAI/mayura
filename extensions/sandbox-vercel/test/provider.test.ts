import { describe, expect, it, vi } from 'vitest';
import { MayuraError } from 'mayura';
import { createSandboxes } from 'mayura/sandbox';
import { vercelSandboxes } from '../src/index.js';

type Seen = { method: string; url: URL; headers: Headers; json?: Record<string, unknown>; bytes: Uint8Array }[];
interface Cmd { command: string; args: string[]; env: Record<string, string> }
interface FakeOptions {
  readonly create?: () => Response;
  /** Answers a command: NDJSON lines (each an object), or a Response. `hang` keeps the stream open. */
  readonly cmd?: (request: Cmd) => { lines: readonly object[]; hang?: boolean } | Response;
  readonly read?: (path: string) => Response;
  readonly write?: (body: Uint8Array, headers: Headers) => Response;
  readonly other?: (method: string, url: URL) => Response | undefined;
}
const ndjson = (lines: readonly object[], hang = false) => new ReadableStream<Uint8Array>({
  start(controller) {
    // Split mid-line, as a network would.
    const text = new TextEncoder().encode(lines.map(line => `${JSON.stringify(line)}\n`).join(''));
    for (let index = 0; index < text.byteLength; index += 11) controller.enqueue(text.slice(index, index + 11));
    if (!hang) controller.close();
  },
});
const finished = (stdout = '', exitCode = 0, stderr = '') => ({ lines: [
  { command: { id: 'cmd_1', exitCode: null, args: [], cwd: '/', name: 'sh', sessionId: 'sbx_1', startedAt: 1 } },
  ...(stdout ? [{ stream: 'stdout', data: stdout }] : []), ...(stderr ? [{ stream: 'stderr', data: stderr }] : []),
  { command: { id: 'cmd_1', exitCode, args: [], cwd: '/', name: 'sh', sessionId: 'sbx_1', startedAt: 1 } }] });
/** Vercel's sandbox API, answering in its wire formats. */
function fakeVercel(options: FakeOptions = {}) {
  const seen: Seen = []; const cmds: Cmd[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); const url = new URL(request.url); const bytes = new Uint8Array(await request.arrayBuffer());
    const json = request.headers.get('content-type') === 'application/json' && bytes.byteLength ? JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown> : undefined;
    seen.push({ method: request.method, url, headers: request.headers, bytes, ...(json ? { json } : {}) });
    const other = options.other?.(request.method, url);
    if (other) return other;
    if (url.pathname === '/v2/sandboxes' && request.method === 'POST') return options.create?.() ?? Response.json({
      routes: [{ port: 3000, subdomain: 'sb-3000', url: 'https://sb-3000.vercel.run' }], sandbox: { name: json?.['name'] }, session: { id: 'sbx_1' } });
    if (url.pathname.endsWith('/cmd')) {
      const request = json as unknown as Cmd; cmds.push(request);
      const answer: { lines: readonly object[]; hang?: boolean } | Response = options.cmd?.(request) ?? finished();
      if (answer instanceof Response) return answer;
      return new Response(ndjson(answer.lines, answer.hang), { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    }
    if (url.pathname.endsWith('/fs/read')) return options.read?.((json as { path: string }).path) ?? new Response(null, { status: 404 });
    if (url.pathname.endsWith('/fs/write')) return options.write?.(bytes, request.headers) ?? Response.json({});
    return Response.json({});
  }) as typeof globalThis.fetch;
  return { fetch, seen, cmds };
}
const limits = { maxSandboxes: 4, maxLifetimeMs: 600_000, network: ['none', 'all', 'allowlist'] as const };
const sandboxesFor = (fake: ReturnType<typeof fakeVercel>, extra: Partial<Parameters<typeof vercelSandboxes>[0]> = {}) =>
  createSandboxes(vercelSandboxes({ token: 'vercel_test_token', fetch: fake.fetch, teamId: 'team_1', projectId: 'prj_1', ...extra }), limits);
/** The one file in a gzipped tarball: its path (from the PAX header) and bytes. */
async function untar(gz: Uint8Array): Promise<{ path: string; data: Uint8Array; ustarName: string; checksumOk: boolean }> {
  const tar = new Uint8Array(await new Response(new Blob([gz as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  const text = (from: number, length: number) => new TextDecoder().decode(tar.subarray(from, from + length)).replace(/\0.*$/su, '');
  const checksum = (offset: number) => { const block = tar.slice(offset, offset + 512); block.fill(32, 148, 156); return block.reduce((sum, byte) => sum + byte, 0) === parseInt(text(offset + 148, 8), 8); };
  expect(text(156, 1)).toBe('x'); expect(text(257, 6)).toBe('ustar');
  const paxSize = parseInt(text(124, 12), 8); const pax = new TextDecoder().decode(tar.subarray(512, 512 + paxSize));
  const record = /^(\d+) path=(.*)\n$/su.exec(pax)!;
  expect(Number(record[1])).toBe(new TextEncoder().encode(pax).byteLength);
  const header = 512 + Math.ceil(paxSize / 512) * 512;
  expect(text(header + 156, 1)).toBe('0');
  const size = parseInt(text(header + 124, 12), 8);
  expect(tar.byteLength).toBe(header + 512 + Math.ceil(size / 512) * 512 + 1_024);
  return { path: record[2]!, data: tar.slice(header + 512, header + 512 + size), ustarName: text(header, 100), checksumOk: checksum(0) && checksum(header) };
}

describe('vercelSandboxes', () => {
  it('refuses configuration it cannot use', () => {
    expect(() => vercelSandboxes({ token: '' })).toThrow(/token/u);
    expect(() => vercelSandboxes({ token: 'vercel_test_token', teamId: 'team/1' })).toThrow(/teamId/u);
    expect(() => vercelSandboxes({ token: 'vercel_test_token', runtime: 'node18' as never })).toThrow(/runtime/u);
    expect(() => vercelSandboxes({ token: 'vercel_test_token', maxLifetimeMs: 86_400_001 })).toThrow(/maxLifetimeMs/u);
    expect(vercelSandboxes({ token: 'vercel_test_token' })).toMatchObject({ id: 'vercel', workdir: '/vercel/sandbox', maxLifetimeMs: 2_700_000,
      features: { stdin: false, ports: true, desktop: false, network: ['none', 'all', 'allowlist'] } });
  });

  it('creates a sandbox that cannot reach the network, does not persist, and lives for its lifetime', async () => {
    const fake = fakeVercel();
    const box = await sandboxesFor(fake).create({ lifetimeMs: 120_000, env: { TOKEN: 'secret' }, labels: { run: 'r1' } });
    expect(box.id).toMatch(/^mayura-[a-f0-9]{24}$/u);
    const created = fake.seen[0]!;
    expect(created.url.href).toBe('https://api.vercel.com/v2/sandboxes?teamId=team_1');
    expect(created.headers.get('authorization')).toBe('Bearer vercel_test_token');
    expect(created.json).toEqual({ name: box.id, runtime: 'node24', projectId: 'prj_1', timeout: 120_000, ports: [], env: { TOKEN: 'secret' },
      networkPolicy: { mode: 'deny-all' }, persistent: false, tags: { run: 'r1' } });
  });

  it('maps networks, images, resources and ports to Vercel\'s terms, and refuses what Vercel cannot do', async () => {
    const fake = fakeVercel(); const sandboxes = sandboxesFor(fake);
    await (await sandboxes.create({ lifetimeMs: 60_000, network: 'all', image: 'python3.13', cpus: 4 })).release();
    expect(fake.seen.find(item => item.method === 'POST' && item.url.pathname === '/v2/sandboxes')!.json).toMatchObject({
      networkPolicy: { mode: 'allow-all' }, runtime: 'python3.13', resources: { vcpus: 4, memory: 8_192 } });
    await (await sandboxes.create({ lifetimeMs: 60_000, network: { allow: ['registry.npmjs.org'] }, image: 'my-team/my-image:1', memoryMiB: 4_096, ports: [3_000] })).release();
    const second = fake.seen.filter(item => item.method === 'POST' && item.url.pathname === '/v2/sandboxes')[1]!.json!;
    expect(second).toMatchObject({ networkPolicy: { mode: 'custom', allowedDomains: ['registry.npmjs.org'] }, image: 'my-team/my-image:1', resources: { vcpus: 2, memory: 4_096 }, ports: [3_000] });
    expect(second).not.toHaveProperty('runtime');
    for (const bad of [{ ports: [80] }, { cpus: 3 }, { cpus: 2, memoryMiB: 8_192 }, { labels: { a: '1', b: '1', c: '1', d: '1', e: '1', f: '1' } }]) {
      expect(await sandboxes.create({ lifetimeMs: 60_000, network: 'all', ...bad }).catch(caught => caught)).toMatchObject({ code: 'INVALID_INPUT' });
    }
  });

  it('maps a refused creation to a fixed error, without Vercel\'s text', async () => {
    for (const [status, reason] of [[401, 'authentication'], [402, 'quota'], [429, 'rate_limited'], [404, 'rejected'], [500, 'unavailable']] as const) {
      const fake = fakeVercel({ create: () => Response.json({ error: { message: 'secret detail from vercel' } }, { status }) });
      const error = await sandboxesFor(fake).create({ lifetimeMs: 60_000 }).then(() => undefined, (caught: unknown) => caught as MayuraError);
      expect(error).toMatchObject({ reason }); expect(error!.message).not.toContain('secret');
    }
    const odd = fakeVercel({ create: () => Response.json({ session: { id: '../x' } }) });
    expect(await sandboxesFor(odd).create({ lifetimeMs: 60_000 }).catch(caught => caught)).toMatchObject({ reason: 'invalid_response' });
  });

  it('runs a command through sh in its directory, with its environment and a tag, reading the NDJSON stream', async () => {
    const fake = fakeVercel({ cmd: () => finished('out é', 3, 'err') });
    const box = await sandboxesFor(fake).create({ lifetimeMs: 60_000 });
    expect(await box.exec(['npm', 'test', '--', 'a b'], { cwd: 'app', env: { CI: '1' } })).toMatchObject({ exitCode: 3, timedOut: false, stdout: 'out é', stderr: 'err' });
    const call = fake.seen.find(item => item.url.pathname.endsWith('/cmd'))!;
    expect(call.url.pathname).toBe('/v2/sandboxes/sessions/sbx_1/cmd');
    expect(call.json).toMatchObject({ command: '/bin/sh', args: ['-c', 'cd -- "$1" || exit; shift; exec "$@"', 'mayura', '/vercel/sandbox/app', 'npm', 'test', '--', 'a b'],
      env: { CI: '1', MAYURA_SANDBOX_EXEC: expect.stringMatching(/^[a-f0-9]{24}$/u) }, wait: true, logs: true });
    expect(await box.exec(['x'], { stdin: 'input' }).catch(caught => caught)).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('fails a command whose stream reports an error, or ends before the command does', async () => {
    let lines: object[] = [{ command: { id: 'cmd_1', exitCode: null } }, { stream: 'error', data: { code: 'sandbox_stream_closed', message: 'Sandbox stream was closed' } }];
    const fake = fakeVercel({ cmd: () => ({ lines }) });
    const box = await sandboxesFor(fake).create({ lifetimeMs: 60_000 });
    expect(await box.exec(['x']).catch(caught => caught)).toMatchObject({ reason: 'gone' });
    lines = [{ command: { id: 'cmd_1', exitCode: null } }, { stream: 'error', data: { code: 'other', message: 'secret' } }];
    expect(await box.exec(['x']).catch(caught => caught)).toMatchObject({ reason: 'rejected' });
    lines = [{ command: { id: 'cmd_1', exitCode: null } }, { stream: 'stdout', data: 'partial' }];
    expect(await box.exec(['x']).catch(caught => caught)).toMatchObject({ reason: 'invalid_response' });
  });

  it('stops a command at its timeout: SIGKILL through the API, and to everything carrying its tag', async () => {
    const kills: unknown[] = [];
    const fake = fakeVercel({
      cmd: request => request.args[1]!.includes('grep -qxF') ? finished() : { lines: [{ command: { id: 'cmd_slow', exitCode: null } }, { stream: 'stdout', data: 'partial' }], hang: true },
      other: (_method, url) => { if (url.pathname.endsWith('/kill')) { kills.push(url.pathname); return Response.json({ command: { id: 'cmd_slow', exitCode: 137 } }); } return undefined; },
    });
    const box = await sandboxesFor(fake).create({ lifetimeMs: 60_000 });
    const result = await box.exec(['sleep', '100'], { timeoutMs: 100 });
    expect(result).toMatchObject({ timedOut: true, stdout: 'partial' }); expect(result.exitCode).toBeUndefined();
    expect(kills).toEqual(['/v2/sandboxes/sessions/sbx_1/cmd/cmd_slow/kill']);
    expect(fake.seen.find(item => item.url.pathname.endsWith('/kill'))!.json).toEqual({ signal: 9 });
    expect(fake.cmds[1]!.args.at(-1)).toBe(fake.cmds[0]!.env['MAYURA_SANDBOX_EXEC']);
  });

  it('cancels with the caller the same way', async () => {
    const kills: unknown[] = [];
    const fake = fakeVercel({
      cmd: request => request.args[1]!.includes('grep -qxF') ? finished() : { lines: [{ command: { id: 'cmd_slow', exitCode: null } }], hang: true },
      other: (_method, url) => { if (url.pathname.endsWith('/kill')) { kills.push(url.pathname); return Response.json({}); } return undefined; },
    });
    const box = await sandboxesFor(fake).create({ lifetimeMs: 60_000 });
    const controller = new AbortController();
    const pending = box.exec(['sleep', '100'], { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    expect(await pending.catch(caught => caught)).toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(kills).toHaveLength(1));
  });

  it('reads files, refusing missing, non-files and too large', async () => {
    const fake = fakeVercel({ read: path => path === '/vercel/sandbox/a.bin' ? new Response(new Uint8Array([0, 255, 7])) : path === '/vercel/sandbox/dir' ? new Response('', { status: 400 })
      : path === '/vercel/sandbox/big' ? new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(100)); controller.close(); } })) : new Response('', { status: 404 }) });
    const box = await sandboxesFor(fake).create({ lifetimeMs: 60_000 });
    expect([...(await box.readFile('a.bin'))!]).toEqual([0, 255, 7]);
    expect(await box.readFile('none')).toBeUndefined();
    expect(await box.readFile('dir').catch(caught => caught)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await box.readFile('big', { maxBytes: 10 }).catch(caught => caught)).toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it('writes a file as a gzipped tarball extracted at /, with its exact path', async () => {
    const written: { path: string; data: Uint8Array; ustarName: string; checksumOk: boolean }[] = []; const cwd: (string | null)[] = [];
    const fake = fakeVercel({ write: (body, headers) => { void untar(body).then(file => written.push(file)); cwd.push(headers.get('x-cwd')); expect(headers.get('content-type')).toBe('application/gzip'); return Response.json({}); } });
    const box = await sandboxesFor(fake).create({ lifetimeMs: 60_000 });
    await box.writeFile('dir/a.txt', 'hello');
    const long = `${'deep/'.repeat(40)}ü file.bin`;
    await box.writeFile(long, new Uint8Array(1_000).map((_, index) => index % 256));
    await vi.waitFor(() => expect(written).toHaveLength(2));
    expect(written[0]).toMatchObject({ path: 'vercel/sandbox/dir/a.txt', ustarName: 'vercel/sandbox/dir/a.txt', checksumOk: true });
    expect(new TextDecoder().decode(written[0]!.data)).toBe('hello');
    expect(written[1]).toMatchObject({ path: `vercel/sandbox/${long}`, ustarName: 'mayura-file', checksumOk: true });
    expect([...written[1]!.data]).toEqual([...new Uint8Array(1_000).map((_, index) => index % 256)]);
    expect(cwd).toEqual(['/', '/']);
  });

  it('lists and removes files with the shared scripts', async () => {
    let answer = finished(['d', '0', '1759312800', 'src', 'f', '5', '1759312801', 'a.txt', ''].join('\u0000'));
    const fake = fakeVercel({ cmd: () => answer });
    const box = await sandboxesFor(fake).create({ lifetimeMs: 60_000 });
    expect(await box.listFiles()).toEqual([{ name: 'a.txt', type: 'file', size: 5, modified: 1_759_312_801_000 }, { name: 'src', type: 'directory', size: 0, modified: 1_759_312_800_000 }]);
    expect(fake.cmds[0]!.args.slice(-2)).toEqual(['/vercel/sandbox', '1000']);
    answer = finished('', 3); expect(await box.listFiles('none')).toBeUndefined();
    answer = finished('', 4); expect(await box.listFiles('file').catch(caught => caught)).toMatchObject({ code: 'INVALID_INPUT' });
    answer = finished('', 7); expect(await box.removeFile('full').catch(caught => caught)).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('not empty') });
    answer = finished(); await box.removeFile('full', { recursive: true });
    expect(fake.cmds.at(-1)!.args.slice(-2)).toEqual(['/vercel/sandbox/full', '1']);
  });

  it('gives the routes\' URLs for ports, and treats a session Vercel ended as gone', async () => {
    const fake = fakeVercel({ cmd: () => new Response(JSON.stringify({ error: { code: 'gone' } }), { status: 410 }) });
    const box = await sandboxesFor(fake).create({ lifetimeMs: 60_000, network: 'all', ports: [3_000] });
    expect(await box.url(3_000)).toBe('https://sb-3000.vercel.run/');
    expect(await box.exec(['x']).catch(caught => caught)).toMatchObject({ reason: 'gone' });
  });

  it('stops the session and deletes the sandbox on release; gone counts as released', async () => {
    let stopStatus = 200; let deleteStatus = 200;
    const fake = fakeVercel({ other: (method, url) => method === 'DELETE' ? new Response(null, { status: deleteStatus }) : url.pathname.endsWith('/stop') ? new Response(null, { status: stopStatus }) : undefined });
    const sandboxes = sandboxesFor(fake);
    const box = await sandboxes.create({ lifetimeMs: 60_000 });
    await box.release();
    const [stop, del] = fake.seen.slice(-2);
    expect([stop!.method, stop!.url.pathname]).toEqual(['POST', '/v2/sandboxes/sessions/sbx_1/stop']);
    expect([del!.method, del!.url.pathname, del!.url.searchParams.get('projectId'), del!.url.searchParams.get('deleteOrphanSnapshots'), del!.url.searchParams.get('teamId')])
      .toEqual(['DELETE', `/v2/sandboxes/${box.id}`, 'prj_1', 'true', 'team_1']);
    stopStatus = 410; deleteStatus = 404; await (await sandboxes.create({ lifetimeMs: 60_000 })).release();
    // A failed stop, or a failed delete, fails the release (and createSandboxes keeps counting the sandbox).
    stopStatus = 500; deleteStatus = 204;
    expect(await (await sandboxes.create({ lifetimeMs: 60_000 })).release().catch(caught => caught)).toMatchObject({ reason: 'unavailable' });
    stopStatus = 200; deleteStatus = 503;
    expect(await (await sandboxes.create({ lifetimeMs: 60_000 })).release().catch(caught => caught)).toMatchObject({ reason: 'unavailable' });
  });
});
