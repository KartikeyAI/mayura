import { describe, expect, it } from 'vitest';
import { testIssuer } from 'mayura/auth/testing';
import { firebaseAuthenticator, firebaseJwksUrl, firebaseSession } from '../src/index.js';

const projectId = 'acme-app-1234';
const issuer = `https://securetoken.google.com/${projectId}`;
const signal = new AbortController().signal;
const grant = { principalId: 'firebase/u1', projectId: 'acme', agentIds: [], capabilities: ['runs:read' as const] };
const user = (extra: Record<string, unknown> = {}) => ({ sub: 'u1', user_id: 'u1', aud: projectId, auth_time: Math.floor(Date.now() / 1_000) - 60, email: 'a@example.com', email_verified: true,
  firebase: { identities: { email: ['a@example.com'] }, sign_in_provider: 'password' }, ...extra });
async function setup(extra: Partial<Parameters<typeof firebaseAuthenticator>[0]> = {}) {
  const google = await testIssuer({ issuer, algorithm: 'RS256' });
  const asked: string[] = [];
  // Google serves Firebase's keys on its own host; the test issuer's keys stand in for them there.
  const fetcher = (async (input: RequestInfo | URL) => { asked.push(String(input)); return String(input) === firebaseJwksUrl ? Response.json(google.jwks) : new Response('not found', { status: 404 }); }) as typeof fetch;
  return { google, asked, authenticate: firebaseAuthenticator({ projectId, fetch: fetcher, identity: () => grant, ...extra }) };
}

describe('firebaseAuthenticator', () => {
  it('refuses configuration it cannot keep to', () => {
    for (const bad of ['', 'Acme', 'a', 'acme_app', 'acme-app-'] ) expect(() => firebaseAuthenticator({ projectId: bad, identity: () => null }), bad).toThrow(/projectId/u);
    expect(() => firebaseAuthenticator({ projectId, identity: 'x' as never })).toThrow(/identity/u);
    expect(() => firebaseAuthenticator({ projectId, identity: () => null, tenants: [] })).toThrow(/tenants/u);
    expect(() => firebaseAuthenticator({ projectId, identity: () => null, tenants: [''] })).toThrow(/tenants/u);
    expect(() => firebaseAuthenticator({ projectId, identity: () => null, allowAnonymous: 'yes' as never })).toThrow(/allowAnonymous/u);
  });

  it('accepts an ID token for the project, with Google\'s keys for Firebase, and reads the user', async () => {
    let seen: unknown;
    const { google, asked, authenticate } = await setup({ identity: session => { seen = session; return session.emailVerified ? grant : null; } });
    expect(await authenticate({ token: await google.sign(user({ name: 'A', phone_number: '+15550100', admin: true })), signal })).not.toBeNull();
    expect(asked).toEqual([firebaseJwksUrl]);
    expect(seen).toMatchObject({ userId: 'u1', email: 'a@example.com', emailVerified: true, phoneNumber: '+15550100', name: 'A', signInProvider: 'password', tenant: null, claims: { admin: true } });
    expect(await authenticate({ token: await google.sign(user({ email_verified: false })), signal })).toBeNull();
  });

  it('refuses tokens for another project, from another issuer or key, not yet signed in, or anonymous', async () => {
    const { google, authenticate } = await setup();
    expect(await authenticate({ token: await google.sign(user({ aud: 'other-project' })), signal })).toBeNull();
    expect(await authenticate({ token: await google.sign(user({ iss: 'https://securetoken.google.com/other-project' })), signal })).toBeNull();
    expect(await authenticate({ token: await google.sign(user({ auth_time: Math.floor(Date.now() / 1_000) + 600 })), signal })).toBeNull();
    expect(await authenticate({ token: await google.sign(user({ auth_time: undefined })), signal })).toBeNull();
    expect(await authenticate({ token: await google.sign(user({ sub: '' })), signal })).toBeNull();
    expect(await authenticate({ token: await google.sign(user({ firebase: { sign_in_provider: 'anonymous' } })), signal })).toBeNull();
    const other = await testIssuer({ issuer, algorithm: 'RS256' });
    expect(await authenticate({ token: await other.sign(user()), signal })).toBeNull();
    const { google: second, authenticate: open } = await setup({ allowAnonymous: true });
    expect(await open({ token: await second.sign(user({ firebase: { sign_in_provider: 'anonymous' } })), signal })).not.toBeNull();
  });

  it('keeps tenants apart: a tenant\'s users only where their tenant is listed, and then only tenants', async () => {
    const { google, authenticate } = await setup();
    expect(await authenticate({ token: await google.sign(user({ firebase: { sign_in_provider: 'password', tenant: 'tenant-a' } })), signal })).toBeNull();
    const { google: second, authenticate: tenanted } = await setup({ tenants: ['tenant-a'] });
    expect(await tenanted({ token: await second.sign(user({ firebase: { sign_in_provider: 'password', tenant: 'tenant-a' } })), signal })).not.toBeNull();
    expect(await tenanted({ token: await second.sign(user({ firebase: { sign_in_provider: 'password', tenant: 'tenant-b' } })), signal })).toBeNull();
    expect(await tenanted({ token: await second.sign(user()), signal })).toBeNull();
  });

  it('reads sessions defensively', () => {
    expect(firebaseSession({ iss: issuer, exp: 1, sub: 'u1', auth_time: 5, email_verified: 'true', email: 7, firebase: 'x' }))
      .toMatchObject({ emailVerified: false, email: null, signInProvider: null, tenant: null, authTimeMs: 5_000 });
    expect(firebaseSession({ iss: issuer, exp: 1, sub: 'u'.repeat(129), auth_time: 5 })).toBeUndefined();
    expect(firebaseSession({ iss: issuer, exp: 1, sub: 'u1', auth_time: '5' })).toBeUndefined();
  });
});
