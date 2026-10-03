import { describe, expect, it } from 'vitest';
import { testIssuer } from 'mayura/auth/testing';
import { neonAuthAuthenticator, neonAuthBanned, neonAuthSession } from '../src/index.js';

const authUrl = 'https://ep-cool-sun-123.neonauth.us-east-1.aws.neon.tech/neondb/auth';
const origin = 'https://ep-cool-sun-123.neonauth.us-east-1.aws.neon.tech';
const signal = new AbortController().signal;
const grant = { principalId: 'neon/u1', projectId: 'acme', agentIds: [], capabilities: ['runs:read' as const] };
const user = (extra: Record<string, unknown> = {}) => ({ sub: 'u1', id: 'u1', aud: origin, email: 'a@example.com', emailVerified: true, name: 'A', role: 'authenticated', banned: false, ...extra });
async function setup(extra: Partial<Parameters<typeof neonAuthAuthenticator>[0]> = {}) {
  const neon = await testIssuer({ issuer: origin, algorithm: 'EdDSA', jwksPath: '/neondb/auth/.well-known/jwks.json' });
  return { neon, authenticate: neonAuthAuthenticator({ authUrl, fetch: neon.fetch, identity: () => grant, ...extra }) };
}

describe('neonAuthAuthenticator', () => {
  it('refuses configuration it cannot check tokens against', () => {
    for (const bad of ['not a url', 'http://ep.neonauth.example/auth', 'https://ep.neonauth.example/auth?x=1', 'https://u:p@ep.neonauth.example/auth']) {
      expect(() => neonAuthAuthenticator({ authUrl: bad, identity: () => null }), bad).toThrow(/authUrl/u);
    }
    expect(() => neonAuthAuthenticator({ authUrl, identity: 'x' as never })).toThrow(/identity/u);
    expect(() => neonAuthAuthenticator({ identity: () => null } as never)).toThrow(/authUrl/u);
  });

  it('accepts EdDSA tokens issued for the auth URL\'s origin, with keys from under the auth URL', async () => {
    const { neon, authenticate } = await setup({ identity: session => session.emailVerified ? { ...grant, principalId: `neon/${session.userId}` } : null });
    expect(neon.jwksUrl).toBe(`${authUrl}/.well-known/jwks.json`);
    expect(await authenticate({ token: await neon.sign(user()), signal })).toMatchObject({ scope: { principalId: 'neon/u1' } });
    expect(await authenticate({ token: await neon.sign(user({ emailVerified: false })), signal })).toBeNull();
    const trailing = neonAuthAuthenticator({ authUrl: `${authUrl}/`, fetch: neon.fetch, identity: () => grant });
    expect(await trailing({ token: await neon.sign(user()), signal })).not.toBeNull();
  });

  it('refuses tokens for another audience or issuer, other keys, other algorithms, and banned users', async () => {
    const { neon, authenticate } = await setup();
    expect(await authenticate({ token: await neon.sign(user({ aud: 'https://elsewhere.example' })), signal })).toBeNull();
    expect(await authenticate({ token: await neon.sign(user({ iss: authUrl })), signal })).toBeNull();
    expect(await authenticate({ token: await neon.sign(user({ sub: undefined })), signal })).toBeNull();
    const other = await testIssuer({ issuer: origin, algorithm: 'EdDSA' });
    expect(await authenticate({ token: await other.sign(user()), signal })).toBeNull();
    const rsa = await testIssuer({ issuer: origin, algorithm: 'RS256', jwksPath: '/neondb/auth/.well-known/jwks.json' });
    expect(await neonAuthAuthenticator({ authUrl, fetch: rsa.fetch, identity: () => grant })({ token: await rsa.sign(user()), signal })).toBeNull();
    expect(await authenticate({ token: await neon.sign(user({ banned: true, banExpires: null })), signal })).toBeNull();
    expect(await authenticate({ token: await neon.sign(user({ banned: true, banExpires: new Date(Date.now() - 60_000).toISOString() })), signal })).not.toBeNull();
  });

  it('reads the user, and when a ban still holds', () => {
    expect(neonAuthSession({ iss: origin, exp: 1, sub: 'u1', email: 'a@example.com', emailVerified: true, name: 'A', role: 'admin' }))
      .toMatchObject({ userId: 'u1', email: 'a@example.com', emailVerified: true, name: 'A', role: 'admin' });
    expect(neonAuthSession({ iss: origin, exp: 1, sub: 'u1', emailVerified: 'yes', email: 7 })).toMatchObject({ emailVerified: false, email: null, name: null, role: null });
    expect(neonAuthSession({ iss: origin, exp: 1 })).toBeUndefined();
    const base = { iss: origin, exp: 1 };
    expect(neonAuthBanned({ ...base, banned: false, banExpires: null })).toBe(false);
    expect(neonAuthBanned({ ...base, banned: true })).toBe(true);
    expect(neonAuthBanned({ ...base, banned: true, banExpires: new Date(Date.now() + 60_000).toISOString() })).toBe(true);
    expect(neonAuthBanned({ ...base, banned: true, banExpires: new Date(Date.now() - 60_000).toISOString() })).toBe(false);
    expect(neonAuthBanned({ ...base, banned: true, banExpires: Math.floor(Date.now() / 1_000) + 60 })).toBe(true);
    expect(neonAuthBanned({ ...base, banned: true, banExpires: Date.now() - 60_000 })).toBe(false);
    expect(neonAuthBanned({ ...base, banned: true, banExpires: 'never' })).toBe(true);
    expect(neonAuthBanned({ ...base, banned: 'true' })).toBe(false);
  });
});
