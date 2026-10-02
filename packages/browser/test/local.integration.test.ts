import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cdpBrowsers, createBrowsers, type Browser, type Browsers } from '../src/index.js';
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
