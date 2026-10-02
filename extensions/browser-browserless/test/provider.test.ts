import { describe, expect, it } from 'vitest';
import { browserlessBrowsers } from '../src/index.js';

const base = { token: 'bl_test_token_1' };
const spec = { lifetimeMs: 600_000, viewport: { width: 1_024, height: 700 }, labels: { run: 'r1' } };
const create = (options: Parameters<typeof browserlessBrowsers>[0]) => browserlessBrowsers(options).create(spec, { signal: AbortSignal.timeout(5_000) });

describe('browserlessBrowsers', () => {
  it('refuses configuration it cannot use', () => {
    expect(() => browserlessBrowsers({ token: '' })).toThrow(/token/u);
    expect(() => browserlessBrowsers({ token: 'has spaces in it' })).toThrow(/token/u);
    expect(() => browserlessBrowsers({ ...base, region: 'production-mars' as never })).toThrow(/region/u);
    expect(() => browserlessBrowsers({ ...base, region: 'production-lon', endpoint: 'wss://own.example' })).toThrow(/region or an endpoint/u);
    for (const endpoint of ['ws://browserless.internal:3000', 'https://browserless.internal', 'wss://own.example/?token=x', 'wss://user:pass@own.example', 'not a url']) {
      expect(() => browserlessBrowsers({ ...base, endpoint }), endpoint).toThrow(/endpoint/u);
    }
    expect(() => browserlessBrowsers({ ...base, maxLifetimeMs: 2 * 86_400_000 })).toThrow(/maxLifetimeMs/u);
    expect(() => browserlessBrowsers({ ...base, stealth: 'yes' as never })).toThrow(/stealth/u);
    expect(browserlessBrowsers(base)).toMatchObject({ id: 'browserless', features: { liveView: false }, maxLifetimeMs: 3_600_000 });
  });

  it('connects to the hosted region with the token and the lifetime as its timeout, nothing else unless asked', async () => {
    const url = new URL((await create(base)).cdp.url);
    expect([url.origin.replace(/^https?/u, 'wss'), url.protocol, url.host]).toEqual(['wss://production-sfo.browserless.io', 'wss:', 'production-sfo.browserless.io']);
    expect(Object.fromEntries(url.searchParams)).toEqual({ token: 'bl_test_token_1', timeout: '600000' });
    const lon = new URL((await create({ ...base, region: 'production-lon', blockAds: true, stealth: true })).cdp.url);
    expect(lon.host).toBe('production-lon.browserless.io');
    expect(Object.fromEntries(lon.searchParams)).toEqual({ token: 'bl_test_token_1', timeout: '600000', blockAds: 'true', stealth: 'true' });
  });

  it('connects to your own Browserless, plainly only on this machine', async () => {
    expect((await create({ ...base, endpoint: 'wss://browserless.internal/chromium' })).cdp.url).toBe('wss://browserless.internal/chromium?token=bl_test_token_1&timeout=600000');
    expect((await create({ ...base, endpoint: 'ws://127.0.0.1:3000' })).cdp.url).toBe('ws://127.0.0.1:3000/?token=bl_test_token_1&timeout=600000');
  });

  it('gives each browser its own id, and nothing to release beyond closing its connection', async () => {
    const provider = browserlessBrowsers(base);
    const [first, second] = [await provider.create(spec, { signal: AbortSignal.timeout(5_000) }), await provider.create(spec, { signal: AbortSignal.timeout(5_000) })];
    expect(first.id).not.toBe(second.id);
    await first.release({ signal: AbortSignal.timeout(5_000) });
  });
});
