import { describe, expect, it, vi } from 'vitest';
import { MayuraError } from 'mayura';
import { createSandboxes } from 'mayura/sandbox';
import { e2bSandboxes } from '../src/index.js';

const encoder = new TextEncoder();
const base64 = (text: string) => btoa(text);
type Seen = { method: string; url: URL; headers: Headers; json?: Record<string, unknown>; bytes: Uint8Array }[];
type Event = Record<string, unknown>;
/** A Connect server stream: each event its own envelope, split across chunks where `split` says. */
function stream(events: readonly Event[], options: { readonly split?: boolean; readonly hang?: boolean; readonly endError?: string } = {}): ReadableStream<Uint8Array> {
  const frames: Uint8Array[] = events.map(event => envelope(0, { event }));
  if (!options.hang) frames.push(envelope(2, options.endError ? { error: { code: options.endError, message: 'secret detail from e2b' } } : {}));
  const joined = new Uint8Array(frames.reduce((sum, frame) => sum + frame.byteLength, 0)); let offset = 0;
  for (const frame of frames) { joined.set(frame, offset); offset += frame.byteLength; }
  return new ReadableStream({
    start(controller) {
      if (options.split) for (let index = 0; index < joined.byteLength; index += 7) controller.enqueue(joined.slice(index, index + 7));
      else controller.enqueue(joined);
      if (!options.hang) controller.close();
    },
  });
}
function envelope(flags: number, message: unknown): Uint8Array {
  const body = encoder.encode(JSON.stringify(message)); const frame = new Uint8Array(5 + body.byteLength);
  frame[0] = flags; new DataView(frame.buffer).setUint32(1, body.byteLength); frame.set(body, 5);
  return frame;
}
function unenvelope(bytes: Uint8Array): Record<string, unknown> {
  expect(bytes[0]).toBe(0);
  const size = new DataView(bytes.buffer, bytes.byteOffset + 1, 4).getUint32(0);
  expect(bytes.byteLength).toBe(5 + size);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(5)));
}

interface FakeOptions {
  readonly create?: () => Response;
  /** Answers a process start: the events to stream, or how. */
  readonly start?: (request: { cmd: string; args: string[]; envs: Record<string, string>; stdin?: boolean }) => ReadableStream<Uint8Array> | Response;
  readonly unary?: (method: string, body: Record<string, unknown>) => Response;
  readonly files?: (method: string, url: URL, body: Uint8Array) => Response;
}
/** E2B's control API and envd, answering in their wire formats. */
function fakeE2b(options: FakeOptions = {}) {
  const seen: Seen = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const bytes = new Uint8Array(await request.arrayBuffer()); const url = new URL(request.url);
    const json = request.headers.get('content-type') === 'application/json' && bytes.byteLength ? JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown> : undefined;
    seen.push({ method: request.method, url, headers: request.headers, bytes, ...(json ? { json } : {}) });
    if (url.pathname === '/v2/sandboxes') return options.create?.() ?? Response.json({ sandboxID: 'sbx1', templateID: 'base', clientID: 'c', envdVersion: '0.4.0', envdAccessToken: 'envd-token', domain: 'e2b.app' }, { status: 201 });
    if (url.pathname.startsWith('/sandboxes/')) return new Response(null, { status: 204 });
    if (url.pathname === '/process.Process/Start') {
      const started = options.start?.(unenvelope(bytes)['process'] === undefined ? {} as never : { ...(unenvelope(bytes)['process'] as { cmd: string; args: string[]; envs: Record<string, string> }), ...(unenvelope(bytes)['stdin'] ? { stdin: true } : {}) });
      if (started instanceof Response) return started;
      return new Response(started ?? stream([{ start: { pid: 7 } }, { end: { exited: true, status: 'exit status 0' } }]), { status: 200, headers: { 'content-type': 'application/connect+json' } });
    }
    if (url.pathname === '/files') return options.files?.(request.method, url, bytes) ?? new Response(null, { status: 404 });
    return options.unary?.(url.pathname.slice(1), json ?? {}) ?? Response.json({});
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}
const limits = { maxSandboxes: 2, maxLifetimeMs: 600_000, network: ['none', 'all', 'allowlist'] as const };
async function sandbox(fake: ReturnType<typeof fakeE2b>, create: Record<string, unknown> = {}) {
  return createSandboxes(e2bSandboxes({ apiKey: 'e2b_test_key', fetch: fake.fetch }), limits).create({ lifetimeMs: 120_000, ...create });
}

