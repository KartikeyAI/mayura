import { describe, expect, it, vi } from 'vitest';
import { MayuraError, type JsonValue } from '@mayura/core';
import type { AnyTool } from '@mayura/tools';
import { testTool, toolGrants } from '../../testing/src/index.js';
import {
  createSandboxes, parseSandboxListing, sandboxPath, sandboxPerRun, sandboxScripts, sandboxTools, SandboxError, sandboxHttpFailure,
  type BackendExecOptions, type BackendExecResult, type ProviderSandboxSpec, type SandboxBackend, type SandboxDesktop, type SandboxFeatures, type SandboxProvider,
} from '../src/index.js';

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);
/** The start of a PNG file: enough to be recognized as one. */
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

interface FakeOptions {
  readonly features?: Partial<SandboxFeatures>;
  readonly exec?: (command: readonly string[], options: BackendExecOptions) => Promise<BackendExecResult>;
  readonly backend?: Partial<SandboxBackend>;
  readonly create?: (spec: ProviderSandboxSpec, signal: AbortSignal) => Promise<void>;
  readonly desktop?: SandboxDesktop;
}
/** A provider whose sandboxes keep files in memory and run commands with `exec`. */
function fakeProvider(options: FakeOptions = {}) {
  const created: ProviderSandboxSpec[] = []; const released: string[] = []; const calls: { command: readonly string[]; options: BackendExecOptions }[] = [];
  let count = 0;
  const provider: SandboxProvider = {
    id: 'fake', workdir: '/work', maxLifetimeMs: 3_600_000,
    features: { stdin: true, ports: true, desktop: options.desktop !== undefined, network: ['none', 'all', 'allowlist'], ...options.features },
    create: async (spec, { signal }) => {
      await options.create?.(spec, signal);
      created.push(spec);
      const id = `box-${++count}`; const files = new Map<string, Uint8Array>();
      return {
        id,
        exec: async (command, execOptions) => {
          calls.push({ command, options: execOptions });
          if (options.exec) return options.exec(command, execOptions);
          return { exitCode: 0, stdout: bytes(command.join(' ')), stderr: new Uint8Array(0) };
        },
        readFile: async path => files.get(path),
        writeFile: async (path, data) => { files.set(path, data); },
        listFiles: async path => path === '/work' ? [...files.keys()].filter(key => key.startsWith('/work/')).map(key => ({ name: key.slice(6), type: 'file' as const, size: files.get(key)!.byteLength })) : undefined,
        removeFile: async path => { files.delete(path); },
        url: async port => `https://${port}-${id}.example.test/`,
        ...(options.desktop ? { desktop: options.desktop } : {}),
        release: async () => { released.push(id); },
        ...options.backend,
      };
    },
  };
  return { provider, created, released, calls };
}
const limits = { maxSandboxes: 2, maxLifetimeMs: 600_000 };
async function failure(run: () => Promise<unknown>): Promise<MayuraError> {
  try { await run(); } catch (error) { if (error instanceof MayuraError) return error; throw error; }
  throw new Error('The call must fail.');
}

describe('sandbox paths', () => {
  it('resolves relative paths at the workdir and normalizes, never above /', () => {
    expect(sandboxPath('src/a.ts', '/work')).toBe('/work/src/a.ts');
    expect(sandboxPath('/etc//hosts', '/work')).toBe('/etc/hosts');
    expect(sandboxPath('a/../b/./c', '/work')).toBe('/work/b/c');
    expect(sandboxPath('../tmp', '/work')).toBe('/tmp');
    expect(() => sandboxPath('/../x', '/work')).toThrow(/climb/u);
    for (const bad of ['', 'a\u0000b', 'line\nbreak', 'x'.repeat(4_097), 7]) expect(() => sandboxPath(bad, '/work')).toThrow(MayuraError);
  });
});

