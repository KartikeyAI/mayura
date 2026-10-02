import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowsers, type Browser, type Browsers } from 'mayura/browser';
import { serveBrowserFixtures, type BrowserFixtureServer } from 'mayura/browser/local';
import { browserConformance } from 'mayura/browser/testing';
import { browserUseBrowsers } from '../src/index.js';
import { fakeBrowserUse } from './fake.js';

// The provider's browsers, driven for real: a stand-in for Browser Use's API whose browsers are the Chrome (or Edge)
// installed here. MAYURA_TEST_BROWSER=chrome or edge.
const channel = process.env['MAYURA_TEST_BROWSER'] as 'chrome' | 'edge' | undefined;

describe.skipIf(channel === undefined)('Browser Use browsers, each a local browser', { timeout: 120_000 }, () => {
  let fixtures: BrowserFixtureServer; let browsers: Browsers; let browser: Browser; let fake: ReturnType<typeof fakeBrowserUse>;
  beforeAll(async () => {
    fixtures = await serveBrowserFixtures(); fake = fakeBrowserUse({ chrome: channel! });
    browsers = createBrowsers(browserUseBrowsers({ apiKey: 'bu_test_key_1', fetch: fake.fetch }), { maxBrowsers: 1, maxLifetimeMs: 600_000, origins: [fixtures.allowed] });
    browser = await browsers.open({ lifetimeMs: 300_000 });
  }, 120_000);
  afterAll(async () => { await browsers?.close(); await fixtures?.close(); });

  for (const test of browserConformance) {
    it(test.name, async () => { expect(await test.run({ browser, allowed: fixtures.allowed, blocked: fixtures.blocked, requests: fixtures.requests })).toBe('passed'); });
  }

  it('stops the browser at the end', async () => {
    await browser.release();
    expect([...fake.browsers.values()][0]!.status).toBe('stopped');
  });

  it('reaches a browser given by its http address', async () => {
    const http = fakeBrowserUse({ chrome: channel!, httpCdp: true });
    const viaHttp = createBrowsers(browserUseBrowsers({ apiKey: 'bu_test_key_1', fetch: http.fetch }), { maxBrowsers: 1, maxLifetimeMs: 600_000, origins: [fixtures.allowed] });
    const other = await viaHttp.open({ lifetimeMs: 120_000 });
    expect((await other.goto(`${fixtures.allowed}/next`)).title).toBe('Next');
    await viaHttp.close();
  });
});
