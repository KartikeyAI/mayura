import { describe, expect, it } from 'vitest';
import type { MayuraError } from 'mayura';
import { browserViewBrowsers } from '../src/index.js';
import { fakeBrowserView } from './fake.js';

const base = { apiKey: 'bv_live_test_1', baseUrl: 'https://sessions.browserview.example' };
const spec = { lifetimeMs: 600_000, viewport: { width: 1_024, height: 700 }, labels: { run: 'r1' } };
const signal = () => AbortSignal.timeout(10_000);

describe('browserViewBrowsers', () => {
  it('refuses configuration it cannot use', () => {
    expect(() => browserViewBrowsers({ apiKey: '' })).toThrow(/apiKey/u);
    expect(() => browserViewBrowsers({ ...base, liveView: true as never })).toThrow(/liveView/u);
    expect(() => browserViewBrowsers({ ...base, idleTimeoutSeconds: -1 })).toThrow(/idleTimeoutSeconds/u);
    expect(() => browserViewBrowsers({ ...base, maxLifetimeMs: 5 * 3_600_000 })).toThrow(/maxLifetimeMs/u);
    expect(() => browserViewBrowsers({ ...base, stealth: 'yes' as never })).toThrow(/stealth/u);
    expect(() => browserViewBrowsers({ ...base, baseUrl: 'http://api.example' })).toThrow(/baseUrl/u);
    expect(browserViewBrowsers({ apiKey: 'bv_live_test_1' })).toMatchObject({ id: 'browserview', features: { liveView: true }, maxLifetimeMs: 14_400_000 });
  });

  it('creates a session not kept alive, ended at its lifetime, with stealth, proxies, captchas, downloads, recording and its agent off', async () => {
    const fake = fakeBrowserView();
    const backend = await browserViewBrowsers({ ...base, fetch: fake.fetch }).create(spec, { signal: signal() });
    const created = fake.seen[0]!;
    expect([created.method, created.path, created.headers.get('authorization')]).toEqual(['POST', '/sessions', 'Bearer bv_live_test_1']);
    expect(created.body).toEqual({ width: 1_024, height: 700, timeout_seconds: 600, idle_timeout_seconds: 0, keep_alive: false,
      stealth: false, proxies: false, solve_captchas: false, downloads: false, record: false, agent: false, metadata: { run: 'r1' } });
    // The browser's WebSocket comes from the session's CDP address, asked with the session token, which it also needs.
    expect([fake.seen[1]!.path, fake.seen[1]!.headers.get('x-session-token'), fake.seen[1]!.headers.get('authorization')]).toEqual(['/sessions/bv_1/cdp/json/version', 'cdp-token-bv_1', null]);
    expect(backend.cdp).toEqual({ url: 'wss://sessions.browserview.example/devtools/browser/bv_1', headers: { 'x-session-token': 'cdp-token-bv_1' } });
    expect(backend.liveViewUrl).toBe('https://sessions.browserview.example/sessions/bv_1/watch?token=view-bv_1');
  });

  it('keeps the screen to what BrowserView takes, uses the viewer only when asked, and an idle timeout when given', async () => {
    const fake = fakeBrowserView();
    const used = await browserViewBrowsers({ ...base, fetch: fake.fetch, liveView: 'interact', idleTimeoutSeconds: 300 }).create({ lifetimeMs: 1_500, viewport: { width: 100, height: 5_000 }, labels: {} }, { signal: signal() });
    expect(fake.seen[0]!.body).toMatchObject({ width: 320, height: 2_160, timeout_seconds: 2, idle_timeout_seconds: 300 });
    expect(fake.seen[0]!.body).not.toHaveProperty('metadata');
    expect(used.liveViewUrl).toBe('https://sessions.browserview.example/sessions/bv_1/viewer?token=control-bv_1');
  });

  it('refuses replies it cannot trust, and maps failures without what BrowserView wrote', async () => {
    for (const reply of [{ id: 'x', cdp_token: 't' }, { id: '../x', cdp_url: '/s/x/cdp', cdp_token: 't' }, { id: 'x', cdp_url: '//evil.example/cdp', cdp_token: 't' },
      { id: 'x', cdp_url: 'https://evil.example/cdp', cdp_token: 't' }, { id: 'x', cdp_url: '/s/x/cdp' }]) {
      const fake = fakeBrowserView({ create: () => Response.json(reply, { status: 201 }) });
      expect(await browserViewBrowsers({ ...base, fetch: fake.fetch }).create(spec, { signal: signal() }).catch(caught => caught), JSON.stringify(reply)).toMatchObject({ reason: 'invalid_response' });
    }
    for (const [status, reason] of [[401, 'authentication'], [403, 'authentication'], [429, 'rate_limited'], [503, 'unavailable']] as const) {
      const fake = fakeBrowserView({ create: () => Response.json({ error: 'secret detail' }, { status }) });
      const caught = await browserViewBrowsers({ ...base, fetch: fake.fetch }).create(spec, { signal: signal() }).then(() => undefined, (thrown: unknown) => thrown as MayuraError);
      expect(caught).toMatchObject({ reason }); expect(caught!.message).not.toContain('secret');
    }
  });

  it('releases a session whose CDP address does not describe its browser', async () => {
    const fake = fakeBrowserView({ create: () => Response.json({ id: 'bv_9', cdp_url: '/sessions/bv_9/cdp', cdp_token: 't' }, { status: 201 }) });
    expect(await browserViewBrowsers({ ...base, fetch: fake.fetch }).create(spec, { signal: signal() }).catch(caught => caught)).toMatchObject({ reason: 'unavailable' });
    expect(fake.seen.at(-1)).toMatchObject({ method: 'POST', path: '/sessions/bv_9/release' });
  });

  it('releases idempotently; one BrowserView does not have is gone, other failures are reported', async () => {
    const fake = fakeBrowserView();
    const backend = await browserViewBrowsers({ ...base, fetch: fake.fetch }).create(spec, { signal: signal() });
    await backend.release({ signal: signal() }); await backend.release({ signal: signal() });
    expect(fake.seen.at(-1)).toMatchObject({ method: 'POST', path: '/sessions/bv_1/release' });
    expect(fake.sessions.get('bv_1')!.ended).toBe(true);
    const missing = fakeBrowserView({ release: () => Response.json({ error: 'not_found' }, { status: 404 }) });
    expect(await (await browserViewBrowsers({ ...base, fetch: missing.fetch }).create(spec, { signal: signal() })).release({ signal: signal() }).catch(caught => caught)).toMatchObject({ reason: 'gone' });
    const failing = fakeBrowserView({ release: () => Response.json({ error: 'oops' }, { status: 500 }) });
    expect(await (await browserViewBrowsers({ ...base, fetch: failing.fetch }).create(spec, { signal: signal() })).release({ signal: signal() }).catch(caught => caught)).toMatchObject({ reason: 'unavailable' });
  });
});