describe('createSandboxes', () => {
  it('refuses configuration it cannot honour', () => {
    const { provider } = fakeProvider();
    expect(() => createSandboxes({ ...provider, id: 'Bad Id' }, limits)).toThrow(/provider/u);
    expect(() => createSandboxes({ ...provider, features: { ...provider.features, network: [] } }, limits)).toThrow(/features/u);
    expect(() => createSandboxes({ ...provider, workdir: 'work' }, limits)).toThrow(/workdir/u);
    expect(() => createSandboxes(provider, { ...limits, maxLifetimeMs: 3_600_001 })).toThrow(/at most 3600000/u);
    expect(() => createSandboxes(provider, { ...limits, maxSandboxes: 0 })).toThrow(MayuraError);
    expect(() => createSandboxes(provider, { ...limits, maxOutputBytes: 17 * 1_048_576 })).toThrow(/maxOutputBytes/u);
    expect(() => createSandboxes(provider, { ...limits, network: ['everything' as never] })).toThrow(/network/u);
  });

  it('creates sandboxes with no network by default, and only the network kinds it was given permission for', async () => {
    const { provider, created } = fakeProvider();
    const closed = createSandboxes(provider, limits);
    const box = await closed.create({ lifetimeMs: 60_000 });
    expect(box.network).toBe('none'); expect(created[0]!.network).toBe('none');
    expect(await failure(() => closed.create({ lifetimeMs: 60_000, network: 'all' }))).toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(await failure(() => closed.create({ lifetimeMs: 60_000, network: { allow: ['registry.npmjs.org'] } }))).toMatchObject({ code: 'PERMISSION_DENIED' });
    const open = createSandboxes(provider, { ...limits, maxSandboxes: 5, network: ['none', 'allowlist'] });
    await open.create({ lifetimeMs: 60_000, network: { allow: ['registry.npmjs.org', '*.github.com'] } });
    expect(created.at(-1)!.network).toEqual({ allow: ['registry.npmjs.org', '*.github.com'] });
    expect(await failure(() => open.create({ lifetimeMs: 60_000, network: 'all' }))).toMatchObject({ code: 'PERMISSION_DENIED' });
    for (const allow of [[], ['UPPER.example'], ['http://x.example'], ['*'], Array.from({ length: 65 }, (_, index) => `d${index}.example`)]) {
      expect(await failure(() => open.create({ lifetimeMs: 60_000, network: { allow } }))).toMatchObject({ code: 'INVALID_INPUT' });
    }
    // Permission is not enough: the provider must be able to enforce it.
    const { provider: plain } = fakeProvider({ features: { network: ['none', 'all'] } });
    expect(await failure(() => createSandboxes(plain, { ...limits, network: ['allowlist'] }).create({ lifetimeMs: 60_000, network: { allow: ['a.example'] } })))
      .toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('cannot enforce') });
    // A provider that cannot keep sandboxes off the network creates them only with 'all', allowed and asked for.
    const { provider: open2, created: openCreated } = fakeProvider({ features: { network: ['all'] } });
    expect(await failure(() => createSandboxes(open2, limits).create({ lifetimeMs: 60_000 }))).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('off the network') });
    expect(await failure(() => createSandboxes(open2, limits).create({ lifetimeMs: 60_000, network: 'all' }))).toMatchObject({ code: 'PERMISSION_DENIED' });
    await createSandboxes(open2, { ...limits, network: ['all'] }).create({ lifetimeMs: 60_000, network: 'all' });
    expect(openCreated.map(spec => spec.network)).toEqual(['all']);
  });

  it('checks lifetimes, environment, ports, resources and labels before calling the provider', async () => {
    const { provider, created } = fakeProvider();
    const sandboxes = createSandboxes(provider, { ...limits, labels: { team: 'a' } });
    for (const options of [
      { lifetimeMs: 999 }, { lifetimeMs: 600_001 }, { lifetimeMs: 1.5e3 + 0.5 },
      { lifetimeMs: 60_000, env: { '1BAD': 'x' } }, { lifetimeMs: 60_000, env: { OK: 'nul\u0000' } }, { lifetimeMs: 60_000, env: { BIG: 'x'.repeat(131_073) } },
      { lifetimeMs: 60_000, ports: [0] }, { lifetimeMs: 60_000, ports: [80, 80] }, { lifetimeMs: 60_000, ports: Array.from({ length: 17 }, (_, index) => 3_000 + index) },
      { lifetimeMs: 60_000, cpus: 0 }, { lifetimeMs: 60_000, memoryMiB: 8 }, { lifetimeMs: 60_000, image: 'has space' },
      { lifetimeMs: 60_000, labels: { Upper: 'x' } }, { lifetimeMs: 60_000, labels: Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`l${index}`, 'x'])) },
    ]) expect(await failure(() => sandboxes.create(options as never))).toMatchObject({ code: expect.stringMatching(/INVALID_INPUT/u) });
    expect(created).toHaveLength(0);
    await sandboxes.create({ lifetimeMs: 60_000, env: { TOKEN: 'secret' }, ports: [3_000], cpus: 2, memoryMiB: 512, image: 'node:24', labels: { run: 'r1' } });
    expect(created[0]).toMatchObject({ lifetimeMs: 60_000, env: { TOKEN: 'secret' }, ports: [3_000], cpus: 2, memoryMiB: 512, image: 'node:24', labels: { team: 'a', run: 'r1' } });
    const { provider: portless } = fakeProvider({ features: { ports: false } });
    expect(await failure(() => createSandboxes(portless, limits).create({ lifetimeMs: 60_000, ports: [3_000] }))).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('bounds how many sandboxes are alive, counting those being created, and frees a slot on release', async () => {
    let open!: () => void; const gate = new Promise<void>(resolve => { open = resolve; });
    const { provider, released } = fakeProvider({ create: () => gate });
    const sandboxes = createSandboxes(provider, limits);
    const first = sandboxes.create({ lifetimeMs: 60_000 }); const second = sandboxes.create({ lifetimeMs: 60_000 });
    expect(sandboxes.active).toBe(2);
    expect(await failure(() => sandboxes.create({ lifetimeMs: 60_000 }))).toMatchObject({ code: 'LIMIT_EXCEEDED' });
    open();
    const box = await first; await second;
    await box.release(); await box.release();
    expect(released).toEqual(['box-1']);
    expect(sandboxes.active).toBe(1);
    await sandboxes.create({ lifetimeMs: 60_000 });
    await sandboxes.close();
    expect(released).toHaveLength(3);
    expect(await failure(() => sandboxes.create({ lifetimeMs: 60_000 }))).toMatchObject({ message: expect.stringContaining('closed') });
  });

  it('releases a sandbox the caller stopped waiting for, instead of leaking it', async () => {
    const { provider, released } = fakeProvider({ create: (_spec, signal) => new Promise(resolve => setTimeout(resolve, 50)).then(() => { void signal; }) });
    const sandboxes = createSandboxes(provider, limits);
    const controller = new AbortController();
    const pending = sandboxes.create({ lifetimeMs: 60_000, signal: controller.signal });
    controller.abort();
    expect(await failure(() => pending)).toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(released).toEqual(['box-1']));
    expect(sandboxes.active).toBe(0);
  });

  it('times out a provider that does not answer', async () => {
    const { provider } = fakeProvider({ create: (_spec, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) });
    expect(await failure(() => createSandboxes(provider, { ...limits, callTimeoutMs: 20 }).create({ lifetimeMs: 60_000 }))).toMatchObject({ reason: 'timeout' });
  });

  it('ends a sandbox at its lifetime: calls fail as gone and it is released', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const { provider, released } = fakeProvider();
      const box = await createSandboxes(provider, limits).create({ lifetimeMs: 5_000 });
      expect(box.ended).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(box.ended).toBe(true);
      expect(released).toEqual(['box-1']);
      expect(await failure(() => box.exec(['true']))).toMatchObject({ reason: 'gone' });
      expect(await failure(() => box.readFile('a'))).toMatchObject({ reason: 'gone' });
    } finally { vi.useRealTimers(); }
  });

  it('keeps counting a sandbox whose release failed, and releases it again on close', async () => {
    let fail = true;
    const { provider } = fakeProvider({ backend: { release: async () => { if (fail) throw new SandboxError('unavailable'); } } });
    const sandboxes = createSandboxes(provider, limits);
    const box = await sandboxes.create({ lifetimeMs: 60_000 });
    expect(await failure(() => box.release())).toMatchObject({ reason: 'unavailable' });
    expect(sandboxes.active).toBe(1);
    expect(await failure(() => box.exec(['true']))).toMatchObject({ reason: 'gone' });
    fail = false;
    await sandboxes.close();
    expect(sandboxes.active).toBe(0);
  });

  it('treats a sandbox the provider already ended as released', async () => {
    const { provider } = fakeProvider({ backend: { release: async () => { throw sandboxHttpFailure(404); } } });
    const sandboxes = createSandboxes(provider, limits);
    await (await sandboxes.create({ lifetimeMs: 60_000 })).release();
    expect(sandboxes.active).toBe(0);
  });
});

