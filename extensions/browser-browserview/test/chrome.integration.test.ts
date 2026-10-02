import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowsers, type Browser, type Browsers, type CdpSocket } from 'mayura/browser';
import { serveBrowserFixtures, type BrowserFixtureServer } from 'mayura/browser/local';
import { browserConformance } from 'mayura/browser/testing';
import { browserViewBrowsers } from '../src/index.js';
import { fakeBrowserView } from './fake.js';

// The provider's sessions, driven for real: a stand-in for BrowserView's API whose sessions are the Chrome (or Edge)
// installed here. Connections to BrowserView's WebSocket go to that browser, once their session token is checked.
// MAYURA_TEST_BROWSER=chrome or edge.
const channel = process.env['MAYURA_TEST_BROWSER'] as 'chrome' | 'edge' | undefined;

describe.skipIf(channel === undefined)('BrowserView browsers, their sessions a local browser', { timeout: 120_000 }, () => {
  let fixtures: BrowserFixtureServer; let browsers: Browsers; let browser: Browser; let fake: ReturnType<typeof fakeBrowserView>;
  const tokens: (string | undefined)[] = [];
  beforeAll(async () => {
    fixtures = await serveBrowserFixtures(); fake = fakeBrowserView({ chrome: channel! });
    const webSocket = (url: string, headers: Readonly<Record<string, string>>): CdpSocket => {
      const id = /\/devtools\/browser\/(.+)$/u.exec(url)?.[1];
      const session = [...fake.sessions.values()].find(item => item.socket.endsWith(`/devtools/browser/${id}`));
      tokens.push(headers['x-session-token']);
      if (!session || headers['x-session-token'] !== session.token || !url.startsWith('wss://sessions.browserview.example/')) throw new Error('refused');
      return new WebSocket(session.socket) as unknown as CdpSocket;
    };
    browsers = createBrowsers(browserViewBrowsers({ apiKey: 'bv_live_test_1', baseUrl: 'https://sessions.browserview.example', fetch: fake.fetch }),
      { maxBrowsers: 1, maxLifetimeMs: 600_000, origins: [fixtures.allowed], webSocket });
    browser = await browsers.open({ lifetimeMs: 300_000 });
  }, 120_000);
  afterAll(async () => { await browsers?.close(); await fixtures?.close(); });

  for (const test of browserConformance) {
    it(test.name, async () => { expect(await test.run({ browser, allowed: fixtures.allowed, blocked: fixtures.blocked, requests: fixtures.requests })).toBe('passed'); });
  }

  it('connected with the session token, and releases the session at the end', async () => {
    expect(tokens).toEqual(['cdp-token-bv_1']);
    await browser.release();
    expect([...fake.sessions.values()][0]!.ended).toBe(true);
  });
});
