import { afterEach, describe, expect, it, vi } from 'vitest';
import { testIssuer } from 'mayura/auth/testing';
import { facebookAuthenticator, facebookSignIn } from '../src/index.js';

const appId = '123456789012345';
const appSecret = 'abcdef0123456789abcdef0123456789';
const signal = new AbortController().signal;
const grant = { principalId: 'facebook/u1', projectId: 'acme', agentIds: [], capabilities: ['runs:read' as const] };
afterEach(() => { vi.useRealTimers(); });
const token = (suffix = 'A') => `EAAB${'x'.repeat(40)}${suffix}`;

/** Facebook's debug_token, answering per input token; records each request URL. */
function fakeGraph(answers: Record<string, unknown> = {}, status = 200) {
  const seen: URL[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input)); seen.push(url);
    if (url.pathname !== '/v26.0/debug_token') return new Response('{}', { status: 404 });
    if (url.searchParams.get('access_token') !== `${appId}|${appSecret}`) return Response.json({ error: { code: 190 } }, { status: 400 });
    const input_token = url.searchParams.get('input_token')!;
    const data = answers[input_token] ?? { app_id: appId, type: 'USER', is_valid: true, user_id: '10001', expires_at: Math.floor(Date.now() / 1_000) + 3_600, scopes: ['email', 'public_profile'] };
    return Response.json({ data }, { status });
  }) as typeof fetch;
  return { fetcher, seen };
}