describe('e2bSandboxes', () => {
  it('refuses configuration it cannot use', () => {
    expect(() => e2bSandboxes({ apiKey: '' })).toThrow(/apiKey/u);
    expect(() => e2bSandboxes({ apiKey: 'e2b_test_key', template: 'has space' })).toThrow(/template/u);
    expect(() => e2bSandboxes({ apiKey: 'e2b_test_key', workdir: 'home' })).toThrow(/workdir/u);
    expect(() => e2bSandboxes({ apiKey: 'e2b_test_key', maxLifetimeMs: 86_400_001 })).toThrow(/maxLifetimeMs/u);
    expect(() => e2bSandboxes({ apiKey: 'e2b_test_key', apiUrl: 'http://api.example' })).toThrow(/https/u);
    expect(e2bSandboxes({ apiKey: 'e2b_test_key' })).toMatchObject({ id: 'e2b', workdir: '/home/user', maxLifetimeMs: 3_600_000, features: { stdin: true, ports: true, desktop: false } });
  });

  it('creates a sandbox with its lifetime, environment, labels and no internet unless allowed', async () => {
    const fake = fakeE2b();
    const box = await sandbox(fake, { env: { TOKEN: 'secret' }, labels: { run: 'r1' }, lifetimeMs: 90_500 });
    expect(box.id).toBe('sbx1');
    const created = fake.seen[0]!;
    expect(created.method).toBe('POST'); expect(created.url.href).toBe('https://api.e2b.app/v2/sandboxes');
    expect(created.headers.get('x-api-key')).toBe('e2b_test_key');
    expect(created.json).toEqual({ templateID: 'base', timeout: 91, autoPause: false, envVars: { TOKEN: 'secret' }, metadata: { run: 'r1' }, allow_internet_access: false });
    await sandbox(fake, { network: 'all', image: 'my-template' });
    expect(fake.seen.at(-1)!.json).toMatchObject({ templateID: 'my-template', allow_internet_access: true });
    await sandbox(fake, { network: { allow: ['registry.npmjs.org', '*.github.com'] }, ports: [3_000] });
    expect(fake.seen.at(-1)!.json).toMatchObject({ allow_internet_access: true,
      network: { allowOut: ['registry.npmjs.org', '*.github.com'], denyOut: ['0.0.0.0/0'], allowPublicTraffic: true } });
  });

  it('maps a refused creation to a fixed error, without E2B\'s text', async () => {
    for (const [status, reason] of [[401, 'authentication'], [429, 'rate_limited'], [503, 'unavailable'], [400, 'rejected']] as const) {
      const fake = fakeE2b({ create: () => Response.json({ code: status, message: 'secret detail from e2b' }, { status }) });
      const error = await sandbox(fake).then(() => undefined, (caught: unknown) => caught as MayuraError);
      expect(error).toMatchObject({ reason }); expect(error!.message).not.toContain('secret');
    }
    const odd = fakeE2b({ create: () => Response.json({ sandboxID: '../x' }, { status: 201 }) });
    expect(await sandbox(odd).catch(caught => caught)).toMatchObject({ reason: 'invalid_response' });
  });

  it('runs a command through sh in its directory, with its environment and a tag, and reads its streamed output', async () => {
    const starts: { cmd: string; args: string[]; envs: Record<string, string> }[] = [];
    const fake = fakeE2b({ start: request => {
      starts.push(request);
      return stream([{ start: { pid: 7 } }, { keepalive: {} }, { data: { stdout: base64('out ') } }, { data: { stderr: base64('err') } }, { data: { stdout: base64('more') } },
        { end: { exitCode: 3, exited: true, status: 'exit status 3' } }], { split: true });
    } });
    const box = await sandbox(fake);
    const result = await box.exec(['npm', 'test', '--', 'a b'], { cwd: 'app', env: { CI: '1' } });
    expect(result).toMatchObject({ exitCode: 3, timedOut: false, stdout: 'out more', stderr: 'err' });
    expect(starts[0]!.cmd).toBe('/bin/sh');
    expect(starts[0]!.args.slice(0, 2)).toEqual(['-c', 'cd -- "$1" || exit; shift; exec "$@"']);
    expect(starts[0]!.args.slice(2)).toEqual(['mayura', '/home/user/app', 'npm', 'test', '--', 'a b']);
    expect(starts[0]!.envs).toMatchObject({ CI: '1', MAYURA_SANDBOX_EXEC: expect.stringMatching(/^[a-f0-9]{24}$/u) });
    const start = fake.seen.find(item => item.url.pathname === '/process.Process/Start')!;
    expect(start.url.origin).toBe('https://sandbox.e2b.app');
    expect(Object.fromEntries(['content-type', 'connect-protocol-version', 'e2b-sandbox-id', 'e2b-sandbox-port', 'x-access-token', 'keepalive-ping-interval'].map(name => [name, start.headers.get(name)])))
      .toEqual({ 'content-type': 'application/connect+json', 'connect-protocol-version': '1', 'e2b-sandbox-id': 'sbx1', 'e2b-sandbox-port': '49983', 'x-access-token': 'envd-token', 'keepalive-ping-interval': '50' });
  });

  it('reads exit codes as E2B encodes them: 0 left out, and signals', async () => {
    let end: Event = { exited: true };
    const fake = fakeE2b({ start: () => stream([{ start: { pid: 7 } }, { end }]) });
    const box = await sandbox(fake);
    expect((await box.exec(['true'])).exitCode).toBe(0);
    end = { exited: false, status: 'signal: killed' };
    expect((await box.exec(['x'])).exitCode).toBe(137);
    end = { exited: false, status: 'something else' };
    expect((await box.exec(['x'])).exitCode).toBe(-1);
  });

  it('fails a command whose stream ends with an error, or without ending the process', async () => {
    let fail: Partial<{ endError: string; noEnd: boolean }> = { endError: 'unavailable' };
    const fake = fakeE2b({ start: () => fail.noEnd ? stream([{ start: { pid: 7 } }]) : stream([{ start: { pid: 7 } }], { endError: fail.endError! }) });
    const box = await sandbox(fake);
    const error = await box.exec(['x']).then(() => undefined, (caught: unknown) => caught as MayuraError);
    expect(error).toMatchObject({ reason: 'unavailable' }); expect(error!.message).not.toContain('secret');
    fail = { endError: 'unauthenticated' };
    expect(await box.exec(['x']).catch(caught => caught)).toMatchObject({ reason: 'authentication' });
    fail = { noEnd: true };
    expect(await box.exec(['x']).catch(caught => caught)).toMatchObject({ reason: 'invalid_response' });
  });

  it('gives standard input in order, then closes it, before the command ends', async () => {
    const calls: [string, Record<string, unknown>][] = [];
    let finish!: () => void;
    const fake = fakeE2b({
      start: request => {
        expect(request.stdin).toBe(true);
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        finish = () => { controller.enqueue(envelope(0, { event: { end: { exited: true } } })); controller.close(); };
        return new ReadableStream({ start(stream) { controller = stream; stream.enqueue(envelope(0, { event: { start: { pid: 42 } } })); } });
      },
      unary: (method, body) => { calls.push([method, body]); if (method === 'process.Process/CloseStdin') finish(); return Response.json({}); },
    });
    const box = await sandbox(fake);
    const input = 'x'.repeat(1_048_576 + 10);
    expect((await box.exec(['cat'], { stdin: input })).exitCode).toBe(0);
    expect(calls.map(([method, body]) => [method, (body['process'] as { pid: number }).pid])).toEqual([
      ['process.Process/SendInput', 42], ['process.Process/SendInput', 42], ['process.Process/CloseStdin', 42]]);
    expect(atob((calls[0]![1]['input'] as { stdin: string }).stdin).length).toBe(1_048_576);
    expect(atob((calls[1]![1]['input'] as { stdin: string }).stdin)).toBe('x'.repeat(10));
  });

  it('stops a command at its timeout: SIGKILL to it, and to everything carrying its tag', async () => {
    const starts: { args: string[]; envs: Record<string, string> }[] = []; const signals: unknown[] = [];
    const fake = fakeE2b({
      start: request => {
        starts.push(request);
        // The command never ends; the kill script does.
        return starts.length === 1 ? stream([{ start: { pid: 9 } }, { data: { stdout: base64('partial') } }], { hang: true }) : stream([{ start: { pid: 10 } }, { end: { exited: true } }]);
      },
      unary: (method, body) => { if (method === 'process.Process/SendSignal') signals.push(body); return Response.json({}); },
    });
    const box = await sandbox(fake);
    const result = await box.exec(['sleep', '100'], { timeoutMs: 100 });
    expect(result).toMatchObject({ timedOut: true, stdout: 'partial' }); expect(result.exitCode).toBeUndefined();
    expect(signals).toEqual([{ process: { pid: 9 }, signal: 'SIGNAL_SIGKILL' }]);
    expect(starts[1]!.args.at(-1)).toBe(starts[0]!.envs['MAYURA_SANDBOX_EXEC']);
    expect(starts[1]!.args[1]).toContain('grep -qxF "MAYURA_SANDBOX_EXEC=$1"');
  });

  it('cancels with the caller the same way', async () => {
    const signals: unknown[] = []; let starts = 0;
    const fake = fakeE2b({ start: () => ++starts === 1 ? stream([{ start: { pid: 9 } }], { hang: true }) : stream([{ start: { pid: 10 } }, { end: { exited: true } }]), unary: (method, body) => { if (method === 'process.Process/SendSignal') signals.push(body); return Response.json({}); } });
    const box = await sandbox(fake);
    const controller = new AbortController();
    const pending = box.exec(['sleep', '100'], { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    expect(await pending.catch(caught => caught)).toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(signals).toHaveLength(1));
  });

  it('reads files by path, as bytes, refusing missing, non-files and too large', async () => {
    const files = new Map<string, Uint8Array>([['/home/user/a.bin', new Uint8Array([0, 255, 7])], ['/home/user/big', new Uint8Array(100)]]);
    const fake = fakeE2b({ files: (_method, url) => {
      const path = url.searchParams.get('path')!;
      if (path === '/home/user/dir') return new Response('is a directory', { status: 400 });
      const data = files.get(path);
      // The big file is sent without its length, so the bound is applied while reading.
      if (data && path === '/home/user/big') return new Response(new ReadableStream({ start(controller) { controller.enqueue(data); controller.close(); } }));
      return data ? new Response(data as Uint8Array<ArrayBuffer>) : new Response('File not found', { status: 404 });
    } });
    const box = await sandbox(fake);
    expect([...(await box.readFile('a.bin'))!]).toEqual([0, 255, 7]);
    const read = fake.seen.at(-1)!;
    expect(read.url.searchParams.get('path')).toBe('/home/user/a.bin'); expect(read.headers.get('x-access-token')).toBe('envd-token');
    expect(await box.readFile('none')).toBeUndefined();
    expect(await box.readFile('dir').catch(caught => caught)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await box.readFile('big', { maxBytes: 10 }).catch(caught => caught)).toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it('writes files as raw bytes', async () => {
    let written: [string, Uint8Array] | undefined;
    const fake = fakeE2b({ files: (method, url, body) => { if (method === 'POST') { written = [url.searchParams.get('path')!, body]; return Response.json([{ path: 'x', name: 'x', type: 'file' }]); } return new Response(null, { status: 404 }); } });
    const box = await sandbox(fake);
    await box.writeFile('dir/a b.txt', 'hello');
    expect(written![0]).toBe('/home/user/dir/a b.txt'); expect(new TextDecoder().decode(written![1])).toBe('hello');
    expect(fake.seen.at(-1)!.headers.get('content-type')).toBe('application/octet-stream');
  });

  it('lists a directory from ListDir, and reports missing ones and files', async () => {
    const fake = fakeE2b({ unary: (method, body) => {
      expect(method).toBe('filesystem.Filesystem/ListDir'); expect(body['depth']).toBe(1);
      if (body['path'] === '/home/user/none') return Response.json({ code: 'not_found', message: 'path not found' }, { status: 404 });
      if (body['path'] === '/home/user/file') return Response.json({ code: 'invalid_argument', message: 'path is not a directory' }, { status: 400 });
      return Response.json({ entries: [
        { name: 'src', type: 'FILE_TYPE_DIRECTORY', path: '/home/user/src', size: '4096', modifiedTime: '2026-10-01T10:00:00Z' },
        { name: 'big.bin', type: 'FILE_TYPE_FILE', path: '/home/user/big.bin', size: '9007199254740' },
        { name: 'link', type: 'FILE_TYPE_SYMLINK', path: '/home/user/link', size: 3 }] });
    } });
    const box = await sandbox(fake);
    expect(await box.listFiles()).toEqual([
      { name: 'big.bin', type: 'file', size: 9_007_199_254_740 }, { name: 'link', type: 'other', size: 3 },
      { name: 'src', type: 'directory', size: 0, modified: Date.parse('2026-10-01T10:00:00Z') }]);
    expect(await box.listFiles('none')).toBeUndefined();
    expect(await box.listFiles('file').catch(caught => caught)).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('removes a directory only when it is empty, unless recursive', async () => {
    const removed: unknown[] = []; const tree: Record<string, string[] | 'file'> = { '/home/user/full': ['a'], '/home/user/empty': [], '/home/user/f': 'file' };
    const fake = fakeE2b({ unary: (method, body) => {
      const path = body['path'] as string; const node = tree[path];
      if (method === 'filesystem.Filesystem/Remove') { removed.push(path); return node === undefined ? Response.json({ code: 'not_found' }, { status: 404 }) : Response.json({}); }
      if (node === undefined) return Response.json({ code: 'not_found' }, { status: 404 });
      if (method === 'filesystem.Filesystem/Stat') return Response.json({ entry: { name: 'x', type: node === 'file' ? 'FILE_TYPE_FILE' : 'FILE_TYPE_DIRECTORY' } });
      return Response.json({ entries: (node as string[]).map(name => ({ name, type: 'FILE_TYPE_FILE' })) });
    } });
    const box = await sandbox(fake);
    expect(await box.removeFile('full').catch(caught => caught)).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('not empty') });
    await box.removeFile('empty'); await box.removeFile('f'); await box.removeFile('full', { recursive: true }); await box.removeFile('none');
    expect(removed).toEqual(['/home/user/empty', '/home/user/f', '/home/user/full']);
  });

  it('reports a sandbox E2B no longer has as gone', async () => {
    const fake = fakeE2b({ start: () => new Response('sandbox not found', { status: 502 }), unary: () => new Response('sandbox not found', { status: 502 }) });
    const box = await sandbox(fake);
    expect(await box.exec(['x']).catch(caught => caught)).toMatchObject({ reason: 'gone' });
    expect(await box.listFiles().catch(caught => caught)).toMatchObject({ reason: 'gone' });
  });

  it('gives port URLs on the sandbox\'s domain, and envd\'s own host on other domains', async () => {
    const fake = fakeE2b({ create: () => Response.json({ sandboxID: 'sbx2', envdAccessToken: 't', domain: 'sandboxes.example.dev' }, { status: 201 }) });
    const box = await sandbox(fake, { ports: [3_000], network: 'all' });
    expect(await box.url(3_000)).toBe('https://3000-sbx2.sandboxes.example.dev/');
    await box.exec(['true']);
    expect(fake.seen.at(-1)!.url.origin).toBe('https://49983-sbx2.sandboxes.example.dev');
  });

  it('deletes the sandbox on release, and treats one already gone as released', async () => {
    let status = 204;
    const fake = fakeE2b(); const original = fake.fetch;
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') { await original(input, init); return new Response(null, { status }); }
      return original(input, init);
    }) as typeof globalThis.fetch;
    const sandboxes = createSandboxes(e2bSandboxes({ apiKey: 'e2b_test_key', fetch }), limits);
    const box = await sandboxes.create({ lifetimeMs: 60_000 });
    await box.release();
    const deleted = fake.seen.at(-1)!;
    expect([deleted.method, deleted.url.href, deleted.headers.get('x-api-key')]).toEqual(['DELETE', 'https://api.e2b.app/sandboxes/sbx1', 'e2b_test_key']);
    status = 404;
    await (await sandboxes.create({ lifetimeMs: 60_000 })).release();
    status = 500;
    expect(await (await sandboxes.create({ lifetimeMs: 60_000 })).release().catch(caught => caught)).toMatchObject({ reason: 'unavailable' });
  });
});
