import { describe, expect, it } from 'vitest';
import { BrowserError, createBrowsers, type BrowsersOptions } from '../src/index.js';
import { fakeBrowser } from './fake-browser.js';

const limits = (fake: ReturnType<typeof fakeBrowser>, extra: Partial<BrowsersOptions> = {}): BrowsersOptions => ({
  maxBrowsers: 2, maxLifetimeMs: 600_000, origins: ['https://example.com'], webSocket: fake.factory, ...extra,
});
const settle = () => new Promise(resolve => setTimeout(resolve, 10));
/** A browser that cannot be checked as a whole, only target by target. */
const perTargetOnly = { error: { code: -32601, message: "'Fetch.enable' wasn't found" } };

describe('createBrowsers', () => {
  it('refuses configuration it cannot use, and allows no origin by default', () => {
    const fake = fakeBrowser();
    expect(() => createBrowsers(fake.provider(), { maxBrowsers: 1, maxLifetimeMs: 60_000 } as BrowsersOptions)).toThrow(/origins/u);
    expect(() => createBrowsers(fake.provider(), limits(fake, { maxLifetimeMs: 7_200_000 }))).toThrow(/maxLifetimeMs/u);
    expect(() => createBrowsers(fake.provider(), limits(fake, { viewport: { width: 10, height: 10 } }))).toThrow(/viewport/u);
    expect(() => createBrowsers({ id: 'Bad Id' } as never, limits(fake))).toThrow(/provider/u);
  });

  it('makes the browser safe before handing it over: downloads denied, every target checked before it runs', async () => {
    const fake = fakeBrowser();
    const browser = await createBrowsers(fake.provider(), limits(fake)).open();
    const methods = fake.sent.map(item => `${item.sessionId ?? 'browser'} ${item.method}`);
    expect(methods).toContain('browser Browser.setDownloadBehavior');
    expect(fake.sent.find(item => item.method === 'Browser.setDownloadBehavior')!.params).toEqual({ behavior: 'deny' });
    expect(fake.sent.find(item => item.method === 'Page.setInterceptFileChooserDialog' && item.sessionId === 'S-T1')!.params).toEqual({ enabled: true });
    // Requests are checked for the whole browser before any target is attached, and so from every page's first request.
    expect(methods.indexOf('browser Fetch.enable')).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf('browser Fetch.enable')).toBeLessThan(methods.indexOf('browser Target.setAutoAttach'));
    expect(methods).not.toContain('S-T1 Fetch.enable');
    expect(fake.sent.find(item => item.method === 'Target.setAutoAttach' && !item.sessionId)!.params).toMatchObject({ autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    expect(browser.cdp).toEqual({ url: 'ws://fake.test/devtools/browser/1', headers: {}, isolated: false });
    await browser.release();
  });

  it('checks each target as it is attached, before it runs, where the browser cannot be checked as a whole', async () => {
    const fake = fakeBrowser({ answer: sent => (sent.method === 'Fetch.enable' && !sent.sessionId ? perTargetOnly : undefined) });
    const browser = await createBrowsers(fake.provider(), limits(fake)).open();
    const methods = fake.sent.map(item => `${item.sessionId ?? 'browser'} ${item.method}`);
    expect(methods.indexOf('S-T1 Fetch.enable')).toBeGreaterThanOrEqual(0);
    expect(methods.indexOf('S-T1 Fetch.enable')).toBeLessThan(methods.indexOf('S-T1 Runtime.runIfWaitingForDebugger'));
    await browser.release();
    // A browser shared with others is never checked as a whole: their pages are theirs.
    const shared = fakeBrowser();
    await (await createBrowsers(shared.provider({ isolate: true }), limits(shared)).open()).release();
    expect(shared.sent.some(item => item.method === 'Fetch.enable' && !item.sessionId)).toBe(false);
  });

  it('lets through requests to allowed origins and fails the rest, in any target', async () => {
    const fake = fakeBrowser();
    const browser = await createBrowsers(fake.provider(), limits(fake)).open();
    fake.event('Fetch.requestPaused', { requestId: 'r1', request: { url: 'https://example.com/app.js' } }, 'S-T1');
    fake.event('Fetch.requestPaused', { requestId: 'r2', request: { url: 'https://tracker.example.net/pixel' } }, 'S-T1');
    fake.event('Fetch.requestPaused', { requestId: 'r3', request: { url: 'http://example.com/' } }, 'S-W1');
    await settle();
    expect(fake.sent.filter(item => item.method.startsWith('Fetch.') && item.method !== 'Fetch.enable').map(item => [item.method, item.params['requestId'], item.sessionId])).toEqual([
      ['Fetch.continueRequest', 'r1', 'S-T1'], ['Fetch.failRequest', 'r2', 'S-T1'], ['Fetch.failRequest', 'r3', 'S-W1'],
    ]);
    await browser.release();
  });

  it('closes a target whose requests cannot be checked', async () => {
    const fake = fakeBrowser({ answer: sent => (sent.method === 'Fetch.enable' && !sent.sessionId ? perTargetOnly : sent.method === 'Fetch.enable' && sent.sessionId === 'S-W9' ? { error: { code: -32601, message: 'no Fetch here' } } : undefined) });
    const browser = await createBrowsers(fake.provider(), limits(fake)).open();
    fake.event('Target.attachedToTarget', { sessionId: 'S-W9', targetInfo: { targetId: 'W9', type: 'service_worker' }, waitingForDebugger: true }, 'S-T1');
    await settle(); await settle();
    expect(fake.sent.some(item => item.method === 'Target.closeTarget' && item.params['targetId'] === 'W9')).toBe(true);
    expect(fake.sent.some(item => item.method === 'Runtime.runIfWaitingForDebugger' && item.sessionId === 'S-W9')).toBe(false);
    await browser.release();
  });

  it('lets a dedicated worker run, whose requests its page checks, and other targets only once checked', async () => {
    const noFetch = { error: { code: -32601, message: "'Fetch.enable' wasn't found" } };
    const fake = fakeBrowser({ answer: sent => (sent.method === 'Fetch.enable' && !sent.sessionId ? perTargetOnly : sent.method === 'Fetch.enable' && (sent.sessionId === 'S-W1' || sent.sessionId === 'S-X1') ? noFetch : undefined) });
    const browser = await createBrowsers(fake.provider(), limits(fake)).open();
    fake.event('Target.attachedToTarget', { sessionId: 'S-W1', targetInfo: { targetId: 'W1', type: 'worker' }, waitingForDebugger: true }, 'S-T1');
    fake.event('Target.attachedToTarget', { sessionId: 'S-X1', targetInfo: { targetId: 'X1', type: 'shared_worker' }, waitingForDebugger: true });
    // The same shared worker reported again through the page: held as long as the first cannot check it.
    fake.event('Target.attachedToTarget', { sessionId: 'S-X2', targetInfo: { targetId: 'X1', type: 'shared_worker' }, waitingForDebugger: true }, 'S-T1');
    await settle(); await settle();
    const ran = (sessionId: string) => fake.sent.some(item => item.method === 'Runtime.runIfWaitingForDebugger' && item.sessionId === sessionId);
    expect(ran('S-W1')).toBe(true);
    expect(ran('S-X1') || ran('S-X2')).toBe(false);
    await browser.release();
  });

  it('lets a target reported twice run through its second session only after the first checks its requests', async () => {
    const fake = fakeBrowser({ answer: sent => (sent.method === 'Fetch.enable' && !sent.sessionId ? perTargetOnly : undefined) });
    const browser = await createBrowsers(fake.provider(), limits(fake)).open();
    const original = fake.sent.length;
    fake.event('Target.attachedToTarget', { sessionId: 'S-Y1', targetInfo: { targetId: 'Y1', type: 'service_worker' }, waitingForDebugger: true });
    fake.event('Target.attachedToTarget', { sessionId: 'S-Y2', targetInfo: { targetId: 'Y1', type: 'service_worker' }, waitingForDebugger: true }, 'S-T1');
    await settle(); await settle();
    const order = fake.sent.slice(original).filter(item => item.sessionId === 'S-Y1' || item.sessionId === 'S-Y2' || item.params['sessionId'] === 'S-Y2')
      .map(item => `${item.sessionId ?? item.params['sessionId']} ${item.method}`);
    expect(order.indexOf('S-Y1 Fetch.enable')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('S-Y1 Fetch.enable')).toBeLessThan(order.indexOf('S-Y2 Runtime.runIfWaitingForDebugger'));
    expect(order).toContain('S-Y2 Target.detachFromTarget');
    expect(order.filter(item => item.startsWith('S-Y2') && !/runIfWaiting|detach/u.test(item))).toEqual([]);
    await browser.release();
  });

  it('refuses to navigate outside the origins, before asking the browser', async () => {
    const fake = fakeBrowser();
    const browser = await createBrowsers(fake.provider(), limits(fake)).open();
    await expect(browser.goto('https://elsewhere.example.org/')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(browser.goto('file:///etc/passwd')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fake.sent.some(item => item.method === 'Page.navigate')).toBe(false);
    expect(await browser.goto('https://example.com/docs')).toMatchObject({ url: 'https://example.com/docs', status: 200, loaded: true, title: 'Title of /docs' });
    await browser.release();
  });

  it('reports a navigation the browser blocked as refused', async () => {
    const fake = fakeBrowser({ answer: sent => (sent.method === 'Page.navigate' ? { frameId: 'F', errorText: 'net::ERR_BLOCKED_BY_CLIENT' } : undefined) });
    const browser = await createBrowsers(fake.provider(), limits(fake)).open();
    await expect(browser.goto('https://example.com/redirects-away')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await browser.release();
  });

  it('acts only on refs from the latest snapshot of the current tab', async () => {
    const fake = fakeBrowser({ answer: sent => (sent.method === 'DOM.getContentQuads' ? { quads: [[0, 0, 10, 0, 10, 10, 0, 10]] } : undefined) });
    const browser = await createBrowsers(fake.provider(), limits(fake)).open();
    await expect(browser.click('e1')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const snapshot = await browser.snapshot();
    expect(snapshot.text).toBe('- button "Go" [ref=e1]');
    await browser.click('e1');
    expect(fake.sent.filter(item => item.method === 'Input.dispatchMouseEvent').map(item => [item.params['type'], item.params['x'], item.params['y']]))
      .toEqual([['mouseMoved', 5, 5], ['mousePressed', 5, 5], ['mouseReleased', 5, 5]]);
    await expect(browser.click('x1')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await browser.newTab();
    await expect(browser.click('e1')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    // A tab that goes away by itself (a page closing its window) takes its refs with it.
    const first = (await browser.tabs()).find(tab => !tab.active)!.tab;
    await browser.selectTab(first); await browser.snapshot();
    fake.event('Target.detachedFromTarget', { sessionId: `S-${first}` });
    await expect(browser.click('e1')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await browser.release();
  });

  it('keeps to its limits: browsers at once, tabs, lifetime, screenshot size', async () => {
    const fake = fakeBrowser();
    const browsers = createBrowsers(fake.provider(), limits(fake, { maxBrowsers: 1, maxTabs: 2, maxScreenshotBytes: 4 }));
    await expect(browsers.open({ lifetimeMs: 900_000 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const browser = await browsers.open();
    await expect(browsers.open()).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await browser.newTab();
    await expect(browser.newTab()).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(browser.screenshot()).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await browsers.close();
    expect(fake.released).toBe(1);
    await expect(browsers.open()).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('ends a browser at its lifetime, and refuses calls after', async () => {
    const fake = fakeBrowser();
    const browser = await createBrowsers(fake.provider(), limits(fake)).open({ lifetimeMs: 1_000 });
    await new Promise(resolve => setTimeout(resolve, 1_100));
    expect(browser.ended).toBe(true);
    await expect(browser.snapshot()).rejects.toMatchObject({ reason: 'gone' });
    expect(fake.released).toBe(1);
  });

  it('counts a browser that already ended as released, and reports other release failures', async () => {
    const gone = fakeBrowser({ releaseError: new BrowserError('gone', 404) });
    await (await createBrowsers(gone.provider(), limits(gone)).open()).release();
    const failing = fakeBrowser({ releaseError: new BrowserError('unavailable', 503) });
    const browsers = createBrowsers(failing.provider(), limits(failing));
    const browser = await browsers.open();
    await expect(browser.release()).rejects.toMatchObject({ reason: 'unavailable' });
    expect(browsers.size).toBe(1);
  });

  it('releases what it created when opening fails or is cancelled', async () => {
    const fake = fakeBrowser({ answer: sent => (sent.method === 'Target.setAutoAttach' && !sent.sessionId ? { error: { code: -1, message: 'no' } } : undefined) });
    await expect(createBrowsers(fake.provider(), limits(fake)).open()).rejects.toBeInstanceOf(Error);
    expect(fake.released).toBe(1);
    const other = fakeBrowser();
    await expect(createBrowsers(other.provider(), limits(other)).open({ signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'CANCELLED' });
    // Nothing is created for a call already cancelled.
    expect(other.created).toBe(0);
  });

  it('shows a live view only for providers that have one, at an https URL', async () => {
    const fake = fakeBrowser();
    expect((await createBrowsers(fake.provider({ liveViewUrl: 'https://view.example/1', liveView: true }), limits(fake)).open()).liveViewUrl).toBe('https://view.example/1');
    expect((await createBrowsers(fake.provider({ liveViewUrl: 'http://view.example/1', liveView: true }), limits(fake)).open()).liveViewUrl).toBeUndefined();
    expect((await createBrowsers(fake.provider({ liveViewUrl: 'https://view.example/1' }), limits(fake)).open()).liveViewUrl).toBeUndefined();
  });

  it('keeps an isolated browser to its own context, letting other pages go untouched', async () => {
    const fake = fakeBrowser();
    const browser = await createBrowsers(fake.provider({ isolate: true }), limits(fake)).open();
    expect(fake.sent.some(item => item.method === 'Target.getTargets')).toBe(false);
    expect(fake.sent.find(item => item.method === 'Target.createTarget')!.params).toMatchObject({ browserContextId: 'C1' });
    fake.event('Target.attachedToTarget', { sessionId: 'S-U1', targetInfo: { targetId: 'U1', type: 'page', browserContextId: 'default' }, waitingForDebugger: true });
    await settle(); await settle();
    const theirs = fake.sent.filter(item => item.sessionId === 'S-U1' || item.params['sessionId'] === 'S-U1').map(item => item.method);
    expect(theirs).toEqual(['Runtime.runIfWaitingForDebugger', 'Target.detachFromTarget']);
    await browser.release(); await settle();
    expect(fake.sent.some(item => item.method === 'Target.disposeBrowserContext')).toBe(true);
  });
});

describe('cdpBrowsers', () => {
  it('refuses endpoints and headers it cannot use', async () => {
    const { cdpBrowsers } = await import('../src/index.js');
    for (const endpoint of ['', 'ftp://x', 'chrome.local:9222', 'ws://has space']) expect(() => cdpBrowsers({ endpoint }), endpoint).toThrow(/endpoint/u);
    expect(() => cdpBrowsers({ endpoint: 'ws://x/', headers: { 'bad header': 'v' } })).toThrow(/headers/u);
    expect(() => cdpBrowsers({ endpoint: 'ws://x/', headers: { authorization: 'a\r\nb' } })).toThrow(/headers/u);
  });

  it('opens each browser in a context of its own, with the headers given', async () => {
    const { cdpBrowsers } = await import('../src/index.js');
    const fetch = (async () => Response.json({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/1' })) as unknown as typeof globalThis.fetch;
    const backend = await cdpBrowsers({ endpoint: 'http://chrome.internal:9222', headers: { authorization: 'Bearer t' }, fetch })
      .create({ lifetimeMs: 60_000, viewport: { width: 800, height: 600 }, labels: {} }, { signal: AbortSignal.timeout(5_000) });
    expect(backend).toMatchObject({ cdp: { url: 'ws://chrome.internal:9222/devtools/browser/1', headers: { authorization: 'Bearer t' } }, isolate: true });
  });
});
