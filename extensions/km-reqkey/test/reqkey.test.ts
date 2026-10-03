import { describe, expect, it } from 'vitest';
import { keyAuthenticator } from 'mayura/keys';
import { reqkeyVerifier, type ReqkeyKey } from '../src/index.js';

const rootKey = 'rk_root_0123456789abcdef';
const key = 'prod_A1B2C3D4E5F6G7H8I9J0K1L2';
const grant = { principalId: 'reqkey/x', projectId: 'acme', agentIds: ['support'], capabilities: ['runs:read' as const] };
const validated = (extra: Record<string, unknown> = {}) => ({ valid: true, requestId: 'r1', apiId: 'api_agents', apiName: 'Agents', createdAt: '2026-01-30T12:34:56Z', expiresAt: '2100-01-01T00:00:00Z', creditsRemaining: 9995, creditsLimit: 10000, allowedApis: ['api_agents', 'api_analytics'], ...extra });
const described = (extra: Record<string, unknown> = {}) => ({ keyId: 'key_X1', key, consumerId: 'consumer_A1', allowedApis: ['api_agents'], status: 'active', tag: 'production', metadata: { org: 'acme' }, ...extra });

/** A fake ReqKey: `validate` and `details` answer each path, and every request is recorded. */
function reqkey(validate: () => Response | Promise<Response>, details: () => Response | Promise<Response> = () => Response.json(described())) {
  const requests: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input); requests.push({ url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return url.endsWith('/key/validate') ? validate() : details();
  }) as typeof fetch;
  return { requests, fetcher };
}
const base = (fetcher: typeof fetch, extra: Partial<Parameters<typeof reqkeyVerifier>[0]> = {}) => reqkeyVerifier({ rootKey, prefix: 'prod_', apiId: 'api_agents', fetch: fetcher, identity: () => grant, ...extra });

