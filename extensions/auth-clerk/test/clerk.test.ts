import { describe, expect, it } from 'vitest';
import { mapCapabilities, principalId } from 'mayura/auth';
import { testIssuer } from 'mayura/auth/testing';
import { clerkAuthenticator, clerkFrontendApi, clerkPermissions, clerkSession } from '../src/index.js';

const frontendApi = 'https://clerk.example.com';
const publishableKey = `pk_test_${btoa('clerk.example.com$')}`;
const signal = new AbortController().signal;
const grant = { principalId: 'clerk/user_1', projectId: 'acme', agentIds: ['support'], capabilities: ['runs:read' as const] };
const v2 = (extra: Record<string, unknown> = {}) => ({ sub: 'user_1', sid: 'sess_1', azp: 'https://app.example.com', v: 2, sts: 'active', ...extra });
async function setup(extra: Partial<Parameters<typeof clerkAuthenticator>[0]> = {}) {
  const clerk = await testIssuer({ issuer: frontendApi, algorithm: 'RS256' });
  const authenticate = clerkAuthenticator({ publishableKey, authorizedParties: ['https://app.example.com'], fetch: clerk.fetch, identity: () => grant, ...extra });
  return { clerk, authenticate };
}

describe('clerkAuthenticator', () => {
  it('reads the Frontend API from a publishable key', () => {
    expect(clerkFrontendApi(publishableKey)).toBe(frontendApi);
    expect(clerkFrontendApi(`pk_live_${btoa('clerk.acme.dev$')}`)).toBe('https://clerk.acme.dev');
    for (const bad of ['sk_test_abc', `pk_prod_${btoa('clerk.example.com$')}`, `pk_test_${btoa('no-dollar.example.com')}`, 'pk_test_!!', `pk_test_${btoa('bad host$')}`]) expect(() => clerkFrontendApi(bad), bad).toThrow(/publishableKey/u);
  });

  it('refuses configuration that would check tokens against nothing', () => {
    expect(() => clerkAuthenticator({ authorizedParties: false, identity: () => null })).toThrow(/publishableKey/u);
    expect(() => clerkAuthenticator({ publishableKey, authorizedParties: [], identity: () => null })).toThrow(/authorizedParties/u);
    expect(() => clerkAuthenticator({ publishableKey, authorizedParties: ['app.example.com'], identity: () => null })).toThrow(/authorizedParties/u);
    expect(() => clerkAuthenticator({ publishableKey, authorizedParties: false, identity: 'x' as never })).toThrow(/identity/u);
    expect(() => clerkAuthenticator({ frontendApi: 'http://clerk.example.com', authorizedParties: false, identity: () => null })).toThrow(/frontendApi/u);
    expect(() => clerkAuthenticator({ frontendApi: 'https://clerk.example.com/path', authorizedParties: false, identity: () => null })).toThrow(/frontendApi/u);
    expect(() => clerkAuthenticator({ frontendApi: 'https://other.example.com', publishableKey, authorizedParties: false, identity: () => null })).toThrow(/different instances/u);
    expect(() => clerkAuthenticator({ publishableKey, authorizedParties: false, identity: () => null, allowPending: 'yes' as never })).toThrow(/allowPending/u);
    expect(() => clerkAuthenticator({ publishableKey, authorizedParties: false, identity: () => null, jwtKey: 'not a pem' })).toThrow(/jwtKey/u);
  });

  it('lets a Clerk session in, with its keys fetched from the Frontend API, and decides with the mapping', async () => {
    const { clerk, authenticate } = await setup({ identity: session => session.userId === 'user_1' ? { ...grant, principalId: principalId('clerk', session.userId) } : null });
    expect(clerk.jwksUrl).toBe(`${frontendApi}/.well-known/jwks.json`);
    const identity = await authenticate({ token: await clerk.sign(v2(), { expiresInMs: 60_000 }), signal });
    expect(identity).toMatchObject({ scope: { principalId: 'clerk/user_1', projectId: 'acme' } });
    expect(identity!.expiresAtMs - Date.now()).toBeLessThanOrEqual(60_000);
    expect(await authenticate({ token: await clerk.sign(v2({ sub: 'user_2' })), signal })).toBeNull();
    expect(clerk.fetch.requests).toBe(1);
  });

  it('refuses tokens for another origin, without one, from another instance, pending, or not Clerk-shaped', async () => {
    const { clerk, authenticate } = await setup();
    expect(await authenticate({ token: await clerk.sign(v2({ azp: 'https://evil.example.com' })), signal })).toBeNull();
    expect(await authenticate({ token: await clerk.sign(v2({ azp: undefined })), signal })).toBeNull();
    expect(await authenticate({ token: await clerk.sign(v2({ sts: 'pending' })), signal })).toBeNull();
    expect(await authenticate({ token: await clerk.sign(v2({ sid: undefined })), signal })).toBeNull();
    expect(await authenticate({ token: await clerk.sign(v2({ iss: 'https://clerk.other.com' })), signal })).toBeNull();
    const other = await testIssuer({ issuer: frontendApi, algorithm: 'RS256' });
    expect(await authenticate({ token: await other.sign(v2()), signal })).toBeNull();
    const es = await testIssuer({ issuer: frontendApi, algorithm: 'ES256' });
    expect(await authenticate({ token: await es.sign(v2()), signal })).toBeNull();
    // Pending sessions only when allowed; azp only checked when there are origins to check.
    const { clerk: second, authenticate: lenient } = await setup({ allowPending: true, authorizedParties: false });
    expect(await lenient({ token: await second.sign(v2({ sts: 'pending', azp: undefined })), signal })).not.toBeNull();
  });

  it('accepts RS256 alone, even from a key set that lists other kinds of key', async () => {
    const clerk = await testIssuer({ issuer: frontendApi, algorithm: 'RS256' });
    const ec = await testIssuer({ issuer: frontendApi, algorithm: 'ES256' });
    await ec.rotate();
    const both = (async () => Response.json({ keys: [...clerk.jwks.keys, ...ec.jwks.keys.slice(1)] })) as unknown as typeof fetch;
    const authenticate = clerkAuthenticator({ publishableKey, authorizedParties: ['https://app.example.com'], fetch: both, identity: () => grant });
    expect(await authenticate({ token: await clerk.sign(v2()), signal })).not.toBeNull();
    expect(await authenticate({ token: await ec.sign(v2()), signal })).toBeNull();
  });

  it('verifies with the PEM key and no network at all', async () => {
    const clerk = await testIssuer({ issuer: frontendApi, algorithm: 'RS256' });
    const key = await crypto.subtle.importKey('jwk', { ...clerk.jwks.keys[0], key_ops: ['verify'] } as JsonWebKey, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, true, ['verify']);
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', key));
    const pem = `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...spki)).replace(/(.{64})/gu, '$1\n')}\n-----END PUBLIC KEY-----\n`;
    const offline = (async () => { throw new Error('no network'); }) as unknown as typeof fetch;
    const authenticate = clerkAuthenticator({ publishableKey, jwtKey: pem, authorizedParties: ['https://app.example.com'], fetch: offline, identity: () => grant });
    expect(await authenticate({ token: await clerk.sign(v2()), signal })).not.toBeNull();
    const other = await testIssuer({ issuer: frontendApi, algorithm: 'RS256' });
    expect(await authenticate({ token: await other.sign(v2()), signal })).toBeNull();
    const ecKey = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])).publicKey;
    const ecPem = `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('spki', ecKey))))}\n-----END PUBLIC KEY-----`;
    const wrongKind = clerkAuthenticator({ publishableKey, jwtKey: ecPem, authorizedParties: false, identity: () => grant });
    await expect(wrongKind({ token: await clerk.sign(v2()), signal })).rejects.toThrow(/RSA public key/u);
  });
});

