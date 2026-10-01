import { describe, expect, it } from 'vitest';
import { createSandboxes, sandboxTools } from 'mayura/sandbox';
import { testTool } from 'mayura/testing';
import { e2bDesktopSandboxes, xdotoolKeys } from '../src/index.js';

const encoder = new TextEncoder();
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
function envelope(flags: number, message: unknown): Uint8Array {
  const body = encoder.encode(JSON.stringify(message)); const frame = new Uint8Array(5 + body.byteLength);
  frame[0] = flags; new DataView(frame.buffer).setUint32(1, body.byteLength); frame.set(body, 5);
  return frame;
}
interface Ran { readonly command: readonly string[]; readonly envs: Record<string, string> }
/** E2B's APIs, running each command by `answer`: its exit code and stdout. */
function fakeE2b(answer: (command: readonly string[]) => { exitCode?: number; stdout?: string } = () => ({})) {
  const ran: Ran[] = []; const requests: { method: string; url: URL; json?: Record<string, unknown> }[] = []; const files = new Map<string, Uint8Array>();
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); const url = new URL(request.url); const bytes = new Uint8Array(await request.arrayBuffer());
    const json = request.headers.get('content-type') === 'application/json' && bytes.byteLength ? JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown> : undefined;
    requests.push({ method: request.method, url, ...(json ? { json } : {}) });
    if (url.pathname === '/v2/sandboxes') return Response.json({ sandboxID: 'desk1', envdAccessToken: 'token', domain: 'e2b.app' }, { status: 201 });
    if (url.pathname.startsWith('/sandboxes/')) return new Response(null, { status: 204 });
    if (url.pathname === '/process.Process/Start') {
      const message = JSON.parse(new TextDecoder().decode(bytes.subarray(5))) as { process: { args: string[]; envs: Record<string, string> } };
      // The provider runs every command as sh -c <script> mayura <cwd> <command...>.
      const command = message.process.args.slice(4);
      ran.push({ command, envs: message.process.envs });
      if (command[0] === 'scrot') files.set(command.at(-1)!, png);
      const result = answer(command);
      const frames = [envelope(0, { event: { start: { pid: 5 } } }),
        ...(result.stdout ? [envelope(0, { event: { data: { stdout: btoa(result.stdout) } } })] : []),
        envelope(0, { event: { end: { exited: true, ...(result.exitCode ? { exitCode: result.exitCode } : {}) } } }), envelope(2, {})];
      return new Response(new Blob(frames as BlobPart[]).stream(), { status: 200 });
    }
    if (url.pathname === '/files') {
      const data = files.get(url.searchParams.get('path')!);
      return data ? new Response(data as Uint8Array<ArrayBuffer>) : new Response(null, { status: 404 });
    }
    if (url.pathname === '/filesystem.Filesystem/Stat') return Response.json({ entry: { type: 'FILE_TYPE_FILE' } });
    if (url.pathname === '/filesystem.Filesystem/Remove') { files.delete((json as { path: string }).path); return Response.json({}); }
    return Response.json({});
  }) as typeof globalThis.fetch;
  return { fetch, ran, requests, files };
}
const limits = { maxSandboxes: 2, maxLifetimeMs: 600_000 };