describe('reqkeyVerifier', () => {
  it('refuses configuration that would send keys anywhere, or validate them for no API', () => {
    const ok = { rootKey, prefix: 'prod_', apiId: 'api_agents', identity: () => null };
    expect(() => reqkeyVerifier({ ...ok, identity: 'x' as never })).toThrow(/identity/u);
    for (const bad of ['', 'short', 'has space in it 0123', 7]) expect(() => reqkeyVerifier({ ...ok, rootKey: bad as never })).toThrow(/rootKey/u);
    for (const bad of ['', '_prod', 'pr.od', 'a'.repeat(33), 7]) expect(() => reqkeyVerifier({ ...ok, prefix: bad as never }), String(bad)).toThrow(/prefix/u);
    for (const bad of ['', 'api agents', '-api', 7]) expect(() => reqkeyVerifier({ ...ok, apiId: bad as never }), String(bad)).toThrow(/apiId/u);
    for (const bad of [999, 30_001, 1.5]) expect(() => reqkeyVerifier({ ...ok, timeoutMs: bad })).toThrow(/timeoutMs/u);
    for (const bad of ['http://api.reqkey.com', 'https://', 'https://x/path']) expect(() => reqkeyVerifier({ ...ok, baseUrl: bad }), bad).toThrow(/baseUrl/u);
  });

  it('validates a key for your API, spending its cost, reads its details, and grants what identity says', async () => {
    const { requests, fetcher } = reqkey(() => Response.json(validated()));
    let seen: ReqkeyKey | undefined;
    const verifier = base(fetcher, { identity: found => { seen = found; return { ...grant, principalId: `reqkey/${found.consumerId}` }; } });
    expect(await verifier.verify(key, { cost: 5 })).toEqual({ ok: true, principalId: 'reqkey/consumer_A1', projectId: 'acme', agentIds: ['support'], capabilities: ['runs:read'], expiresAtMs: Date.parse('2100-01-01T00:00:00Z'), remaining: 9995 });
    expect(seen).toEqual({ keyId: 'key_X1', consumerId: 'consumer_A1', apiId: 'api_agents', allowedApis: ['api_agents', 'api_analytics'], tag: 'production', metadata: { org: 'acme' }, expiresAtMs: Date.parse('2100-01-01T00:00:00Z'), remaining: 9995, limit: 10000 });
    const validate = requests.find(request => request.url === 'https://api.reqkey.com/key/validate')!;
    expect(validate.body).toEqual({ key, apiId: 'api_agents', credits: 5 });
    expect(validate.init).toMatchObject({ method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${rootKey}` } });
    expect(requests.find(request => request.url === 'https://api.reqkey.com/key/details')!.body).toEqual({ key });
    await verifier.verify(key);
    expect(requests.filter(request => request.url.endsWith('/key/validate'))[1]!.body['credits']).toBe(1);
    await expect(verifier.verify(key, { cost: -1 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('sends nothing but keys with your prefix to ReqKey', async () => {
    const { requests, fetcher } = reqkey(() => Response.json(validated()));
    const verifier = base(fetcher);
    for (const token of ['eyJhbGciOiJSUzI1NiJ9.e30.sig', 'dev_A1B2C3D4E5F6G7H8I9J0K1L2', 'prod_short', 'prod_A1B2C3D4 E5F6G7H8I9', 'prodA1B2C3D4E5F6G7H8I9J0K1L2', 7]) {
      expect(verifier.accepts(token as never), String(token)).toBe(false);
      expect(await verifier.verify(token as never)).toEqual({ ok: false, reason: 'malformed' });
    }
    expect(requests).toEqual([]);
    expect(verifier.accepts(key)).toBe(true);
  });

  it('refuses keys ReqKey refuses, with Mayura\'s reasons, and lets go of the unread details', async () => {
    const cases: [() => Response, Record<string, unknown>][] = [
      [() => Response.json({ valid: false }), { ok: false, reason: 'not_found' }],
      [() => Response.json({ error: 'Consumer credit limit exceeded' }, { status: 402 }), { ok: false, reason: 'exhausted' }],
      [() => Response.json({ error: 'Key disabled' }, { status: 403 }), { ok: false, reason: 'forbidden' }],
      [() => Response.json({ error: 'Rate limited' }, { status: 429, headers: { 'retry-after': '12' } }), { ok: false, reason: 'rate_limited', retryAfterMs: 12_000 }],
      [() => Response.json({ error: 'Rate limited' }, { status: 429, headers: { 'retry-after': '0.25' } }), { ok: false, reason: 'rate_limited', retryAfterMs: 250 }],
      [() => Response.json({ error: 'Rate limited' }, { status: 429, headers: { 'retry-after': 'soon' } }), { ok: false, reason: 'rate_limited' }],
      [() => Response.json({ error: 'Rate limited' }, { status: 429, headers: { 'retry-after': 'Infinity' } }), { ok: false, reason: 'rate_limited' }],
      [() => Response.json({ error: 'Rate limited' }, { status: 429 }), { ok: false, reason: 'rate_limited' }],
      [() => Response.json(validated({ apiId: 'api_admin' })), { ok: false, reason: 'forbidden' }],
      [() => Response.json(validated({ apiId: undefined })), { ok: false, reason: 'forbidden' }],
    ];
    // A body that says whether it was let go of unread.
    const tracked = (json: unknown, init: ResponseInit = {}) => {
      const state = { released: false };
      const response = new Response(new ReadableStream({ start: controller => controller.enqueue(new TextEncoder().encode(JSON.stringify(json))), cancel: () => { state.released = true; } }), init);
      return { response, state };
    };
    for (const [answer, expected] of cases) {
      const details = tracked(described());
      const original = answer();
      const validation = original.status === 200 ? { response: original, state: { released: true } } : tracked({ error: 'blocked' }, { status: original.status, headers: original.headers });
      expect(await base(reqkey(() => validation.response, () => details.response).fetcher).verify(key), JSON.stringify(expected)).toEqual(expected);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(details.state.released, `details ${JSON.stringify(expected)}`).toBe(true);
      expect(validation.state.released, `validation ${JSON.stringify(expected)}`).toBe(true);
    }
    expect(await base(reqkey(() => Response.json(validated())).fetcher, { identity: async () => null }).verify(key)).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('reads ReqKey\'s answers defensively, and keeps the sooner of the key\'s and the grant\'s expiry', async () => {
    let seen: ReqkeyKey | undefined;
    const capture = (validation: Record<string, unknown>, details: Record<string, unknown> = described(), expiresAtMs?: number) =>
      base(reqkey(() => Response.json(validation), () => Response.json(details)).fetcher, { identity: found => { seen = found; return expiresAtMs === undefined ? grant : { ...grant, expiresAtMs }; } }).verify(key);
    expect(await capture(validated({ expiresAt: null, creditsRemaining: null, creditsLimit: -1, allowedApis: undefined }), described({ allowedApis: ['api_agents', 7], tag: '', metadata: ['x'] }))).toMatchObject({ ok: true, expiresAtMs: null, remaining: null });
    expect(seen).toMatchObject({ allowedApis: ['api_agents'], tag: null, metadata: null, expiresAtMs: null, remaining: null, limit: null });
    await capture(validated({ expiresAt: 'not a date', creditsRemaining: 1.5, allowedApis: 'api_agents' }), described({ allowedApis: undefined }));
    expect(seen).toMatchObject({ expiresAtMs: null, remaining: null, allowedApis: [] });
    await capture(validated({ expiresAt: 4_102_444_800_000 }));
    expect(seen?.expiresAtMs).toBeNull();
    // A number is not ReqKey's form: 2030 is never taken for the year.
    await capture(validated({ expiresAt: 2030 }));
    expect(seen?.expiresAtMs).toBeNull();
    await capture(validated({ allowedApis: undefined }), described({ allowedApis: 'api_agents' }));
    expect(seen?.allowedApis).toEqual([]);
    expect(await capture(validated({ expiresAt: null }), described(), 2_000_000_000_000)).toMatchObject({ expiresAtMs: 2_000_000_000_000 });
    expect(await capture(validated({ expiresAt: '2030-01-01T00:00:00Z' }), described(), 2_000_000_000_000)).toMatchObject({ expiresAtMs: Date.parse('2030-01-01T00:00:00Z') });
    expect(await capture(validated(), described(), 2_000_000_000_000)).toMatchObject({ expiresAtMs: 2_000_000_000_000 });
  });

  it('throws when ReqKey cannot answer, never with the root key or the key in the error, and stops when cancelled', async () => {
    const failing = [
      reqkey(() => Response.json({ error: 'Missing or invalid rootKey' }, { status: 401 })), reqkey(() => new Response('', { status: 500 })),
      reqkey(() => Response.json({ error: 'Not found' }, { status: 404 })), reqkey(() => Response.json({ error: 'Bad' }, { status: 400 })),
      reqkey(() => { throw new TypeError(`fetch failed for ${rootKey} ${key}`); }), reqkey(() => new Response('not json')), reqkey(() => Response.json({ valid: 'yes' })), reqkey(() => Response.json([true])),
      reqkey(() => Response.json(validated()), () => Response.json({ error: 'Not found' }, { status: 404 })),
      reqkey(() => Response.json(validated()), () => { throw new TypeError(`down ${rootKey}`); }),
      reqkey(() => Response.json(validated()), () => new Response('not json')),
      reqkey(() => Response.json(validated()), () => Response.json(described({ keyId: '' }))),
      reqkey(() => Response.json(validated()), () => Response.json(described({ consumerId: 7 }))),
    ];
    for (const { fetcher } of failing) {
      const error = await base(fetcher).verify(key).catch((caught: unknown) => caught as Error);
      expect(error).toMatchObject({ code: 'TOOL_FAILED' });
      expect(String((error as Error).message)).not.toContain(rootKey);
      expect(String((error as Error).message)).not.toContain(key);
    }
    expect(String((await base(failing[0]!.fetcher).verify(key).catch((caught: unknown) => caught as Error) as Error).message)).toMatch(/HTTP 401/u);
    expect(String((await base(failing[8]!.fetcher).verify(key).catch((caught: unknown) => caught as Error) as Error).message)).toMatch(/HTTP 404/u);
    const waiting = (async (_input: RequestInfo | URL, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch;
    const controller = new AbortController();
    const pending = base(waiting).verify(key, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    const started = Date.now();
    await expect(base(waiting, { timeoutMs: 1_000 }).verify(key)).rejects.toMatchObject({ code: 'TOOL_FAILED' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('uses another ReqKey address, and serves keyAuthenticator', async () => {
    const { requests, fetcher } = reqkey(() => Response.json(validated()));
    const authenticate = keyAuthenticator(base(fetcher, { baseUrl: 'http://127.0.0.1:8787/' }), { cost: 0 });
    expect(await authenticate({ token: key, signal: new AbortController().signal })).toMatchObject({ scope: { principalId: 'reqkey/x', projectId: 'acme' }, capabilities: ['runs:read'] });
    expect(requests.map(request => request.url).sort()).toEqual(['http://127.0.0.1:8787/key/details', 'http://127.0.0.1:8787/key/validate']);
    expect(requests.find(request => request.url.endsWith('/key/validate'))!.body['credits']).toBe(0);
    expect(await authenticate({ token: 'eyJ.e30.sig', signal: new AbortController().signal })).toBeNull();
    expect(requests).toHaveLength(2);
  });
});