describe('Sandbox.exec', () => {
  it('runs arguments in the workdir with the environment and input given, and decodes the output', async () => {
    const { provider, calls } = fakeProvider({ exec: async (_command, options) => ({ exitCode: 3, stdout: bytes('out é'), stderr: bytes(new TextDecoder().decode(options.stdin)) }) });
    const box = await createSandboxes(provider, limits).create({ lifetimeMs: 60_000 });
    const result = await box.exec(['node', 'x.js'], { cwd: 'src', env: { A: '1' }, stdin: 'input' });
    expect(result).toMatchObject({ exitCode: 3, timedOut: false, stdout: 'out é', stderr: 'input', truncated: false });
    expect(calls[0]).toMatchObject({ command: ['node', 'x.js'], options: { cwd: '/work/src', env: { A: '1' } } });
    expect(new TextDecoder().decode(calls[0]!.options.stdin)).toBe('input');
    await box.exec(['true']);
    expect(calls[1]!.options).toMatchObject({ cwd: '/work', env: {} }); expect(calls[1]!.options.stdin).toBeUndefined();
  });

  it('refuses bad commands, and input on providers that cannot take it', async () => {
    const { provider } = fakeProvider();
    const box = await createSandboxes(provider, limits).create({ lifetimeMs: 60_000 });
    for (const command of [[], [''], ['a\u0000b'], 'ls' as never, ['x'.repeat(131_073)]]) expect(await failure(() => box.exec(command))).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await failure(() => box.exec(['true'], { timeoutMs: 0 }))).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await failure(() => box.exec(['true'], { timeoutMs: 1_800_001 }))).toMatchObject({ code: 'INVALID_INPUT' });
    const { provider: noStdin } = fakeProvider({ features: { stdin: false } });
    const other = await createSandboxes(noStdin, limits).create({ lifetimeMs: 60_000 });
    expect(await failure(() => other.exec(['cat'], { stdin: 'x' }))).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('standard input') });
  });

  it('stops a command at its timeout and reports it timed out, without an exit code', async () => {
    let stopped = false;
    const { provider } = fakeProvider({ exec: (_command, options) => new Promise(resolve => {
      options.signal.addEventListener('abort', () => { stopped = true; resolve({ stdout: bytes('partial'), stderr: new Uint8Array(0) }); });
    }) });
    const box = await createSandboxes(provider, limits).create({ lifetimeMs: 60_000 });
    const result = await box.exec(['sleep', '100'], { timeoutMs: 20 });
    expect(stopped).toBe(true);
    expect(result).toMatchObject({ timedOut: true, stdout: 'partial' });
    expect(result.exitCode).toBeUndefined();
  });

  it('gives up on a provider that does not stop the command after its timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { provider } = fakeProvider({ exec: () => new Promise(() => undefined) });
      const box = await createSandboxes(provider, limits).create({ lifetimeMs: 600_000 });
      const pending = box.exec(['sleep', '100'], { timeoutMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_000 + 10_000);
      expect(await pending).toMatchObject({ timedOut: true, stdout: '' });
    } finally { vi.useRealTimers(); }
  });

  it('cancels with the caller, stopping the command', async () => {
    let stopped = false;
    const { provider } = fakeProvider({ exec: (_command, options) => new Promise(resolve => {
      options.signal.addEventListener('abort', () => { stopped = true; resolve({ stdout: new Uint8Array(0), stderr: new Uint8Array(0) }); });
    }) });
    const box = await createSandboxes(provider, limits).create({ lifetimeMs: 60_000 });
    const controller = new AbortController();
    const pending = box.exec(['sleep', '100'], { signal: controller.signal });
    controller.abort();
    expect(await failure(() => pending)).toMatchObject({ code: 'CANCELLED' });
    expect(stopped).toBe(true);
    expect(await failure(() => box.exec(['true'], { signal: controller.signal }))).toMatchObject({ code: 'CANCELLED' });
  });

  it('keeps at most maxOutputBytes of each stream, and refuses results that are not valid', async () => {
    let result: unknown = { exitCode: 0, stdout: bytes('x'.repeat(100)), stderr: bytes('y') };
    const { provider } = fakeProvider({ exec: async () => result as BackendExecResult });
    const box = await createSandboxes(provider, { ...limits, maxOutputBytes: 10 }).create({ lifetimeMs: 60_000 });
    expect(await box.exec(['x'])).toMatchObject({ stdout: 'x'.repeat(10), stderr: 'y', truncated: true });
    for (const bad of [undefined, { exitCode: 0, stdout: 'text', stderr: new Uint8Array(0) }, { exitCode: 1.5, stdout: new Uint8Array(0), stderr: new Uint8Array(0) },
      { stdout: new Uint8Array(0), stderr: new Uint8Array(0) }]) {
      result = bad;
      expect(await failure(() => box.exec(['x']))).toMatchObject({ reason: 'invalid_response' });
    }
  });

  it('maps a provider failure without its text', async () => {
    const { provider } = fakeProvider({ exec: async () => { throw new Error('secret provider detail'); } });
    const box = await createSandboxes(provider, limits).create({ lifetimeMs: 60_000 });
    const error = await failure(() => box.exec(['x']));
    expect(error).toMatchObject({ reason: 'invalid_response' }); expect(error.message).not.toContain('secret');
  });
});

