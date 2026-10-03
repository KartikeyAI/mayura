import { MayuraError } from 'mayura';
import {
  jwtVerifier, peekIssuer, remoteJwks, serverIdentity,
  type Authenticator, type IdentityGrant, type JwtClaims, type JwtKeyFilter, type JwtKeySource, type JwtVerifier,
} from 'mayura/auth';

/** A verified Entra ID access token for your API. */
export interface EntraSession {
  /** The user or service principal: its object id (`oid`), the same across your applications. */
  readonly objectId: string;
  /** The tenant the token was issued in (`tid`). */
  readonly tenantId: string;
  /** `sub`: pairwise, different for each application; prefer `objectId`. */
  readonly subject: string;
  /** Whether an application holds it on its own behalf (no delegated scopes), rather than a user. */
  readonly app: boolean;
  /** The client application the token was issued to (`azp` in v2.0 tokens, `appid` in v1.0). */
  readonly clientId: string | null;
  /** App roles: a user's assigned roles, or an application's granted permissions. */
  readonly roles: readonly string[];
  /** Delegated permissions granted to the client on the user's behalf (`scp`). */
  readonly scopes: readonly string[];
  readonly name: string | null;
  /** The user's sign-in name (`preferred_username` in v2.0, `upn` or `unique_name` in v1.0); never a stable key. */
  readonly username: string | null;
  readonly version: '1.0' | '2.0';
  /** The token's claims, as verified. */
  readonly claims: JwtClaims;
}

export interface EntraAuthenticatorOptions {
  /** The tenants (directory ids) accepted, or `any` for a multi-tenant application that accepts every tenant. */
  readonly tenants: readonly string[] | 'any';
  /** Your API's application (client) id, and its app ID URI if tokens name that instead. */
  readonly audience: string | readonly string[];
  /** What a token's holder may do, or null to refuse; for example from `session.roles` with `mapCapabilities`. */
  readonly identity: (session: EntraSession) => IdentityGrant | null | Promise<IdentityGrant | null>;
  /** Accept app-only tokens (client credentials, no user); refused by default. */
  readonly allowApps?: boolean;
  /** The access token versions accepted: `['2.0']` by default (your API's `accessTokenAcceptedVersion`). */
  readonly versions?: readonly ('1.0' | '2.0')[];
  /** Clock difference allowed; 5 s by default. */
  readonly clockSkewMs?: number;
  /** The longest an identity lasts before the token is checked again; 60 s by default. */
  readonly maxIdentityMs?: number;
  /** For tests and proxies: the fetch to use for Microsoft's keys. */
  readonly fetch?: typeof fetch;
}

const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** Microsoft Graph: tokens for it are Graph's to check, never an API's. */
const graph = new Set(['00000003-0000-0000-c000-000000000000', 'https://graph.microsoft.com', 'https://graph.microsoft.com/']);
const issuerV2 = (tenant: string) => `https://login.microsoftonline.com/${tenant}/v2.0`;
const issuerV1 = (tenant: string) => `https://sts.windows.net/${tenant}/`;
const text = (value: unknown) => typeof value === 'string' && value !== '' ? value : null;

/** The tenant an issuer names, for either token version; undefined for any other issuer. */
function tenantOf(issuer: string | undefined): { readonly tenant: string; readonly version: '1.0' | '2.0' } | undefined {
  const v2 = issuer && /^https:\/\/login\.microsoftonline\.com\/([0-9a-f-]{36})\/v2\.0$/u.exec(issuer);
  if (v2 && guid.test(v2[1]!)) return { tenant: v2[1]!, version: '2.0' };
  const v1 = issuer && /^https:\/\/sts\.windows\.net\/([0-9a-f-]{36})\/$/u.exec(issuer);
  if (v1 && guid.test(v1[1]!)) return { tenant: v1[1]!, version: '1.0' };
  return undefined;
}

/** An Entra session from verified claims; undefined without an object id and a tenant matching the issuer. */
export function entraSession(claims: JwtClaims): EntraSession | undefined {
  const issued = tenantOf(claims.iss);
  const oid = claims['oid']; const tid = claims['tid'];
  if (!issued || typeof oid !== 'string' || !guid.test(oid) || tid !== issued.tenant || typeof claims.sub !== 'string' || claims.sub === '') return undefined;
  const scopes = typeof claims['scp'] === 'string' ? claims['scp'].split(' ').filter(Boolean) : [];
  return Object.freeze({
    objectId: oid, tenantId: tid, subject: claims.sub,
    // Delegated tokens always carry scp; a token without it is an application's own.
    app: typeof claims['scp'] !== 'string',
    clientId: text(claims['azp']) ?? text(claims['appid']),
    roles: Object.freeze(Array.isArray(claims['roles']) ? claims['roles'].filter((role): role is string => typeof role === 'string') : []),
    scopes: Object.freeze(scopes), name: text(claims['name']),
    username: text(claims['preferred_username']) ?? text(claims['upn']) ?? text(claims['unique_name']), version: issued.version, claims,
  });
}

