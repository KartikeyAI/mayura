import { describe, expect, it } from 'vitest';
import { mapCapabilities } from 'mayura/auth';
import { keyAuthenticator } from 'mayura/keys';
import { unkeyVerifier, type UnkeyKey } from '../src/index.js';

const rootKey = 'unkey_root_0123456789abcdef';
const key = 'sk_3ZbXq9wYk2LmNpQrStUv';
const grant = { principalId: 'unkey/x', projectId: 'acme', agentIds: ['support'], capabilities: ['runs:read' as const] };
const valid = (extra: Record<string, unknown> = {}) => ({ valid: true, code: 'VALID', keyId: 'key_1', keyspaceId: 'ks_api1', name: 'ci', enabled: true, meta: { plan: 'pro' }, permissions: ['agents.use'], roles: ['user'], identity: { id: 'id_1', externalId: 'org_42', meta: { tier: 'gold' } }, credits: 99, expires: 4_102_444_800_000, ...extra });

/** A fake Unkey answering `keys.verifyKey` with `data`, recording each request. */
function unkey(answer: (body: Record<string, unknown>) => Response | Promise<Response>) {
  const requests: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    requests.push({ url: String(input), init, body });
    return answer(body);
  }) as typeof fetch;
  return { requests, fetcher };
}
const answering = (data: Record<string, unknown>) => unkey(() => Response.json({ meta: { requestId: 'req_1' }, data }));
const base = (fetcher: typeof fetch, extra: Partial<Parameters<typeof unkeyVerifier>[0]> = {}) => unkeyVerifier({ rootKey, prefix: 'sk', keyspaces: ['ks_api1'], fetch: fetcher, identity: () => grant, ...extra });

