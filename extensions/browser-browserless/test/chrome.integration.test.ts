import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowsers, type Browser, type Browsers, type CdpSocket } from 'mayura/browser';
import { localBrowsers, serveBrowserFixtures, type BrowserFixtureServer } from 'mayura/browser/local';
import { browserConformance } from 'mayura/browser/testing';
import { browserlessBrowsers } from '../src/index.js';

// The provider's browsers, driven for real: each connection to Browserless's URL is answered by a browser launched from
// the Chrome (or Edge) installed here, as Browserless launches one per connection. MAYURA_TEST_BROWSER=chrome or edge.
const channel = process.env['MAYURA_TEST_BROWSER'] as 'chrome' | 'edge' | undefined;

describe.skipIf(channel === undefined)('Browserless browsers, each connection a local browser', { timeout: 120_000 }, () => {
  let fixtures: BrowserFixtureServer; let browsers: Browsers; let browser: Browser;
  const asked: string[] = []; const launched: { release(options: { signal: AbortSignal }): Promise<void> }[] = [];
  beforeAll(async () => {
    fixtures = await serveBrowserFixtures();
    const webSocket = async (url: string): Promise<CdpSocket> => {
      asked.push(url);
      const local = await localBrowsers({ channel: channel! }).create({ lifetimeMs: 300_000, viewport: { width: 1_280, height: 800 }, labels: {} }, { signal: AbortSignal.timeout(60_000) });
      launched.push(local);
      return new WebSocket(local.cdp.url) as unknown as CdpSocket;
    };
    browsers = createBrowsers(browserlessBrowsers({ token: 'bl_test_token_1' }), { maxBrowsers: 1, maxLifetimeMs: 600_000, origins: [fixtures.allowed], webSocket });
    browser = await browsers.open({ lifetimeMs: 300_000 });
  }, 120_000);
  afterAll(async () => {
    await browsers?.close(); await fixtures?.close();
    for (const local of launched) await local.release({ signal: AbortSignal.timeout(30_000) });
  });

  for (const test of browserConformance) {
    it(test.name, async () => { expect(await test.run({ browser, allowed: fixtures.allowed, blocked: fixtures.blocked, requests: fixtures.requests })).toBe('passed'); });
  }

  it('connected to Browserless with the token and the lifetime', () => {
    expect(asked).toEqual(['wss://production-sfo.browserless.io/?token=bl_test_token_1&timeout=300000']);
  });
});
