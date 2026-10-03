import { MayuraError } from 'mayura';
import { jwtAuthenticator, jwtVerifier, remoteJwks, type Authenticator, type IdentityGrant, type JwtClaims } from 'mayura/auth';

/** A verified Amazon Cognito user pool token: an access token, or with `tokenUse: 'id'` an ID token. */
export interface CognitoSession {
  readonly tokenUse: 'access' | 'id';
  /** The user's id in the pool (`sub`), the stable key; or for a machine its app client id. */
  readonly subject: string;
  /** The user name (`username`, or `cognito:username` in ID tokens); null for a machine. */
  readonly username: string | null;
  /** The app client the token was issued to (`client_id`, or `aud` in ID tokens). */
  readonly clientId: string;
  /** Whether a machine holds it (client credentials: no user, its own client as subject). */
  readonly machine: boolean;
  /** The user pool groups the user is in (`cognito:groups`). */
  readonly groups: readonly string[];
  /** The scopes granted (`scope`, access tokens only). */
  readonly scopes: readonly string[];
  /** The email and whether it is verified (ID tokens only). */
  readonly email: string | null;
  readonly emailVerified: boolean;
  /** The token's claims, as verified. */
  readonly claims: JwtClaims;
}

export interface CognitoAuthenticatorOptions {
  /** The user pool's id, such as `us-east-1_AbCdEf123`; its region is read from it. */
  readonly userPoolId: string;
  /** The app clients whose tokens are accepted. */
  readonly clientIds: readonly string[];
  /** What a token's holder may do, or null to refuse; for example from `session.groups` with `mapCapabilities`. */
  readonly identity: (session: CognitoSession) => IdentityGrant | null | Promise<IdentityGrant | null>;
  /** Which tokens are accepted: `access` (the default, as APIs should), or `id`; never both. */
  readonly tokenUse?: 'access' | 'id';
  /** Accept machine (client credentials) access tokens; refused by default. */
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

/** A Cognito session from verified claims; undefined when they are not a Cognito access or ID token's. */
export function cognitoSession(claims: JwtClaims): CognitoSession | undefined {
  const tokenUse = claims['token_use'];
  if (tokenUse !== 'access' && tokenUse !== 'id') return undefined;
  const clientId = tokenUse === 'access' ? text(claims['client_id']) : text(claims.aud);
  if (clientId === null || typeof claims.sub !== 'string' || claims.sub === '') return undefined;
  const username = text(claims[tokenUse === 'access' ? 'username' : 'cognito:username']);
  return Object.freeze({
    tokenUse, subject: claims.sub, username, clientId,
    // A client credentials token names no user, and its subject is its own client.
    machine: tokenUse === 'access' && username === null && claims.sub === clientId,
    groups: Object.freeze(strings(claims['cognito:groups'])),
    scopes: Object.freeze(tokenUse === 'access' && typeof claims['scope'] === 'string' ? claims['scope'].split(' ').filter(Boolean) : []),
    email: text(claims['email']), emailVerified: claims['email_verified'] === true, claims,
  });
}

/**
 * A server `authenticate` for Amazon Cognito user pool tokens: RS256 with the pool's published keys, issued by the pool
 * (`https://cognito-idp.<region>.amazonaws.com/<pool>`) to one of your app clients. Access tokens by default, ID tokens
 * only with `tokenUse: 'id'`, never one for the other. Machine tokens only with `allowMachines`. Cognito can revoke
 * tokens that stay valid until they expire; keep them short-lived. `identity` decides what the holder may do.
 */
export function cognitoAuthenticator(options: CognitoAuthenticatorOptions): Authenticator {
  if (!options || typeof options.identity !== 'function') throw new MayuraError('INVALID_CONFIG', 'cognitoAuthenticator(): identity decides what a token\'s holder may do.');
  const pool = typeof options.userPoolId === 'string' ? /^([a-z]{2}(?:-[a-z]+)+-\d{1,2})_[0-9A-Za-z]{1,64}$/u.exec(options.userPoolId) : null;
  if (!pool) throw new MayuraError('INVALID_CONFIG', 'cognitoAuthenticator(): userPoolId is the user pool\'s id, such as us-east-1_AbCdEf123.');
  const clientIds = options.clientIds;
  if (!Array.isArray(clientIds) || clientIds.length === 0 || clientIds.some(id => typeof id !== 'string' || !/^[0-9a-z]{1,128}$/u.test(id))) throw new MayuraError('INVALID_CONFIG', 'cognitoAuthenticator(): clientIds are the user pool\'s app client ids.');
  const tokenUse = options.tokenUse ?? 'access';
  if (tokenUse !== 'access' && tokenUse !== 'id') throw new MayuraError('INVALID_CONFIG', 'cognitoAuthenticator(): tokenUse is access or id.');
  if (options.allowMachines !== undefined && typeof options.allowMachines !== 'boolean') throw new MayuraError('INVALID_CONFIG', 'cognitoAuthenticator(): allowMachines must be a boolean.');
  const issuer = `https://cognito-idp.${pool[1]}.amazonaws.com/${options.userPoolId}`;
  const verifier = jwtVerifier({
    // Access tokens carry no audience: the client (client_id, or an ID token's aud) is checked against clientIds below.
    issuer, audience: false, algorithms: ['RS256'], clockSkewMs: options.clockSkewMs ?? 5_000,
    keys: remoteJwks({ url: `${issuer}/.well-known/jwks.json`, ...(options.fetch ? { fetch: options.fetch } : {}) }),
  });
  return jwtAuthenticator({
    verifier, ...(options.maxIdentityMs !== undefined ? { maxIdentityMs: options.maxIdentityMs } : {}),
    identity: claims => {
      const session = cognitoSession(claims);
      if (!session || session.tokenUse !== tokenUse || !clientIds.includes(session.clientId) || (session.machine && options.allowMachines !== true)) return null;
      return options.identity(session);
    },
  });
}