describe('e2bDesktopSandboxes', () => {
  it('refuses configuration it cannot use', () => {
    expect(() => e2bDesktopSandboxes({ apiKey: 'e2b_test_key', resolution: [100, 100] })).toThrow(/resolution/u);
    expect(() => e2bDesktopSandboxes({ apiKey: 'e2b_test_key', dpi: 1 })).toThrow(/dpi/u);
    expect(() => e2bDesktopSandboxes({ apiKey: 'e2b_test_key', liveView: 'on' as never })).toThrow(/liveView/u);
    expect(e2bDesktopSandboxes({ apiKey: 'e2b_test_key' })).toMatchObject({ id: 'e2b-desktop', features: { desktop: true, stdin: true } });
  });

  it('starts the desktop template\'s X server and desktop at the resolution asked for', async () => {
    const fake = fakeE2b();
    const box = await createSandboxes(e2bDesktopSandboxes({ apiKey: 'e2b_test_key', fetch: fake.fetch, resolution: [1280, 800], dpi: 120 }), limits).create({ lifetimeMs: 60_000 });
    expect(fake.requests[0]!.json).toMatchObject({ templateID: 'desktop', allow_internet_access: false });
    expect(fake.requests[0]!.json).not.toHaveProperty('network');
    expect(fake.ran[0]!.command.slice(0, 2)).toEqual(['sh', '-c']);
    expect(fake.ran[0]!.command[2]).toContain('Xvfb :0 -ac -screen 0 "$1x$2x24" -retro -dpi "$3"');
    expect(fake.ran[0]!.command.slice(3)).toEqual(['mayura', '1280', '800', '120']);
    expect(fake.ran[0]!.envs['DISPLAY']).toBe(':0');
    expect(box.desktop).toBeDefined();
  });

  it('releases the sandbox when the desktop does not start', async () => {
    const fake = fakeE2b(command => command[0] === 'sh' ? { exitCode: 3 } : {});
    const error = await createSandboxes(e2bDesktopSandboxes({ apiKey: 'e2b_test_key', fetch: fake.fetch }), limits).create({ lifetimeMs: 60_000 }).catch(caught => caught);
    expect(error).toMatchObject({ reason: 'rejected' });
    expect(fake.requests.at(-1)).toMatchObject({ method: 'DELETE' });
    expect(fake.requests.at(-1)!.url.pathname).toBe('/sandboxes/desk1');
  });

  it('clicks, moves, scrolls, types and presses keys with xdotool, arguments passed as they are', async () => {
    const fake = fakeE2b();
    const box = await createSandboxes(e2bDesktopSandboxes({ apiKey: 'e2b_test_key', fetch: fake.fetch }), limits).create({ lifetimeMs: 60_000 });
    const desktop = box.desktop!;
    await desktop.click(10, 20); await desktop.click(1, 2, { button: 'right', double: true }); await desktop.click(3, 4, { button: 'middle' });
    await desktop.move(5, 6); await desktop.scroll(7, 8, { dy: 3, dx: -2 }); await desktop.scroll(7, 8, { dy: -1 });
    const text = `${'a'.repeat(60)} "$(rm -rf /)" ü`;
    await desktop.type(text); await desktop.key('ctrl+shift+t'); await desktop.key('Enter'); await desktop.key('f5');
    expect(fake.ran.slice(1).map(item => item.command)).toEqual([
      ['xdotool', 'mousemove', '--sync', '10', '20', 'click', '1'],
      ['xdotool', 'mousemove', '--sync', '1', '2', 'click', '--repeat', '2', '3'],
      ['xdotool', 'mousemove', '--sync', '3', '4', 'click', '2'],
      ['xdotool', 'mousemove', '--sync', '5', '6'],
      ['xdotool', 'mousemove', '--sync', '7', '8', 'click', '--repeat', '3', '5', 'click', '--repeat', '2', '6'],
      ['xdotool', 'mousemove', '--sync', '7', '8', 'click', '--repeat', '1', '4'],
      ['xdotool', 'type', '--delay', '12', '--', [...text].slice(0, 50).join('')],
      ['xdotool', 'type', '--delay', '12', '--', [...text].slice(50).join('')],
      ['xdotool', 'key', '--', 'ctrl+shift+t'], ['xdotool', 'key', '--', 'Return'], ['xdotool', 'key', '--', 'F5'],
    ]);
    expect(fake.ran.slice(1).every(item => item.envs['DISPLAY'] === ':0')).toBe(true);
  });

  it('maps key names to X keysyms', () => {
    expect(['ctrl+c', 'Cmd+L', 'alt+Tab', 'esc', 'BackSpace', 'pagedown', 'f12', 'F13x', 'a', 'Return'].map(xdotoolKeys))
      .toEqual(['ctrl+c', 'super+L', 'alt+Tab', 'Escape', 'BackSpace', 'Page_Down', 'F12', 'F13x', 'a', 'Return']);
  });

  it('takes a screenshot with scrot, reads it and removes the file', async () => {
    const fake = fakeE2b(command => command[1] === 'getdisplaygeometry' ? { stdout: '1024 768\n' } : {});
    const box = await createSandboxes(e2bDesktopSandboxes({ apiKey: 'e2b_test_key', fetch: fake.fetch }), limits).create({ lifetimeMs: 60_000 });
    const shot = await box.desktop!.screenshot();
    expect(shot.mediaType).toBe('image/png'); expect([...shot.data]).toEqual([...png]);
    const scrot = fake.ran.find(item => item.command[0] === 'scrot')!;
    expect(scrot.command).toEqual(['scrot', '--pointer', expect.stringMatching(/^\/tmp\/mayura-screenshot-[a-f0-9]{16}\.png$/u)]);
    expect(fake.files.size).toBe(0);
    expect(await box.desktop!.size()).toEqual({ width: 1024, height: 768 });
    const tools = sandboxTools(box, { name: 'pc', desktop: true });
    const { outcome } = await testTool(tools.find(tool => tool.id === 'pc.screenshot')!, {});
    expect(outcome).toMatchObject({ status: 'succeeded', output: { width: 1024, height: 768 }, media: [{ mediaType: 'image/png' }] });
  });

  it('fails a desktop action whose command fails, or whose output is not what xdotool prints', async () => {
    const fake = fakeE2b(command => command[1] === 'getdisplaygeometry' ? { stdout: 'Error: no display' } : command[0] === 'xdotool' ? { exitCode: 1 } : {});
    const box = await createSandboxes(e2bDesktopSandboxes({ apiKey: 'e2b_test_key', fetch: fake.fetch }), limits).create({ lifetimeMs: 60_000 });
    expect(await box.desktop!.click(1, 1).catch(caught => caught)).toMatchObject({ reason: 'rejected' });
    expect(await box.desktop!.size().catch(caught => caught)).toMatchObject({ reason: 'invalid_response' });
  });

  it('has no live view unless asked for', async () => {
    const fake = fakeE2b();
    const box = await createSandboxes(e2bDesktopSandboxes({ apiKey: 'e2b_test_key', fetch: fake.fetch }), limits).create({ lifetimeMs: 60_000 });
    expect(await box.desktop!.viewUrl()).toBeUndefined();
    expect(fake.ran.some(item => item.command[2]?.includes('x11vnc'))).toBe(false);
  });

  it('serves a password-protected live view on a public port, started once', async () => {
    for (const liveView of ['view', 'control'] as const) {
      const fake = fakeE2b();
      const box = await createSandboxes(e2bDesktopSandboxes({ apiKey: 'e2b_test_key', fetch: fake.fetch, liveView }), limits).create({ lifetimeMs: 60_000 });
      expect(fake.requests[0]!.json).toMatchObject({ network: { allowPublicTraffic: true } });
      const url = await box.desktop!.viewUrl();
      expect(await box.desktop!.viewUrl()).toBe(url);
      const started = fake.ran.filter(item => item.command[2]?.includes('x11vnc'));
      expect(started).toHaveLength(1);
      const password = started[0]!.command[4]!;
      expect(password).toMatch(/^[a-f0-9]{8}$/u); expect(started[0]!.command[5]).toBe(liveView);
      expect(started[0]!.command[2]).toContain('_flag=; [ "$2" = view ] && _flag=-viewonly');
      expect(url).toBe(`https://6080-desk1.e2b.app/vnc.html?autoconnect=true&resize=scale&password=${password}${liveView === 'view' ? '&view_only=true' : ''}`);
    }
    const fake = fakeE2b();
    await expect(createSandboxes(e2bDesktopSandboxes({ apiKey: 'e2b_test_key', fetch: fake.fetch, liveView: 'view' }), { ...limits, network: ['none', 'all'] })
      .create({ lifetimeMs: 60_000, network: 'all', ports: [6080] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
