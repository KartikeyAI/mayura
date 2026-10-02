import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowsers, type Browser, type Browsers, type CdpSocket } from 'mayura/browser';
import { localBrowsers, serveBrowserFixtures, type BrowserFixtureServer } from 'mayura/browser/local';
import { browserConformance } from 'mayura/browser/testing';
import { cloudflareBrowsers } from '../src/index.js';

// The provider's browsers, driven for real: each connection to Browser Run's endpoint is answered by a browser
// launched from the Chrome (or Edge) installed here, once its token is checked. MAYURA_TEST_BROWSER=chrome or edge.
const channel = process.env['MAYURA_TEST_BROWSER'] as 'chrome' | 'edge' | undefined;
const account = '0123456789abcdef0123456789abcdef';

describe.skipIf(channel === undefined)('Cloudflare browsers, each connection a local browser', { timeout: 120_000 }, () => {
  let fixtures: BrowserFixtureServer; let browsers: Browsers; let browser: Browser;
  const asked: { url: string; authorization: string | undefined }[] = []; const launched: { release(options: { signal: AbortSignal }): Promise<void> }[] = [];
  beforeAll(async () => {
    fixtures = await serveBrowserFixtures();
    const webSocket = async (url: string, headers: Readonly<Record<string, string>>): Promise<CdpSocket> => {
      asked.push({ url, authorization: headers['authorization'] });
      if (headers['authorization'] !== 'Bearer cf_test_token_0123456789abcdef') throw new Error('refused');
      const local = await localBrowsers({ channel: channel! }).create({ lifetimeMs: 300_000, viewport: { width: 1_280, height: 800 }, labels: {} }, { signal: AbortSignal.timeout(60_000) });
      launched.push(local);
      return new WebSocket(local.cdp.url) as unknown as CdpSocket;
    };
    browsers = createBrowsers(cloudflareBrowsers({ accountId: account, apiToken: 'cf_test_token_0123456789abcdef' }), { maxBrowsers: 1, maxLifetimeMs: 600_000, origins: [fixtures.allowed], webSocket });
    browser = await browsers.open({ lifetimeMs: 300_000 });
  }, 120_000);
  afterAll(async () => {
    await browsers?.close(); await fixtures?.close();
    for (const local of launched) await local.release({ signal: AbortSignal.timeout(30_000) });
  });

  for (const test of browserConformance) {
    it(test.name, async () => { expect(await test.run({ browser, allowed: fixtures.allowed, blocked: fixtures.blocked, requests: fixtures.requests })).toBe('passed'); });
  }

  it('connected to the account\'s Browser Run endpoint with its token', () => {
    expect(asked).toEqual([{ url: `wss://api.cloudflare.com/client/v4/accounts/${account}/browser-run/devtools/browser?keep_alive=60000`, authorization: 'Bearer cf_test_token_0123456789abcdef' }]);
  });
});
