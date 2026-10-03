import { describe, expect, it } from 'vitest';
import { mapCapabilities } from 'mayura/auth';
import { testIssuer } from 'mayura/auth/testing';
import { entraAuthenticator, entraSession } from '../src/index.js';

const tenantA = '11111111-1111-4111-8111-111111111111';
const tenantB = '22222222-2222-4222-8222-222222222222';
const api = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const oid = '33333333-3333-4333-8333-333333333333';
const signal = new AbortController().signal;
const grant = { principalId: 'entra/u1', projectId: 'acme', agentIds: [], capabilities: ['runs:read' as const] };
const v2 = (tenant: string) => `https://login.microsoftonline.com/${tenant}/v2.0`;
const v1 = (tenant: string) => `https://sts.windows.net/${tenant}/`;
const user = (tenant: string, extra: Record<string, unknown> = {}) => ({ aud: api, tid: tenant, oid, sub: 'pairwise-sub', azp: 'client-app', scp: 'access_as_user', roles: ['Agents.Use'], name: 'Ada', preferred_username: 'ada@contoso.com', ver: '2.0', ...extra });

/** Microsoft's two key sets: v2.0 keys bound to tenants by their issuer template, and v1.0 keys. */
async function microsoft() {
  const signer = await testIssuer({ issuer: v2(tenantA), algorithm: 'RS256' });
  const legacy = await testIssuer({ issuer: v1(tenantA), algorithm: 'RS256' });
  const v2Keys = [{ ...signer.jwks.keys[0]!, issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0' }];
  const asked: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input); asked.push(url);
    if (url === 'https://login.microsoftonline.com/common/discovery/v2.0/keys') return Response.json({ keys: v2Keys });
    if (url === 'https://login.microsoftonline.com/common/discovery/keys') return Response.json(legacy.jwks);
    return new Response('', { status: 404 });
  }) as typeof fetch;
  return { signer, legacy, v2Keys, asked, fetcher };
}
const as = (tenant: string, version: '1.0' | '2.0' = '2.0') => ({ iss: version === '2.0' ? v2(tenant) : v1(tenant) });

