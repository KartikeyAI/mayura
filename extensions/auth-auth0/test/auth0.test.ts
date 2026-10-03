import { describe, expect, it } from 'vitest';
import { mapCapabilities, principalId } from 'mayura/auth';
import { testIssuer } from 'mayura/auth/testing';
import { auth0Authenticator, auth0Session } from '../src/index.js';

const issuer = 'https://acme.us.auth0.com/';
const audience = 'https://api.acme.com';
const signal = new AbortController().signal;
const grant = { principalId: 'auth0/x', projectId: 'acme', agentIds: [], capabilities: ['runs:read' as const] };
async function setup(extra: Partial<Parameters<typeof auth0Authenticator>[0]> = {}) {
  const tenant = await testIssuer({ issuer, algorithm: 'RS256' });
  return { tenant, authenticate: auth0Authenticator({ domain: 'acme.us.auth0.com', audience, fetch: tenant.fetch, identity: () => grant, ...extra }) };
}

describe('auth0Authenticator', () => {
  it('refuses configuration that would check tokens against nothing', () => {
    for (const domain of ['', 'localhost', 'https://', 'acme us.auth0.com', 7]) expect(() => auth0Authenticator({ domain: domain as never, audience, identity: () => null }), String(domain)).toThrow(/domain/u);
    for (const bad of ['', [], [''], 7]) expect(() => auth0Authenticator({ domain: 'acme.us.auth0.com', audience: bad as never, identity: () => null })).toThrow(/auth0Authenticator\(\): audience/u);
    expect(() => auth0Authenticator({ domain: 'acme.us.auth0.com', audience, identity: 'x' as never })).toThrow(/identity/u);
    expect(() => auth0Authenticator({ domain: 'acme.us.auth0.com', audience, identity: () => null, signingSecret: 7 as never })).toThrow(/signingSecret/u);
  });

  it('accepts tokens from the tenant for the API, with keys from its JWKS, whatever form the domain is given in', async () => {
    for (const domain of ['acme.us.auth0.com', 'https://acme.us.auth0.com', 'https://acme.us.auth0.com/']) {
      const { tenant, authenticate } = await setup({ domain, identity: session => ({ ...grant, principalId: principalId('auth0', session.subject) }) });
      expect(tenant.jwksUrl).toBe(`${issuer}.well-known/jwks.json`);
      const identity = await authenticate({ token: await tenant.sign({ sub: 'auth0|123', aud: [audience, `${issuer}userinfo`], azp: 'app1', scope: 'openid read:runs' }), signal });
      expect(identity!.scope.principalId).toMatch(/^auth0\/_[A-Za-z0-9_-]{43}$/u);
    }
  });

  it('refuses tokens for another API, from another tenant, or without the trailing slash Auth0 issues', async () => {
    const { tenant, authenticate } = await setup();
    expect(await authenticate({ token: await tenant.sign({ sub: 'auth0|1', aud: 'https://other-api.com' }), signal })).toBeNull();
    expect(await authenticate({ token: await tenant.sign({ sub: 'auth0|1', aud: audience, iss: 'https://acme.us.auth0.com' }), signal })).toBeNull();
    expect(await authenticate({ token: await tenant.sign({ sub: 'auth0|1', aud: audience, iss: 'https://evil.us.auth0.com/' }), signal })).toBeNull();
    const other = await testIssuer({ issuer, algorithm: 'RS256' });
    expect(await authenticate({ token: await other.sign({ sub: 'auth0|1', aud: audience }), signal })).toBeNull();
    expect(await authenticate({ token: await tenant.sign({ aud: audience }), signal })).toBeNull();
  });

  it('reads both token profiles: users and machines, scopes, permissions and organizations', async () => {
    const auth0Profile = auth0Session({ iss: issuer, exp: 1, sub: 'auth0|1', azp: 'app1', gty: 'password', scope: 'openid read:runs', permissions: ['read:runs', 7], org_id: 'org_1', org_name: 'acme' });
    expect(auth0Profile).toMatchObject({ subject: 'auth0|1', clientId: 'app1', machine: false, scopes: ['openid', 'read:runs'], permissions: ['read:runs'], orgId: 'org_1', orgName: 'acme' });
    const rfc9068 = auth0Session({ iss: issuer, exp: 1, sub: 'svc@clients', client_id: 'svc', jti: 'j1', scope: 'write:runs' });
    expect(rfc9068).toMatchObject({ subject: 'svc@clients', clientId: 'svc', machine: true, scopes: ['write:runs'], permissions: [], orgId: null, orgName: null });
    expect(auth0Session({ iss: issuer, exp: 1, sub: 'x', gty: 'client-credentials' })?.machine).toBe(true);
    expect(auth0Session({ iss: issuer, exp: 1, sub: 'x' })?.scopes).toEqual([]);
    expect(auth0Session({ iss: issuer, exp: 1, sub: 'x', scope: 'a  b' })?.scopes).toEqual(['a', 'b']);
    expect(auth0Session({ iss: issuer, exp: 1, sub: 'x', org_name: 'no-id' })?.orgName).toBeNull();
    expect(auth0Session({ iss: issuer, exp: 1 })).toBeUndefined();
    const { tenant, authenticate } = await setup({
      identity: session => session.orgId && !session.machine ? { principalId: principalId('auth0', session.subject), projectId: session.orgId, agentIds: ['support'],
        capabilities: mapCapabilities(session.permissions, { 'read:runs': ['runs:read'], 'write:runs': ['runs:submit'] }) } : null,
    });
    expect(await authenticate({ token: await tenant.sign({ sub: 'auth0|1', aud: audience, permissions: ['read:runs', 'delete:everything'], org_id: 'org_1' }), signal }))
      .toMatchObject({ scope: { projectId: 'org_1' }, capabilities: ['runs:read'] });
    expect(await authenticate({ token: await tenant.sign({ sub: 'auth0|1', aud: audience, permissions: ['read:runs'] }), signal })).toBeNull();
    expect(await authenticate({ token: await tenant.sign({ sub: 'svc@clients', aud: audience, gty: 'client-credentials', org_id: 'org_1' }, { header: { typ: 'at+jwt' } }), signal })).toBeNull();
  });

  it('verifies HS256 tokens only with the API\'s signing secret, and then nothing signed with the tenant\'s keys', async () => {
    const secret = 'an-api-signing-secret-of-32-bytes-or-more';
    const tenant = await testIssuer({ issuer, algorithm: 'RS256' });
    const authenticate = auth0Authenticator({ domain: 'acme.us.auth0.com', audience, signingSecret: secret, fetch: tenant.fetch, identity: () => grant });
    const body = (claims: object) => `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
    const sign = async (input: string, key: string) => Buffer.from(await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), new TextEncoder().encode(input))).toString('base64url');
    const input = body({ iss: issuer, aud: audience, sub: 'auth0|1', exp: Math.floor(Date.now() / 1_000) + 600 });
    expect(await authenticate({ token: `${input}.${await sign(input, secret)}`, signal })).not.toBeNull();
    expect(await authenticate({ token: `${input}.${await sign(input, `${secret}!`)}`, signal })).toBeNull();
    expect(await authenticate({ token: await tenant.sign({ sub: 'auth0|1', aud: audience }), signal })).toBeNull();
    // Without the secret, HS256 tokens are never accepted.
    const { authenticate: rsOnly } = await setup();
    expect(await rsOnly({ token: `${input}.${await sign(input, secret)}`, signal })).toBeNull();
    expect(tenant.fetch.requests).toBe(0);
  });
});
