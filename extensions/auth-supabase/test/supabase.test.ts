import { describe, expect, it } from 'vitest';
import { testIssuer } from 'mayura/auth/testing';
import { supabaseAuthenticator, supabaseSession } from '../src/index.js';

const projectUrl = 'https://abcdefghijklmnopqrst.supabase.co';
const issuer = `${projectUrl}/auth/v1`;
const signal = new AbortController().signal;
const grant = { principalId: 'supabase/u1', projectId: 'acme', agentIds: [], capabilities: ['runs:read' as const] };
const user = (extra: Record<string, unknown> = {}) => ({ sub: 'u1', aud: 'authenticated', role: 'authenticated', aal: 'aal1', session_id: 's1', email: 'a@example.com', is_anonymous: false, app_metadata: { provider: 'email', plan: 'pro' }, user_metadata: { name: 'A' }, ...extra });
async function setup(extra: Partial<Parameters<typeof supabaseAuthenticator>[0]> = {}) {
  const project = await testIssuer({ issuer, algorithm: 'ES256', jwksPath: '/auth/v1/.well-known/jwks.json' });
  return { project, authenticate: supabaseAuthenticator({ projectUrl, fetch: project.fetch, identity: () => grant, ...extra }) };
}
const hs256 = async (claims: object, secret: string) => {
  const input = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  const mac = await crypto.subtle.sign('HMAC', await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), new TextEncoder().encode(input));
  return `${input}.${Buffer.from(mac).toString('base64url')}`;
};

describe('supabaseAuthenticator', () => {
  it('refuses configuration it cannot keep to', () => {
    for (const bad of ['nope', 'http://x.supabase.co', 'https://x.supabase.co/auth/v1', 'https://x.supabase.co?y=1']) expect(() => supabaseAuthenticator({ projectUrl: bad, identity: () => null }), bad).toThrow(/projectUrl/u);
    expect(() => supabaseAuthenticator({ projectUrl, identity: 'x' as never })).toThrow(/identity/u);
    expect(() => supabaseAuthenticator({ identity: () => null } as never)).toThrow(/projectUrl/u);
    expect(() => supabaseAuthenticator({ projectUrl, identity: () => null, roles: [] })).toThrow(/roles/u);
    expect(() => supabaseAuthenticator({ projectUrl, identity: () => null, allowAnonymous: 'yes' as never })).toThrow(/allowAnonymous/u);
    expect(() => supabaseAuthenticator({ projectUrl, identity: () => null, requireAal2: 1 as never })).toThrow(/requireAal2/u);
    expect(() => supabaseAuthenticator({ projectUrl, identity: () => null, jwtSecret: 7 as never })).toThrow(/jwtSecret/u);
  });

  it('accepts a signed-in user\'s token with the project\'s keys, and reads the user', async () => {
    let seen: unknown;
    const { project, authenticate } = await setup({ identity: session => { seen = session; return session.appMetadata['plan'] === 'pro' ? grant : null; } });
    expect(project.jwksUrl).toBe(`${issuer}/.well-known/jwks.json`);
    expect(await authenticate({ token: await project.sign(user()), signal })).not.toBeNull();
    expect(seen).toMatchObject({ userId: 'u1', email: 'a@example.com', role: 'authenticated', aal: 'aal1', sessionId: 's1', anonymous: false, appMetadata: { plan: 'pro' }, userMetadata: { name: 'A' } });
    expect(await authenticate({ token: await project.sign(user({ app_metadata: { plan: 'free' } })), signal })).toBeNull();
    const rsa = await testIssuer({ issuer, algorithm: 'RS256', jwksPath: '/auth/v1/.well-known/jwks.json' });
    expect(await supabaseAuthenticator({ projectUrl, fetch: rsa.fetch, identity: () => grant })({ token: await rsa.sign(user()), signal })).not.toBeNull();
  });

  it('never lets the anon key, a service role, an anonymous user or another audience in by default', async () => {
    const { project, authenticate } = await setup();
    expect(await authenticate({ token: await project.sign(user({ role: 'anon', aud: 'authenticated' })), signal })).toBeNull();
    expect(await authenticate({ token: await project.sign(user({ role: 'service_role' })), signal })).toBeNull();
    expect(await authenticate({ token: await project.sign(user({ is_anonymous: true })), signal })).toBeNull();
    expect(await authenticate({ token: await project.sign(user({ aud: 'anon' })), signal })).toBeNull();
    expect(await authenticate({ token: await project.sign(user({ role: undefined })), signal })).toBeNull();
    expect(await authenticate({ token: await project.sign(user({ iss: 'https://other.supabase.co/auth/v1' })), signal })).toBeNull();
    const { project: second, authenticate: open } = await setup({ allowAnonymous: true, roles: ['authenticated', 'anon'] });
    expect(await open({ token: await second.sign(user({ is_anonymous: true })), signal })).not.toBeNull();
    expect(await open({ token: await second.sign(user({ role: 'anon' })), signal })).not.toBeNull();
  });

  it('requires a second factor when asked', async () => {
    const { project, authenticate } = await setup({ requireAal2: true });
    expect(await authenticate({ token: await project.sign(user()), signal })).toBeNull();
    expect(await authenticate({ token: await project.sign(user({ aal: 'aal2' })), signal })).not.toBeNull();
  });

  it('takes legacy HS256 tokens only with the project\'s secret, while its asymmetric keys keep working', async () => {
    const secret = 'super-secret-jwt-token-with-at-least-32-characters-long';
    const exp = Math.floor(Date.now() / 1_000) + 600;
    const { project, authenticate } = await setup({ jwtSecret: secret });
    expect(await authenticate({ token: await hs256({ ...user(), iss: issuer, exp }, secret), signal })).not.toBeNull();
    expect(await authenticate({ token: await hs256({ ...user(), iss: issuer, exp }, `${secret}x`), signal })).toBeNull();
    expect(await authenticate({ token: await project.sign(user()), signal })).not.toBeNull();
    // The legacy anon key, signed with the secret, is still not a user.
    expect(await authenticate({ token: await hs256({ iss: issuer, ref: 'abcdefghijklmnopqrst', role: 'anon', aud: 'authenticated', sub: 'anon', exp }, secret), signal })).toBeNull();
    const { authenticate: asymmetricOnly } = await setup();
    expect(await asymmetricOnly({ token: await hs256({ ...user(), iss: issuer, exp }, secret), signal })).toBeNull();
  });

  it('reads sessions defensively', () => {
    const odd = supabaseSession({ iss: issuer, exp: 1, sub: 'u1', role: 'authenticated', app_metadata: [1], user_metadata: 'x', is_anonymous: 'true', email: 7, phone: '', aal: {} })!;
    expect(odd.appMetadata).toEqual({}); expect(odd.userMetadata).toEqual({});
    expect(odd).toMatchObject({ anonymous: false, email: null, phone: null, aal: null, sessionId: null });
    expect(supabaseSession({ iss: issuer, exp: 1, sub: 'u1' })).toBeUndefined();
    expect(supabaseSession({ iss: issuer, exp: 1, role: 'authenticated' })).toBeUndefined();
  });
});
