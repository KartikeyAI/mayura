import { describe, expect, it } from 'vitest';
import type { MayuraError } from 'mayura';
import { anchorBrowsers } from '../src/index.js';
import { fakeAnchor } from './fake.js';

const base = { apiKey: 'sk-anchor-test-1' };
const spec = { lifetimeMs: 600_000, viewport: { width: 1_024, height: 700 }, labels: { run: 'r1' } };
const signal = () => AbortSignal.timeout(10_000);

describe('anchorBrowsers', () => {
  it('refuses configuration it cannot use', () => {
    expect(() => anchorBrowsers({ apiKey: '' })).toThrow(/apiKey/u);
    expect(() => anchorBrowsers({ ...base, liveView: true as never })).toThrow(/liveView/u);
    expect(() => anchorBrowsers({ ...base, idleTimeoutMinutes: 0 })).toThrow(/idleTimeoutMinutes/u);
    expect(() => anchorBrowsers({ ...base, idleTimeoutMinutes: 2_000 })).toThrow(/idleTimeoutMinutes/u);
    expect(() => anchorBrowsers({ ...base, maxLifetimeMs: 30_000 })).toThrow(/maxLifetimeMs/u);
    expect(() => anchorBrowsers({ ...base, recording: 'yes' as never })).toThrow(/recording/u);
    expect(() => anchorBrowsers({ ...base, baseUrl: 'http://api.example' })).toThrow(/baseUrl/u);
    expect(anchorBrowsers(base)).toMatchObject({ id: 'anchor', features: { liveView: true } });
  });

  it('creates a session ended at its lifetime or soon after nothing is connected, with recording, ads, proxy and captchas off', async () => {
    const fake = fakeAnchor();
    const backend = await anchorBrowsers({ ...base, fetch: fake.fetch }).create(spec, { signal: signal() });
    const created = fake.seen[0]!;
    expect([created.method, created.path, created.headers.get('anchor-api-key')]).toEqual(['POST', '/v1/sessions', 'sk-anchor-test-1']);
    expect(created.body).toEqual({
      session: { timeout: { max_duration: 10, idle_timeout: 1 }, recording: { active: false }, proxy: { active: false }, live_view: { read_only: true }, tags: ['run=r1'] },
      browser: { viewport: { width: 1_024, height: 700 }, adblock: { active: false }, captcha_solver: { active: false }, headless: { active: false } },
    });
    expect(backend).toMatchObject({ id: 'anchor-1', cdp: { url: 'wss://connect.anchorbrowser.example?apiKey=secret&sessionId=anchor-1' }, liveViewUrl: 'https://live.anchorbrowser.example/inspector.html?sessionId=anchor-1' });
  });

  it('asks for whole minutes, runs headless without a live view, and lets the live view be used only when asked', async () => {
    const fake = fakeAnchor();
    await anchorBrowsers({ ...base, fetch: fake.fetch, liveView: false, idleTimeoutMinutes: 10 }).create({ ...spec, lifetimeMs: 5_000, labels: {} }, { signal: signal() });
    expect(fake.seen.at(-1)!.body).toEqual({
      session: { timeout: { max_duration: 1, idle_timeout: 10 }, recording: { active: false }, proxy: { active: false } },
      browser: { viewport: { width: 1_024, height: 700 }, adblock: { active: false }, captcha_solver: { active: false }, headless: { active: true } },
    });
    await anchorBrowsers({ ...base, fetch: fake.fetch, liveView: 'interact', adblock: true, recording: true }).create(spec, { signal: signal() });
    expect(fake.seen.at(-1)!.body).toMatchObject({ session: { recording: { active: true }, live_view: { read_only: false } }, browser: { adblock: { active: true } } });
  });

  it('refuses replies it cannot trust, and maps failures without what Anchor wrote', async () => {
    for (const reply of [{ id: 'x', cdp_url: 'wss://a/' }, { data: { id: 'x' } }, { data: { id: '../x', cdp_url: 'wss://a/' } }, { data: { id: 'x', cdp_url: 'ws://connect.anchorbrowser.example/' } }]) {
      const fake = fakeAnchor({ create: () => Response.json(reply) });
      expect(await anchorBrowsers({ ...base, fetch: fake.fetch }).create(spec, { signal: signal() }).catch(caught => caught), JSON.stringify(reply)).toMatchObject({ reason: 'invalid_response' });
    }
    for (const [status, reason] of [[401, 'authentication'], [402, 'quota'], [429, 'rate_limited'], [503, 'unavailable']] as const) {
      const fake = fakeAnchor({ create: () => Response.json({ error: { message: 'secret detail' } }, { status }) });
      const caught = await anchorBrowsers({ ...base, fetch: fake.fetch }).create(spec, { signal: signal() }).then(() => undefined, (thrown: unknown) => thrown as MayuraError);
      expect(caught).toMatchObject({ reason }); expect(caught!.message).not.toContain('secret');
    }
  });

  it('ends the session on release; one Anchor no longer has is gone, other failures are reported', async () => {
    const fake = fakeAnchor();
    const backend = await anchorBrowsers({ ...base, fetch: fake.fetch }).create(spec, { signal: signal() });
    await backend.release({ signal: signal() });
    expect(fake.seen.at(-1)).toMatchObject({ method: 'DELETE', path: '/v1/sessions/anchor-1' });
    expect(fake.sessions.get('anchor-1')!.ended).toBe(true);
    expect(await backend.release({ signal: signal() }).catch(caught => caught)).toMatchObject({ reason: 'gone' });
    const failing = fakeAnchor({ end: () => Response.json({ error: { message: 'oops' } }, { status: 500 }) });
    expect(await (await anchorBrowsers({ ...base, fetch: failing.fetch }).create(spec, { signal: signal() })).release({ signal: signal() }).catch(caught => caught)).toMatchObject({ reason: 'unavailable' });
  });
});
