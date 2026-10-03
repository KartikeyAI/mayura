import { MayuraError } from 'mayura';
import { hmacSecret, jwtAuthenticator, jwtVerifier, remoteJwks, type Authenticator, type IdentityGrant, type JwtClaims } from 'mayura/auth';

/** A verified Auth0 access token, either token profile (Auth0's, or RFC 9068). */
export interface Auth0Session {
  /** The user (`auth0|...`, `google-oauth2|...`), or for a machine `<client id>@clients`. */
  readonly subject: string;
  /** The application the token was issued to (`azp`, or `client_id` in the RFC 9068 profile). */
  readonly clientId: string | null;
  /** Whether a machine holds it (client credentials) rather than a user. */
  readonly machine: boolean;
  /** The scopes granted (`scope`). */
  readonly scopes: readonly string[];
  /** The API's permissions granted (`permissions`, with RBAC on). */
  readonly permissions: readonly string[];
  /** The organization the user signed in through (`org_id`, `org_name`), when there is one. */
  readonly orgId: string | null;
  readonly orgName: string | null;
  /** The token's claims, as verified. */
  readonly claims: JwtClaims;
}

export interface Auth0AuthenticatorOptions {
  /** Your tenant's domain, such as `acme.us.auth0.com`, or the custom domain your applications get tokens from. */
  readonly domain: string;
  /** Your API's identifier (its audience), which tokens must be issued for. */
  readonly audience: string | readonly string[];
  /** What a token's holder may do, or null to refuse; for example from `session.permissions` with `mapCapabilities`. */
  readonly identity: (session: Auth0Session) => IdentityGrant | null | Promise<IdentityGrant | null>;
  /** Your API's signing secret, only if it signs with HS256; RS256 with the tenant's keys otherwise. */
  readonly signingSecret?: string;
  /** Clock difference allowed; 5 s by default. */
  readonly clockSkewMs?: number;
  /** The longest an identity lasts before the token is checked again; 60 s by default. */
  readonly maxIdentityMs?: number;
  /** For tests and proxies: the fetch to use for the JWKS. */
  readonly fetch?: typeof fetch;
}

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** An Auth0 session from verified claims, either token profile; undefined when the claims are not an Auth0 access token's. */
export function auth0Session(claims: JwtClaims): Auth0Session | undefined {
  if (typeof claims.sub !== 'string' || claims.sub === '') return undefined;
  const text = (value: unknown) => typeof value === 'string' && value !== '' ? value : null;
  const orgId = text(claims['org_id']);
  return Object.freeze({
    subject: claims.sub, clientId: text(claims['azp']) ?? text(claims['client_id']),
    // Auth0's profile names the grant (gty); in either profile a machine's subject is <client id>@clients.
    machine: claims['gty'] === 'client-credentials' || claims.sub.endsWith('@clients'),
    scopes: Object.freeze(typeof claims['scope'] === 'string' ? claims['scope'].split(' ').filter(Boolean) : []),
    permissions: Object.freeze(strings(claims['permissions'])),
    orgId, orgName: orgId ? text(claims['org_name']) : null, claims,
  });
}

/**
 * A server `authenticate` for Auth0 access tokens: issued by your tenant (`https://<domain>/`) for your API (its
 * audience), signed with RS256 by the tenant's published keys (or HS256 with your API's secret, when it signs that
 * way). `identity` decides what the holder may do; Auth0 asks APIs to check `org_id` when organizations are used.
 */
export function auth0Authenticator(options: Auth0AuthenticatorOptions): Authenticator {
  if (!options || typeof options.identity !== 'function') throw new MayuraError('INVALID_CONFIG', 'auth0Authenticator(): identity decides what a token\'s holder may do.');
  const domain = typeof options.domain === 'string' ? options.domain.trim().replace(/^https:\/\//u, '').replace(/\/$/u, '') : '';
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/iu.test(domain)) throw new MayuraError('INVALID_CONFIG', 'auth0Authenticator(): domain is your tenant\'s domain, such as acme.us.auth0.com.');
  const audience = options.audience;
  if (!(typeof audience === 'string' && audience !== '') && !(Array.isArray(audience) && audience.length > 0 && audience.every(item => typeof item === 'string' && item !== ''))) {
    throw new MayuraError('INVALID_CONFIG', 'auth0Authenticator(): audience is your API\'s identifier.');
  }
  if (options.signingSecret !== undefined && typeof options.signingSecret !== 'string') throw new MayuraError('INVALID_CONFIG', 'auth0Authenticator(): signingSecret is your API\'s signing secret.');
  const issuer = `https://${domain}/`;
  const verifier = jwtVerifier({
    issuer, audience, clockSkewMs: options.clockSkewMs ?? 5_000,
    ...(options.signingSecret !== undefined
      ? { algorithms: ['HS256'] as const, keys: hmacSecret(options.signingSecret) }
      : { algorithms: ['RS256'] as const, keys: remoteJwks({ url: `${issuer}.well-known/jwks.json`, ...(options.fetch ? { fetch: options.fetch } : {}) }) }),
  });
  return jwtAuthenticator({
    verifier, ...(options.maxIdentityMs !== undefined ? { maxIdentityMs: options.maxIdentityMs } : {}),
    identity: claims => {
      const session = auth0Session(claims);
      return session ? options.identity(session) : null;
    },
  });
}