describe('Clerk organizations', () => {
  it('decodes version 2 permissions as Clerk documents them: bit 0 is the first permission, only organization features', () => {
    expect(clerkPermissions({ fea: 'o:dashboard,o:teams', o: { per: 'manage,read', fpm: '3,2' } })).toEqual(['org:dashboard:manage', 'org:dashboard:read', 'org:teams:read']);
    expect(clerkPermissions({ fea: 'u:profile,o:invoices,ou:reports', o: { per: 'read,write', fpm: '1,3' } })).toEqual(['org:invoices:read', 'org:reports:read', 'org:reports:write']);
    // Masks wider than 53 bits are read exactly.
    const names = Array.from({ length: 60 }, (_, index) => `p${index}`).join(',');
    expect(clerkPermissions({ fea: 'o:big', o: { per: names, fpm: (2n ** 59n).toString() } })).toEqual(['org:big:p59']);
    for (const odd of [{ fea: 'o:a', o: { per: 'read', fpm: 'x' } }, { fea: 'broken', o: { per: 'read', fpm: '1' } }, { fea: 'o:a', o: { per: 'read' } }, { fea: 7, o: {} }, {}]) {
      expect(clerkPermissions(odd as never), JSON.stringify(odd)).toEqual([]);
    }
    expect(clerkPermissions({ fea: 'o:a,o:b', o: { per: 'read', fpm: '1' } })).toEqual(['org:a:read']);
    // A claim of the wrong type, or a feature list with a malformed element, grants nothing at all (Clerk's SDK refuses it).
    expect(clerkPermissions({ fea: 7, o: { per: 'read', fpm: '1' } } as never)).toEqual([]);
    expect(clerkPermissions({ fea: 'broken,o:a', o: { per: 'read', fpm: '1,1' } })).toEqual([]);
  });

  it('reads the active organization from either token version, and grants through a permission table', async () => {
    const claims = { iss: frontendApi, exp: 1, sub: 'user_1', sid: 'sess_1', v: 2, fea: 'o:invoices', o: { id: 'org_1', slg: 'acme', rol: 'admin', per: 'read,create', fpm: '3' } };
    expect(clerkSession(claims)).toMatchObject({ userId: 'user_1', sessionId: 'sess_1', orgId: 'org_1', orgSlug: 'acme', orgRole: 'org:admin', orgPermissions: ['org:invoices:read', 'org:invoices:create'] });
    expect(clerkSession({ ...claims, o: undefined })).toMatchObject({ orgId: null, orgRole: null, orgPermissions: [] });
    expect(clerkSession({ ...claims, o: { per: 'read', fpm: '1' } })).toMatchObject({ orgId: null, orgPermissions: [] });
    expect(clerkSession({ iss: frontendApi, exp: 1, sub: 'user_1', sid: 's', org_id: 'org_9', org_role: 'org:member', org_slug: 'nine', org_permissions: ['org:invoices:read', 7] }))
      .toMatchObject({ orgId: 'org_9', orgRole: 'org:member', orgSlug: 'nine', orgPermissions: ['org:invoices:read'] });
    expect(clerkSession({ iss: frontendApi, exp: 1, sub: 'user_1', sid: 's', act: { sub: 'user_admin' } })?.actor).toEqual({ sub: 'user_admin' });
    expect(clerkSession({ iss: frontendApi, exp: 1, sid: 's' })).toBeUndefined();
    const { clerk, authenticate } = await setup({
      identity: session => session.orgId ? { principalId: principalId('clerk', session.userId), projectId: session.orgId, agentIds: ['support'],
        capabilities: mapCapabilities(session.orgPermissions, { 'org:invoices:read': ['runs:read'], 'org:invoices:create': ['runs:submit'] }) } : null,
    });
    expect(await authenticate({ token: await clerk.sign(v2({ fea: 'o:invoices', o: { id: 'org_1', rol: 'member', per: 'read,create', fpm: '1' } })), signal }))
      .toMatchObject({ scope: { projectId: 'org_1' }, capabilities: ['runs:read'] });
    expect(await authenticate({ token: await clerk.sign(v2()), signal })).toBeNull();
  });
});
