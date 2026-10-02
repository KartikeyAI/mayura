import { describe, expect, it } from 'vitest';
import type { MayuraError } from 'mayura';
import { kernelBrowsers } from '../src/index.js';
import { fakeKernel } from './fake.js';

const base = { apiKey: 'sk_kernel_test_1' };
const spec = { lifetimeMs: 600_000, viewport: { width: 1_024, height: 700 }, labels: { run: 'r1' } };
const signal = () => AbortSignal.timeout(10_000);

describe('kernelBrowsers', () => {
  it('refuses configuration it cannot use', () => {
    expect(() => kernelBrowsers({ apiKey: '' })).toThrow(/apiKey/u);
    expect(() => kernelBrowsers({ ...base, liveView: true as never })).toThrow(/liveView/u);
    expect(() => kernelBrowsers({ ...base, region: 'mars' as never })).toThrow(/region/u);
    expect(() => kernelBrowsers({ ...base, standbyTimeoutSeconds: 5 })).toThrow(/standbyTimeoutSeconds/u);
    expect(() => kernelBrowsers({ ...base, standbyTimeoutSeconds: 300_000 })).toThrow(/standbyTimeoutSeconds/u);
    expect(() => kernelBrowsers({ ...base, maxLifetimeMs: 100 * 3_600_000 })).toThrow(/maxLifetimeMs/u);
    expect(() => kernelBrowsers({ ...base, stealth: 'yes' as never })).toThrow(/stealth/u);
    expect(() => kernelBrowsers({ ...base, baseUrl: 'http://api.example' })).toThrow(/baseUrl/u);
    expect(kernelBrowsers(base)).toMatchObject({ id: 'kernel', features: { liveView: true } });
  });

  it('creates a browser deleted soon after nothing is connected, with stealth and its captcha solver off, labels as tags', async () => {
    const fake = fakeKernel();
    const backend = await kernelBrowsers({ ...base, fetch: fake.fetch, region: 'eu-west' }).create(spec, { signal: signal() });
    const created = fake.seen[0]!;
    expect([created.method, created.path, created.headers.get('authorization')]).toEqual(['POST', '/browsers', 'Bearer sk_kernel_test_1']);
    expect(created.body).toEqual({ timeout_seconds: 60, headless: false, stealth: false, viewport: { width: 1_024, height: 700 }, region: 'eu-west', tags: { run: 'r1' } });
    expect(backend).toMatchObject({ id: 'kernel_1', cdp: { url: 'wss://proxy.kernel.example:8443/browser/cdp?jwt=secret-kernel_1' } });
    expect(new URL(backend.liveViewUrl!).searchParams.get('readOnly')).toBe('true');
  });

  it('runs headless without a live view, lets the live view be used when asked, and sends no tags without labels', async () => {
    const fake = fakeKernel();
    const none = await kernelBrowsers({ ...base, fetch: fake.fetch, liveView: false, standbyTimeoutSeconds: 600 }).create({ ...spec, labels: {} }, { signal: signal() });
    expect(fake.seen.at(-1)!.body).toEqual({ timeout_seconds: 600, headless: true, stealth: false, viewport: { width: 1_024, height: 700 } });
    expect(none.liveViewUrl).toBeUndefined();
    const used = await kernelBrowsers({ ...base, fetch: fake.fetch, liveView: 'interact' }).create(spec, { signal: signal() });
    expect(new URL(used.liveViewUrl!).searchParams.has('readOnly')).toBe(false);
  });

  it('refuses replies it cannot trust, and maps failures without what Kernel wrote', async () => {
    for (const reply of [{ session_id: 'x' }, { session_id: '../x', cdp_ws_url: 'wss://a/' }, { session_id: 'x', cdp_ws_url: 'ws://proxy.kernel.example/' }, { session_id: 'x', cdp_ws_url: 'https://a/' }]) {
      const fake = fakeKernel({ create: () => Response.json(reply) });
      expect(await kernelBrowsers({ ...base, fetch: fake.fetch }).create(spec, { signal: signal() }).catch(caught => caught), JSON.stringify(reply)).toMatchObject({ reason: 'invalid_response' });
    }
    for (const [status, reason] of [[401, 'authentication'], [402, 'quota'], [429, 'rate_limited'], [503, 'unavailable']] as const) {
      const fake = fakeKernel({ create: () => Response.json({ message: 'secret detail' }, { status }) });
      const caught = await kernelBrowsers({ ...base, fetch: fake.fetch }).create(spec, { signal: signal() }).then(() => undefined, (thrown: unknown) => thrown as MayuraError);
      expect(caught).toMatchObject({ reason }); expect(caught!.message).not.toContain('secret');
    }
  });

  it('deletes the browser on release; one deleted already is gone, other failures are reported', async () => {
    const fake = fakeKernel();
    const backend = await kernelBrowsers({ ...base, fetch: fake.fetch }).create(spec, { signal: signal() });
    await backend.release({ signal: signal() });
    expect(fake.seen.at(-1)).toMatchObject({ method: 'DELETE', path: '/browsers/kernel_1' });
    expect(fake.browsers.get('kernel_1')!.deleted).toBe(true);
    expect(await backend.release({ signal: signal() }).catch(caught => caught)).toMatchObject({ reason: 'gone' });
    const failing = fakeKernel({ remove: () => Response.json({ message: 'busy' }, { status: 500 }) });
    expect(await (await kernelBrowsers({ ...base, fetch: failing.fetch }).create(spec, { signal: signal() })).release({ signal: signal() }).catch(caught => caught)).toMatchObject({ reason: 'unavailable' });
  });
});
