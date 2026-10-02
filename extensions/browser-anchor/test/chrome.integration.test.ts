import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowsers, type Browser, type Browsers } from 'mayura/browser';
import { serveBrowserFixtures, type BrowserFixtureServer } from 'mayura/browser/local';
import { browserConformance } from 'mayura/browser/testing';
import { anchorBrowsers } from '../src/index.js';
import { fakeAnchor } from './fake.js';

// The provider's sessions, driven for real: a stand-in for Anchor's API whose sessions are the Chrome (or Edge)
// installed here. MAYURA_TEST_BROWSER=chrome or edge.
const channel = process.env['MAYURA_TEST_BROWSER'] as 'chrome' | 'edge' | undefined;

describe.skipIf(channel === undefined)('Anchor browsers, their browsers a local browser', { timeout: 120_000 }, () => {
  let fixtures: BrowserFixtureServer; let browsers: Browsers; let browser: Browser; let fake: ReturnType<typeof fakeAnchor>;
  beforeAll(async () => {
    fixtures = await serveBrowserFixtures(); fake = fakeAnchor({ chrome: channel! });
    browsers = createBrowsers(anchorBrowsers({ apiKey: 'sk-anchor-test-1', fetch: fake.fetch }), { maxBrowsers: 1, maxLifetimeMs: 600_000, origins: [fixtures.allowed] });
    browser = await browsers.open({ lifetimeMs: 300_000 });
  }, 120_000);
  afterAll(async () => { await browsers?.close(); await fixtures?.close(); });

  for (const test of browserConformance) {
    it(test.name, async () => { expect(await test.run({ browser, allowed: fixtures.allowed, blocked: fixtures.blocked, requests: fixtures.requests })).toBe('passed'); });
  }

  it('has a live view, and releases the session at the end', async () => {
    expect(browser.liveViewUrl).toMatch(/^https:\/\//u);
    await browser.release();
    expect([...fake.sessions.values()][0]!.ended).toBe(true);
  });
});
