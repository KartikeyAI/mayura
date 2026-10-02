import { describe, expect, it } from 'vitest';
import { cloudflareBrowsers } from '../src/index.js';
import { account, fakeBrowserRun, token } from './fake.js';

const base = { accountId: account, apiToken: token };
const spec = { lifetimeMs: 600_000, viewport: { width: 1_024, height: 700 }, labels: {} };
const signal = () => ({ signal: AbortSignal.timeout(5_000) });
const prefix = `/client/v4/accounts/${account}/browser-run/devtools/browser`;

describe('cloudflareBrowsers', () => {
  it('refuses configuration it cannot use', () => {
    expect(() => cloudflareBrowsers({ ...base, accountId: 'acme' })).toThrow(/accountId/u);
    expect(() => cloudflareBrowsers({ ...base, apiToken: 'short' })).toThrow(/apiToken/u);
    expect(() => cloudflareBrowsers({ ...base, apiToken: 'has spaces in the token value!' })).toThrow(/apiToken/u);
    expect(() => cloudflareBrowsers({ ...base, keepAliveMs: 5_000 })).toThrow(/keepAliveMs/u);
    expect(() => cloudflareBrowsers({ ...base, keepAliveMs: 1_200_000 })).toThrow(/keepAliveMs/u);
    expect(() => cloudflareBrowsers({ ...base, maxLifetimeMs: 10 })).toThrow(/maxLifetimeMs/u);
    expect(() => cloudflareBrowsers({ ...base, liveView: 'watch' as never })).toThrow(/liveView/u);
    expect(() => cloudflareBrowsers({ ...base, fetch: 'no' as never })).toThrow(/fetch/u);
    for (const baseUrl of ['http://cf.internal', 'ftp://api.example', 'https://api.example/x', 'https://api.example/?y=1', 'https://u:p@api.example']) {
      expect(() => cloudflareBrowsers({ ...base, baseUrl }), baseUrl).toThrow(/baseUrl/u);
    }
    expect(cloudflareBrowsers(base)).toMatchObject({ id: 'cloudflare', features: { liveView: true }, maxLifetimeMs: 3_600_000 });
    expect(cloudflareBrowsers({ ...base, liveView: false }).features).toEqual({ liveView: false });
  });

  it('acquires a session with a keep-alive, and drives it at the session\'s own CDP address with the token in a header', async () => {
    const fake = fakeBrowserRun();
    const backend = await cloudflareBrowsers({ ...base, fetch: fake.fetch, liveView: false }).create(spec, signal());
    expect(fake.seen).toEqual([{ method: 'POST', path: prefix, search: '?keep_alive=60000', authorization: `Bearer ${token}` }]);
    expect(backend.id).toBe('1909cef7-0000-4394-bc31-000000000001');
    expect(backend.cdp).toEqual({ url: `wss://api.cloudflare.com${prefix}/${backend.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(backend.liveViewUrl).toBeUndefined();
    const local = await cloudflareBrowsers({ ...base, keepAliveMs: 600_000, fetch: fake.fetch, liveView: false, baseUrl: 'http://127.0.0.1:8787' }).create(spec, signal());
    expect(local.cdp.url).toBe(`ws://127.0.0.1:8787${prefix}/${local.id}`);
    expect(fake.seen.at(-1)).toMatchObject({ search: '?keep_alive=600000' });
  });

  it('gives a read-only live view by default, an interactive one when asked, for the browser\'s lifetime up to an hour', async () => {
    const fake = fakeBrowserRun();
    const viewed = await cloudflareBrowsers({ ...base, fetch: fake.fetch }).create(spec, signal());
    expect(viewed.liveViewUrl).toBe(`https://live.browser.run/ui/view?mode=tab&wss=x&jwt=signed-${viewed.id}`);
    expect(fake.seen[1]).toEqual({ method: 'POST', path: `${prefix}/${viewed.id}/live_view`, search: '', authorization: `Bearer ${token}`, body: { mode: 'tab', expiresInMs: 600_000, guardrails: { mode: 'readonly' } } });
    await cloudflareBrowsers({ ...base, fetch: fake.fetch, liveView: 'interact' }).create({ ...spec, lifetimeMs: 7_200_000 }, signal());
    expect(fake.seen.at(-1)!.body).toEqual({ mode: 'tab', expiresInMs: 3_600_000 });
  });

  it('closes the session on release, once and safely again; a failed live view closes it too', async () => {
    const fake = fakeBrowserRun();
    const backend = await cloudflareBrowsers({ ...base, fetch: fake.fetch, liveView: false }).create(spec, signal());
    await backend.release(signal());
    expect(fake.seen.at(-1)).toEqual({ method: 'DELETE', path: `${prefix}/${backend.id}`, search: '', authorization: `Bearer ${token}` });
    expect(fake.sessions.get(backend.id)!.closed).toBe(true);
    await expect(backend.release(signal())).resolves.toBeUndefined();
    const failing = fakeBrowserRun({ close: () => new Response('no', { status: 500 }) });
    const kept = await cloudflareBrowsers({ ...base, fetch: failing.fetch, liveView: false }).create(spec, signal());
    await expect(kept.release(signal())).rejects.toMatchObject({ reason: 'unavailable' });
    for (const [liveView, reason] of [[() => new Response('no', { status: 500 }), 'unavailable'], [() => Response.json({ devtoolsFrontendUrl: 'http://live.example/x' }), 'invalid_response']] as const) {
      const broken = fakeBrowserRun({ liveView });
      await expect(cloudflareBrowsers({ ...base, fetch: broken.fetch }).create(spec, signal())).rejects.toMatchObject({ reason });
      expect(broken.seen.at(-1)).toMatchObject({ method: 'DELETE' });
      expect([...broken.sessions.values()].every(session => session.closed)).toBe(true);
    }
  });

  it('turns Cloudflare\'s refusals and odd answers into browser errors', async () => {
    const create = (fake: ReturnType<typeof fakeBrowserRun>) => cloudflareBrowsers({ ...base, fetch: fake.fetch, liveView: false }).create(spec, signal());
    await expect(create(fakeBrowserRun({ acquire: () => new Response('{}', { status: 429 }) }))).rejects.toMatchObject({ reason: 'rate_limited' });
    await expect(cloudflareBrowsers({ ...base, apiToken: 'cf_wrong_token_0123456789abcdef', fetch: fakeBrowserRun().fetch }).create(spec, signal())).rejects.toMatchObject({ reason: 'authentication' });
    for (const reply of [{}, { sessionId: '../other' }, { sessionId: 42 }]) {
      await expect(create(fakeBrowserRun({ acquire: () => Response.json(reply) })), JSON.stringify(reply)).rejects.toMatchObject({ reason: 'invalid_response' });
    }
  });
});
