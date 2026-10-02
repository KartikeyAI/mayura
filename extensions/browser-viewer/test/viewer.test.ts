import { describe, expect, it } from 'vitest';
import { browserViewer, serveBrowserViewer } from '../src/index.js';
import { fakeCdp, stubBrowser, until } from './fake.js';

const at = (path: string, init?: RequestInit) => new Request(new URL(path, 'http://viewer.test'), init);
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => at(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
/** Reads the first part of an MJPEG stream, however its bytes arrive. */
async function firstPart(response: Response): Promise<{ head: string; body: Uint8Array; reader: ReadableStreamDefaultReader<Uint8Array> }> {
  const reader = response.body!.getReader(); let bytes = new Uint8Array();
  for (;;) {
    const text = new TextDecoder('latin1').decode(bytes); const end = text.indexOf('\r\n\r\n');
    const length = Number(/Content-Length: (\d+)/u.exec(text)?.[1] ?? Number.NaN);
    if (end >= 0 && bytes.byteLength >= end + 4 + length + 2) return { head: text.slice(0, end + 4), body: bytes.slice(end + 4, end + 4 + length), reader };
    const { value, done } = await reader.read();
    if (done) throw new Error('the stream ended');
    bytes = new Uint8Array([...bytes, ...value]);
  }
}

describe('browserViewer', () => {
  it('refuses settings it cannot use', () => {
    for (const [option, value] of [['basePath', 'viewer'], ['basePath', '/viewer'], ['basePath', '/a b/'], ['frameAncestors', ['*']], ['frameAncestors', ["'self'"]],
      ['maxViewersPerShare', 0], ['maxShares', 1_000], ['maxInputPerSecond', 0], ['maxFps', 99], ['quality', 0], ['webSocket', 'x']] as const) {
      expect(() => browserViewer({ [option]: value } as never), option).toThrow(new RegExp(option, 'u'));
    }
  });

  it('shares a browser by a link with a secret token, and nothing else is answered', async () => {
    const viewer = browserViewer({ basePath: '/viewer/', webSocket: fakeCdp().factory });
    const { browser } = stubBrowser();
    const share = await viewer.share(browser);
    expect(share.path).toMatch(/^\/viewer\/v\/[A-Za-z0-9_-]{43}\/$/u);
    expect(share).toMatchObject({ interact: false });
    expect(share.expiresAt - Date.now()).toBeGreaterThan(3_590_000);
    expect(await viewer.handle(at('/elsewhere'))).toBeUndefined();
    expect(await viewer.handle(at('/viewer/other'))).toBeUndefined();
    for (const path of ['/viewer/v/', '/viewer/v/short/', `/viewer/v/${'A'.repeat(43)}/`, `${share.path}x`, `${share.path.slice(0, -1)}`]) {
      expect((await viewer.handle(at(path)))!.status, path).toBe(404);
    }
    const page = (await viewer.handle(at(share.path)))!;
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    const policy = page.headers.get('content-security-policy')!;
    expect(policy).toContain("frame-ancestors 'none'"); expect(policy).toContain("default-src 'none'");
    const html = await page.text();
    expect(html).toContain('src="stream"');
    // View only: no script at all.
    expect(html).not.toContain('<script');
    expect((await viewer.handle(at(share.path, { method: 'POST' })))!.status).toBe(405);
    share.revoke();
    expect((await viewer.handle(at(share.path)))!.status).toBe(404);
    expect(viewer.size).toBe(0);
  });

  it('streams the browser as MJPEG, to a few viewers at once, and ends the stream when the link is revoked', async () => {
    const cdp = fakeCdp();
    const viewer = browserViewer({ webSocket: cdp.factory, maxViewersPerShare: 1 });
    const share = await viewer.share(stubBrowser().browser);
    const stream = (await viewer.handle(at(`${share.path}stream`)))!;
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toBe('multipart/x-mixed-replace; boundary=mayura-frame');
    expect((await viewer.handle(at(`${share.path}stream`)))!.status).toBe(429);
    cdp.frame('T1');
    const { head, body, reader } = await firstPart(stream);
    expect(head).toBe('--mayura-frame\r\nContent-Type: image/jpeg\r\nContent-Length: 4\r\n\r\n');
    expect(body).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    const next = reader.read();
    share.revoke();
    expect(await next).toEqual({ done: true, value: undefined });
    expect(cdp.open).toBe(0);
  });

  it('ends a link when its browser ends or it expires, and stops a stream whose reader went away', async () => {
    const cdp = fakeCdp();
    const viewer = browserViewer({ webSocket: cdp.factory });
    const one = stubBrowser();
    const share = await viewer.share(one.browser);
    one.state.ended = true;
    expect((await viewer.handle(at(share.path)))!.status).toBe(404);
    await expect(viewer.share(one.browser)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const brief = await viewer.share(stubBrowser().browser, { expiresInMs: 1_000 });
    expect((await viewer.handle(at(brief.path)))!.status).toBe(200);
    const watching = (await viewer.handle(at(`${brief.path}stream`)))!.body!.getReader();
    const ending = watching.read();
    await new Promise(resolve => setTimeout(resolve, 1_100));
    expect((await viewer.handle(at(brief.path)))!.status).toBe(404);
    // What was being watched ends with the link.
    expect(await ending).toEqual({ done: true, value: undefined });
    const kept = await viewer.share(stubBrowser().browser);
    const stream = (await viewer.handle(at(`${kept.path}stream`)))!;
    await until(() => cdp.open === 1);
    await stream.body!.cancel();
    await until(() => cdp.open === 0);
  });

  it('answers a browser it cannot reach as gone, and stops one whose link was revoked while connecting', async () => {
    const unreachable = browserViewer({ webSocket: fakeCdp({ fail: true }).factory });
    const share = await unreachable.share(stubBrowser().browser);
    expect((await unreachable.handle(at(`${share.path}stream`)))!.status).toBe(410);
    const slow = fakeCdp({ openAfterMs: 300 });
    const viewer = browserViewer({ webSocket: slow.factory });
    const revoked = await viewer.share(stubBrowser().browser);
    const answer = viewer.handle(at(`${revoked.path}stream`));
    await until(() => slow.sockets.length === 1);
    revoked.revoke();
    expect((await answer)!.status).toBe(404);
    await until(() => slow.open === 0);
  });

  it('refuses shares it cannot keep to', async () => {
    const viewer = browserViewer({ maxShares: 1, webSocket: fakeCdp().factory });
    await expect(viewer.share(stubBrowser({ unjoinable: true }).browser)).rejects.toThrow(/cannot be joined/u);
    await expect(viewer.share({} as never)).rejects.toThrow(/needs a browser/u);
    for (const options of [{ interact: 1 }, { expiresInMs: 10 }, { expiresInMs: 90_000_000 }]) await expect(viewer.share(stubBrowser().browser, options as never), JSON.stringify(options)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    const first = stubBrowser();
    await viewer.share(first.browser);
    await expect(viewer.share(stubBrowser().browser)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    // A share whose browser ended makes room.
    first.state.ended = true;
    await viewer.share(stubBrowser().browser);
    await expect(viewer.share(stubBrowser().browser)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    // Closing revokes the links still open.
    expect(viewer.size).toBe(1);
    viewer.close();
    expect(viewer.size).toBe(0);
    await expect(viewer.share(stubBrowser().browser)).rejects.toThrow(/closed/u);
  });

  it('takes input only on interactive links, only as JSON from its own page, bounded, into the page being watched', async () => {
    const cdp = fakeCdp();
    const viewer = browserViewer({ webSocket: cdp.factory, maxInputPerSecond: 4, frameAncestors: ['https://app.example'] });
    const view = await viewer.share(stubBrowser().browser);
    expect((await viewer.handle(post(`${view.path}input`, { type: 'text', text: 'x' })))!.status).toBe(403);
    const share = await viewer.share(stubBrowser().browser, { interact: true });
    const page = (await viewer.handle(at(share.path)))!;
    const html = await page.text();
    const nonce = /<script nonce="([^"]+)">/u.exec(html)?.[1];
    expect(nonce).toBeDefined();
    expect(page.headers.get('content-security-policy')).toContain(`script-src 'nonce-${nonce}'`);
    expect(page.headers.get('content-security-policy')).toContain('frame-ancestors https://app.example');
    const unwatched = (await viewer.handle(post(`${share.path}input`, { type: 'text', text: 'x' })))!;
    expect(unwatched.status).toBe(409); expect(await unwatched.text()).toBe('Nothing is being watched.');
    const stream = (await viewer.handle(at(`${share.path}stream`)))!;
    cdp.frame('T1'); await firstPart(stream);
    expect((await viewer.handle(at(`${share.path}input`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })))!.status).toBe(415);
    expect((await viewer.handle(post(`${share.path}input`, { type: 'text', text: 'x' }, { 'sec-fetch-site': 'cross-site' })))!.status).toBe(403);
    expect((await viewer.handle(post(`${share.path}input`, { type: 'text', text: 'x'.repeat(5_000) })))!.status).toBe(413);
    expect((await viewer.handle(at(`${share.path}input`, { method: 'GET' })))!.status).toBe(405);
    expect((await viewer.handle(post(`${share.path}input`, { type: 'text', text: 'hi' }, { 'sec-fetch-site': 'same-origin' })))!.status).toBe(204);
    const refused = (await viewer.handle(post(`${share.path}input`, { type: 'drag' })))!;
    expect(refused.status).toBe(400); expect(await refused.text()).toMatch(/type is mouse/u);
    expect((await viewer.handle(post(`${share.path}input`, { type: 'text', text: 'again' })))!.status).toBe(429);
    expect(cdp.sent.filter(item => item.method === 'Input.insertText').map(item => item.params['text'])).toEqual(['hi']);
    viewer.close();
    // Not JSON, and what the browser refuses, are told apart.
    const refusing = fakeCdp({ refuse: ['Input.insertText'] });
    const other = browserViewer({ webSocket: refusing.factory });
    const used = await other.share(stubBrowser().browser, { interact: true });
    const watched = (await other.handle(at(`${used.path}stream`)))!;
    refusing.frame('T1'); await firstPart(watched);
    expect((await other.handle(at(`${used.path}input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' })))!.status).toBe(400);
    expect((await other.handle(post(`${used.path}input`, { type: 'text', text: 'hi' })))!.status).toBe(409);
    other.close();
  });
});

describe('serveBrowserViewer', () => {
  it('listens on this machine only unless told otherwise', async () => {
    await expect(serveBrowserViewer({ host: '0.0.0.0' })).rejects.toThrow(/remote/u);
    await expect(serveBrowserViewer({ host: '' })).rejects.toThrow(/host/u);
    await expect(serveBrowserViewer({ port: 70_000 })).rejects.toMatchObject({ code: 'INVALID_CONFIG', message: expect.stringContaining('port') });
    for (const publicUrl of ['http://viewer.example', 'https://viewer.example/path', 'https://u:p@viewer.example', 'nope']) {
      await expect(serveBrowserViewer({ publicUrl }), publicUrl).rejects.toThrow(/publicUrl/u);
    }
  });

  it('serves pages and streams over HTTP, with links at its address or the public one', async () => {
    const cdp = fakeCdp();
    const served = await serveBrowserViewer({ webSocket: cdp.factory });
    try {
      expect(served.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);
      const share = await served.share(stubBrowser().browser, { interact: true });
      expect(share.url).toBe(new URL(share.path, served.url).href);
      expect((await fetch(share.url)).status).toBe(200);
      expect((await fetch(new URL('/nothing', served.url))).status).toBe(404);
      const stream = await fetch(`${share.url}stream`);
      cdp.frame('T1');
      const { body, reader } = await firstPart(stream);
      expect(body).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
      expect((await fetch(`${share.url}input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'text', text: 'hi' }) })).status).toBe(204);
      expect((await fetch(`${share.url}input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(10_000) })).status).toBe(413);
      await reader.cancel();
      await until(() => cdp.open === 0);
    } finally { await served.close(); }
    // A browser that fails the viewer is an error page, not a crash.
    const failing = await serveBrowserViewer({ webSocket: cdp.factory });
    try {
      const broken = stubBrowser();
      const share = await failing.share(broken.browser);
      Object.defineProperty(broken.browser, 'ended', { get: () => { throw new Error('broken'); } });
      expect((await fetch(share.url)).status).toBe(500);
    } finally { await failing.close(); }
    const proxied = await serveBrowserViewer({ publicUrl: 'https://viewer.example', webSocket: cdp.factory });
    try {
      expect((await proxied.share(stubBrowser().browser)).url).toMatch(/^https:\/\/viewer\.example\/v\/[A-Za-z0-9_-]{43}\/$/u);
    } finally { await proxied.close(); }
  });
});
