import { describe, expect, it } from 'vitest';
import { mapCapabilities, principalId } from 'mayura/auth';
import { testIssuer } from 'mayura/auth/testing';
import { oktaAuthenticator, oktaSession } from '../src/index.js';

const issuer = 'https://acme.okta.com/oauth2/default';
const audience = 'api://default';
const signal = new AbortController().signal;
const grant = { principalId: 'okta/x', projectId: 'acme', agentIds: [], capabilities: ['runs:read' as const] };
const user = (extra: Record<string, unknown> = {}) => ({ sub: 'ada@acme.com', uid: '00u1abcd', cid: '0oa1web', aud: audience, scp: ['openid', 'agents.use'], ver: 1, ...extra });
const machine = (extra: Record<string, unknown> = {}) => ({ sub: '0oa1svc', cid: '0oa1svc', aud: audience, scp: ['agents.use'], ver: 1, ...extra });
async function setup(extra: Partial<Parameters<typeof oktaAuthenticator>[0]> = {}, server = issuer) {
  const okta = await testIssuer({ issuer: server, algorithm: 'RS256', jwksPath: `${new URL(server).pathname}/v1/keys` });
  return { okta, authenticate: oktaAuthenticator({ domain: 'acme.okta.com', audience, fetch: okta.fetch, identity: () => grant, ...extra }) };
}

describe('oktaAuthenticator', () => {
  it('refuses configuration that would check tokens against nothing, or against the org authorization server', () => {
    const base = { domain: 'acme.okta.com', audience, identity: () => null };
    for (const domain of ['', 'localhost', 'https://', 'acme okta.com', 7]) expect(() => oktaAuthenticator({ ...base, domain: domain as never }), String(domain)).toThrow(/domain/u);
    for (const server of ['', 'aus/1', 'a'.repeat(65), 7]) expect(() => oktaAuthenticator({ ...base, authorizationServer: server as never }), String(server)).toThrow(/authorizationServer/u);
    for (const bad of ['', [], [''], 7]) expect(() => oktaAuthenticator({ ...base, audience: bad as never })).toThrow(/oktaAuthenticator\(\): audience/u);
    for (const bad of [[], [''], 'x']) expect(() => oktaAuthenticator({ ...base, clientIds: bad as never })).toThrow(/clientIds/u);
    expect(() => oktaAuthenticator({ ...base, identity: 'x' as never })).toThrow(/identity/u);
    expect(() => oktaAuthenticator({ ...base, allowMachines: 'yes' as never })).toThrow(/allowMachines/u);
  });

  it('accepts user tokens from the authorization server for its audience, with keys from its /v1/keys', async () => {
    for (const domain of ['acme.okta.com', 'https://acme.okta.com', 'https://acme.okta.com/']) {
      let seen: unknown;
      const { okta, authenticate } = await setup({ domain, identity: session => { seen = session; return { ...grant, principalId: principalId('okta', session.userId!), capabilities: mapCapabilities(session.scopes, { 'agents.use': ['runs:submit'] }) }; } });
      expect(okta.jwksUrl).toBe(`${issuer}/v1/keys`);
      expect(await authenticate({ token: await okta.sign(user({ groups: ['Agents', 7] })), signal })).toMatchObject({ capabilities: ['runs:submit'] });
      expect(seen).toMatchObject({ subject: 'ada@acme.com', userId: '00u1abcd', clientId: '0oa1web', machine: false, scopes: ['openid', 'agents.use'], groups: ['Agents'] });
    }
  });

  it('uses the custom authorization server named', async () => {
    const { okta, authenticate } = await setup({ authorizationServer: 'aus1a2b3c' }, 'https://acme.okta.com/oauth2/aus1a2b3c');
    expect(await authenticate({ token: await okta.sign(user()), signal })).not.toBeNull();
    expect(await authenticate({ token: await okta.sign(user({ iss: issuer })), signal })).toBeNull();
  });

  it('refuses other audiences, issuers, keys, clients, DPoP-bound tokens and machines unless allowed', async () => {
    const { okta, authenticate } = await setup();
    expect(await authenticate({ token: await okta.sign(user({ aud: 'api://other' })), signal })).toBeNull();
    expect(await authenticate({ token: await okta.sign(user({ iss: 'https://acme.okta.com' })), signal })).toBeNull();
    const other = await testIssuer({ issuer, algorithm: 'RS256', jwksPath: '/oauth2/default/v1/keys' });
    expect(await authenticate({ token: await other.sign(user()), signal })).toBeNull();
    expect(await authenticate({ token: await okta.sign(user({ cid: undefined })), signal })).toBeNull();
    expect(await authenticate({ token: await okta.sign(user({ cnf: { jkt: 'thumbprint' } })), signal })).toBeNull();
    expect(await authenticate({ token: await okta.sign(machine()), signal })).toBeNull();
    const machines = oktaAuthenticator({ domain: 'acme.okta.com', audience, allowMachines: true, fetch: okta.fetch, identity: session => session.machine ? grant : null });
    expect(await machines({ token: await okta.sign(machine()), signal })).not.toBeNull();
    const clients = oktaAuthenticator({ domain: 'acme.okta.com', audience, clientIds: ['0oa1web'], fetch: okta.fetch, identity: () => grant });
    expect(await clients({ token: await okta.sign(user()), signal })).not.toBeNull();
    expect(await clients({ token: await okta.sign(user({ cid: '0oa1other' })), signal })).toBeNull();
  });

  it('reads sessions defensively', () => {
    const claims = { iss: issuer, exp: 1, ...user() };
    expect(oktaSession({ ...claims, scp: 'agents.use', groups: 'Agents' })).toMatchObject({ scopes: [], groups: [] });
    expect(oktaSession({ ...claims, sub: '' })).toBeUndefined();
    expect(oktaSession({ ...claims, cid: '' })).toBeUndefined();
    // A user token whose login happens to equal its client id is still a user's: it carries uid.
    expect(oktaSession({ ...claims, sub: '0oa1web' })?.machine).toBe(false);
    expect(oktaSession({ iss: issuer, exp: 1, ...machine() })).toMatchObject({ machine: true, userId: null });
    expect(oktaSession({ iss: issuer, exp: 1, ...machine({ sub: 'someone' }) })?.machine).toBe(false);
  });
});