describe('unkeyVerifier', () => {
  it('refuses configuration that would send keys anywhere, or accept any keyspace\'s keys', () => {
    const ok = { rootKey, prefix: 'sk', keyspaces: ['ks_api1'], identity: () => null };
    expect(() => unkeyVerifier({ ...ok, identity: 'x' as never })).toThrow(/identity/u);
    for (const bad of ['', 'short', 'has space in it 0123', 7]) expect(() => unkeyVerifier({ ...ok, rootKey: bad as never })).toThrow(/rootKey/u);
    for (const bad of ['', '_sk', 'sk-live', 'a'.repeat(17), 7]) expect(() => unkeyVerifier({ ...ok, prefix: bad as never }), String(bad)).toThrow(/prefix/u);
    for (const bad of [[], ['api1'], ['ks_'], ['ks_a', 'ks_b', 'ks_c', 'ks_d', 'ks_e', 'ks_f'], 'ks_api1']) expect(() => unkeyVerifier({ ...ok, keyspaces: bad as never }), JSON.stringify(bad)).toThrow(/keyspaces/u);
    for (const bad of ['', 'x'.repeat(1_001), 7]) expect(() => unkeyVerifier({ ...ok, permissions: bad as never })).toThrow(/permissions/u);
    for (const bad of [999, 30_001, 1.5]) expect(() => unkeyVerifier({ ...ok, timeoutMs: bad })).toThrow(/timeoutMs/u);
    for (const bad of ['http://api.unkey.com', 'ftp://x', 'https://', 'https://x/path']) expect(() => unkeyVerifier({ ...ok, baseUrl: bad }), bad).toThrow(/baseUrl/u);
  });

  it('verifies a key with Unkey, spending its cost in your keyspaces, and grants what identity says', async () => {
    const { requests, fetcher } = answering(valid());
    let seen: UnkeyKey | undefined;
    const verifier = base(fetcher, { permissions: 'agents.use', identity: found => { seen = found; return { ...grant, principalId: `unkey/${found.identity!.externalId}`, capabilities: mapCapabilities(found.permissions, { 'agents.use': ['runs:submit'] }) }; } });
    expect(await verifier.verify(key, { cost: 3 })).toEqual({ ok: true, principalId: 'unkey/org_42', projectId: 'acme', agentIds: ['support'], capabilities: ['runs:submit'], expiresAtMs: 4_102_444_800_000, remaining: 99 });
    expect(seen).toEqual({ keyId: 'key_1', keyspaceId: 'ks_api1', name: 'ci', meta: { plan: 'pro' }, permissions: ['agents.use'], roles: ['user'], identity: { id: 'id_1', externalId: 'org_42', meta: { tier: 'gold' } }, expiresAtMs: 4_102_444_800_000, remaining: 99 });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://api.unkey.com/v2/keys.verifyKey');
    expect(requests[0]!.body).toEqual({ key, keyspaces: ['ks_api1'], credits: { cost: 3 }, permissions: 'agents.use' });
    expect(requests[0]!.init).toMatchObject({ method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${rootKey}` } });
    await verifier.verify(key);
    expect(requests[1]!.body['credits']).toEqual({ cost: 1 });
    await expect(verifier.verify(key, { cost: -1 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('sends nothing but keys with your prefix to Unkey', async () => {
    const { requests, fetcher } = answering(valid());
    const verifier = base(fetcher);
    for (const token of ['eyJhbGciOiJSUzI1NiJ9.e30.sig', 'pk_3ZbXq9wYk2LmNpQrStUv', 'sk_short', 'sk_3ZbXq9wY k2Lm', 'sk3ZbXq9wYk2LmNpQrStUv', 7]) {
      expect(verifier.accepts(token as never), String(token)).toBe(false);
      expect(await verifier.verify(token as never)).toEqual({ ok: false, reason: 'malformed' });
    }
    expect(requests).toEqual([]);
    expect(verifier.accepts(key)).toBe(true);
  });

  it('refuses keys Unkey refuses, with Mayura\'s reasons', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ valid: false, code: 'NOT_FOUND' }, 'not_found'], [{ valid: false, code: 'DISABLED', keyId: 'key_1' }, 'disabled'], [{ valid: false, code: 'EXPIRED' }, 'expired'],
      [{ valid: false, code: 'FORBIDDEN' }, 'forbidden'], [{ valid: false, code: 'INSUFFICIENT_PERMISSIONS' }, 'forbidden'], [{ valid: false, code: 'USAGE_EXCEEDED' }, 'exhausted'],
      [{ valid: false, code: 'SOMETHING_NEW' }, 'forbidden'], [{ ...valid(), valid: false }, 'forbidden'], [{ ...valid(), code: 'EXPIRED' }, 'expired'], [{ ...valid(), code: 'SOMETHING_NEW' }, 'forbidden'],
    ];
    for (const [data, reason] of cases) expect(await base(answering(data).fetcher).verify(key), JSON.stringify(data)).toEqual({ ok: false, reason });
    const now = Date.now();
    const limited = await base(answering({ valid: false, code: 'RATE_LIMITED', ratelimits: [{ name: 'a', exceeded: false, reset: now + 1_000 }, { name: 'b', exceeded: true, reset: now + 30_000 }, { name: 'c', exceeded: true, reset: now + 60_000 }, 7] }).fetcher).verify(key);
    expect(limited).toMatchObject({ ok: false, reason: 'rate_limited' });
    expect((limited as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(25_000);
    expect((limited as { retryAfterMs: number }).retryAfterMs).toBeLessThanOrEqual(30_000);
    expect(await base(answering({ valid: false, code: 'RATE_LIMITED', ratelimits: [{ exceeded: true, reset: now - 5_000 }] }).fetcher).verify(key)).toEqual({ ok: false, reason: 'rate_limited', retryAfterMs: 0 });
    expect(await base(answering({ valid: false, code: 'RATE_LIMITED' }).fetcher).verify(key)).toEqual({ ok: false, reason: 'rate_limited' });
  });

  it('refuses a valid key from another keyspace, without an id, or that identity refuses', async () => {
    expect(await base(answering(valid({ keyspaceId: 'ks_admin' })).fetcher).verify(key)).toEqual({ ok: false, reason: 'forbidden' });
    expect(await base(answering(valid({ keyspaceId: undefined })).fetcher).verify(key)).toEqual({ ok: false, reason: 'forbidden' });
    expect(await base(answering(valid({ keyId: '' })).fetcher).verify(key)).toEqual({ ok: false, reason: 'forbidden' });
    expect(await base(answering(valid()).fetcher, { identity: async () => null }).verify(key)).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('reads Unkey\'s answer defensively, and keeps the sooner of the key\'s and the grant\'s expiry', async () => {
    let seen: UnkeyKey | undefined;
    const capture = (data: Record<string, unknown>, expiresAtMs?: number) => base(answering(data).fetcher, { identity: found => { seen = found; return expiresAtMs === undefined ? grant : { ...grant, expiresAtMs }; } }).verify(key);
    expect(await capture(valid({ name: '', meta: ['x'], permissions: ['a', 7], roles: 'r', identity: { id: 'id_1' }, credits: -1, expires: 1.5 }))).toMatchObject({ ok: true, expiresAtMs: null, remaining: null });
    expect(seen).toMatchObject({ name: null, meta: null, permissions: ['a'], roles: [], identity: null, expiresAtMs: null, remaining: null });
    await capture(valid({ identity: { id: 'id_1', externalId: 'org_1', meta: 'm' }, credits: 1.5, expires: '2100-01-01' }));
    expect(seen).toMatchObject({ identity: { id: 'id_1', externalId: 'org_1', meta: null }, remaining: null, expiresAtMs: null });
    await capture(valid({ identity: { externalId: 'org_1' }, credits: undefined }));
    expect(seen).toMatchObject({ identity: null, remaining: null });
    expect(await capture(valid(), 2_000_000_000_000)).toMatchObject({ expiresAtMs: 2_000_000_000_000 });
    expect(await capture(valid({ expires: 1_900_000_000_000 }), 2_000_000_000_000)).toMatchObject({ expiresAtMs: 1_900_000_000_000 });
    expect(await capture(valid({ expires: undefined }), 2_000_000_000_000)).toMatchObject({ expiresAtMs: 2_000_000_000_000 });
  });

  it('throws when Unkey cannot answer, never with the root key or the key in the error, and stops when cancelled', async () => {
    const failing = [
      unkey(() => new Response('{"error":{}}', { status: 401 })), unkey(() => new Response('', { status: 503 })),
      unkey(() => { throw new TypeError(`fetch failed for ${rootKey}`); }), unkey(() => new Response('not json')),
      unkey(() => Response.json({ data: { valid: 'yes', code: 'VALID' } })), unkey(() => Response.json({ data: { valid: true } })), unkey(() => Response.json({ data: [] })),
    ];
    for (const { fetcher } of failing) {
      const error = await base(fetcher).verify(key).catch((caught: unknown) => caught as Error);
      expect(error).toMatchObject({ code: 'TOOL_FAILED' });
      expect(String((error as Error).message)).not.toContain(rootKey);
      expect(String((error as Error).message)).not.toContain(key);
    }
    expect(String((await base(failing[0]!.fetcher).verify(key).catch((caught: unknown) => caught as Error) as Error).message)).toMatch(/HTTP 401/u);
    const waiting = () => (async (_input: RequestInfo | URL, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch;
    const controller = new AbortController();
    const pending = base(waiting()).verify(key, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    const started = Date.now();
    await expect(base(waiting(), { timeoutMs: 1_000 }).verify(key)).rejects.toMatchObject({ code: 'TOOL_FAILED' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('uses a self-hosted Unkey, and serves keyAuthenticator', async () => {
    const { requests, fetcher } = answering(valid());
    const verifier = base(fetcher, { baseUrl: 'http://localhost:7070/' });
    const authenticate = keyAuthenticator(verifier, { cost: 0 });
    expect(await authenticate({ token: key, signal: new AbortController().signal })).toMatchObject({ scope: { principalId: 'unkey/x', projectId: 'acme' }, capabilities: ['runs:read'] });
    expect(requests[0]!.url).toBe('http://localhost:7070/v2/keys.verifyKey');
    expect(requests[0]!.body['credits']).toEqual({ cost: 0 });
    expect(await authenticate({ token: 'eyJ.e30.sig', signal: new AbortController().signal })).toBeNull();
    expect(requests).toHaveLength(1);
  });
});
