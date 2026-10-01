import { describe, expect, it, vi } from 'vitest';
import { MayuraError } from 'mayura';
import { createSandboxes, sandboxTools } from 'mayura/sandbox';
import { testTool } from 'mayura/testing';
import { daytonaSandboxes } from '../src/index.js';

const encoder = new TextEncoder(); const decoder = new TextDecoder();
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
/** Splits a command line the way sh does for words, single-quoted strings and `'\''`. */
function words(line: string): string[] {
  const result: string[] = []; let current = ''; let quoted = false; let started = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quoted) { if (char === "'") quoted = false; else current += char; continue; }
    if (char === "'") { quoted = true; started = true; continue; }
    if (char === '\\') { current += line[++index]; started = true; continue; }
    if (char === ' ') { if (started) { result.push(current); current = ''; started = false; } continue; }
    current += char; started = true;
  }
  if (started) result.push(current);
  return result;
}
interface Run { readonly tag: string; readonly argv: string[]; readonly out: string; readonly err: string; readonly stdin: string; readonly env: string; readonly cwd: string; readonly command: string[] }
interface FakeOptions {
  readonly states?: string[];
  readonly create?: () => Response | undefined;
  /** Runs a command: what it writes to stdout and stderr, and its exit code; undefined never finishes. */
  readonly run?: (run: Run, files: Map<string, Uint8Array>) => { stdout?: string; stderr?: string; exitCode?: number };
  readonly other?: (method: string, url: URL, body: Uint8Array) => Response | undefined;
}
/** Daytona's API and toolbox, with a file system, running commands by `run`. */
function fakeDaytona(options: FakeOptions = {}) {
  const seen: { method: string; url: URL; headers: Headers; body: Uint8Array; json?: Record<string, unknown> }[] = [];
  const files = new Map<string, Uint8Array>(); const runs: Run[] = []; const sessions = new Set<string>(); const commands = new Map<string, { exitCode?: number }>();
  const states = [...(options.states ?? ['creating', 'starting', 'started'])];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); const url = new URL(request.url); const body = new Uint8Array(await request.clone().arrayBuffer());
    const json = request.headers.get('content-type') === 'application/json' && body.byteLength ? JSON.parse(decoder.decode(body)) as Record<string, unknown> : undefined;
    seen.push({ method: request.method, url, headers: request.headers, body, ...(json ? { json } : {}) });
    const other = options.other?.(request.method, url, body);
    if (other) return other;
    const path = url.pathname; const query = (name: string) => url.searchParams.get(name)!;
    if (url.origin === 'https://app.daytona.io') {
      if (path === '/api/sandbox' && request.method === 'POST') return options.create?.() ?? Response.json({ id: 'sb1', state: states.shift(), toolboxProxyUrl: 'https://proxy.app.daytona.io/toolbox' });
      if (path === '/api/sandbox/sb1' && request.method === 'GET') return Response.json({ id: 'sb1', state: states.length ? states.shift() : 'started', toolboxProxyUrl: 'https://proxy.app.daytona.io/toolbox' });
      if (path === '/api/sandbox/sb1' && request.method === 'DELETE') return Response.json({ id: 'sb1' });
      const signed = /^\/api\/sandbox\/sb1\/ports\/(\d+)\/signed-preview-url$/u.exec(path);
      if (signed) return Response.json({ sandboxId: 'sb1', port: Number(signed[1]), token: 'tok', url: `https://${signed[1]}-tok.proxy.daytona.works` });
    }
    expect(path.startsWith('/toolbox/sb1/')).toBe(true);
    const tool = path.slice('/toolbox/sb1'.length);
    if (tool === '/files/upload-v2') {
      const form = await request.formData(); const file = form.get('file') as Blob;
      files.set(query('path'), new Uint8Array(await file.arrayBuffer())); return Response.json({ name: 'x', path: query('path'), type: 'file' });
    }
    if (tool === '/files/folder') return new Response(null, { status: 201 });
    if (tool === '/files/download') { const data = files.get(query('path')); return data ? new Response(data as Uint8Array<ArrayBuffer>) : Response.json({ message: 'secret not found' }, { status: 404 }); }
    if (tool === '/files' && request.method === 'DELETE') { files.delete(query('path')); return new Response(null, { status: 204 }); }
    if (tool === '/process/session' && request.method === 'POST') { sessions.add(json!['sessionId'] as string); return new Response(null, { status: 201 }); }
    const exec = /^\/process\/session\/([^/]+)\/exec$/u.exec(tool);
    if (exec) {
      expect(sessions.has(exec[1]!)).toBe(true); expect(json!['runAsync']).toBe(true);
      const argv = words(json!['command'] as string);
      const [assignment, , , , , out, err, stdin, env, cwd, ...command] = argv;
      const run: Run = { tag: assignment!.split('=')[1]!, argv, out: out!, err: err!, stdin: stdin!, env: env!, cwd: cwd!, command };
      runs.push(run);
      const result = options.run?.(run, files) ?? { exitCode: 0 };
      files.set(run.out, encoder.encode(result.stdout ?? '')); files.set(run.err, encoder.encode(result.stderr ?? ''));
      const cmdId = `cmd${runs.length}`; commands.set(cmdId, { ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }) });
      return Response.json({ cmdId }, { status: 202 });
    }
    const status = /^\/process\/session\/[^/]+\/command\/([^/]+)$/u.exec(tool);
    if (status) return Response.json({ id: status[1], command: 'x', ...commands.get(status[1]!) });
    if (/^\/process\/session\/[^/]+$/u.test(tool) && request.method === 'DELETE') { sessions.delete(tool.split('/').pop()!); return new Response(null, { status: 204 }); }
    return Response.json({});
  }) as typeof globalThis.fetch;
  return { fetch, seen, files, runs, sessions };
}
const limits = { maxSandboxes: 3, maxLifetimeMs: 600_000, network: ['none', 'all', 'allowlist'] as const };
const sandboxesFor = (fake: ReturnType<typeof fakeDaytona>, extra: Partial<Parameters<typeof daytonaSandboxes>[0]> = {}) =>
  createSandboxes(daytonaSandboxes({ apiKey: 'dtn_test_key', fetch: fake.fetch, organizationId: 'org1', ...extra }), limits);

