import { describe, expect, it } from 'vitest';
import { cloudflareBrowsers } from '../src/index.js';

const base = { accountId: '0123456789abcdef0123456789abcdef', apiToken: 'cf_test_token_0123456789abcdef' };
const spec = { lifetimeMs: 600_000, viewport: { width: 1_024, height: 700 }, labels: {} };
const create = (options: Parameters<typeof cloudflareBrowsers>[0]) => cloudflareBrowsers(options).create(spec, { signal: AbortSignal.timeout(5_000) });

describe('cloudflareBrowsers', () => {
  it('refuses configuration it cannot use', () => {
    expect(() => cloudflareBrowsers({ ...base, accountId: 'acme' })).toThrow(/accountId/u);
    expect(() => cloudflareBrowsers({ ...base, apiToken: 'short' })).toThrow(/apiToken/u);
    expect(() => cloudflareBrowsers({ ...base, apiToken: 'has spaces in the token value!' })).toThrow(/apiToken/u);
    expect(() => cloudflareBrowsers({ ...base, keepAliveMs: 5_000 })).toThrow(/keepAliveMs/u);
    expect(() => cloudflareBrowsers({ ...base, keepAliveMs: 1_200_000 })).toThrow(/keepAliveMs/u);
    expect(() => cloudflareBrowsers({ ...base, maxLifetimeMs: 10 })).toThrow(/maxLifetimeMs/u);
    for (const endpoint of ['ws://cf.internal/devtools/browser', 'https://api.example/x', 'wss://a.example/x?y=1', 'wss://u:p@a.example/x']) {
      expect(() => cloudflareBrowsers({ ...base, endpoint }), endpoint).toThrow(/endpoint/u);
    }
    expect(cloudflareBrowsers(base)).toMatchObject({ id: 'cloudflare', features: { liveView: false }, maxLifetimeMs: 3_600_000 });
  });

  it('acquires a browser at the account\'s Browser Run endpoint, with the token in a header and a keep-alive', async () => {
    const backend = await create(base);
    expect(backend.cdp).toEqual({
      url: 'wss://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/browser-run/devtools/browser?keep_alive=60000',
      headers: { authorization: 'Bearer cf_test_token_0123456789abcdef' },
    });
    expect(new URL((await create({ ...base, keepAliveMs: 600_000, endpoint: 'ws://127.0.0.1:8787/devtools/browser' })).cdp.url).href).toBe('ws://127.0.0.1:8787/devtools/browser?keep_alive=600000');
  });

  it('gives each browser its own id, and nothing to release beyond closing its connection', async () => {
    const provider = cloudflareBrowsers(base);
    const first = await provider.create(spec, { signal: AbortSignal.timeout(5_000) });
    const second = await provider.create(spec, { signal: AbortSignal.timeout(5_000) });
    expect(first.id).not.toBe(second.id);
    await first.release({ signal: AbortSignal.timeout(5_000) });
  });
});
