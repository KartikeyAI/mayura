import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectCdp, createBrowsers, type Browser, type Browsers, type CdpSocket } from 'mayura/browser';
import { serveBrowserFixtures, type BrowserFixtureServer } from 'mayura/browser/local';
import { browserConformance } from 'mayura/browser/testing';
import { cloudflareBrowsers } from '../src/index.js';
import { account, fakeBrowserRun, token } from './fake.js';

// The provider's browsers, driven for real: each Browser Run session is a browser launched from the Chrome (or Edge)
// installed here, reached at the session's CDP address once its token is checked. MAYURA_TEST_BROWSER=chrome or edge.
const channel = process.env['MAYURA_TEST_BROWSER'] as 'chrome' | 'edge' | undefined;

describe.skipIf(channel === undefined)('Cloudflare browsers, each session a local browser', { timeout: 120_000 }, () => {
  let fixtures: BrowserFixtureServer; let browsers: Browsers; let browser: Browser; let fake: ReturnType<typeof fakeBrowserRun>;
  const asked: { url: string; authorization: string | undefined }[] = [];
  const webSocket = (url: string, headers: Readonly<Record<string, string>>): CdpSocket => {
    asked.push({ url, authorization: headers['authorization'] });
    const socket = headers['authorization'] === `Bearer ${token}` ? fake.socketFor(url) : undefined;
    if (!socket) throw new Error('refused');
    return new WebSocket(socket) as unknown as CdpSocket;
  };
  beforeAll(async () => {
    fixtures = await serveBrowserFixtures();
    fake = fakeBrowserRun({ chrome: channel! });
    browsers = createBrowsers(cloudflareBrowsers({ accountId: account, apiToken: token, fetch: fake.fetch }), { maxBrowsers: 1, maxLifetimeMs: 600_000, origins: [fixtures.allowed], webSocket });
    browser = await browsers.open({ lifetimeMs: 300_000 });
  }, 120_000);
  afterAll(async () => { await browsers?.close(); await fixtures?.close(); });

  for (const test of browserConformance) {
    it(test.name, async () => { expect(await test.run({ browser, allowed: fixtures.allowed, blocked: fixtures.blocked, requests: fixtures.requests })).toBe('passed'); });
  }

  it('connected to its session\'s CDP address with the token, where a second client finds the same browser', async () => {
    expect(asked[0]).toEqual({ url: `wss://api.cloudflare.com/client/v4/accounts/${account}/browser-run/devtools/browser/${browser.id}`, authorization: `Bearer ${token}` });
    expect(browser.liveViewUrl).toMatch(/^https:\/\/live\.browser\.run\//u);
    await browser.goto(`${fixtures.allowed}/form`);
    const second = await connectCdp(browser.cdp!.url, { headers: browser.cdp!.headers, webSocket });
    try {
      const { targetInfos } = await second.send<{ targetInfos: { type: string; url: string }[] }>('Target.getTargets');
      expect(targetInfos.filter(target => target.type === 'page').map(target => target.url)).toContain(`${fixtures.allowed}/form`);
    } finally { second.close(); }
  });

  it('closes the session on release', async () => {
    await browser.release();
    expect(fake.seen.at(-1)).toMatchObject({ method: 'DELETE', path: `/client/v4/accounts/${account}/browser-run/devtools/browser/${browser.id}` });
    expect(fake.sessions.get(browser.id)!.closed).toBe(true);
  });
});
