import { describe, expect, it } from 'vitest';
import type { MayuraError } from 'mayura';
import { browserbaseBrowsers } from '../src/index.js';
import { fakeBrowserbase } from './fake.js';

const base = { apiKey: 'bb_test_key_123' };
const spec = { lifetimeMs: 600_000, viewport: { width: 1_024, height: 700 }, labels: { run: 'r1' } };
const signal = () => AbortSignal.timeout(10_000);

describe('browserbaseBrowsers', () => {
  it('refuses configuration it cannot use', () => {
    expect(() => browserbaseBrowsers({ apiKey: '' })).toThrow(/apiKey/u);
    expect(() => browserbaseBrowsers({ ...base, region: 'mars-1' as never })).toThrow(/region/u);
    expect(() => browserbaseBrowsers({ ...base, maxLifetimeMs: 30_000 })).toThrow(/maxLifetimeMs/u);
    expect(() => browserbaseBrowsers({ ...base, maxLifetimeMs: 7 * 3_600_000 })).toThrow(/maxLifetimeMs/u);
    expect(() => browserbaseBrowsers({ ...base, baseUrl: 'http://api.example' })).toThrow(/baseUrl/u);
    expect(() => browserbaseBrowsers({ ...base, solveCaptchas: 'yes' as never })).toThrow(/solveCaptchas/u);
    expect(browserbaseBrowsers(base)).toMatchObject({ id: 'browserbase', features: { liveView: true }, maxLifetimeMs: 21_600_000 });
  });

  it('creates a session that ends with its lifetime or its connection, with captchas, recording and logs off', async () => {
    const fake = fakeBrowserbase();
    const backend = await browserbaseBrowsers({ ...base, fetch: fake.fetch, region: 'eu-central-1' }).create(spec, { signal: signal() });
    expect(backend).toMatchObject({ id: 'sess-1', cdp: { url: 'wss://connect.browserbase.example/?signingKey=secret-sess-1' } });
    expect(backend.liveViewUrl).toMatch(/^https:\/\/www\.browserbase\.example\/devtools-fullscreen\//u);
    const created = fake.seen[0]!;
    expect([created.method, created.path, created.headers.get('x-bb-api-key')]).toEqual(['POST', '/v1/sessions', 'bb_test_key_123']);
    expect(created.body).toEqual({ region: 'eu-central-1', timeout: 600, keepAlive: false, userMetadata: { run: 'r1' },
      browserSettings: { viewport: { width: 1_024, height: 700 }, solveCaptchas: false, recordSession: false, logSession: false, blockAds: false } });
    expect(fake.seen[1]!.path).toBe('/v1/sessions/sess-1/debug?expiresIn=600');
  });

  it('asks for at least a minute and at most six hours', async () => {
    const fake = fakeBrowserbase();
    await browserbaseBrowsers({ ...base, fetch: fake.fetch, liveView: false }).create({ ...spec, lifetimeMs: 5_000 }, { signal: signal() });
    expect(fake.seen[0]!.body).toMatchObject({ timeout: 60 });
    expect(fake.seen).toHaveLength(1);
  });

  it('refuses replies it cannot trust, and maps failures without what Browserbase wrote', async () => {
    for (const reply of [{ id: 'sess-1' }, { id: '../x', connectUrl: 'wss://a/' }, { id: 'sess-1', connectUrl: 'ws://connect.browserbase.example/' }, { id: 'sess-1', connectUrl: 'https://a/' }]) {
      const fake = fakeBrowserbase({ create: () => Response.json(reply, { status: 201 }) });
      expect(await browserbaseBrowsers({ ...base, fetch: fake.fetch }).create(spec, { signal: signal() }).catch(caught => caught), JSON.stringify(reply)).toMatchObject({ reason: 'invalid_response' });
    }
    for (const [status, reason] of [[401, 'authentication'], [402, 'quota'], [429, 'rate_limited'], [503, 'unavailable']] as const) {
      const fake = fakeBrowserbase({ create: () => Response.json({ message: 'secret detail' }, { status }) });
      const caught = await browserbaseBrowsers({ ...base, fetch: fake.fetch }).create(spec, { signal: signal() }).then(() => undefined, (thrown: unknown) => thrown as MayuraError);
      expect(caught).toMatchObject({ reason }); expect(caught!.message).not.toContain('secret');
    }
  });

  it('releases a session whose live view it could not get', async () => {
    const fake = fakeBrowserbase({ debug: () => Response.json({ message: 'nope' }, { status: 500 }) });
    expect(await browserbaseBrowsers({ ...base, fetch: fake.fetch }).create(spec, { signal: signal() }).catch(caught => caught)).toMatchObject({ reason: 'unavailable' });
    expect(fake.seen.at(-1)).toMatchObject({ method: 'POST', path: '/v1/sessions/sess-1', body: { status: 'REQUEST_RELEASE', projectId: 'proj-1' } });
    expect(fake.sessions.get('sess-1')!.status).toBe('COMPLETED');
  });

  it('releases by asking Browserbase to; one already ended counts as released, one still running does not', async () => {
    const fake = fakeBrowserbase();
    const backend = await browserbaseBrowsers({ ...base, fetch: fake.fetch, liveView: false }).create(spec, { signal: signal() });
    await backend.release({ signal: signal() });
    expect(fake.seen.at(-1)).toMatchObject({ method: 'POST', path: '/v1/sessions/sess-1', body: { status: 'REQUEST_RELEASE', projectId: 'proj-1' } });
    await backend.release({ signal: signal() });
    const stuck = fakeBrowserbase({ release: () => Response.json({ message: 'busy' }, { status: 503 }) });
    const running = await browserbaseBrowsers({ ...base, fetch: stuck.fetch, liveView: false }).create(spec, { signal: signal() });
    expect(await running.release({ signal: signal() }).catch(caught => caught)).toMatchObject({ reason: 'unavailable' });
    const gone = fakeBrowserbase({ release: () => Response.json({}, { status: 400 }), sessionStatus: 'TIMED_OUT' });
    await (await browserbaseBrowsers({ ...base, fetch: gone.fetch, liveView: false }).create(spec, { signal: signal() })).release({ signal: signal() });
  });
});
