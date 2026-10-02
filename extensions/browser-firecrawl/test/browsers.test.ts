import { describe, expect, it } from 'vitest';
import type { MayuraError } from 'mayura';
import { firecrawlBrowsers } from '../src/index.js';
import { fakeFirecrawl } from './fake.js';

const base = { apiKey: 'fc-test-key-1' };
const spec = { lifetimeMs: 600_000, viewport: { width: 1_024, height: 700 }, labels: { run: 'r1' } };
const signal = () => AbortSignal.timeout(10_000);

describe('firecrawlBrowsers', () => {
  it('refuses configuration it cannot use', () => {
    expect(() => firecrawlBrowsers({ apiKey: '' })).toThrow(/apiKey/u);
    expect(() => firecrawlBrowsers({ ...base, liveView: true as never })).toThrow(/liveView/u);
    expect(() => firecrawlBrowsers({ ...base, activityTimeoutSeconds: 5 })).toThrow(/activityTimeoutSeconds/u);
    expect(() => firecrawlBrowsers({ ...base, maxLifetimeMs: 2 * 3_600_000 })).toThrow(/maxLifetimeMs/u);
    expect(() => firecrawlBrowsers({ ...base, baseUrl: 'http://api.example' })).toThrow(/baseUrl/u);
    expect(firecrawlBrowsers(base)).toMatchObject({ id: 'firecrawl', features: { liveView: true }, maxLifetimeMs: 3_600_000 });
  });

  it('creates a session ended at its lifetime or when idle, with a view-only live view unless asked', async () => {
    const fake = fakeFirecrawl();
    const backend = await firecrawlBrowsers({ ...base, fetch: fake.fetch }).create(spec, { signal: signal() });
    expect([fake.seen[0]!.method, fake.seen[0]!.path, fake.seen[0]!.headers.get('authorization')]).toEqual(['POST', '/v2/interact', 'Bearer fc-test-key-1']);
    expect(fake.seen[0]!.body).toEqual({ ttl: 600, activityTtl: 300 });
    expect(backend).toMatchObject({ id: 'fc-session-1', cdp: { url: 'wss://cdp-proxy.firecrawl.example/cdp/fc-session-1?token=secret' }, liveViewUrl: 'https://liveview.firecrawl.example/fc-session-1' });
    const used = await firecrawlBrowsers({ ...base, fetch: fake.fetch, liveView: 'interact', activityTimeoutSeconds: 60 }).create({ ...spec, lifetimeMs: 5_000 }, { signal: signal() });
    expect(fake.seen.at(-1)!.body).toEqual({ ttl: 30, activityTtl: 60 });
    expect(used.liveViewUrl).toBe('https://liveview.firecrawl.example/fc-session-2?interactive=true');
  });

  it('refuses replies it cannot trust, and maps failures without what Firecrawl wrote', async () => {
    for (const reply of [{ id: 'x' }, { id: '../x', cdpUrl: 'wss://a/' }, { id: 'x', cdpUrl: 'ws://cdp.firecrawl.example/' }, { id: 'x', cdpUrl: 'https://a/' }]) {
      const fake = fakeFirecrawl({ reply: seen => seen.path === '/v2/interact' ? Response.json(reply) : undefined });
      expect(await firecrawlBrowsers({ ...base, fetch: fake.fetch }).create(spec, { signal: signal() }).catch(caught => caught), JSON.stringify(reply)).toMatchObject({ reason: 'invalid_response' });
    }
    for (const [status, reason] of [[401, 'authentication'], [402, 'quota'], [429, 'rate_limited'], [503, 'unavailable']] as const) {
      const fake = fakeFirecrawl({ reply: () => Response.json({ error: 'secret detail' }, { status }) });
      const caught = await firecrawlBrowsers({ ...base, fetch: fake.fetch }).create(spec, { signal: signal() }).then(() => undefined, (thrown: unknown) => thrown as MayuraError);
      expect(caught).toMatchObject({ reason }); expect(caught!.message).not.toContain('secret');
    }
  });

  it('deletes the session on release; one deleted already is gone, other failures are reported', async () => {
    const fake = fakeFirecrawl();
    const backend = await firecrawlBrowsers({ ...base, fetch: fake.fetch }).create(spec, { signal: signal() });
    await backend.release({ signal: signal() });
    expect(fake.seen.at(-1)).toMatchObject({ method: 'DELETE', path: '/v2/interact/fc-session-1' });
    expect(await backend.release({ signal: signal() }).catch(caught => caught)).toMatchObject({ reason: 'gone' });
    const failing = fakeFirecrawl({ reply: seen => seen.method === 'DELETE' ? Response.json({}, { status: 500 }) : undefined });
    expect(await (await firecrawlBrowsers({ ...base, fetch: failing.fetch }).create(spec, { signal: signal() })).release({ signal: signal() }).catch(caught => caught)).toMatchObject({ reason: 'unavailable' });
  });
});
