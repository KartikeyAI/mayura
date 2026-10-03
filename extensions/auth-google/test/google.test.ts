import { describe, expect, it } from 'vitest';
import { testIssuer } from 'mayura/auth/testing';
import { googleAuthenticator, googleJwksUrl, googleSession, googleSignIn } from '../src/index.js';

const clientId = '1234567890-abc.apps.googleusercontent.com';
const signal = new AbortController().signal;
const grant = { principalId: 'google/u1', projectId: 'acme', agentIds: [], capabilities: ['runs:read' as const] };
const account = (extra: Record<string, unknown> = {}) => ({ sub: '1100000000001', aud: clientId, azp: clientId, email: 'ada@acme.com', email_verified: true, hd: 'acme.com', name: 'Ada', ...extra });
async function setup(extra: Partial<Parameters<typeof googleAuthenticator>[0]> = {}) {
  const google = await testIssuer({ issuer: 'https://accounts.google.com', algorithm: 'RS256' });
  const asked: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => { asked.push(String(input)); return String(input) === googleJwksUrl ? Response.json(google.jwks) : new Response('', { status: 404 }); }) as typeof fetch;
  return { google, asked, authenticate: googleAuthenticator({ clientIds: clientId, fetch: fetcher, identity: () => grant, ...extra }) };
}

describe('googleAuthenticator', () => {
  it('refuses configuration it cannot keep to', () => {
    for (const bad of ['', 'abc', 'x.apps.google.com', [], [7]]) expect(() => googleAuthenticator({ clientIds: bad as never, identity: () => null }), JSON.stringify(bad)).toThrow(/client IDs/u);
    expect(() => googleAuthenticator({ clientIds: clientId, identity: 'x' as never })).toThrow(/identity/u);
    for (const bad of ['', 'acme', 'acme .com', 7]) expect(() => googleAuthenticator({ clientIds: clientId, identity: () => null, hostedDomain: bad as never }), String(bad)).toThrow(/hostedDomain/u);
  });

  it('accepts an ID token for one of the client IDs, from either issuer spelling, with Google\'s keys', async () => {
    let seen: unknown;
    const { google, asked, authenticate } = await setup({ clientIds: ['other-1.apps.googleusercontent.com', clientId], identity: session => { seen = session; return grant; } });
    expect(await authenticate({ token: await google.sign(account()), signal })).not.toBeNull();
    expect(seen).toMatchObject({ userId: '1100000000001', email: 'ada@acme.com', emailVerified: true, hostedDomain: 'acme.com', name: 'Ada', authorizedParty: clientId });
    expect(asked).toEqual([googleJwksUrl]);
    const bare = await testIssuer({ issuer: 'accounts.google.com', algorithm: 'RS256' });
    const fetcher = (async () => Response.json(bare.jwks)) as unknown as typeof fetch;
    expect(await googleAuthenticator({ clientIds: clientId, fetch: fetcher, identity: () => grant })({ token: await bare.sign(account()), signal })).not.toBeNull();
  });

  it('refuses tokens for another client, from another issuer or key, or without an account id', async () => {
    const { google, authenticate } = await setup();
    expect(await authenticate({ token: await google.sign(account({ aud: 'someone-else.apps.googleusercontent.com' })), signal })).toBeNull();
    expect(await authenticate({ token: await google.sign(account({ iss: 'https://accounts.google.co' })), signal })).toBeNull();
    expect(await authenticate({ token: await google.sign(account({ sub: '' })), signal })).toBeNull();
    const other = await testIssuer({ issuer: 'https://accounts.google.com', algorithm: 'RS256' });
    expect(await authenticate({ token: await other.sign(account()), signal })).toBeNull();
  });

  it('keeps to a Workspace domain when asked, or any Workspace account with *', async () => {
    const { google, authenticate } = await setup({ hostedDomain: 'ACME.com' });
    expect(await authenticate({ token: await google.sign(account()), signal })).not.toBeNull();
    expect(await authenticate({ token: await google.sign(account({ hd: 'Acme.COM' })), signal })).not.toBeNull();
    expect(await authenticate({ token: await google.sign(account({ hd: 'evil.com' })), signal })).toBeNull();
    expect(await authenticate({ token: await google.sign(account({ hd: undefined })), signal })).toBeNull();
    const { google: second, authenticate: anyWorkspace } = await setup({ hostedDomain: '*' });
    expect(await anyWorkspace({ token: await second.sign(account({ hd: 'other.org' })), signal })).not.toBeNull();
    expect(await anyWorkspace({ token: await second.sign(account({ hd: undefined, email: 'ada@gmail.com' })), signal })).toBeNull();
    const { google: third, authenticate: consumers } = await setup();
    expect(await consumers({ token: await third.sign(account({ hd: undefined, email: 'ada@gmail.com' })), signal })).not.toBeNull();
  });

  it('reads sessions defensively', () => {
    expect(googleSession({ iss: 'https://accounts.google.com', exp: 1, sub: 'u', email_verified: 'true', email: 7, hd: '' }))
      .toMatchObject({ emailVerified: false, email: null, hostedDomain: null, name: null, picture: null, authorizedParty: null });
    expect(googleSession({ iss: 'https://accounts.google.com', exp: 1 })).toBeUndefined();
  });
});

describe('googleSignIn', () => {
  it('asks Google for no more than signing in needs', () => {
    expect(googleSignIn({ clientId, clientSecret: 's' })).toEqual({ clientId, clientSecret: 's', accessType: 'online', includeGrantedScopes: false });
    expect(googleSignIn({ clientId: [clientId, 'two.apps.googleusercontent.com'], clientSecret: 's', hostedDomain: 'Acme.com', offline: true, scopes: ['https://www.googleapis.com/auth/calendar.readonly'] }))
      .toEqual({ clientId: [clientId, 'two.apps.googleusercontent.com'], clientSecret: 's', accessType: 'offline', includeGrantedScopes: false, hd: 'acme.com', scope: ['https://www.googleapis.com/auth/calendar.readonly'] });
    expect(() => googleSignIn({ clientId: 'nope', clientSecret: 's' })).toThrow(/client IDs/u);
    expect(() => googleSignIn({ clientId, clientSecret: '' })).toThrow(/clientSecret/u);
    expect(() => googleSignIn({ clientId, clientSecret: 's', hostedDomain: 'x' })).toThrow(/hostedDomain/u);
    expect(() => googleSignIn({ clientId, clientSecret: 's', offline: 'yes' as never })).toThrow(/offline/u);
    expect(() => googleSignIn({ clientId, clientSecret: 's', scopes: ['a b'] })).toThrow(/scopes/u);
    expect(() => googleSignIn(undefined as never)).toThrow(/client IDs/u);
  });
});
