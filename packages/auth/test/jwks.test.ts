import { afterEach, describe, expect, it, vi } from 'vitest';
import { jwtVerifier, remoteJwks } from '../src/index.js';
import { testIssuer } from '../src/testing.js';

afterEach(() => { vi.useRealTimers(); });
const verifierFor = (issuer: Awaited<ReturnType<typeof testIssuer>>, fetcher: typeof fetch, extra: Partial<Parameters<typeof remoteJwks>[0]> = {}) =>
  jwtVerifier({ issuer: issuer.issuer, audience: 'api', algorithms: [issuer.algorithm], keys: remoteJwks({ url: issuer.jwksUrl, fetch: fetcher, ...extra }) });
/** A fetch that answers as `respond` says, counting calls. */
function scripted(respond: (call: number) => Response | Promise<Response>) {
  let calls = 0;
  const fetcher = (async () => respond(++calls)) as typeof fetch;
  return { fetcher, get calls() { return calls; } };
}

describe('remoteJwks', () => {
  it('refuses URLs and limits it cannot keep to', () => {
    for (const url of ['nope', 'http://issuer.example/jwks', 'https://u:p@issuer.example/jwks', 'https://issuer.example/jwks#x', 'ftp://issuer.example/jwks']) {
      expect(() => remoteJwks({ url }), url).toThrow(/url/u);
    }
    expect(() => remoteJwks({ url: 'http://127.0.0.1:9/jwks' })).not.toThrow();
    for (const [name, value] of [['timeoutMs', 10], ['maxAgeMs', 10], ['minRefreshMs', 10], ['maxBytes', 10], ['maxKeys', 0]] as const) {
      expect(() => remoteJwks({ url: 'https://issuer.example/jwks', [name]: value }), name).toThrow(new RegExp(name, 'u'));
    }
    expect(() => remoteJwks({ url: 'https://issuer.example/jwks', fetch: 'x' as never })).toThrow(/fetch/u);
  });

  it('fetches the keys once and keeps them for their max-age, not refetching for each token', async () => {
    const issuer = await testIssuer();
    const verifier = verifierFor(issuer, issuer.fetch);
    for (let index = 0; index < 5; index++) expect(await verifier.verify(await issuer.sign({ aud: 'api' }))).toMatchObject({ ok: true });
    expect(issuer.fetch.requests).toBe(1);
  });

  it('shares one fetch among tokens checked at once', async () => {
    const issuer = await testIssuer();
    const verifier = verifierFor(issuer, issuer.fetch);
    const tokens = await Promise.all([1, 2, 3, 4].map(() => issuer.sign({ aud: 'api' })));
    expect((await Promise.all(tokens.map(token => verifier.verify(token)))).every(result => result.ok)).toBe(true);
    expect(issuer.fetch.requests).toBe(1);
  });

  it('finds a rotated key by refetching, but no more often than minRefreshMs for unknown key ids', async () => {
    const issuer = await testIssuer();
    const verifier = verifierFor(issuer, issuer.fetch, { minRefreshMs: 1_000 });
    expect(await verifier.verify(await issuer.sign({ aud: 'api' }))).toMatchObject({ ok: true });
    await new Promise(resolve => setTimeout(resolve, 1_100));
    await issuer.rotate();
    expect(await verifier.verify(await issuer.sign({ aud: 'api' }))).toMatchObject({ ok: true });
    expect(issuer.fetch.requests).toBe(2);
    for (let index = 0; index < 5; index++) expect(await verifier.verify(await issuer.sign({ aud: 'api' }, { header: { kid: `unknown-${index}` } }))).toEqual({ ok: false, reason: 'key' });
    expect(issuer.fetch.requests).toBe(2);
  });

  it('honours a shorter max-age, and caps a longer one at maxAgeMs', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const issuer = await testIssuer();
    const short = scripted(async () => Response.json(issuer.jwks, { headers: { 'cache-control': 'max-age=60' } }));
    const verifier = verifierFor(issuer, short.fetcher, { minRefreshMs: 1_000 });
    await verifier.verify(await issuer.sign({ aud: 'api' }));
    vi.setSystemTime(Date.now() + 61_000);
    await verifier.verify(await issuer.sign({ aud: 'api' }));
    expect(short.calls).toBe(2);
    const long = scripted(async () => Response.json(issuer.jwks, { headers: { 'cache-control': 'max-age=999999' } }));
    const capped = verifierFor(issuer, long.fetcher, { maxAgeMs: 120_000 });
    await capped.verify(await issuer.sign({ aud: 'api' }));
    vi.setSystemTime(Date.now() + 121_000);
    await capped.verify(await issuer.sign({ aud: 'api' }));
    expect(long.calls).toBe(2);
  });

  it('throws, never verifies, when the keys cannot be fetched and none are cached', async () => {
    const issuer = await testIssuer();
    const token = await issuer.sign({ aud: 'api' });
    for (const respond of [() => new Response('down', { status: 503 }), () => Response.json(issuer.jwks, { status: 500 }), () => new Response('not json'), () => Response.json({ nope: 1 }), () => { throw new TypeError('network'); }]) {
      await expect(verifierFor(issuer, scripted(respond).fetcher).verify(token)).rejects.toMatchObject({ code: 'TOOL_FAILED' });
    }
    await expect(verifierFor(issuer, scripted(() => Response.json({ keys: Array.from({ length: 3 }, () => issuer.jwks.keys[0]) })).fetcher, { maxKeys: 2 }).verify(token)).rejects.toMatchObject({ code: 'TOOL_FAILED' });
    const big = JSON.stringify({ keys: issuer.jwks.keys, pad: 'x'.repeat(5_000) });
    await expect(verifierFor(issuer, scripted(() => new Response(big)).fetcher, { maxBytes: 2_048 }).verify(token)).rejects.toMatchObject({ code: 'TOOL_FAILED' });
    // A declared length over the limit is refused without reading the body.
    let pulls = 0;
    const unread = () => new Response(new ReadableStream({ pull: controller => { pulls++; controller.enqueue(new TextEncoder().encode(big)); controller.close(); } }, { highWaterMark: 0 }), { headers: { 'content-length': String(big.length) } });
    await expect(verifierFor(issuer, scripted(unread).fetcher, { maxBytes: 2_048 }).verify(token)).rejects.toMatchObject({ code: 'TOOL_FAILED' });
    expect(pulls).toBe(0);
  });

  it('keeps using keys past their age while the JWKS is down, for one more maxAgeMs at most', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const issuer = await testIssuer();
    const flaky = scripted(call => call === 1 ? Response.json(issuer.jwks) : new Response('down', { status: 503 }));
    const verifier = verifierFor(issuer, flaky.fetcher, { maxAgeMs: 60_000, minRefreshMs: 1_000 });
    expect(await verifier.verify(await issuer.sign({ aud: 'api' }))).toMatchObject({ ok: true });
    vi.setSystemTime(Date.now() + 90_000);
    expect(await verifier.verify(await issuer.sign({ aud: 'api' }))).toMatchObject({ ok: true });
    vi.setSystemTime(Date.now() + 40_000);
    await expect(verifier.verify(await issuer.sign({ aud: 'api' }))).rejects.toMatchObject({ code: 'TOOL_FAILED' });
  });

  it('fetches nothing for HMAC tokens, which no JWKS can verify', async () => {
    const issuer = await testIssuer();
    const verifier = jwtVerifier({ issuer: issuer.issuer, audience: 'api', algorithms: ['ES256', 'HS256'], keys: remoteJwks({ url: issuer.jwksUrl, fetch: issuer.fetch }) });
    expect(await verifier.verify(await issuer.sign({ aud: 'api' }, { header: { alg: 'HS256' } }))).toEqual({ ok: false, reason: 'key' });
    expect(issuer.fetch.requests).toBe(0);
  });

  it('stops for a caller who cancels while stale keys are being refreshed, rather than going on with them', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const issuer = await testIssuer();
    let first = true;
    const slow = ((_input: RequestInfo | URL, init?: RequestInit) => {
      if (first) { first = false; return Promise.resolve(Response.json(issuer.jwks)); }
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError'))));
    }) as typeof fetch;
    const verifier = verifierFor(issuer, slow, { maxAgeMs: 60_000 });
    expect(await verifier.verify(await issuer.sign({ aud: 'api' }))).toMatchObject({ ok: true });
    vi.setSystemTime(Date.now() + 61_000);
    const controller = new AbortController();
    const waiting = verifier.verify(await issuer.sign({ aud: 'api' }), { signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('gives up on a JWKS that does not answer in time, and when the caller cancels', async () => {
    const issuer = await testIssuer();
    const token = await issuer.sign({ aud: 'api' });
    const hanging = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError'))))) as typeof fetch;
    const started = Date.now();
    await expect(verifierFor(issuer, hanging, { timeoutMs: 1_000 }).verify(token)).rejects.toMatchObject({ code: 'TOOL_FAILED' });
    expect(Date.now() - started).toBeLessThan(5_000);
    const controller = new AbortController();
    const waiting = verifierFor(issuer, hanging).verify(token, { signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('does not follow redirects, and asks for JSON', async () => {
    const issuer = await testIssuer();
    let seen: RequestInit | undefined;
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => { seen = init; return Response.json(issuer.jwks); }) as typeof fetch;
    await verifierFor(issuer, fetcher).verify(await issuer.sign({ aud: 'api' }));
    expect(seen).toMatchObject({ redirect: 'error', headers: { accept: 'application/json' } });
  });
});