describe('entraAuthenticator', () => {
  it('refuses configuration it cannot keep to, and tokens meant for Microsoft Graph', () => {
    const base = { tenants: [tenantA], audience: api, identity: () => null };
    for (const tenants of [[], ['contoso.onmicrosoft.com'], 'common', [7]]) expect(() => entraAuthenticator({ ...base, tenants: tenants as never }), JSON.stringify(tenants)).toThrow(/tenants/u);
    for (const audience of ['', [], [7]]) expect(() => entraAuthenticator({ ...base, audience: audience as never })).toThrow(/audience/u);
    for (const audience of ['00000003-0000-0000-c000-000000000000', 'https://graph.microsoft.com', 'HTTPS://GRAPH.MICROSOFT.COM/']) expect(() => entraAuthenticator({ ...base, audience }), audience).toThrow(/Graph/u);
    expect(() => entraAuthenticator({ ...base, identity: 'x' as never })).toThrow(/identity/u);
    expect(() => entraAuthenticator({ ...base, versions: ['3.0' as never] })).toThrow(/versions/u);
    expect(() => entraAuthenticator({ ...base, versions: [] })).toThrow(/versions/u);
    expect(() => entraAuthenticator({ ...base, allowApps: 'yes' as never })).toThrow(/allowApps/u);
    expect(() => entraAuthenticator({ ...base, maxIdentityMs: 10 })).toThrow(/maxIdentityMs/u);
  });

  it('accepts a v2.0 user token for the API from an accepted tenant, with Microsoft\'s v2.0 keys', async () => {
    const { signer, asked, fetcher } = await microsoft();
    let seen: unknown;
    const authenticate = entraAuthenticator({ tenants: [tenantA], audience: [api, 'api://agents'], fetch: fetcher, identity: session => { seen = session; return { ...grant, capabilities: mapCapabilities(session.roles, { 'Agents.Use': ['runs:submit'] }) }; } });
    expect(await authenticate({ token: await signer.sign(user(tenantA)), signal })).toMatchObject({ capabilities: ['runs:submit'] });
    expect(seen).toMatchObject({ objectId: oid, tenantId: tenantA, subject: 'pairwise-sub', app: false, clientId: 'client-app', roles: ['Agents.Use'], scopes: ['access_as_user'], name: 'Ada', username: 'ada@contoso.com', version: '2.0' });
    expect(asked).toEqual(['https://login.microsoftonline.com/common/discovery/v2.0/keys']);
    expect(await authenticate({ token: await signer.sign(user(tenantA, { aud: 'api://agents' })), signal })).not.toBeNull();
  });

  it('refuses other tenants, audiences, tenant mismatches, app tokens and v1.0 tokens unless asked', async () => {
    const { signer, legacy, asked, fetcher } = await microsoft();
    const authenticate = entraAuthenticator({ tenants: [tenantA], audience: api, fetch: fetcher, identity: () => grant });
    expect(await authenticate({ token: await signer.sign({ ...user(tenantB), ...as(tenantB) }), signal })).toBeNull();
    // Neither an unlisted tenant's token nor a v1.0 token (not accepted here) makes it fetch any keys.
    expect(await authenticate({ token: await legacy.sign({ ...user(tenantA, { ver: '1.0' }), ...as(tenantA, '1.0') }), signal })).toBeNull();
    expect(asked).toEqual([]);
    for (const dashes of [`https://login.microsoftonline.com/${'-'.repeat(36)}/v2.0`, `https://sts.windows.net/${'-'.repeat(36)}/`]) {
      expect(entraAuthenticator({ tenants: 'any', audience: api, versions: ['1.0', '2.0'], fetch: fetcher, identity: () => grant }).accepts(await signer.sign({ ...user(tenantA), iss: dashes })), dashes).toBe(false);
    }
    expect(authenticate.accepts(await signer.sign({ ...user(tenantB), ...as(tenantB) }))).toBe(false);
    expect(await authenticate({ token: await signer.sign(user(tenantA, { aud: '00000003-0000-0000-c000-000000000000' })), signal })).toBeNull();
    expect(await authenticate({ token: await signer.sign(user(tenantA, { tid: tenantB })), signal })).toBeNull();
    expect(await authenticate({ token: await signer.sign(user(tenantA, { oid: 'not-a-guid' })), signal })).toBeNull();
    expect(await authenticate({ token: await signer.sign(user(tenantA, { scp: undefined, roles: ['Agents.ReadAll'] })), signal })).toBeNull();
    expect(await authenticate({ token: await legacy.sign({ ...user(tenantA, { appid: 'client-app', azp: undefined, ver: '1.0' }), ...as(tenantA, '1.0') }), signal })).toBeNull();
    const other = await testIssuer({ issuer: v2(tenantA), algorithm: 'RS256' });
    expect(await authenticate({ token: await other.sign(user(tenantA)), signal })).toBeNull();
    const apps = entraAuthenticator({ tenants: [tenantA], audience: api, allowApps: true, fetch: fetcher, identity: () => grant });
    expect(await apps({ token: await signer.sign(user(tenantA, { scp: undefined, roles: ['Agents.ReadAll'] })), signal })).not.toBeNull();
  });

  it('verifies v1.0 tokens with the v1.0 keys when asked', async () => {
    const { legacy, asked, fetcher } = await microsoft();
    let seen: unknown;
    const authenticate = entraAuthenticator({ tenants: [tenantA], audience: api, versions: ['1.0', '2.0'], fetch: fetcher, identity: session => { seen = session; return grant; } });
    expect(await authenticate({ token: await legacy.sign({ ...user(tenantA, { appid: 'client-app', azp: undefined, preferred_username: undefined, upn: 'ada@contoso.com', ver: '1.0' }), ...as(tenantA, '1.0') }), signal })).not.toBeNull();
    expect(seen).toMatchObject({ version: '1.0', clientId: 'client-app', username: 'ada@contoso.com' });
    // v1.0 keys name no issuer: the token's tenant must still be its issuer's.
    expect(await authenticate({ token: await legacy.sign({ ...user(tenantA, { tid: tenantB, ver: '1.0' }), ...as(tenantA, '1.0') }), signal })).toBeNull();
    expect(asked).toEqual(['https://login.microsoftonline.com/common/discovery/keys']);
  });

  it('accepts any tenant when asked, substituting each issuer, and keeps a tenant-bound key to its tenant', async () => {
    const { signer, v2Keys, fetcher } = await microsoft();
    const authenticate = entraAuthenticator({ tenants: 'any', audience: api, fetch: fetcher, identity: session => ({ ...grant, projectId: session.tenantId }) });
    expect(await authenticate({ token: await signer.sign({ ...user(tenantA), ...as(tenantA) }), signal })).toMatchObject({ scope: { projectId: tenantA } });
    expect(await authenticate({ token: await signer.sign({ ...user(tenantB), ...as(tenantB) }), signal })).toMatchObject({ scope: { projectId: tenantB } });
    expect(await authenticate({ token: await signer.sign({ ...user(tenantB), iss: 'https://login.microsoftonline.com/common/v2.0' }), signal })).toBeNull();
    // A key bound to one tenant (as Microsoft binds some) never verifies another tenant's token.
    v2Keys[0] = { ...v2Keys[0]!, issuer: v2(tenantA) };
    const bound = entraAuthenticator({ tenants: 'any', audience: api, fetch: fetcher, identity: () => grant });
    expect(await bound({ token: await signer.sign({ ...user(tenantA), ...as(tenantA) }), signal })).not.toBeNull();
    expect(await bound({ token: await signer.sign({ ...user(tenantB), ...as(tenantB) }), signal })).toBeNull();
  });

  it('reads sessions defensively', () => {
    const claims = { iss: v2(tenantA), exp: 1, ...user(tenantA) };
    expect(entraSession({ ...claims, roles: ['a', 7], scp: 'a  b', name: 7 })).toMatchObject({ roles: ['a'], scopes: ['a', 'b'], name: null });
    expect(entraSession({ ...claims, iss: 'https://login.microsoftonline.com/not-a-tenant/v2.0' })).toBeUndefined();
    expect(entraSession({ ...claims, sub: '' })).toBeUndefined();
    expect(entraSession({ ...claims, azp: undefined, preferred_username: undefined, unique_name: 'ada' })).toMatchObject({ clientId: null, username: 'ada' });
  });
});
