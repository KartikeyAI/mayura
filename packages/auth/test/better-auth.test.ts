import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { Schema } from '@mayura/core';
import { defineAgent } from '@mayura/runtime';
import { createAgentServer, type AgentServer } from '@mayura/server';
import { jwtAuthenticator, mapCapabilities } from '../src/index.js';
import { betterAuthApiKeyAuthenticator, betterAuthAuthenticator, betterAuthJwtVerifier, betterAuthPermissions, withBetterAuth, type BetterAuthInstance } from '../src/better-auth.js';
import { realBetterAuth } from './better-auth-fixture.js';

const signal = new AbortController().signal;
const servers: AgentServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });
const grant = (userId: string) => ({ principalId: `user/${userId}`, projectId: 'acme', agentIds: ['echo'], capabilities: ['runs:read' as const] });
function mayuraServer(authenticate: Parameters<typeof createAgentServer>[0]['authenticate']) {
  const schema: Schema<unknown> = { '~standard': { version: 1, vendor: 'test', validate: value => ({ value }) } };
  const agent = defineAgent({ id: 'echo', version: '1', instructions: 'Fixture.', tools: [], input: schema, output: schema,
    model: { id: 'fixture', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0, generate: async () => ({ type: 'final' as const, output: 1, usage: { costMicros: 0 } }) } });
  const server = createAgentServer({ publicOrigin: 'http://localhost:3000', agents: [{ agent, permissions: { allow: ['model:fixture'] } }], authenticate });
  servers.push(server);
  return server;
}

describe('better-auth sessions', () => {
  it('lets a signed-in user in with what the mapping grants, and stops them the moment they sign out', async () => {
    const { auth, signUp } = await realBetterAuth(new DatabaseSync(':memory:'));
    const { token, userId } = await signUp('ada@example.com');
    const authenticate = betterAuthAuthenticator(auth, { identity: session => grant(session.user.id), maxIdentityMs: 30_000 });
    const identity = await authenticate({ token, signal });
    expect(identity).toMatchObject({ scope: { principalId: `user/${userId}`, projectId: 'acme' }, capabilities: ['runs:read'] });
    expect(identity!.expiresAtMs - Date.now()).toBeLessThanOrEqual(30_000);
    const server = mayuraServer(authenticate);
    const call = () => server.fetch(new Request('http://localhost:3000/v1/agents', { headers: { authorization: `Bearer ${token}` } }));
    expect((await call()).status).toBe(200);
    await auth.api.signOut({ headers: new Headers({ authorization: `Bearer ${token}` }) });
    expect((await call()).status).toBe(401);
    expect(await authenticate({ token, signal })).toBeNull();
  });

  it('grants from the user\'s role in their active organization, and nothing to a user the mapping refuses', async () => {
    const { auth, signUp } = await realBetterAuth(new DatabaseSync(':memory:'));
    const owner = await signUp('owner@example.com');
    const outsider = await signUp('outsider@example.com');
    const headers = new Headers({ authorization: `Bearer ${owner.token}` });
    const org = await auth.api.createOrganization({ body: { name: 'Acme', slug: 'acme' }, headers });
    await auth.api.setActiveOrganization({ body: { organizationId: org!.id }, headers });
    const authenticate = betterAuthAuthenticator(auth, {
      identity: async session => {
        const organizationId = session.session.activeOrganizationId;
        if (!organizationId) return null;
        const member = await auth.api.getActiveMember({ headers: new Headers({ authorization: `Bearer ${owner.token}` }) });
        return member?.userId === session.user.id && member.role === 'owner'
          ? { principalId: `user/${session.user.id}`, projectId: organizationId, agentIds: ['echo'], capabilities: ['runs:read', 'runs:submit'] } : null;
      },
    });
    expect(await authenticate({ token: owner.token, signal })).toMatchObject({ scope: { projectId: org!.id }, capabilities: ['runs:read', 'runs:submit'] });
    expect(await authenticate({ token: outsider.token, signal })).toBeNull();
  });

  it('checks only better-auth tokens, refuses made-up ones, and refuses bad options', async () => {
    const { auth, signUp } = await realBetterAuth(new DatabaseSync(':memory:'));
    const { token } = await signUp('b@example.com');
    let asked = 0;
    const counting: BetterAuthInstance = { handler: auth.handler, api: { getSession: async input => { asked++; return auth.api.getSession(input); } } };
    const authenticate = betterAuthAuthenticator(counting, { identity: session => grant(session.user.id) });
    expect(authenticate.accepts(token)).toBe(true);
    for (const other of ['eyJhbGciOiJFZERTQSJ9.e30.sig', 'acme_123', 'short', '']) {
      expect(authenticate.accepts(other), other).toBe(false);
      expect(await authenticate({ token: other, signal })).toBeNull();
    }
    expect(asked).toBe(0);
    expect(await authenticate({ token: `${'A'.repeat(32)}.${'B'.repeat(44)}`, signal })).toBeNull();
    expect(asked).toBe(1);
    const custom = betterAuthAuthenticator(counting, { identity: session => grant(session.user.id), accepts: value => value.startsWith('ba.') });
    expect(custom.accepts(token)).toBe(false);
    expect(() => betterAuthAuthenticator({} as never, { identity: () => null })).toThrow(/auth/u);
    expect(() => betterAuthAuthenticator(auth, { identity: 'x' as never })).toThrow(/identity/u);
    expect(() => betterAuthAuthenticator(auth, { identity: () => null, accepts: 'x' as never })).toThrow(/accepts/u);
    expect(() => betterAuthAuthenticator(auth, { identity: () => null, maxIdentityMs: 1 })).toThrow(/maxIdentityMs/u);
  });

  it('refuses a session better-auth reports as expired, and lets better-auth\'s failures through as unavailable', async () => {
    const expired: BetterAuthInstance = { handler: async () => new Response(null), api: { getSession: async () => ({ user: { id: 'u1' }, session: { id: 's1', userId: 'u1', expiresAt: new Date(Date.now() - 1_000) } }) } };
    expect(await betterAuthAuthenticator(expired, { identity: () => grant('u1') })({ token: 'A'.repeat(32), signal })).toBeNull();
    // A session in a shape Mayura does not know, or with no expiry it can read, is refused rather than trusted.
    for (const odd of [{ user: { id: 'u1' } }, { session: { id: 's1', userId: 'u1', expiresAt: new Date(Date.now() + 60_000) } }, 'yes',
      { user: { id: 'u1' }, session: { id: 's1', userId: 'u1', expiresAt: 'whenever' } }, { user: { id: 'u1' }, session: { id: 's1', userId: 'u1' } }]) {
      const strange: BetterAuthInstance = { handler: async () => new Response(null), api: { getSession: async () => odd } };
      expect(await betterAuthAuthenticator(strange, { identity: () => grant('u1') })({ token: 'A'.repeat(32), signal }), JSON.stringify(odd)).toBeNull();
    }
    const broken: BetterAuthInstance = { handler: async () => new Response(null), api: { getSession: async () => { throw new Error('database down'); } } };
    await expect(betterAuthAuthenticator(broken, { identity: () => grant('u1') })({ token: 'A'.repeat(32), signal })).rejects.toThrow(/database down/u);
  });
});

