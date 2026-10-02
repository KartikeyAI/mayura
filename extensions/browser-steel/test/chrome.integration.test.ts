import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowsers, type Browser, type Browsers } from 'mayura/browser';
import { serveBrowserFixtures, type BrowserFixtureServer } from 'mayura/browser/local';
import { browserConformance } from 'mayura/browser/testing';
import { steelBrowsers } from '../src/index.js';
import { fakeSteel } from './fake.js';

// The provider's sessions, driven for real: a stand-in for Steel's API whose sessions are the Chrome (or Edge)
// installed here. MAYURA_TEST_BROWSER=chrome or edge.
const channel = process.env['MAYURA_TEST_BROWSER'] as 'chrome' | 'edge' | undefined;

describe.skipIf(channel === undefined)('Steel browsers, their sessions a local browser', { timeout: 120_000 }, () => {
  let fixtures: BrowserFixtureServer; let browsers: Browsers; let browser: Browser; let fake: ReturnType<typeof fakeSteel>;
  beforeAll(async () => {
    fixtures = await serveBrowserFixtures(); fake = fakeSteel({ chrome: channel! });
    browsers = createBrowsers(steelBrowsers({ apiKey: 'steel_test_key_1', fetch: fake.fetch }), { maxBrowsers: 1, maxLifetimeMs: 600_000, origins: [fixtures.allowed] });
    browser = await browsers.open({ lifetimeMs: 300_000 });
  }, 120_000);
  afterAll(async () => { await browsers?.close(); await fixtures?.close(); });

  for (const test of browserConformance) {
    it(test.name, async () => { expect(await test.run({ browser, allowed: fixtures.allowed, blocked: fixtures.blocked, requests: fixtures.requests })).toBe('passed'); });
  }

  it('has a live view, and releases the session at the end', async () => {
    expect(browser.liveViewUrl).toMatch(/^https:\/\//u);
    await browser.release();
    expect([...fake.sessions.values()][0]!.status).toBe('released');
  });
});
