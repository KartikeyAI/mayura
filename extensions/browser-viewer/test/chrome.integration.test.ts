import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowsers, type Browser, type Browsers } from 'mayura/browser';
import { localBrowsers, serveBrowserFixtures, type BrowserFixtureServer } from 'mayura/browser/local';
import { browserScreencast, serveBrowserViewer, type ServedBrowserViewer } from '../src/index.js';

// The viewer on a Mayura browser launched from the Chrome (or Edge) installed here. MAYURA_TEST_BROWSER=chrome or edge.
const channel = process.env['MAYURA_TEST_BROWSER'] as 'chrome' | 'edge' | undefined;
const jpeg = (data: Uint8Array) => data[0] === 0xff && data[1] === 0xd8;

describe.skipIf(channel === undefined)('the viewer on a real browser', { timeout: 120_000 }, () => {
  let fixtures: BrowserFixtureServer; let browsers: Browsers; let browser: Browser; let served: ServedBrowserViewer;
  beforeAll(async () => {
    fixtures = await serveBrowserFixtures();
    browsers = createBrowsers(localBrowsers({ channel: channel! }), { maxBrowsers: 1, maxLifetimeMs: 600_000, origins: [fixtures.allowed] });
    browser = await browsers.open();
    served = await serveBrowserViewer();
  }, 120_000);
  afterAll(async () => { await served?.close(); await browsers?.close(); await fixtures?.close(); });

  it('streams the active tab as JPEG frames, and follows the agent to another tab', async () => {
    await browser.goto(`${fixtures.allowed}/form`);
    const cast = await browserScreencast(browser);
    try {
      const first = await cast.next();
      expect(first).toMatchObject({ mediaType: 'image/jpeg' });
      expect(jpeg(first!.data)).toBe(true);
      expect(first!.width).toBeGreaterThan(300);
      const opened = await browser.newTab(`${fixtures.allowed}/`);
      const tab = 'tab' in opened ? opened.tab : undefined;
      let frame = await cast.next();
      for (let index = 0; index < 50 && frame?.tab !== tab; index++) frame = await cast.next();
      expect(frame?.tab).toBe(tab);
      await browser.closeTab(tab!);
    } finally { cast.close(); }
  });

  it('lets a person use the page through an interactive link, within the browser\'s origins', async () => {
    await browser.goto(`${fixtures.allowed}/form`);
    const share = await served.share(browser, { interact: true });
    const stream = await fetch(`${share.url}stream`);
    expect(stream.headers.get('content-type')).toBe('multipart/x-mixed-replace; boundary=mayura-frame');
    const reader = stream.body!.getReader();
    let seen = new Uint8Array();
    while (seen.byteLength < 4_000) { const { value, done } = await reader.read(); if (done) break; seen = new Uint8Array([...seen, ...value]); }
    expect(new TextDecoder().decode(seen.slice(0, 40))).toContain('--mayura-frame');
    // Click the query box (found by its place on the page), type, and press Enter.
    const box = await browser.evaluate("(() => { const r = document.querySelector('input').getBoundingClientRect(); return [(r.left + r.width / 2) / innerWidth, (r.top + r.height / 2) / innerHeight]; })()");
    const [x, y] = box.value as [number, number];
    const send = (event: unknown) => fetch(`${share.url}input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event) });
    expect((await send({ type: 'mouse', action: 'down', x, y })).status).toBe(204);
    expect((await send({ type: 'mouse', action: 'up', x, y })).status).toBe(204);
    expect((await send({ type: 'text', text: 'from a person' })).status).toBe(204);
    expect((await send({ type: 'key', action: 'down', key: 'Enter' })).status).toBe(204);
    expect((await send({ type: 'key', action: 'up', key: 'Enter' })).status).toBe(204);
    await new Promise(resolve => setTimeout(resolve, 500));
    // The box holds "old" at first; what the person typed goes after it.
    expect((await browser.text()).text).toContain('searched for oldfrom a person');
    // What a person does is kept to the origins as much as what the agent does.
    const before = fixtures.requests().length;
    await browser.evaluate(`(() => { const a = document.createElement('a'); a.href = '${fixtures.blocked}/target?via=viewer'; a.textContent = 'away'; a.style = 'position:fixed;left:0;top:0;width:200px;height:100px;display:block;z-index:9'; a.addEventListener('click', () => { navigator.sendBeacon('/clicked-away'); }); document.body.append(a); })()`);
    await send({ type: 'mouse', action: 'down', x: 0.02, y: 0.02 }); await send({ type: 'mouse', action: 'up', x: 0.02, y: 0.02 });
    await new Promise(resolve => setTimeout(resolve, 1_000));
    // The link was clicked (its page said so, to an allowed origin), and its request never left the browser.
    const after = fixtures.requests().slice(before);
    expect(after.filter(request => request.host === new URL(fixtures.allowed).host && request.path === '/clicked-away')).toHaveLength(1);
    expect(after.filter(request => request.host === new URL(fixtures.blocked).host)).toEqual([]);
    share.revoke();
    await reader.cancel().catch(() => undefined);
  });

  it('ends the stream when the browser ends', async () => {
    const share = await served.share(browser);
    const stream = await fetch(`${share.url}stream`);
    const reader = stream.body!.getReader();
    await reader.read();
    await browser.release();
    let done = false;
    for (let index = 0; index < 1_000 && !done; index++) done = (await reader.read()).done;
    expect(done).toBe(true);
    expect((await fetch(share.url)).status).toBe(404);
  });
});
