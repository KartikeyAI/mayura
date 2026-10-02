import { describe, expect, it } from 'vitest';
import type { MayuraError } from 'mayura';
import { steelBrowsers } from '../src/index.js';
import { fakeSteel } from './fake.js';

const base = { apiKey: 'steel_test_key_1' };
const spec = { lifetimeMs: 600_000, viewport: { width: 1_024, height: 700 }, labels: { run: 'r1' } };
const signal = () => AbortSignal.timeout(10_000);

describe('steelBrowsers', () => {
  it('refuses configuration it cannot use', () => {
    expect(() => steelBrowsers({ apiKey: '' })).toThrow(/apiKey/u);
    expect(() => steelBrowsers({ ...base, liveView: true as never })).toThrow(/liveView/u);
    expect(() => steelBrowsers({ ...base, maxLifetimeMs: 1_000 })).toThrow(/maxLifetimeMs/u);
    expect(() => steelBrowsers({ ...base, maxLifetimeMs: 2 * 86_400_000 })).toThrow(/maxLifetimeMs/u);
    expect(() => steelBrowsers({ ...base, inactivityTimeoutMs: 10 })).toThrow(/inactivityTimeoutMs/u);
    expect(() => steelBrowsers({ ...base, baseUrl: 'http://api.example' })).toThrow(/baseUrl/u);
    expect(() => steelBrowsers({ ...base, blockAds: 'yes' as never })).toThrow(/blockAds/u);
    expect(steelBrowsers(base)).toMatchObject({ id: 'steel', features: { liveView: true } });
    expect(steelBrowsers({ ...base, liveView: false }).features.liveView).toBe(false);
  });

  it('creates a session that ends at its lifetime, without captcha solving, ads blocked or proxies unless asked', async () => {
    const fake = fakeSteel();
    const backend = await steelBrowsers({ ...base, fetch: fake.fetch }).create(spec, { signal: signal() });
    const created = fake.seen[0]!;
    expect([created.method, created.path, created.headers.get('steel-api-key')]).toEqual(['POST', '/v1/sessions', 'steel_test_key_1']);
    expect(created.body).toEqual({ timeout: 600_000, dimensions: { width: 1_024, height: 700 }, solveCaptcha: false, blockAds: false, useProxy: false });
    // The key rides on the WebSocket as Steel asks; the viewer only shows.
    expect(new URL(backend.cdp.url).searchParams.get('apiKey')).toBe('steel_test_key_1');
    expect(new URL(backend.cdp.url).searchParams.get('sessionId')).toBe(backend.id);
    expect(new URL(backend.liveViewUrl!).searchParams.get('interactive')).toBe('false');
  });

  it('gives Steel at least its minimum timeout, an inactivity timeout when asked, and a viewer to interact with when asked', async () => {
    const fake = fakeSteel();
    const backend = await steelBrowsers({ ...base, fetch: fake.fetch, inactivityTimeoutMs: 60_000, liveView: 'interact' }).create({ ...spec, lifetimeMs: 5_000 }, { signal: signal() })
      .catch(caught => caught);
    expect(backend).toMatchObject({ code: 'INVALID_INPUT' });
    const ok = await steelBrowsers({ ...base, fetch: fake.fetch, inactivityTimeoutMs: 60_000, liveView: 'interact' }).create(spec, { signal: signal() });
    expect(fake.seen.at(-1)!.body).toMatchObject({ timeout: 600_000, inactivityTimeout: 60_000 });
    expect(new URL(ok.liveViewUrl!).searchParams.get('interactive')).toBe('true');
    await steelBrowsers({ ...base, fetch: fake.fetch }).create({ ...spec, lifetimeMs: 5_000 }, { signal: signal() });
    expect(fake.seen.at(-1)!.body).toMatchObject({ timeout: 15_000 });
    const none = await steelBrowsers({ ...base, fetch: fake.fetch, liveView: false }).create(spec, { signal: signal() });
    expect(none.liveViewUrl).toBeUndefined();
  });

  it('refuses replies it cannot trust, and maps failures without what Steel wrote', async () => {
    for (const reply of [{ id: 'x' }, { id: '../x', websocketUrl: 'wss://a/' }, { id: 'x', websocketUrl: 'ws://connect.steel.example/' }, { id: 'x', websocketUrl: 'https://a/' }]) {
      const fake = fakeSteel({ create: () => Response.json(reply) });
      expect(await steelBrowsers({ ...base, fetch: fake.fetch }).create(spec, { signal: signal() }).catch(caught => caught), JSON.stringify(reply)).toMatchObject({ reason: 'invalid_response' });
    }
    for (const [status, reason] of [[401, 'authentication'], [402, 'quota'], [429, 'rate_limited'], [503, 'unavailable']] as const) {
      const fake = fakeSteel({ create: () => Response.json({ message: 'secret detail' }, { status }) });
      const caught = await steelBrowsers({ ...base, fetch: fake.fetch }).create(spec, { signal: signal() }).then(() => undefined, (thrown: unknown) => thrown as MayuraError);
      expect(caught).toMatchObject({ reason }); expect(caught!.message).not.toContain('secret');
    }
  });

  it('releases explicitly; one already ended counts as released, one still running does not', async () => {
    const fake = fakeSteel();
    const backend = await steelBrowsers({ ...base, fetch: fake.fetch }).create(spec, { signal: signal() });
    await backend.release({ signal: signal() });
    expect(fake.seen.at(-1)).toMatchObject({ method: 'POST', path: `/v1/sessions/${backend.id}/release` });
    expect(fake.sessions.get(backend.id)!.status).toBe('released');
    await backend.release({ signal: signal() });
    const stuck = fakeSteel({ release: () => Response.json({ message: 'busy' }, { status: 503 }) });
    const running = await steelBrowsers({ ...base, fetch: stuck.fetch }).create(spec, { signal: signal() });
    expect(await running.release({ signal: signal() }).catch(caught => caught)).toMatchObject({ reason: 'unavailable' });
    const failed = fakeSteel({ release: () => Response.json({}, { status: 400 }), sessionStatus: 'failed' });
    await (await steelBrowsers({ ...base, fetch: failed.fetch }).create(spec, { signal: signal() })).release({ signal: signal() });
  });
});