describe('facebookAuthenticator: access tokens', () => {
  it('refuses configuration it cannot keep to', () => {
    const base = { appId, appSecret, identity: () => null };
    expect(() => facebookAuthenticator({ ...base, appId: 'abc' })).toThrow(/appId/u);
    expect(() => facebookAuthenticator({ ...base, appSecret: 'short' })).toThrow(/appSecret/u);
    expect(() => facebookAuthenticator({ ...base, identity: 'x' as never })).toThrow(/identity/u);
    expect(() => facebookAuthenticator({ ...base, requiredScopes: ['Email!'] })).toThrow(/requiredScopes/u);
    expect(() => facebookAuthenticator({ ...base, limitedLogin: 'yes' as never })).toThrow(/limitedLogin/u);
    for (const [name, value] of [['cacheTtlMs', 600_000], ['timeoutMs', 10], ['maxIdentityMs', 10]] as const) expect(() => facebookAuthenticator({ ...base, [name]: value }), name).toThrow(new RegExp(name, 'u'));
    expect(() => facebookAuthenticator({ ...base, graphVersion: '26' })).toThrow(/graphVersion/u);
  });

  it('asks Facebook about each token with the app token, and lets in a valid user token for this app', async () => {
    const { fetcher, seen } = fakeGraph();
    let session: unknown;
    const authenticate = facebookAuthenticator({ appId, appSecret, fetch: fetcher, requiredScopes: ['email'], identity: found => { session = found; return grant; } });
    const identity = await authenticate({ token: token(), signal });
    expect(identity).not.toBeNull();
    expect(session).toMatchObject({ kind: 'access_token', userId: '10001', scopes: ['email', 'public_profile'], email: null });
    expect(seen[0]!.searchParams.get('input_token')).toBe(token());
    await authenticate({ token: token(), signal });
    expect(seen).toHaveLength(2);
    expect(authenticate.accepts(token())).toBe(true);
    expect(authenticate.accepts('eyJhbGciOiJSUzI1NiJ9.e30.x')).toBe(false);
  });

  it('refuses tokens Facebook says are invalid, for another app, not a user\'s, expired, or missing a permission', async () => {
    const now = Math.floor(Date.now() / 1_000);
    const valid = { app_id: appId, type: 'USER', is_valid: true, user_id: '10001', expires_at: now + 3_600, scopes: ['email'] };
    const { fetcher } = fakeGraph({
      [token('B')]: { ...valid, is_valid: false }, [token('C')]: { ...valid, app_id: '999999999' }, [token('D')]: { ...valid, type: 'PAGE' },
      [token('E')]: { ...valid, expires_at: now - 10 }, [token('F')]: { ...valid, scopes: ['public_profile'] }, [token('G')]: { ...valid, user_id: '' },
      [token('H')]: { ...valid, expires_at: 0 }, [token('I')]: { ...valid, scopes: [7, 'public_profile'] }, [token('J')]: { ...valid, scopes: ['email', 7] },
    });
    const authenticate = facebookAuthenticator({ appId, appSecret, fetch: fetcher, requiredScopes: ['email'], identity: () => grant });
    for (const suffix of ['B', 'C', 'D', 'E', 'F', 'G', 'I']) expect(await authenticate({ token: token(suffix), signal }), suffix).toBeNull();
    let scopes: unknown;
    await facebookAuthenticator({ appId, appSecret, fetch: fetcher, requiredScopes: ['email'], identity: found => { scopes = found.scopes; return grant; } })({ token: token('J'), signal });
    expect(scopes).toEqual(['email']);
    // 0 is Facebook's "does not expire": the identity still ends after maxIdentityMs.
    const lasting = await authenticate({ token: token('H'), signal });
    expect(lasting!.expiresAtMs - Date.now()).toBeLessThanOrEqual(60_000);
    expect(await authenticate({ token: 'not-a-facebook-token', signal })).toBeNull();
  });

  it('keeps answers only when cacheTtlMs says so', async () => {
    const { fetcher, seen } = fakeGraph();
    const authenticate = facebookAuthenticator({ appId, appSecret, fetch: fetcher, cacheTtlMs: 60_000, identity: () => grant });
    vi.useFakeTimers({ toFake: ['Date'] });
    await authenticate({ token: token(), signal }); await authenticate({ token: token(), signal }); await authenticate({ token: token('Z'), signal });
    expect(seen).toHaveLength(2);
    vi.setSystemTime(Date.now() + 61_000);
    await authenticate({ token: token(), signal });
    expect(seen).toHaveLength(3);
  });

  it('answers that authentication is unavailable when Facebook cannot answer, never leaking the app secret', async () => {
    for (const fetcher of [fakeGraph({}, 500).fetcher, (async () => new Response('not json')) as unknown as typeof fetch, (async () => Response.json({ nope: 1 })) as unknown as typeof fetch,
      (async () => { throw new Error(`failed https://graph.facebook.com/?access_token=${appId}|${appSecret}`); }) as unknown as typeof fetch]) {
      const authenticate = facebookAuthenticator({ appId, appSecret, fetch: fetcher, identity: () => grant });
      const error = await authenticate({ token: token(), signal }).then(() => undefined, caught => caught as Error);
      expect(error).toMatchObject({ code: 'TOOL_FAILED' });
      expect(String(error?.message)).not.toContain(appSecret);
    }
    const controller = new AbortController();
    const hanging = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as typeof fetch;
    const waiting = facebookAuthenticator({ appId, appSecret, fetch: hanging, identity: () => grant })({ token: token(), signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'CANCELLED' });
    const started = Date.now();
    await expect(facebookAuthenticator({ appId, appSecret, fetch: hanging, timeoutMs: 1_000, identity: () => grant })({ token: token(), signal })).rejects.toMatchObject({ code: 'TOOL_FAILED' });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('facebookAuthenticator: Limited Login', () => {
  it('accepts Limited Login tokens for the app with Facebook\'s keys, only when enabled', async () => {
    const facebook = await testIssuer({ issuer: 'https://www.facebook.com', algorithm: 'RS256', jwksPath: '/.well-known/oauth/openid/jwks/' });
    const { fetcher: graph, seen } = fakeGraph();
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => String(input) === facebook.jwksUrl ? Response.json(facebook.jwks) : graph(input, init)) as typeof fetch;
    let session: unknown;
    const authenticate = facebookAuthenticator({ appId, appSecret, fetch: fetcher, limitedLogin: true, identity: found => { session = found; return grant; } });
    expect(await authenticate({ token: await facebook.sign({ sub: 'pairwise-1', aud: appId, email: 'a@example.com', name: 'A', nonce: 'n' }), signal })).not.toBeNull();
    expect(session).toMatchObject({ kind: 'limited_login', userId: 'pairwise-1', email: 'a@example.com', name: 'A' });
    await authenticate({ token: await facebook.sign({ sub: 'pairwise-2', aud: appId, email: 7, name: '' }), signal });
    expect(session).toMatchObject({ userId: 'pairwise-2', email: null, name: null });
    expect(await authenticate({ token: await facebook.sign({ sub: 'pairwise-1', aud: '999' }), signal })).toBeNull();
    expect(await authenticate({ token: await facebook.sign({ aud: appId }), signal })).toBeNull();
    expect(seen).toHaveLength(0);
    const off = facebookAuthenticator({ appId, appSecret, fetch: fetcher, identity: () => grant });
    expect(off.accepts(await facebook.sign({ sub: 'x', aud: appId }))).toBe(false);
    expect(await off({ token: await facebook.sign({ sub: 'x', aud: appId }), signal })).toBeNull();
  });
});

describe('facebookSignIn', () => {
  it('reads no more of the profile than signing in needs', () => {
    expect(facebookSignIn({ clientId: appId, clientSecret: 's' })).toEqual({ clientId: appId, clientSecret: 's', fields: ['id', 'name', 'email'] });
    expect(facebookSignIn({ clientId: appId, clientSecret: 's', picture: true, scopes: ['user_birthday'] })).toEqual({ clientId: appId, clientSecret: 's', fields: ['id', 'name', 'email', 'picture'], scope: ['user_birthday'] });
    expect(() => facebookSignIn({ clientId: 'x', clientSecret: 's' })).toThrow(/clientId/u);
    expect(() => facebookSignIn({ clientId: appId, clientSecret: '' })).toThrow(/clientSecret/u);
    expect(() => facebookSignIn({ clientId: appId, clientSecret: 's', picture: 1 as never })).toThrow(/picture/u);
    expect(() => facebookSignIn({ clientId: appId, clientSecret: 's', scopes: ['Bad Scope'] })).toThrow(/scopes/u);
  });
});