describe('daytonaSandboxes', () => {
  it('refuses configuration it cannot use', () => {
    expect(() => daytonaSandboxes({ apiKey: '' })).toThrow(/apiKey/u);
    expect(() => daytonaSandboxes({ apiKey: 'dtn_test_key', organizationId: 'org/1' })).toThrow(/organizationId/u);
    expect(() => daytonaSandboxes({ apiKey: 'dtn_test_key', workdir: 'home' })).toThrow(/workdir/u);
    expect(() => daytonaSandboxes({ apiKey: 'dtn_test_key', maxLifetimeMs: 1_000 })).toThrow(/maxLifetimeMs/u);
    expect(daytonaSandboxes({ apiKey: 'dtn_test_key' })).toMatchObject({ id: 'daytona', workdir: '/home/daytona', features: { stdin: true, ports: true, desktop: false } });
    expect(daytonaSandboxes({ apiKey: 'dtn_test_key', desktop: true }).features.desktop).toBe(true);
  });

  it('creates a private sandbox with no network, its lifetime as Daytona\'s time to live, and waits for it to start', async () => {
    const fake = fakeDaytona();
    const box = await sandboxesFor(fake).create({ lifetimeMs: 90_000, env: { TOKEN: 'secret' }, labels: { run: 'r1' }, cpus: 2, memoryMiB: 4_096, image: 'snap-1' });
    expect(box.id).toBe('sb1');
    const created = fake.seen[0]!;
    expect(created.url.href).toBe('https://app.daytona.io/api/sandbox');
    expect([created.headers.get('authorization'), created.headers.get('x-daytona-organization-id')]).toEqual(['Bearer dtn_test_key', 'org1']);
    expect(created.json).toEqual({ name: expect.stringMatching(/^mayura-[a-f0-9]{24}$/u), snapshot: 'snap-1', env: { TOKEN: 'secret' }, labels: { run: 'r1' }, public: false,
      networkBlockAll: true, cpu: 2, memory: 4, ttlMinutes: 2, autoStopInterval: 0, autoDeleteInterval: 0 });
    expect(fake.seen.filter(item => item.method === 'GET' && item.url.pathname === '/api/sandbox/sb1')).toHaveLength(2);
  });

  it('maps the network, and refuses memory Daytona cannot give', async () => {
    const fake = fakeDaytona({ states: ['started', 'started', 'started'] }); const sandboxes = sandboxesFor(fake);
    await (await sandboxes.create({ lifetimeMs: 60_000, network: 'all' })).release();
    await (await sandboxes.create({ lifetimeMs: 60_000, network: { allow: ['registry.npmjs.org', '*.github.com'] } })).release();
    const bodies = fake.seen.filter(item => item.method === 'POST' && item.url.pathname === '/api/sandbox').map(item => item.json!);
    expect(bodies[0]).toMatchObject({ networkBlockAll: false }); expect(bodies[0]).not.toHaveProperty('domainAllowList');
    expect(bodies[1]).toMatchObject({ networkBlockAll: false, domainAllowList: 'registry.npmjs.org,*.github.com' });
    expect(await sandboxes.create({ lifetimeMs: 60_000, memoryMiB: 1_500 }).catch(caught => caught)).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('releases a sandbox that fails to start, and maps refusals without Daytona\'s text', async () => {
    const failing = fakeDaytona({ states: ['creating', 'error'] });
    expect(await sandboxesFor(failing).create({ lifetimeMs: 60_000 }).catch(caught => caught)).toMatchObject({ reason: 'rejected' });
    expect(failing.seen.at(-1)).toMatchObject({ method: 'DELETE' });
    for (const [status, reason] of [[401, 'authentication'], [403, 'authentication'], [404, 'rejected'], [429, 'rate_limited'], [500, 'unavailable']] as const) {
      const fake = fakeDaytona({ create: () => Response.json({ message: 'secret detail from daytona' }, { status }) });
      const error = await sandboxesFor(fake).create({ lifetimeMs: 60_000 }).then(() => undefined, (caught: unknown) => caught as MayuraError);
      expect(error).toMatchObject({ reason }); expect(error!.message).not.toContain('secret');
    }
  });

  it('runs a command in its own session, arguments exactly, its environment and input in files, and its output read back bounded', async () => {
    let envFile = '';
    let stdin = '';
    const fake = fakeDaytona({ run: (run, files) => {
      if (run.command[0] !== 'npm') return { exitCode: 0 };
      envFile = decoder.decode(files.get(run.env)); stdin = decoder.decode(files.get(run.stdin));
      return { stdout: 'x'.repeat(50), stderr: 'err', exitCode: 3 };
    } });
    const box = await createSandboxes(daytonaSandboxes({ apiKey: 'dtn_test_key', fetch: fake.fetch }), { ...limits, maxOutputBytes: 20 }).create({ lifetimeMs: 60_000 });
    const args = ['test', "it's", '$HOME', '"q"', 'a b', ';rm -rf /'];
    const result = await box.exec(['npm', ...args], { cwd: 'app', env: { SECRET: "Sekr1t'value" }, stdin: 'input' });
    expect(result).toMatchObject({ exitCode: 3, stdout: 'x'.repeat(20), stderr: 'err', truncated: true });
    const run = fake.runs[0]!;
    expect(run.argv.slice(0, 4)).toEqual([`MAYURA_SANDBOX_EXEC=${run.tag}`, 'sh', '-c', expect.stringContaining('exec >"$1" 2>"$2"')]);
    expect(run.tag).toMatch(/^[a-f0-9]{24}$/u);
    expect(run.command).toEqual(['npm', ...args]); expect(run.cwd).toBe('/home/daytona/app');
    expect([run.out, run.err, run.stdin, run.env]).toEqual(['out', 'err', 'in', 'env'].map(ext => `/tmp/mayura-${run.tag}.${ext}`));
    expect(stdin).toBe('input');
    expect(envFile).toBe("export SECRET='Sekr1t'\\''value'\n");
    const line = fake.seen.find(item => item.url.pathname.endsWith('/exec'))!.json!['command'] as string;
    expect(line).not.toContain('Sekr1t');
    await vi.waitFor(() => expect(fake.sessions.size).toBe(0));
    await vi.waitFor(() => expect([...fake.files.keys()].filter(key => key.startsWith('/tmp/mayura-'))).toEqual([run.env]));
    expect((await box.exec(['true'])).exitCode).toBe(0);
    expect(fake.runs[1]).toMatchObject({ stdin: '-', env: '-' });
  });

  it('reads back only as much output as is kept, whatever the command wrote', async () => {
    const fake = fakeDaytona({ run: () => ({ stdout: 'x'.repeat(1_000_000), exitCode: 0 }) });
    const backend = await daytonaSandboxes({ apiKey: 'dtn_test_key', fetch: fake.fetch }).create(
      { lifetimeMs: 60_000, network: 'none', env: {}, ports: [], labels: {} }, { signal: new AbortController().signal });
    const result = await backend.exec(['yes'], { cwd: '/home/daytona', env: {}, maxOutputBytes: 64, signal: new AbortController().signal });
    expect(result.stdout.byteLength).toBe(64); expect(result.truncated).toBe(true);
  });

  it('stops a command at its timeout: everything carrying its tag is killed, and what it wrote is returned', async () => {
    const fake = fakeDaytona({ run: run => run.command[0] === 'sleep' ? { stdout: 'partial' } : { exitCode: 0 } });
    const box = await sandboxesFor(fake).create({ lifetimeMs: 60_000 });
    const result = await box.exec(['sleep', '100'], { timeoutMs: 300 });
    expect(result).toMatchObject({ timedOut: true, stdout: 'partial' }); expect(result.exitCode).toBeUndefined();
    const kill = fake.seen.find(item => item.url.pathname.endsWith('/process/execute'))!;
    const argv = words(kill.json!['command'] as string);
    expect(argv.slice(0, 2)).toEqual(['sh', '-c']); expect(argv[2]).toContain('grep -qxF "MAYURA_SANDBOX_EXEC=$1"');
    expect(argv.slice(3)).toEqual(['mayura', fake.runs[0]!.tag]);
  });

  it('cancels with the caller the same way', async () => {
    const fake = fakeDaytona({ run: () => ({}) });
    const box = await sandboxesFor(fake).create({ lifetimeMs: 60_000 });
    const controller = new AbortController();
    const pending = box.exec(['sleep', '100'], { signal: controller.signal });
    setTimeout(() => controller.abort(), 300);
    expect(await pending.catch(caught => caught)).toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(fake.seen.some(item => item.url.pathname.endsWith('/process/execute'))).toBe(true));
  });

  it('reads, writes, lists and removes files with the toolbox', async () => {
    const fake = fakeDaytona({ other: (method, url) => {
      const path = url.searchParams.get('path');
      if (url.pathname.endsWith('/files') && method === 'GET') {
        if (path === '/home/daytona/none') return Response.json({ message: 'not found' }, { status: 404 });
        if (path === '/home/daytona/file.txt') return Response.json({ message: 'not a directory' }, { status: 400 });
        if (path === '/home/daytona/full') return Response.json([{ name: 'a', isDir: false, size: 1 }]);
        if (path === '/home/daytona/empty') return Response.json([]);
        return Response.json([{ name: 'src', isDir: true, size: 4096, modifiedAt: '2026-10-01T10:00:00Z' }, { name: 'a.txt', isDir: false, size: 5, modifiedAt: 'bad' }]);
      }
      if (url.pathname.endsWith('/files/download') && path === '/home/daytona/dir') return Response.json({ message: 'is a directory' }, { status: 400 });
      return undefined;
    } });
    const box = await sandboxesFor(fake).create({ lifetimeMs: 60_000 });
    await box.writeFile('dir/a.bin', new Uint8Array([0, 255, 7]));
    const folder = fake.seen.find(item => item.url.pathname.endsWith('/files/folder'))!;
    expect([folder.url.searchParams.get('path'), folder.url.searchParams.get('mode')]).toEqual(['/home/daytona/dir', '0755']);
    expect([...fake.files.get('/home/daytona/dir/a.bin')!]).toEqual([0, 255, 7]);
    expect([...(await box.readFile('dir/a.bin'))!]).toEqual([0, 255, 7]);
    expect(await box.readFile('none')).toBeUndefined();
    expect(await box.readFile('dir').catch(caught => caught)).toMatchObject({ code: 'INVALID_INPUT' });
    fake.files.set('/home/daytona/big', new Uint8Array(100));
    expect(await box.readFile('big', { maxBytes: 10 }).catch(caught => caught)).toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(await box.listFiles()).toEqual([{ name: 'a.txt', type: 'file', size: 5 }, { name: 'src', type: 'directory', size: 0, modified: Date.parse('2026-10-01T10:00:00Z') }]);
    expect(await box.listFiles('none')).toBeUndefined();
    expect(await box.listFiles('file.txt').catch(caught => caught)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await box.removeFile('full').catch(caught => caught)).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('not empty') });
    await box.removeFile('empty'); await box.removeFile('file.txt'); await box.removeFile('full', { recursive: true }); await box.removeFile('none');
    expect(fake.seen.filter(item => item.method === 'DELETE' && item.url.pathname.endsWith('/files')).map(item => [item.url.searchParams.get('path'), item.url.searchParams.get('recursive')]))
      .toEqual([['/home/daytona/empty', null], ['/home/daytona/file.txt', null], ['/home/daytona/full', 'true']]);
  });

  it('gives signed port URLs, valid while the sandbox lives, without making it public', async () => {
    const fake = fakeDaytona();
    const box = await sandboxesFor(fake).create({ lifetimeMs: 600_000, network: 'all', ports: [3_000] });
    expect(await box.url(3_000)).toBe('https://3000-tok.proxy.daytona.works/');
    const signed = fake.seen.find(item => item.url.pathname.endsWith('/signed-preview-url'))!;
    expect(Number(signed.url.searchParams.get('expiresInSeconds'))).toBeGreaterThan(590);
    expect(fake.seen[0]!.json!['public']).toBe(false);
  });

  it('has a desktop through computer use, when asked for', async () => {
    const fake = fakeDaytona({ other: (_method, url) => {
      if (url.pathname.endsWith('/computeruse/screenshot')) return Response.json({ screenshot: btoa(String.fromCharCode(...png)), sizeBytes: png.byteLength });
      if (url.pathname.endsWith('/computeruse/display/info')) return Response.json({ displays: [{ id: 0, width: 1280, height: 720, isActive: true }] });
      return undefined;
    } });
    const box = await sandboxesFor(fake, { desktop: true }).create({ lifetimeMs: 60_000 });
    expect(fake.seen.some(item => item.url.pathname === '/toolbox/sb1/computeruse/start')).toBe(true);
    const desktop = box.desktop!;
    await desktop.click(10, 20, { button: 'right', double: true }); await desktop.move(1, 2); await desktop.scroll(3, 4, { dy: -2 });
    await desktop.type('hello'); await desktop.key('Ctrl+Shift+T'); await desktop.key('Enter');
    expect(fake.seen.filter(item => item.url.pathname.includes('/computeruse/') && item.method === 'POST' && !item.url.pathname.endsWith('/start')).map(item => [item.url.pathname.slice('/toolbox/sb1/computeruse/'.length), item.json]))
      .toEqual([['mouse/click', { x: 10, y: 20, button: 'right', double: true }], ['mouse/move', { x: 1, y: 2 }], ['mouse/scroll', { x: 3, y: 4, direction: 'up', amount: 2 }],
        ['keyboard/type', { text: 'hello' }], ['keyboard/hotkey', { keys: 'ctrl+shift+t' }], ['keyboard/key', { key: 'enter' }]]);
    expect(await desktop.scroll(1, 1, { dx: 2 }).catch(caught => caught)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await desktop.size()).toEqual({ width: 1280, height: 720 });
    expect(await desktop.viewUrl()).toBe('https://6080-tok.proxy.daytona.works/vnc.html?autoconnect=true&resize=scale');
    const { outcome } = await testTool(sandboxTools(box, { name: 'pc', desktop: true }).find(tool => tool.id === 'pc.screenshot')!, {});
    expect(outcome).toMatchObject({ status: 'succeeded', output: { width: 1280, height: 720 }, media: [{ mediaType: 'image/png' }] });
    const plain = await sandboxesFor(fakeDaytona()).create({ lifetimeMs: 60_000 });
    expect(plain.desktop).toBeUndefined();
  });

  it('deletes the sandbox on release; one already gone counts as released', async () => {
    let status = 200;
    const fake = fakeDaytona({ states: ['started', 'started', 'started'], other: method => method === 'DELETE' ? new Response(null, { status }) : undefined });
    const sandboxes = sandboxesFor(fake);
    await (await sandboxes.create({ lifetimeMs: 60_000 })).release();
    expect(fake.seen.at(-1)).toMatchObject({ method: 'DELETE' }); expect(fake.seen.at(-1)!.url.pathname).toBe('/api/sandbox/sb1');
    status = 404; await (await sandboxes.create({ lifetimeMs: 60_000 })).release();
    status = 500; expect(await (await sandboxes.create({ lifetimeMs: 60_000 })).release().catch(caught => caught)).toMatchObject({ reason: 'unavailable' });
  });
});