/**
 * A server `authenticate` for Microsoft Entra ID access tokens issued for your API: RS256 with Microsoft's keys (for
 * the token's version; keys bound to a tenant verify only that tenant's tokens), from a tenant you accept, the issuer
 * substituted for each tenant, never wildcarded. App-only tokens only with `allowApps`. `identity` decides what the
 * holder may do; never accept tokens meant for Microsoft Graph, which this refuses to be configured for.
 */
export function entraAuthenticator(options: EntraAuthenticatorOptions): Authenticator {
  if (!options || typeof options.identity !== 'function') throw new MayuraError('INVALID_CONFIG', 'entraAuthenticator(): identity decides what a token\'s holder may do.');
  const tenants = options.tenants;
  if (tenants !== 'any' && (!Array.isArray(tenants) || tenants.length === 0 || tenants.some(tenant => typeof tenant !== 'string' || !guid.test(tenant)))) {
    throw new MayuraError('INVALID_CONFIG', 'entraAuthenticator(): tenants are directory (tenant) ids, or any for a multi-tenant application.');
  }
  const audience = typeof options.audience === 'string' ? [options.audience] : options.audience;
  if (!Array.isArray(audience) || audience.length === 0 || audience.some(item => typeof item !== 'string' || item === '')) throw new MayuraError('INVALID_CONFIG', 'entraAuthenticator(): audience is your API\'s application id or app ID URI.');
  if (audience.some(item => graph.has(item.toLowerCase()))) throw new MayuraError('INVALID_CONFIG', 'entraAuthenticator(): tokens for Microsoft Graph are Graph\'s to check: give your own API\'s audience.');
  const versions = options.versions ?? ['2.0'];
  if (!Array.isArray(versions) || versions.length === 0 || versions.some(version => version !== '1.0' && version !== '2.0')) throw new MayuraError('INVALID_CONFIG', 'entraAuthenticator(): versions are 1.0 and/or 2.0.');
  if (options.allowApps !== undefined && typeof options.allowApps !== 'boolean') throw new MayuraError('INVALID_CONFIG', 'entraAuthenticator(): allowApps must be a boolean.');
  const maxIdentityMs = options.maxIdentityMs ?? 60_000;
  if (!Number.isSafeInteger(maxIdentityMs) || maxIdentityMs < 1_000 || maxIdentityMs > 3_600_000) throw new MayuraError('INVALID_CONFIG', 'entraAuthenticator(): maxIdentityMs is 1,000 to 3,600,000.');
  const fetchOption = options.fetch ? { fetch: options.fetch } : {};
  // A key that names its issuer (a template with {tenantid}, or one tenant) verifies only tokens from that issuer.
  const keyFilter: JwtKeyFilter = (key, claims) => typeof key['issuer'] !== 'string' || key['issuer'].replace('{tenantid}', String(claims['tid'])) === claims['iss'];
  const v2Keys = remoteJwks({ url: 'https://login.microsoftonline.com/common/discovery/v2.0/keys', keyFilter, ...fetchOption });
  const v1Keys = remoteJwks({ url: 'https://login.microsoftonline.com/common/discovery/keys', keyFilter, ...fetchOption });
  // v1.0 and v2.0 tokens are signed with different key sets.
  const keys: JwtKeySource = Object.freeze({
    key: (header: Parameters<JwtKeySource['key']>[0], keyOptions: Parameters<JwtKeySource['key']>[1]) => (typeof keyOptions.claims?.['iss'] === 'string' && keyOptions.claims['iss'].startsWith('https://sts.windows.net/') ? v1Keys : v2Keys).key(header, keyOptions),
  });
  // Either version's issuer for the tenant: tenantFor has already refused versions not accepted.
  const verifierFor = (tenant: string): JwtVerifier => jwtVerifier({
    issuer: [issuerV2(tenant), issuerV1(tenant)], audience, algorithms: ['RS256'], clockSkewMs: options.clockSkewMs ?? 5_000, keys,
  });
  const verifiers = new Map<string, JwtVerifier>();
  if (tenants !== 'any') for (const tenant of tenants) verifiers.set(tenant, verifierFor(tenant));
  const tenantFor = (token: string) => {
    const issued = tenantOf(peekIssuer(token));
    return issued && versions.includes(issued.version) && (tenants === 'any' || verifiers.has(issued.tenant)) ? issued.tenant : undefined;
  };
  const accepts = (token: string) => tenantFor(token) !== undefined;
  const authenticate = async ({ token, signal }: { readonly token: string; readonly signal: AbortSignal }) => {
    const tenant = tenantFor(token);
    if (tenant === undefined) return null;
    // Any tenant: a verifier made for this token's tenant, its issuer substituted; nothing is kept for a tenant unseen.
    const result = await (verifiers.get(tenant) ?? verifierFor(tenant)).verify(token, { signal });
    if (!result.ok) return null;
    const session = entraSession(result.claims);
    if (!session || (session.app && options.allowApps !== true)) return null;
    return serverIdentity(await options.identity(session), { credentialExpiresAtMs: result.claims.exp * 1_000, maxIdentityMs });
  };
  return Object.assign(authenticate, { accepts });
}
