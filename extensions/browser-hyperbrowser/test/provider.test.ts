import { describe, expect, it } from 'vitest';
import type { MayuraError } from 'mayura';
import { hyperbrowserBrowsers } from '../src/index.js';
import { fakeHyperbrowser } from './fake.js';

const base = { apiKey: 'hb_test_key_1' };
const spec = { lifetimeMs: 600_000, viewport: { width: 1_024, height: 700 }, labels: { run: 'r1' } };
const signal = () => AbortSignal.timeout(10_000);

describe('hyperbrowserBrowsers', () => {
  it('refuses configuration it cannot use', () => {
    expect(() => hyperbrowserBrowsers({ apiKey: '' })).toThrow(/apiKey/u);
    expect(() => hyperbrowserBrowsers({ ...base, liveView: true as never })).toThrow(/liveView/u);
    expect(() => hyperbrowserBrowsers({ ...base, region: 'Bad Region' })).toThrow(/region/u);
    expect(() => hyperbrowserBrowsers({ ...base, maxLifetimeMs: 30_000 })).toThrow(/maxLifetimeMs/u);
    expect(() => hyperbrowserBrowsers({ ...base, maxLifetimeMs: 13 * 3_600_000 })).toThrow(/maxLifetimeMs/u);
    expect(() => hyperbrowserBrowsers({ ...base, baseUrl: 'http://api.example' })).toThrow(/baseUrl/u);
    expect(() => hyperbrowserBrowsers({ ...base, adblock: 'yes' as never })).toThrow(/adblock/u);
    expect(hyperbrowserBrowsers(base)).toMatchObject({ id: 'hyperbrowser', features: { liveView: true }, maxLifetimeMs: 43_200_000 });
  });

  it('creates a session that stops at its lifetime, with proxies, stealth, captchas, recording and saved downloads off', async () => {
    const fake = fakeHyperbrowser();
    const backend = await hyperbrowserBrowsers({ ...base, fetch: fake.fetch, region: 'us-east' }).create(spec, { signal: signal() });
    const created = fake.seen[0]!;
    expect([created.method, created.path, created.headers.get('x-api-key')]).toEqual(['POST', '/api/session', 'hb_test_key_1']);
    expect(created.body).toEqual({ timeoutMinutes: 10, screen: { width: 1_024, height: 700 }, region: 'us-east', useProxy: false, useStealth: false, solveCaptchas: false,
      adblock: false, enableWebRecording: false, enableVideoWebRecording: false, saveDownloads: false, viewOnlyLiveView: true });
    expect(backend).toMatchObject({ id: 'hb-session-1', cdp: { url: 'wss://connect.hyperbrowser.example/?token=secret-hb-session-1' }, liveViewUrl: 'https://app.hyperbrowser.example/live?token=live-hb-session-1' });
  });

  it('asks for whole minutes from 1 to 720, a live view to use only when asked, and none when not wanted', async () => {
    const fake = fakeHyperbrowser();
    await hyperbrowserBrowsers({ ...base, fetch: fake.fetch, liveView: 'interact' }).create({ ...spec, lifetimeMs: 5_000 }, { signal: signal() });
    expect(fake.seen.at(-1)!.body).toMatchObject({ timeoutMinutes: 1, viewOnlyLiveView: false });
    await hyperbrowserBrowsers({ ...base, fetch: fake.fetch }).create({ ...spec, lifetimeMs: 90_000 }, { signal: signal() });
    expect(fake.seen.at(-1)!.body).toMatchObject({ timeoutMinutes: 2 });
    expect((await hyperbrowserBrowsers({ ...base, fetch: fake.fetch, liveView: false }).create(spec, { signal: signal() })).liveViewUrl).toBeUndefined();
  });

  it('refuses replies it cannot trust, and maps failures without what Hyperbrowser wrote', async () => {
    for (const reply of [{ id: 'x' }, { id: '../x', wsEndpoint: 'wss://a/' }, { id: 'x', wsEndpoint: 'ws://connect.hyperbrowser.example/' }, { id: 'x', wsEndpoint: 'https://a/' }]) {
      const fake = fakeHyperbrowser({ create: () => Response.json(reply) });
      expect(await hyperbrowserBrowsers({ ...base, fetch: fake.fetch }).create(spec, { signal: signal() }).catch(caught => caught), JSON.stringify(reply)).toMatchObject({ reason: 'invalid_response' });
    }
    for (const [status, reason] of [[401, 'authentication'], [402, 'quota'], [429, 'rate_limited'], [503, 'unavailable']] as const) {
      const fake = fakeHyperbrowser({ create: () => Response.json({ message: 'secret detail' }, { status }) });
      const caught = await hyperbrowserBrowsers({ ...base, fetch: fake.fetch }).create(spec, { signal: signal() }).then(() => undefined, (thrown: unknown) => thrown as MayuraError);
      expect(caught).toMatchObject({ reason }); expect(caught!.message).not.toContain('secret');
    }
  });

  it('stops sessions; one already ended counts as released, one that failed to close or still runs does not', async () => {
    const fake = fakeHyperbrowser();
    const backend = await hyperbrowserBrowsers({ ...base, fetch: fake.fetch }).create(spec, { signal: signal() });
    await backend.release({ signal: signal() });
    expect(fake.seen.at(-1)).toMatchObject({ method: 'PUT', path: '/api/session/hb-session-1/stop' });
    expect(fake.sessions.get('hb-session-1')!.status).toBe('closed');
    // Stopped already: Hyperbrowser refuses, and its status says it ended.
    await backend.release({ signal: signal() });
    const missing = fakeHyperbrowser({ stop: () => Response.json({ message: 'Session not found' }, { status: 404 }) });
    expect(await (await hyperbrowserBrowsers({ ...base, fetch: missing.fetch }).create(spec, { signal: signal() })).release({ signal: signal() }).catch(caught => caught)).toMatchObject({ reason: 'gone' });
    const stuck = fakeHyperbrowser({ stop: () => Response.json({ message: 'busy' }, { status: 500 }) });
    expect(await (await hyperbrowserBrowsers({ ...base, fetch: stuck.fetch }).create(spec, { signal: signal() })).release({ signal: signal() }).catch(caught => caught)).toMatchObject({ reason: 'unavailable' });
    const closeError = fakeHyperbrowser({ stop: () => Response.json({}, { status: 500 }), sessionStatus: 'close-error' });
    expect(await (await hyperbrowserBrowsers({ ...base, fetch: closeError.fetch }).create(spec, { signal: signal() })).release({ signal: signal() }).catch(caught => caught)).toMatchObject({ reason: 'unavailable' });
  });
});
