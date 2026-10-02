import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cdpBrowsers, connectCdp, createBrowsers, type Browser, type Browsers } from '../src/index.js';
import { findLocalBrowser, localBrowsers, serveBrowserFixtures, type BrowserFixtureServer } from '../src/local/index.js';
import { browserConformance } from '../src/testing.js';

// The browser core against a real browser installed here: MAYURA_TEST_BROWSER=chrome or edge. Nothing is downloaded.
const channel = process.env['MAYURA_TEST_BROWSER'] as 'chrome' | 'edge' | undefined;

describe.skipIf(channel === undefined)('browsers on the local browser', { timeout: 120_000 }, () => {
  let fixtures: BrowserFixtureServer; let browsers: Browsers; let browser: Browser;
  beforeAll(async () => {
    fixtures = await serveBrowserFixtures();
    browsers = createBrowsers(localBrowsers({ channel: channel! }), { maxBrowsers: 2, maxLifetimeMs: 600_000, origins: [fixtures.allowed] });
    browser = await browsers.open();
  }, 120_000);
  afterAll(async () => { await browsers?.close(); await fixtures?.close(); });

  for (const test of browserConformance) {
    it(test.name, async () => { expect(await test.run({ browser, allowed: fixtures.allowed, blocked: fixtures.blocked, requests: fixtures.requests })).toBe('passed'); });
  }

  it('keeps pages another client opens to the origins too', async () => {
    const other = await connectCdp(browser.cdp!.url, { headers: browser.cdp!.headers });
    try {
      const before = fixtures.requests().length;
      await other.send('Target.createTarget', { url: `${fixtures.blocked}/target?from=other` });
      await other.send('Target.createTarget', { url: `${fixtures.allowed}/next?from=other` });
      await new Promise(resolve => setTimeout(resolve, 2_000));
      const seen = fixtures.requests().slice(before);
      expect(seen.some(request => request.path === '/next')).toBe(true);
      expect(seen.filter(request => request.host === new URL(fixtures.blocked).host)).toEqual([]);
    } finally { other.close(); }
    for (const tab of (await browser.tabs()).filter(item => !item.active)) await browser.closeTab(tab.tab);
  });

  it('finds the installed browser', () => { expect(findLocalBrowser(channel)).toMatch(/chrome|msedge|chromium|edge/iu); });

  it('runs each browser with a profile of its own, removed on release', async () => {
    const profiles = () => readdirSync(tmpdir()).filter(name => name.startsWith('mayura-browser-')).sort();
    const before = profiles();
    const another = await browsers.open();
    expect(profiles().length).toBe(before.length + 1);
    await another.release();
    expect(profiles()).toEqual(before);
  });

  it('connects to a browser others use without touching their tabs', async () => {
    // A second local browser stands for one someone runs; it is reached through its CDP endpoint, isolated.
    const host = await localBrowsers({ channel: channel! }).create({ lifetimeMs: 60_000, viewport: { width: 800, height: 600 }, labels: {} }, { signal: AbortSignal.timeout(60_000) });
    try {
      const shared = createBrowsers(cdpBrowsers({ endpoint: host.cdp.url }), { maxBrowsers: 1, maxLifetimeMs: 60_000, origins: [fixtures.allowed] });
      const guest = await shared.open();
      const own = await guest.goto(`${fixtures.allowed}/next`);
      expect(own.title).toBe('Next');
      expect((await guest.tabs()).map(tab => tab.url)).toEqual([`${fixtures.allowed}/next`]);
      await shared.close();
    } finally { await host.release({ signal: AbortSignal.timeout(30_000) }); }
  });
});