describe('Sandbox files, ports and desktop', () => {
  it('reads, writes, lists and removes files by checked paths', async () => {
    const { provider } = fakeProvider();
    const box = await createSandboxes(provider, { ...limits, maxFileBytes: 16 }).create({ lifetimeMs: 60_000 });
    await box.writeFile('a.txt', 'hello');
    expect(new TextDecoder().decode(await box.readFile('/work/a.txt'))).toBe('hello');
    expect(await box.readFile('missing')).toBeUndefined();
    expect(await box.listFiles()).toEqual([{ name: 'a.txt', type: 'file', size: 5 }]);
    expect(await box.listFiles('/nowhere')).toBeUndefined();
    await box.removeFile('a.txt');
    expect(await box.readFile('a.txt')).toBeUndefined();
    expect(await failure(() => box.writeFile('big', 'x'.repeat(17)))).toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(await failure(() => box.writeFile('/', 'x'))).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await failure(() => box.removeFile('/'))).toMatchObject({ code: 'INVALID_INPUT' });
    expect(await failure(() => box.readFile('a', { maxBytes: 17 }))).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('refuses a provider\'s file results that break the contract', async () => {
    let listing: unknown = [];
    const { provider } = fakeProvider({ backend: { readFile: async () => bytes('x'.repeat(20)), listFiles: async () => listing as never } });
    const box = await createSandboxes(provider, { ...limits, maxFileBytes: 16 }).create({ lifetimeMs: 60_000 });
    expect(await failure(() => box.readFile('a'))).toMatchObject({ code: 'LIMIT_EXCEEDED' });
    for (const bad of [[{ name: '../x', type: 'file', size: 1 }], [{ name: 'a', type: 'link', size: 1 }], [{ name: 'a\nb', type: 'file', size: 1 }], [{ name: 'a', type: 'file', size: -1 }], 'x']) {
      listing = bad;
      expect(await failure(() => box.listFiles())).toMatchObject({ reason: 'invalid_response' });
    }
    listing = [{ name: 'b', type: 'file', size: 1 }, { name: 'a', type: 'directory', size: 0, modified: 5 }];
    expect(await box.listFiles()).toEqual([{ name: 'a', type: 'directory', size: 0, modified: 5 }, { name: 'b', type: 'file', size: 1 }]);
    listing = [{ name: 'a', type: 'file', size: 1 }, { name: 'b', type: 'file', size: 1 }];
    expect(await failure(() => box.listFiles(undefined, { limit: 1 }))).toMatchObject({ reason: 'invalid_response' });
  });

  it('gives URLs only for ports opened at creation, and only real URLs', async () => {
    let url = 'https://3000-box.example.test/';
    const { provider } = fakeProvider({ backend: { url: async () => url } });
    const box = await createSandboxes(provider, limits).create({ lifetimeMs: 60_000, ports: [3_000] });
    expect(await box.url(3_000)).toBe('https://3000-box.example.test/');
    expect(await failure(() => box.url(4_000))).toMatchObject({ code: 'INVALID_INPUT' });
    url = 'javascript:alert(1)';
    expect(await failure(() => box.url(3_000))).toMatchObject({ reason: 'invalid_response' });
    const { provider: portless } = fakeProvider({ features: { ports: false } });
    expect(await failure(async () => (await createSandboxes(portless, limits).create({ lifetimeMs: 60_000 })).url(3_000))).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('checks desktop actions and what the desktop returns', async () => {
    const actions: unknown[] = [];
    const desktop: SandboxDesktop = {
      size: async () => ({ width: 1024, height: 768 }),
      screenshot: async () => ({ data: png, mediaType: 'image/png' }),
      click: async (x, y, options) => { actions.push(['click', x, y, options.button, options.double]); },
      move: async (x, y) => { actions.push(['move', x, y]); },
      scroll: async (x, y, options) => { actions.push(['scroll', x, y, options.dx, options.dy]); },
      type: async text => { actions.push(['type', text]); },
      key: async keys => { actions.push(['key', keys]); },
    };
    const { provider } = fakeProvider({ desktop });
    const box = await createSandboxes(provider, limits).create({ lifetimeMs: 60_000 });
    await box.desktop!.click(10, 20, { button: 'right', double: true }); await box.desktop!.scroll(1, 2, { dy: -3 });
    await box.desktop!.type('hi'); await box.desktop!.key('ctrl+c');
    expect(actions).toEqual([['click', 10, 20, 'right', true], ['scroll', 1, 2, 0, -3], ['type', 'hi'], ['key', 'ctrl+c']]);
    expect(await box.desktop!.viewUrl()).toBeUndefined();
    for (const bad of [() => box.desktop!.click(-1, 0), () => box.desktop!.click(1.5, 0), () => box.desktop!.click(0, 0, { button: 'x' as never }),
      () => box.desktop!.type(''), () => box.desktop!.key('ctrl+c; rm -rf /'), () => box.desktop!.scroll(0, 0, { dy: 101 })]) {
      expect(await failure(bad)).toMatchObject({ code: 'INVALID_INPUT' });
    }
    const { provider: noDesktop } = fakeProvider();
    expect((await createSandboxes(noDesktop, limits).create({ lifetimeMs: 60_000 })).desktop).toBeUndefined();
    for (const shot of [{ data: new Uint8Array(0), mediaType: 'image/png' }, { data: png, mediaType: 'image/jpeg' }, { data: bytes('not an image'), mediaType: 'image/png' }]) {
      const { provider: broken } = fakeProvider({ desktop: { ...desktop, screenshot: async () => shot as never } });
      expect(await failure(async () => (await createSandboxes(broken, limits).create({ lifetimeMs: 60_000 })).desktop!.screenshot())).toMatchObject({ reason: 'invalid_response' });
    }
  });
});

describe('sandboxTools', () => {
  const run = async (tools: AnyTool[], id: string, input: JsonValue, runId?: string) =>
    (await testTool(tools.find(item => item.id === id)!, input, runId === undefined ? {} : { runId })).outcome;

  it('only reads unless each further power is enabled, each with its own permission', async () => {
    const { provider } = fakeProvider();
    const box = await createSandboxes(provider, limits).create({ lifetimeMs: 60_000, ports: [3_000] });
    expect(sandboxTools(box, { name: 'dev' }).map(tool => tool.id)).toEqual(['dev.read', 'dev.list']);
    const tools = sandboxTools(box, { name: 'dev', exec: true, write: true, ports: true });
    expect(tools.map(tool => [tool.id, tool.capabilities, tool.effects])).toEqual([
      ['dev.read', ['sandbox:dev:read'], 'read'], ['dev.list', ['sandbox:dev:read'], 'read'], ['dev.exec', ['sandbox:dev:exec'], 'write'],
      ['dev.write', ['sandbox:dev:write'], 'write'], ['dev.remove', ['sandbox:dev:write'], 'write'], ['dev.url', ['sandbox:dev:ports'], 'read']]);
    expect(() => sandboxTools(box, { name: 'dev', desktop: true })).toThrow(/no desktop/u);
    expect(() => sandboxTools(box, { name: 'Dev' })).toThrow(/name/u);
    expect(() => sandboxTools(box, { name: 'dev', execTimeoutMs: 0 })).toThrow(/execTimeoutMs/u);
  });

  it('runs commands through sh -c, bounded, and clips long output in the middle', async () => {
    const { provider, calls } = fakeProvider({ exec: async () => ({ exitCode: 1, stdout: bytes(`${'a'.repeat(50)}${'b'.repeat(50)}`), stderr: bytes('err') }) });
    const box = await createSandboxes(provider, limits).create({ lifetimeMs: 60_000 });
    const tools = sandboxTools(box, { name: 'dev', exec: true, maxOutputBytes: 20, execTimeoutMs: 10_000 });
    const outcome = await run(tools, 'dev.exec', { command: 'npm test', cwd: 'app', timeoutSeconds: 99 });
    expect(outcome).toMatchObject({ status: 'succeeded', output: { exitCode: 1, timedOut: false, stderr: 'err' } });
    const stdout = (outcome as { output: { stdout: string } }).output.stdout;
    expect(stdout.startsWith('a'.repeat(10)) && stdout.endsWith('b'.repeat(10)) && stdout.includes('80 bytes left out')).toBe(true);
    expect(calls[0]).toMatchObject({ command: ['sh', '-c', 'npm test'], options: { cwd: '/work/app' } });
    expect(await run(tools, 'dev.exec', { command: 'npm test', extra: 1 } as never)).toMatchObject({ status: 'failed' });
  });

  it('is denied without the permission', async () => {
    const { provider, calls } = fakeProvider();
    const box = await createSandboxes(provider, limits).create({ lifetimeMs: 60_000 });
    const tools = sandboxTools(box, { name: 'dev', exec: true });
    const tool = tools.find(item => item.id === 'dev.exec')!;
    const { outcome } = await testTool(tool, { command: 'rm -rf /' }, { permissions: toolGrants(tool).filter(grant => !grant.startsWith('sandbox:')) });
    expect(outcome).toMatchObject({ status: 'blocked', error: { code: 'PERMISSION_DENIED' } });
    expect(calls).toHaveLength(0);
  });

  it('reads text as text and other bytes as base64, in parts', async () => {
    const { provider } = fakeProvider();
    const box = await createSandboxes(provider, limits).create({ lifetimeMs: 60_000 });
    await box.writeFile('t.txt', 'abcdef'); await box.writeFile('b.bin', new Uint8Array([0xff, 0xfe]));
    const tools = sandboxTools(box, { name: 'dev', write: true, maxReadBytes: 4 });
    expect(await run(tools, 'dev.read', { path: 't.txt' })).toMatchObject({ output: { found: true, text: 'abcd', size: 6, nextOffset: 4 } });
    expect(await run(tools, 'dev.read', { path: 't.txt', offset: 4 })).toMatchObject({ output: { text: 'ef' } });
    expect(await run(tools, 'dev.read', { path: 'b.bin' })).toMatchObject({ output: { base64: '//4=' } });
    expect(await run(tools, 'dev.read', { path: 'none' })).toMatchObject({ output: { found: false } });
    expect(await run(tools, 'dev.write', { path: 'n.txt', text: 'x' })).toMatchObject({ output: { size: 1 } });
    expect(await run(tools, 'dev.write', { path: 'n.txt' })).toMatchObject({ status: 'failed', error: { code: 'INVALID_INPUT' } });
    expect(await run(tools, 'dev.write', { path: 'n.txt', text: 'a', base64: 'YQ==' })).toMatchObject({ status: 'failed', error: { code: 'INVALID_INPUT' } });
    expect(await run(tools, 'dev.list', {})).toMatchObject({ output: { found: true, entries: expect.arrayContaining([{ name: 'n.txt', type: 'file', size: 1 }]) } });
  });

  it('works in the run\'s own sandbox, created on first use and released when the run ends', async () => {
    const { provider, created, released } = fakeProvider();
    const sandboxes = createSandboxes(provider, limits);
    const perRun = sandboxPerRun(sandboxes, ({ runId }) => ({ lifetimeMs: 60_000, labels: { run: runId } }));
    const tools = sandboxTools(perRun.source, { name: 'dev', exec: true });
    await run(tools, 'dev.exec', { command: 'one' }, 'run-a'); await run(tools, 'dev.exec', { command: 'two' }, 'run-a');
    await run(tools, 'dev.exec', { command: 'three' }, 'run-b');
    expect(created.map(spec => spec.labels['run'])).toEqual(['run-a', 'run-b']);
    expect(perRun.runs).toEqual(['run-a', 'run-b']);
    await perRun.release('run-a'); await perRun.release('run-a'); await perRun.release('never');
    expect(released).toEqual(['box-1']); expect(perRun.runs).toEqual(['run-b']);
  });

  it('returns a screenshot as media the model can see', async () => {
    const desktop: SandboxDesktop = { size: async () => ({ width: 800, height: 600 }), screenshot: async () => ({ data: png, mediaType: 'image/png' }),
      click: async () => undefined, move: async () => undefined, scroll: async () => undefined, type: async () => undefined, key: async () => undefined };
    const { provider } = fakeProvider({ desktop });
    const box = await createSandboxes(provider, limits).create({ lifetimeMs: 60_000 });
    const tools = sandboxTools(box, { name: 'pc', desktop: true });
    expect(tools.map(tool => tool.id)).toEqual(['pc.read', 'pc.list', 'pc.screenshot', 'pc.click', 'pc.scroll', 'pc.type', 'pc.key']);
    const outcome = await run(tools, 'pc.screenshot', {});
    expect(outcome).toMatchObject({ status: 'succeeded', output: { width: 800, height: 600 }, media: [{ mediaType: 'image/png' }] });
    expect(await run(tools, 'pc.click', { x: 5, y: 6, button: 'side' })).toMatchObject({ status: 'failed', error: { code: 'INVALID_INPUT' } });
  });
});

describe('sandboxScripts and parseSandboxListing', () => {
  it('parses the list script\'s output, leaving out names it cannot list safely', () => {
    const output = new TextEncoder().encode(['d', '4096', '1759312800', 'src', 'f', '12', '1759312801', 'with space.txt', 'f', '1', '0', 'bad\nname', 'o', '7', '5', 'link', ''].join('\u0000'));
    expect(parseSandboxListing(output)).toEqual([
      { name: 'src', type: 'directory', size: 0, modified: 1_759_312_800_000 }, { name: 'with space.txt', type: 'file', size: 12, modified: 1_759_312_801_000 },
      { name: 'link', type: 'other', size: 7, modified: 5_000 }]);
    expect(parseSandboxListing(new Uint8Array(0))).toEqual([]);
    expect(() => parseSandboxListing(new TextEncoder().encode('f\u000012\u0000'))).toThrow(SandboxError);
  });

  it('tags commands by one variable that the kill script looks for', () => {
    expect(sandboxScripts.tagVariable).toBe('MAYURA_SANDBOX_EXEC');
    expect(sandboxScripts.kill).toContain('grep -qxF "MAYURA_SANDBOX_EXEC=$1"');
    expect(Object.isFrozen(sandboxScripts)).toBe(true);
  });
});
