import { describe, expect, it } from 'vitest';
import { mapCapabilities, principalId } from 'mayura/auth';
import { testIssuer } from 'mayura/auth/testing';
import { cognitoAuthenticator, cognitoSession } from '../src/index.js';

const poolId = 'eu-west-1_AbCdEf123';
const issuer = `https://cognito-idp.eu-west-1.amazonaws.com/${poolId}`;
const client = '1example23456789abcdefghij';
const signal = new AbortController().signal;
const grant = { principalId: 'cognito/x', projectId: 'acme', agentIds: [], capabilities: ['runs:read' as const] };
const access = (extra: Record<string, unknown> = {}) => ({ sub: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', token_use: 'access', client_id: client, username: 'ada', scope: 'openid agents/use', 'cognito:groups': ['agents'], ...extra });
const id = (extra: Record<string, unknown> = {}) => ({ sub: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', token_use: 'id', aud: client, 'cognito:username': 'ada', email: 'ada@acme.com', email_verified: true, ...extra });
const machine = (extra: Record<string, unknown> = {}) => ({ sub: client, token_use: 'access', client_id: client, scope: 'agents/use', ...extra });
async function setup(extra: Partial<Parameters<typeof cognitoAuthenticator>[0]> = {}) {
  const pool = await testIssuer({ issuer, algorithm: 'RS256', jwksPath: `/${poolId}/.well-known/jwks.json` });
  return { pool, authenticate: cognitoAuthenticator({ userPoolId: poolId, clientIds: [client], fetch: pool.fetch, identity: () => grant, ...extra }) };
}

describe('cognitoAuthenticator', () => {
  it('refuses configuration that would check tokens against nothing', () => {
    const base = { userPoolId: poolId, clientIds: [client], identity: () => null };
    for (const userPoolId of ['', 'AbCdEf123', 'eu-west-1', 'eu-west-1_', 'EU-WEST-1_Ab', 'eu-west-1_Ab/c', 7]) expect(() => cognitoAuthenticator({ ...base, userPoolId: userPoolId as never }), String(userPoolId)).toThrow(/userPoolId/u);
    for (const clientIds of [[], [''], ['Not-An-Id'], client, [7]]) expect(() => cognitoAuthenticator({ ...base, clientIds: clientIds as never }), JSON.stringify(clientIds)).toThrow(/clientIds/u);
    expect(() => cognitoAuthenticator({ ...base, identity: 'x' as never })).toThrow(/identity/u);
    expect(() => cognitoAuthenticator({ ...base, tokenUse: 'refresh' as never })).toThrow(/tokenUse/u);
    expect(() => cognitoAuthenticator({ ...base, allowMachines: 'yes' as never })).toThrow(/allowMachines/u);
  });

  it('accepts access tokens from the pool for an app client, with keys from the pool\'s JWKS', async () => {
    let seen: unknown;
    const { pool, authenticate } = await setup({ identity: session => { seen = session; return { ...grant, principalId: principalId('cognito', session.subject), capabilities: mapCapabilities(session.groups, { agents: ['runs:submit'] }) }; } });
    expect(pool.jwksUrl).toBe(`${issuer}/.well-known/jwks.json`);
    expect(await authenticate({ token: await pool.sign(access()), signal })).toMatchObject({ capabilities: ['runs:submit'] });
    expect(seen).toMatchObject({ tokenUse: 'access', username: 'ada', clientId: client, machine: false, groups: ['agents'], scopes: ['openid', 'agents/use'], email: null, emailVerified: false });
  });

  it('refuses ID tokens unless asked for them, and then refuses access tokens', async () => {
    const { pool, authenticate } = await setup();
    expect(await authenticate({ token: await pool.sign(id()), signal })).toBeNull();
    let seen: unknown;
    const ids = cognitoAuthenticator({ userPoolId: poolId, clientIds: [client], tokenUse: 'id', fetch: pool.fetch, identity: session => { seen = session; return grant; } });
    expect(await ids({ token: await pool.sign(id()), signal })).not.toBeNull();
    expect(seen).toMatchObject({ tokenUse: 'id', username: 'ada', clientId: client, machine: false, email: 'ada@acme.com', emailVerified: true, scopes: [] });
    expect(await ids({ token: await pool.sign(id({ aud: 'otherclient' })), signal })).toBeNull();
    expect(await ids({ token: await pool.sign(access({ aud: client })), signal })).toBeNull();
  });

  it('refuses other clients, pools, keys and machines unless allowed', async () => {
    const { pool, authenticate } = await setup();
    expect(await authenticate({ token: await pool.sign(access({ client_id: 'otherclient' })), signal })).toBeNull();
    expect(await authenticate({ token: await pool.sign(access({ iss: 'https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_Other' })), signal })).toBeNull();
    expect(await authenticate({ token: await pool.sign(access({ token_use: undefined })), signal })).toBeNull();
    const other = await testIssuer({ issuer, algorithm: 'RS256', jwksPath: `/${poolId}/.well-known/jwks.json` });
    expect(await authenticate({ token: await other.sign(access()), signal })).toBeNull();
    expect(await authenticate({ token: await pool.sign(machine()), signal })).toBeNull();
    const machines = cognitoAuthenticator({ userPoolId: poolId, clientIds: [client], allowMachines: true, fetch: pool.fetch, identity: session => session.machine ? grant : null });
    expect(await machines({ token: await pool.sign(machine()), signal })).not.toBeNull();
  });

  it('reads sessions defensively', () => {
    const claims = { iss: issuer, exp: 1, ...access() };
    expect(cognitoSession({ ...claims, 'cognito:groups': ['a', 7], scope: 'a  b' })).toMatchObject({ groups: ['a'], scopes: ['a', 'b'] });
    expect(cognitoSession({ ...claims, scope: ['a'] })?.scopes).toEqual([]);
    expect(cognitoSession({ ...claims, sub: '' })).toBeUndefined();
    expect(cognitoSession({ ...claims, client_id: '' })).toBeUndefined();
    expect(cognitoSession({ ...claims, token_use: 'refresh', aud: client })).toBeUndefined();
    // An access token names its client in client_id, never aud; an ID token the other way round.
    expect(cognitoSession({ ...claims, client_id: undefined, aud: client })).toBeUndefined();
    expect(cognitoSession({ iss: issuer, exp: 1, ...id({ aud: undefined, client_id: client }) })).toBeUndefined();
    expect(cognitoSession({ iss: issuer, exp: 1, ...id({ email_verified: 'true', scope: 'a' }) })).toMatchObject({ emailVerified: false, scopes: [] });
    // A user whose name is the client id is still a user; an ID token is never a machine's.
    expect(cognitoSession({ ...claims, sub: client })?.machine).toBe(false);
    expect(cognitoSession({ iss: issuer, exp: 1, ...machine({ sub: 'someone' }) })?.machine).toBe(false);
    expect(cognitoSession({ iss: issuer, exp: 1, ...id({ sub: client, 'cognito:username': undefined }) })?.machine).toBe(false);
    expect(cognitoSession({ iss: issuer, exp: 1, ...access({ username: undefined, 'cognito:username': 'ada' }) })?.username).toBeNull();
  });
});
