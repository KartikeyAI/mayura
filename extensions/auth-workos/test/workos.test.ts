import { describe, expect, it } from 'vitest';
import { mapCapabilities } from 'mayura/auth';
import { testIssuer } from 'mayura/auth/testing';
import { workosAuthenticator, workosSession } from '../src/index.js';

const clientId = 'client_01HXYZABCDEF';
const signal = new AbortController().signal;
const grant = { principalId: 'workos/u1', projectId: 'acme', agentIds: [], capabilities: ['runs:read' as const] };
async function setup(extra: Partial<Parameters<typeof workosAuthenticator>[0]> = {}, connectDomain = 'https://acme.authkit.app') {
  const authkit = await testIssuer({ issuer: extra.issuer ?? 'https://api.workos.com/', algorithm: 'RS256' });
  const connect = await testIssuer({ issuer: connectDomain, algorithm: 'RS256', jwksPath: '/oauth2/jwks' });
  const asked: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input); asked.push(url);
    if (url === `https://api.workos.com/sso/jwks/${clientId}`) return Response.json(authkit.jwks);
    if (url === `${connectDomain}/oauth2/jwks`) return Response.json(connect.jwks);
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { authkit, connect, asked, authenticate: workosAuthenticator({ clientId, fetch: fetcher, identity: () => grant, ...extra }) };
}

