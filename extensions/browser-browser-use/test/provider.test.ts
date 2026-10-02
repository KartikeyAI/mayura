import { describe, expect, it } from 'vitest';
import type { MayuraError } from 'mayura';
import { browserUseBrowsers } from '../src/index.js';
import { fakeBrowserUse } from './fake.js';

const base = { apiKey: 'bu_test_key_1' };
const spec = { lifetimeMs: 600_000, viewport: { width: 1_024, height: 700 }, labels: { run: 'r1' } };
const signal = () => AbortSignal.timeout(10_000);

describe('browserUseBrowsers', () => {
  it('refuses configuration it cannot use', () => {
    expect(() => browserUseBrowsers({ apiKey: '' })).toThrow(/apiKey/u);
    expect(() => browserUseBrowsers({ ...base, proxyCountryCode: 'USA' })).toThrow(/proxyCountryCode/u);
    expect(() => browserUseBrowsers({ ...base, maxLifetimeMs: 30_000 })).toThrow(/maxLifetimeMs/u);
    expect(() => browserUseBrowsers({ ...base, maxLifetimeMs: 5 * 3_600_000 })).toThrow(/maxLifetimeMs/u);
    expect(() => browserUseBrowsers({ ...base, liveView: 'view' as never })).toThrow(/liveView/u);
    expect(() => browserUseBrowsers({ ...base, baseUrl: 'http://api.example' })).toThrow(/baseUrl/u);
    expect(browserUseBrowsers(base)).toMatchObject({ id: 'browser-use', features: { liveView: false }, maxLifetimeMs: 14_400_000 });
  });

  it('creates a browser stopped at its lifetime, with no proxy and no captcha solving or recording, labels as metadata', async () => {
    const fake = fakeBrowserUse();
    const backend = await browserUseBrowsers({ ...base, fetch: fake.fetch }).create(spec, { signal: signal() });
    const created = fake.seen[0]!;
    expect([created.method, created.path, created.headers.get('x-browser-use-api-key')]).toEqual(['POST', '/api/v2/browsers', 'bu_test_key_1']);
    expect(created.body).toEqual({ timeout: 10, browserScreenWidth: 1_024, browserScreenHeight: 700, proxyCountryCode: null, solveCaptchas: false, enableRecording: false, metadata: { run: 'r1' } });
    expect(backend).toMatchObject({ id: '0000-bu-1', cdp: { url: 'wss://cdp.browser-use.example/0000-bu-1?token=secret' } });
  });

  it('asks for whole minutes from 1 to 240 and a screen Browser Use takes, a proxy only when asked, and at most 10 labels', async () => {
    const fake = fakeBrowserUse();
    await browserUseBrowsers({ ...base, fetch: fake.fetch, proxyCountryCode: 'de' }).create({ lifetimeMs: 5_000, viewport: { width: 200, height: 150 }, labels: {} }, { signal: signal() });
    expect(fake.seen.at(-1)!.body).toEqual({ timeout: 1, browserScreenWidth: 320, browserScreenHeight: 320, proxyCountryCode: 'de', solveCaptchas: false, enableRecording: false });
    const labels = Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`k${index}`, 'v']));
    expect(await browserUseBrowsers({ ...base, fetch: fake.fetch }).create({ ...spec, labels }, { signal: signal() }).catch(caught => caught)).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('gives the live view only when asked, as createBrowsers shows it only then', async () => {
    const fake = fakeBrowserUse();
    expect(browserUseBrowsers({ ...base, liveView: true }).features.liveView).toBe(true);
    expect((await browserUseBrowsers({ ...base, fetch: fake.fetch, liveView: true }).create(spec, { signal: signal() })).liveViewUrl).toBe('https://live.browser-use.example/0000-bu-1');
  });

  it('refuses replies it cannot trust, and maps failures without what Browser Use wrote', async () => {
    for (const reply of [{ id: 'x' }, { id: '../x', cdpUrl: 'wss://a/' }, { id: 'x', cdpUrl: 'ws://cdp.browser-use.example/' }, { id: 'x', cdpUrl: 'http://cdp.browser-use.example/' }, { id: 'x', cdpUrl: 'ftp://a/' }]) {
      const fake = fakeBrowserUse({ create: () => Response.json(reply, { status: 201 }) });
      expect(await browserUseBrowsers({ ...base, fetch: fake.fetch }).create(spec, { signal: signal() }).catch(caught => caught), JSON.stringify(reply)).toMatchObject({ reason: 'invalid_response' });
    }
    for (const [status, reason] of [[401, 'authentication'], [402, 'quota'], [429, 'rate_limited'], [503, 'unavailable']] as const) {
      const fake = fakeBrowserUse({ create: () => Response.json({ detail: 'secret detail' }, { status }) });
      const caught = await browserUseBrowsers({ ...base, fetch: fake.fetch }).create(spec, { signal: signal() }).then(() => undefined, (thrown: unknown) => thrown as MayuraError);
      expect(caught).toMatchObject({ reason }); expect(caught!.message).not.toContain('secret');
    }
  });

  it('stops the browser whose CDP address does not describe one', async () => {
    const fake = fakeBrowserUse({ create: () => Response.json({ id: 'bu-x', cdpUrl: 'https://cdp.browser-use.example/bu-x' }, { status: 201 }) });
    // Browser Use's own API answers the discovery request as a 404 here.
    expect(await browserUseBrowsers({ ...base, fetch: fake.fetch }).create(spec, { signal: signal() }).catch(caught => caught)).toMatchObject({ reason: 'unavailable' });
    expect(fake.seen.at(-2)).toMatchObject({ method: 'PATCH', path: '/api/v2/browsers/bu-x', body: { action: 'stop' } });
  });

  it('stops the browser on release; one already stopped counts as released, one still running does not', async () => {
    const fake = fakeBrowserUse();
    const backend = await browserUseBrowsers({ ...base, fetch: fake.fetch }).create(spec, { signal: signal() });
    await backend.release({ signal: signal() });
    expect(fake.seen.at(-1)).toMatchObject({ method: 'PATCH', path: '/api/v2/browsers/0000-bu-1', body: { action: 'stop' } });
    expect(fake.browsers.get('0000-bu-1')!.status).toBe('stopped');
    await backend.release({ signal: signal() });
    const stuck = fakeBrowserUse({ stop: () => Response.json({ detail: 'busy' }, { status: 503 }) });
    expect(await (await browserUseBrowsers({ ...base, fetch: stuck.fetch }).create(spec, { signal: signal() })).release({ signal: signal() }).catch(caught => caught)).toMatchObject({ reason: 'unavailable' });
  });
});