describe('better-auth API keys', () => {
  it('lets a key in with its permissions mapped, and refuses keys better-auth refuses', async () => {
    const { auth, signUp } = await realBetterAuth(new DatabaseSync(':memory:'));
    const { userId } = await signUp('c@example.com');
    const created = await auth.api.createApiKey({ body: { name: 'ci', permissions: { runs: ['read', 'submit'], admin: ['all'] }, userId } });
    expect(created.key.startsWith('acme_')).toBe(true);
    const table = { 'runs:read': ['runs:read'], 'runs:submit': ['runs:submit'] } as const;
    const authenticate = betterAuthApiKeyAuthenticator(auth, { prefix: 'acme_', identity: key => ({ principalId: `user/${key.referenceId}`, projectId: 'acme', agentIds: ['echo'], capabilities: mapCapabilities(betterAuthPermissions(key.permissions), table) }) });
    expect(await authenticate({ token: created.key, signal })).toMatchObject({ scope: { principalId: `user/${userId}` }, capabilities: ['runs:read', 'runs:submit'] });
    expect(betterAuthPermissions({ runs: ['read'], tools: ['use', 7 as never] })).toEqual(['runs:read', 'tools:use']);
    expect(betterAuthPermissions(null)).toEqual([]);
    expect(await authenticate({ token: 'acme_made_up_key', signal })).toBeNull();
    expect(await authenticate({ token: 'other_key', signal })).toBeNull();
    await auth.api.updateApiKey({ body: { keyId: created.id, enabled: false, userId } });
    expect(await authenticate({ token: created.key, signal })).toBeNull();
    const server = mayuraServer(authenticate);
    const second = await auth.api.createApiKey({ body: { name: 'second', permissions: { runs: ['read'] }, userId } });
    expect((await server.fetch(new Request('http://localhost:3000/v1/agents', { headers: { authorization: `Bearer ${second.key}` } }))).status).toBe(200);
  });

  it('applies better-auth\'s rate limit and expiry for the key', async () => {
    const { auth, signUp } = await realBetterAuth(new DatabaseSync(':memory:'), { rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 2 } });
    const { userId } = await signUp('d@example.com');
    const { key } = await auth.api.createApiKey({ body: { name: 'limited', userId } });
    const authenticate = betterAuthApiKeyAuthenticator(auth, { prefix: 'acme_', identity: found => grant(found.referenceId) });
    expect(await authenticate({ token: key, signal })).not.toBeNull();
    expect(await authenticate({ token: key, signal })).not.toBeNull();
    expect(await authenticate({ token: key, signal })).toBeNull();
    // Keys better-auth does not vouch for, with no owner, disabled or expired: all refused. Tokens without the prefix never reach it.
    let asked = 0;
    for (const answer of [{ valid: true, key: { id: 'k', referenceId: 'u', expiresAt: new Date(Date.now() - 1_000).toISOString() } }, { valid: false, key: { id: 'k', referenceId: 'u' } },
      { valid: 'yes', key: { id: 'k', referenceId: 'u' } }, { valid: true, key: { id: 'k' } }, { valid: true, key: { id: 'k', referenceId: 'u', enabled: false } }, { valid: true, key: null }, null]) {
      const answering: BetterAuthInstance = { handler: auth.handler, api: { getSession: async () => null, verifyApiKey: async () => { asked++; return answer; } } };
      const check = betterAuthApiKeyAuthenticator(answering, { prefix: 'acme_', identity: found => grant(found.referenceId) });
      expect(await check({ token: 'acme_x', signal }), JSON.stringify(answer)).toBeNull();
      expect(await check({ token: 'other_x', signal })).toBeNull();
    }
    expect(asked).toBe(7);
    expect(() => betterAuthApiKeyAuthenticator({ handler: auth.handler, api: { getSession: auth.api.getSession } } as never, { prefix: 'acme_', identity: () => null })).toThrow(/apiKey/u);
    expect(() => betterAuthApiKeyAuthenticator(auth, { prefix: '', identity: () => null })).toThrow(/prefix/u);
    expect(() => betterAuthApiKeyAuthenticator(auth, { prefix: 'acme_', identity: 'x' as never })).toThrow(/identity/u);
  });
});