describe('workosAuthenticator', () => {
  it('refuses configuration it cannot keep to', () => {
    for (const bad of ['', 'client', 'app_123456', 'client_!!!!!!']) expect(() => workosAuthenticator({ clientId: bad, identity: () => null }), bad).toThrow(/clientId/u);
    expect(() => workosAuthenticator({ clientId, identity: 'x' as never })).toThrow(/identity/u);
    expect(() => workosAuthenticator({ clientId, identity: () => null, issuer: 'http://auth.example.com' })).toThrow(/issuer/u);
    expect(() => workosAuthenticator({ clientId, identity: () => null, connect: { domain: 'acme.authkit.app' } })).toThrow(/connect.domain/u);
    expect(() => workosAuthenticator({ clientId, identity: () => null, connect: {} as never })).toThrow(/connect.domain/u);
    expect(() => workosAuthenticator({ clientId, identity: () => null, allowMachines: 'yes' as never })).toThrow(/allowMachines/u);
    expect(() => workosAuthenticator({ clientId, identity: () => null, maxIdentityMs: 10 })).toThrow(/maxIdentityMs/u);
  });

  it('accepts AuthKit session tokens with the client\'s keys, and reads the organization, role and permissions', async () => {
    let seen: unknown;
    const { authkit, asked, authenticate } = await setup({ identity: session => { seen = session; return session.orgId ? { ...grant, projectId: session.orgId, capabilities: mapCapabilities(session.permissions, { 'agents:use': ['runs:submit'] }) } : null; } });
    expect(await authenticate({ token: await authkit.sign({ sub: 'user_1', sid: 'session_1', org_id: 'org_1', role: 'admin', permissions: ['agents:use', 'billing:all'] }), signal }))
      .toMatchObject({ scope: { projectId: 'org_1' }, capabilities: ['runs:submit'] });
    expect(seen).toMatchObject({ kind: 'authkit', subject: 'user_1', machine: false, sessionId: 'session_1', orgId: 'org_1', role: 'admin', roles: ['admin'], permissions: ['agents:use', 'billing:all'] });
    expect(asked).toEqual([`https://api.workos.com/sso/jwks/${clientId}`]);
    expect(await authenticate({ token: await authkit.sign({ sub: 'user_1', sid: 'session_1' }), signal })).toBeNull();
  });

  it('refuses other issuers, keys and algorithms, and Connect tokens unless asked', async () => {
    const { authkit, connect, authenticate } = await setup();
    expect(await authenticate({ token: await authkit.sign({ sub: 'user_1', iss: 'https://api.workos.com' }), signal })).toBeNull();
    const other = await testIssuer({ issuer: 'https://api.workos.com/', algorithm: 'RS256' });
    expect(await authenticate({ token: await other.sign({ sub: 'user_1' }), signal })).toBeNull();
    expect(await authenticate({ token: await connect.sign({ sub: 'user_1', aud: clientId, client_id: 'app', sid: 'consent' }), signal })).toBeNull();
    expect(await authenticate({ token: await authkit.sign({ sid: 's' }), signal })).toBeNull();
    expect(authenticate.accepts(await connect.sign({ sub: 'x' }))).toBe(false);
  });

  it('accepts Connect tokens for the audience from the AuthKit domain; machines only when allowed', async () => {
    let seen: unknown;
    const { connect, asked, authenticate } = await setup({ connect: { domain: 'https://acme.authkit.app' }, identity: session => { seen = session; return grant; } });
    expect(await authenticate({ token: await connect.sign({ sub: 'user_1', aud: clientId, client_id: 'client_app', sid: 'consent_1', org_id: 'org_1', scope: 'read:runs  write:runs' }), signal })).not.toBeNull();
    // Only the keys of the token's own issuer are fetched.
    expect(asked).toEqual(['https://acme.authkit.app/oauth2/jwks']);
    expect(seen).toMatchObject({ kind: 'connect', machine: false, subject: 'user_1', clientId: 'client_app', sessionId: 'consent_1', scopes: ['read:runs', 'write:runs'] });
    expect(await authenticate({ token: await connect.sign({ sub: 'user_1', aud: 'other' }), signal })).toBeNull();
    const machine = { sub: 'client_m2m', client_id: 'client_m2m', aud: clientId, org_id: 'org_1', scope: 'read:runs' };
    expect(await authenticate({ token: await connect.sign(machine), signal })).toBeNull();
    const { connect: second, authenticate: machines } = await setup({ connect: { domain: 'https://acme.authkit.app', audience: ['https://agents.acme.com'] }, allowMachines: true, identity: session => { seen = session; return grant; } });
    expect(await machines({ token: await second.sign({ ...machine, aud: 'https://agents.acme.com' }), signal })).not.toBeNull();
    expect(seen).toMatchObject({ machine: true, subject: 'client_m2m' });
  });

  it('tries both kinds when a custom auth domain is also the AuthKit domain', async () => {
    const shared = 'https://auth.acme.com';
    const { authkit, connect, authenticate } = await setup({ issuer: shared, connect: { domain: shared } }, shared);
    expect(await authenticate({ token: await authkit.sign({ sub: 'user_1', sid: 's1' }), signal })).not.toBeNull();
    expect(await authenticate({ token: await connect.sign({ sub: 'user_1', aud: clientId, client_id: 'client_app', sid: 'c1' }), signal })).not.toBeNull();
  });

  it('reads sessions defensively', () => {
    expect(workosSession({ iss: 'x', exp: 1, sub: 'u', roles: ['a', 7], role: 'a', permissions: 'x', scope: 7, org_id: 5 }, 'authkit'))
      .toMatchObject({ roles: ['a'], permissions: [], scopes: [], orgId: null, clientId: null });
    expect(workosSession({ iss: 'x', exp: 1, sub: 'u' }, 'authkit')).toMatchObject({ roles: [], role: null, machine: false });
    expect(workosSession({ iss: 'x', exp: 1, sub: 'c', client_id: 'c' }, 'authkit')?.machine).toBe(false);
    expect(workosSession({ iss: 'x', exp: 1, sub: 'c', client_id: 'c', sid: 's' }, 'connect')?.machine).toBe(false);
    expect(workosSession({ iss: 'x', exp: 1, sub: 'user_1', client_id: 'client_app' }, 'connect')?.machine).toBe(false);
    expect(workosSession({ iss: 'x', exp: 1 }, 'connect')).toBeUndefined();
  });
});
