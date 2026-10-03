import { afterEach, describe, expect, it } from 'vitest';
import type { Schema } from '@mayura/core';
import { defineAgent } from '@mayura/runtime';
import { createAgentServer, type AgentServer, type ServerIdentity } from '@mayura/server';
import { chainAuthenticators, jwtAuthenticator, jwtVerifier, mapCapabilities, principalId, serverCapabilities, staticKeys, type IdentityGrant } from '../src/index.js';
import { testIssuer } from '../src/testing.js';

const signal = new AbortController().signal;
const servers: AgentServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });
const grant = (overrides: Partial<IdentityGrant> = {}): IdentityGrant => ({ principalId: 'clerk/user_1', projectId: 'acme', agentIds: ['echo'], capabilities: ['runs:read'], ...overrides });
async function setup(identity: Parameters<typeof jwtAuthenticator>[0]['identity'] = () => grant(), maxIdentityMs?: number) {
  const issuer = await testIssuer();
  const verifier = jwtVerifier({ issuer: issuer.issuer, audience: 'api', algorithms: ['ES256'], keys: staticKeys(issuer.jwks) });
  return { issuer, authenticate: jwtAuthenticator({ verifier, identity, ...(maxIdentityMs ? { maxIdentityMs } : {}) }) };
}

describe('identity', () => {
  it('lists exactly the capabilities the server knows', () => {
    // Every listed capability is one the server type allows, and the list has them all.
    const typed: readonly ServerIdentity['capabilities'][number][] = serverCapabilities;
    expect(new Set(typed).size).toBe(10);
  });

  it('makes principal ids the server accepts, keeping subjects readable where it can', () => {
    expect(principalId('clerk', 'user_2abc')).toBe('clerk/user_2abc');
    const encoded = principalId('auth0', 'auth0|123');
    expect(encoded).toMatch(/^auth0\/_[A-Za-z0-9_-]{43}$/u);
    expect(principalId('auth0', 'auth0|123')).toBe(encoded);
    expect(principalId('auth0', 'auth0|124')).not.toBe(encoded);
    // A subject that already starts with _ is encoded too, so it can never collide with an encoded one.
    expect(principalId('x', '_abc')).toMatch(/^x\/_[A-Za-z0-9_-]{43}$/u);
    expect(principalId('x', 'a'.repeat(200))).toMatch(/^x\/_[A-Za-z0-9_-]{43}$/u);
    expect(() => principalId('Bad NS', 'a')).toThrow(/namespace/u);
    expect(() => principalId('ns', '')).toThrow(/subject/u);
  });

  it('maps permissions to capabilities through an explicit table only', () => {
    const table = { 'org:runs:write': ['runs:submit', 'runs:read'], 'org:admin': ['workflows:control'] } as const;
    expect(mapCapabilities(['org:runs:write', 'org:unknown', 7], table)).toEqual(['runs:read', 'runs:submit']);
    expect(mapCapabilities('org:admin openid', table)).toEqual(['workflows:control']);
    expect(mapCapabilities(undefined, table)).toEqual([]);
    expect(mapCapabilities(['toString', 'constructor'], table)).toEqual([]);
    expect(() => mapCapabilities([], { x: ['root'] } as never)).toThrow(/capabilities/u);
  });

  it('grants only what the identity mapping returns, for no longer than the token or maxIdentityMs', async () => {
    const { issuer, authenticate } = await setup(claims => claims['sub'] === 'user_1' ? grant() : null, 30_000);
    const identity = await authenticate({ token: await issuer.sign({ aud: 'api', sub: 'user_1' }), signal });
    expect(identity).toMatchObject({ scope: { principalId: 'clerk/user_1', projectId: 'acme' }, agentIds: ['echo'], capabilities: ['runs:read'] });
    expect(identity!.expiresAtMs - Date.now()).toBeLessThanOrEqual(30_000);
    const brief = await authenticate({ token: await issuer.sign({ aud: 'api', sub: 'user_1' }, { expiresInMs: 10_000 }), signal });
    expect(brief!.expiresAtMs - Date.now()).toBeLessThanOrEqual(10_000);
    expect(await authenticate({ token: await issuer.sign({ aud: 'api', sub: 'user_2' }), signal })).toBeNull();
    expect(await authenticate({ token: await issuer.sign({ aud: 'nope', sub: 'user_1' }), signal })).toBeNull();
    expect(await authenticate({ token: 'mk_live_not_a_jwt', signal })).toBeNull();
  });

  it('caps an identity at the grant\'s own expiry, and refuses one already over', async () => {
    const soon = Date.now() + 5_000;
    const { issuer, authenticate } = await setup(() => grant({ expiresAtMs: soon }));
    expect((await authenticate({ token: await issuer.sign({ aud: 'api' }), signal }))!.expiresAtMs).toBe(soon);
    const { issuer: second, authenticate: past } = await setup(() => grant({ expiresAtMs: Date.now() - 1 }));
    expect(await past({ token: await second.sign({ aud: 'api' }), signal })).toBeNull();
    // A grant asking for longer than the token lasts still ends with the token.
    const { issuer: third, authenticate: longer } = await setup(() => grant({ expiresAtMs: Date.now() + 3_600_000 }), 3_600_000);
    expect((await longer({ token: await third.sign({ aud: 'api' }, { expiresInMs: 10_000 }), signal }))!.expiresAtMs - Date.now()).toBeLessThanOrEqual(10_000);
  });

  it('treats a grant the server cannot use as a configuration problem, not a caller', async () => {
    for (const bad of [grant({ principalId: 'auth0|x' }), grant({ projectId: '' }), grant({ agentIds: ['a b'] }), grant({ capabilities: ['root' as never] }), grant({ expiresAtMs: 1.5 })]) {
      const { issuer, authenticate } = await setup(() => bad);
      await expect(authenticate({ token: await issuer.sign({ aud: 'api' }), signal }), JSON.stringify(bad)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    }
  });

  it('routes each token to the authenticator for its issuer, and refuses tokens no one accepts', async () => {
    const first = await setup(() => grant({ principalId: 'first/u' }));
    const second = await setup(() => grant({ principalId: 'second/u' }));
    const second2 = await testIssuer({ issuer: 'https://second-issuer.test' });
    const routed = chainAuthenticators(first.authenticate, jwtAuthenticator({
      verifier: jwtVerifier({ issuer: second2.issuer, audience: 'api', algorithms: ['ES256'], keys: staticKeys(second2.jwks) }), identity: () => grant({ principalId: 'second/u' }) }));
    expect((await routed({ token: await first.issuer.sign({ aud: 'api' }), signal }))!.scope.principalId).toBe('first/u');
    expect((await routed({ token: await second2.sign({ aud: 'api' }), signal }))!.scope.principalId).toBe('second/u');
    expect(await routed({ token: await second.issuer.sign({ aud: 'api', iss: 'https://unknown.test' }), signal })).toBeNull();
    expect(routed.accepts(await first.issuer.sign({}))).toBe(true);
    expect(() => chainAuthenticators()).toThrow(/authenticators/u);
    expect(() => jwtAuthenticator({ verifier: {} as never, identity: () => null })).toThrow(/verifier/u);
    const verifier = jwtVerifier({ issuer: second2.issuer, audience: 'api', algorithms: ['ES256'], keys: staticKeys(second2.jwks) });
    expect(() => jwtAuthenticator({ verifier, identity: 'x' as never })).toThrow(/identity/u);
    for (const maxIdentityMs of [10, 7_200_000, 1.5]) expect(() => jwtAuthenticator({ verifier, identity: () => null, maxIdentityMs }), String(maxIdentityMs)).toThrow(/maxIdentityMs/u);
  });

  it("never checks, or fetches keys for, a token that is not its issuer's; a chain never asks an authenticator that does not accept", async () => {
    const issuer = await testIssuer();
    const foreign = await testIssuer({ issuer: 'https://foreign.test' });
    let verified = 0;
    const counting = { issuers: [issuer.issuer], verify: async () => { verified++; return { ok: false as const, reason: 'key' as const }; } };
    const authenticate = jwtAuthenticator({ verifier: counting, identity: () => grant() });
    expect(await authenticate({ token: await foreign.sign({ aud: 'api' }), signal })).toBeNull();
    expect(await authenticate({ token: 'not-a-token', signal })).toBeNull();
    expect(verified).toBe(0);
    let asked = 0;
    const greedy = Object.assign(async () => { asked++; return null; }, { accepts: () => false });
    expect(await chainAuthenticators(greedy)({ token: await foreign.sign({}), signal })).toBeNull();
    expect(asked).toBe(0);
  });

  it('works as Mayura\'s server authenticate: a verified caller in, anyone else 401', async () => {
    const { issuer, authenticate } = await setup(claims => claims['sub'] === 'user_1' ? grant({ capabilities: ['runs:read'] }) : null);
    const schema: Schema<unknown> = { '~standard': { version: 1, vendor: 'test', validate: value => ({ value }) } };
    const agent = defineAgent({ id: 'echo', version: '1', instructions: 'Fixture.', tools: [], input: schema, output: schema,
      model: { id: 'fixture', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0, generate: async () => ({ type: 'final' as const, output: 1, usage: { costMicros: 0 } }) } });
    const server = createAgentServer({ publicOrigin: 'https://agents.test', agents: [{ agent, permissions: { allow: ['model:fixture'] } }], authenticate });
    servers.push(server);
    const call = async (token: string) => server.fetch(new Request('https://agents.test/v1/agents', { headers: { authorization: `Bearer ${token}` } }));
    const allowed = await call(await issuer.sign({ aud: 'api', sub: 'user_1' }));
    expect(allowed.status).toBe(200);
    expect((await allowed.json() as { agents: { id: string }[] }).agents.map(item => item.id)).toEqual(['echo']);
    expect((await call(await issuer.sign({ aud: 'api', sub: 'user_2' }))).status).toBe(401);
    expect((await call(await issuer.sign({ aud: 'api', sub: 'user_1' }, { expiresInMs: -60_000 }))).status).toBe(401);
    expect((await call('garbage')).status).toBe(401);
  });
});