describe('better-auth JWTs and mounting', () => {
  it('verifies better-auth\'s JWTs against its JWKS, without asking better-auth per request', async () => {
    const { auth, signUp } = await realBetterAuth(new DatabaseSync(':memory:'));
    const { token, userId } = await signUp('e@example.com');
    let jwksFetches = 0;
    const fetchFromAuth = (async (input: RequestInfo | URL) => { jwksFetches++; return auth.handler(new Request(String(input))); }) as typeof fetch;
    const verifier = betterAuthJwtVerifier({ baseURL: 'http://localhost:3000', fetch: fetchFromAuth });
    const issued = await auth.handler(new Request('http://localhost:3000/api/auth/token', { headers: { authorization: `Bearer ${token}` } }));
    const jwtToken = (await issued.json() as { token: string }).token;
    const authenticate = jwtAuthenticator({ verifier, identity: claims => grant(String(claims.sub)) });
    expect(await authenticate({ token: jwtToken, signal })).toMatchObject({ scope: { principalId: `user/${userId}` } });
    expect(await authenticate({ token: jwtToken, signal })).not.toBeNull();
    expect(jwksFetches).toBe(1);
    const [header, , signature] = jwtToken.split('.');
    const forged = `${header}.${Buffer.from(JSON.stringify({ sub: 'someone-else', iss: 'http://localhost:3000', aud: 'http://localhost:3000', exp: Math.floor(Date.now() / 1_000) + 600 })).toString('base64url')}.${signature}`;
    expect(await authenticate({ token: forged, signal })).toBeNull();
    expect(() => betterAuthJwtVerifier({ baseURL: 'not a url' })).toThrow(/baseURL/u);
    expect(() => betterAuthJwtVerifier({} as never)).toThrow(/baseURL/u);
    expect(() => betterAuthJwtVerifier({ baseURL: 'http://localhost:3000', basePath: 'api' })).toThrow(/basePath/u);
  });

  it('serves better-auth and Mayura\'s server from one handler: sign up over HTTP, then call the server', async () => {
    const { auth } = await realBetterAuth(new DatabaseSync(':memory:'));
    const server = mayuraServer(betterAuthAuthenticator(auth, { identity: session => grant(session.user.id) }));
    const handle = withBetterAuth(auth, request => server.fetch(request));
    const signedUp = await handle(new Request('http://localhost:3000/api/auth/sign-up/email', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: JSON.stringify({ email: 'f@example.com', password: 'a-long-test-password-1', name: 'F' }) }));
    expect(signedUp.status).toBe(200);
    const token = signedUp.headers.get('set-auth-token')!;
    expect((await handle(new Request('http://localhost:3000/v1/agents', { headers: { authorization: `Bearer ${token}` } }))).status).toBe(200);
    expect((await handle(new Request('http://localhost:3000/v1/agents'))).status).toBe(401);
    // Only better-auth's own path goes to it: a path that merely starts the same goes on.
    const seen: string[] = [];
    const routed = withBetterAuth({ handler: async request => { seen.push(`auth ${new URL(request.url).pathname}`); return new Response(null); } }, request => { seen.push(`next ${new URL(request.url).pathname}`); return new Response(null); });
    for (const path of ['/api/auth', '/api/auth/session', '/api/authentication', '/v1/runs']) await routed(new Request(`http://localhost:3000${path}`));
    expect(seen).toEqual(['auth /api/auth', 'auth /api/auth/session', 'next /api/authentication', 'next /v1/runs']);
    expect(() => withBetterAuth({} as never, request => server.fetch(request))).toThrow(/auth/u);
    expect(() => withBetterAuth(auth, 'x' as never)).toThrow(/next/u);
    expect(() => withBetterAuth(auth, request => server.fetch(request), { basePath: 'nope' })).toThrow(/basePath/u);
  });
});
