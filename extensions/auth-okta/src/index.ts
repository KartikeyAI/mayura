import { MayuraError } from 'mayura';
import { jwtAuthenticator, jwtVerifier, remoteJwks, type Authenticator, type IdentityGrant, type JwtClaims } from 'mayura/auth';

/** A verified Okta access token from a custom authorization server. */
export interface OktaSession {
  /** `sub`: the user's login (often an email), or for a machine its client id; prefer `userId` to key on. */
  readonly subject: string;
  /** The user's Okta id (`uid`, `00u...`); null for a machine. */
  readonly userId: string | null;
  /** The client application the token was issued to (`cid`). */
  readonly clientId: string;
  /** Whether a machine holds it (client credentials: no user, its own client as subject). */
  readonly machine: boolean;
  /** The scopes granted (`scp`). */
  readonly scopes: readonly string[];
  /** The `groups` claim, when the authorization server is set up to add it. */
  readonly groups: readonly string[];
  /** The token's claims, as verified. */
  readonly claims: JwtClaims;
}

export interface OktaAuthenticatorOptions {
  /** Your Okta domain, such as `acme.okta.com`, or the custom domain your applications get tokens from. */
  readonly domain: string;
  /** The custom authorization server's id: `default` (the default), or one such as `aus1a2b3c4d5e6f7g8h9`. */
  readonly authorizationServer?: string;
  /** The authorization server's audience, which tokens must be issued for, such as `api://default`. */
  readonly audience: string | readonly string[];
  /** What a token's holder may do, or null to refuse; for example from `session.scopes` with `mapCapabilities`. */
  readonly identity: (session: OktaSession) => IdentityGrant | null | Promise<IdentityGrant | null>;
  /** The client applications (`cid`) whose tokens are accepted; any of the authorization server's by default. */
  readonly clientIds?: readonly string[];
  /** Accept machine (client credentials) tokens; refused by default. */
  readonly allowMachines?: boolean;
  /** Clock difference allowed; 5 s by default. */
  readonly clockSkewMs?: number;
  /** The longest an identity lasts before the token is checked again; 60 s by default. */
  readonly maxIdentityMs?: number;
  /** For tests and proxies: the fetch to use for the JWKS. */
  readonly fetch?: typeof fetch;
}

const text = (value: unknown) => typeof value === 'string' && value !== '' ? value : null;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** An Okta session from verified claims; undefined when they are not an Okta access token's (no subject or client). */
export function oktaSession(claims: JwtClaims): OktaSession | undefined {
  const clientId = text(claims['cid']); const userId = text(claims['uid']);
  if (typeof claims.sub !== 'string' || claims.sub === '' || clientId === null) return undefined;
  return Object.freeze({
    subject: claims.sub, userId, clientId,
    // Only user tokens carry uid; a client credentials token's subject is its own client.
    machine: userId === null && claims.sub === clientId,
    scopes: Object.freeze(strings(claims['scp'])), groups: Object.freeze(strings(claims['groups'])), claims,
  });
}

/**
 * A server `authenticate` for Okta access tokens from a custom authorization server (`https://<domain>/oauth2/<id>`),
 * for its audience, signed with RS256 by its published keys. Tokens from the org authorization server are for Okta's
 * own APIs and never accepted, nor are sender-constrained (DPoP) tokens, whose proof this does not check. Machine tokens
 * only with `allowMachines`. `identity` decides what the holder may do.
 */
export function oktaAuthenticator(options: OktaAuthenticatorOptions): Authenticator {
  if (!options || typeof options.identity !== 'function') throw new MayuraError('INVALID_CONFIG', 'oktaAuthenticator(): identity decides what a token\'s holder may do.');
  const domain = typeof options.domain === 'string' ? options.domain.trim().replace(/^https:\/\//u, '').replace(/\/$/u, '') : '';
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/iu.test(domain)) throw new MayuraError('INVALID_CONFIG', 'oktaAuthenticator(): domain is your Okta domain, such as acme.okta.com.');
  const server = options.authorizationServer ?? 'default';
  if (typeof server !== 'string' || !/^[A-Za-z0-9]{1,64}$/u.test(server)) {
    throw new MayuraError('INVALID_CONFIG', 'oktaAuthenticator(): authorizationServer is a custom authorization server\'s id, such as default; the org authorization server\'s tokens are for Okta\'s APIs.');
  }
  const audience = options.audience;
  if (!(typeof audience === 'string' && audience !== '') && !(Array.isArray(audience) && audience.length > 0 && audience.every(item => typeof item === 'string' && item !== ''))) {
    throw new MayuraError('INVALID_CONFIG', 'oktaAuthenticator(): audience is the authorization server\'s audience, such as api://default.');
  }
  const clientIds = options.clientIds;
  if (clientIds !== undefined && (!Array.isArray(clientIds) || clientIds.length === 0 || clientIds.some(id => typeof id !== 'string' || id === ''))) throw new MayuraError('INVALID_CONFIG', 'oktaAuthenticator(): clientIds are client application ids.');
  if (options.allowMachines !== undefined && typeof options.allowMachines !== 'boolean') throw new MayuraError('INVALID_CONFIG', 'oktaAuthenticator(): allowMachines must be a boolean.');
  const issuer = `https://${domain}/oauth2/${server}`;
  const verifier = jwtVerifier({
    issuer, audience, algorithms: ['RS256'], clockSkewMs: options.clockSkewMs ?? 5_000,
    keys: remoteJwks({ url: `${issuer}/v1/keys`, ...(options.fetch ? { fetch: options.fetch } : {}) }),
  });
  return jwtAuthenticator({
    verifier, ...(options.maxIdentityMs !== undefined ? { maxIdentityMs: options.maxIdentityMs } : {}),
    identity: claims => {
      // A DPoP-bound token is only its holder's with a proof of the key; as a bearer token it is refused.
      if (claims['cnf'] !== undefined) return null;
      const session = oktaSession(claims);
      if (!session || (session.machine && options.allowMachines !== true) || (clientIds && !clientIds.includes(session.clientId))) return null;
      return options.identity(session);
    },
  });
}
