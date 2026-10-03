import { MayuraError } from 'mayura';
import { jwtAuthenticator, jwtVerifier, remoteJwks, type Authenticator, type IdentityGrant, type JwtClaims } from 'mayura/auth';

/** A verified Google account, from an ID token's claims. */
export interface GoogleSession {
  /** The account's stable id (`sub`); use it, never the email, to know who someone is. */
  readonly userId: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  /** The Google Workspace domain of the account (`hd`), or null for a consumer account. */
  readonly hostedDomain: string | null;
  readonly name: string | null;
  readonly picture: string | null;
  /** The client the token was issued through (`azp`). */
  readonly authorizedParty: string | null;
  /** The token's claims, as verified. */
  readonly claims: JwtClaims;
}

export interface GoogleAuthenticatorOptions {
  /** Your OAuth client IDs, one of which a token's audience must be. */
  readonly clientIds: string | readonly string[];
  /** What a Google account may do, or null to refuse. */
  readonly identity: (session: GoogleSession) => IdentityGrant | null | Promise<IdentityGrant | null>;
  /** Only accounts of this Google Workspace domain (`hd`), or `*` for any Workspace account. */
  readonly hostedDomain?: string;
  /** Clock difference allowed; 5 s by default. */
  readonly clockSkewMs?: number;
  /** The longest an identity lasts before the token is checked again; 60 s by default (ID tokens last an hour). */
  readonly maxIdentityMs?: number;
  /** For tests and proxies: the fetch to use for Google's keys. */
  readonly fetch?: typeof fetch;
}

/** Google's keys for its ID tokens. */
export const googleJwksUrl = 'https://www.googleapis.com/oauth2/v3/certs';
const clientIdPattern = /^[A-Za-z0-9._-]{1,256}\.apps\.googleusercontent\.com$/u;
const domainPattern = /^(?:\*|[a-z0-9-]+(?:\.[a-z0-9-]+)+)$/iu;
const text = (value: unknown) => typeof value === 'string' && value !== '' ? value : null;

function clientIdList(value: unknown, owner: string): string[] {
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || list.length === 0 || list.some(item => typeof item !== 'string' || !clientIdPattern.test(item))) {
    throw new MayuraError('INVALID_CONFIG', `${owner}: client IDs end in .apps.googleusercontent.com.`);
  }
  return [...list];
}
function checkDomain(value: unknown, owner: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !domainPattern.test(value)) throw new MayuraError('INVALID_CONFIG', `${owner}: hostedDomain is a Workspace domain such as acme.com, or * for any.`);
  return value.toLowerCase();
}

/** A Google session from verified claims; undefined without an account id. */
export function googleSession(claims: JwtClaims): GoogleSession | undefined {
  if (typeof claims.sub !== 'string' || claims.sub === '') return undefined;
  return Object.freeze({
    userId: claims.sub, email: text(claims['email']), emailVerified: claims['email_verified'] === true, hostedDomain: text(claims['hd']),
    name: text(claims['name']), picture: text(claims['picture']), authorizedParty: text(claims['azp']), claims,
  });
}

/**
 * A server `authenticate` for Google ID tokens sent straight to Mayura, checked as Google advises: RS256 with Google's
 * keys, issued by `accounts.google.com` (either spelling Google uses) for one of your client IDs, and with
 * `hostedDomain` only from that Workspace domain. `identity` decides what the account may do.
 */
export function googleAuthenticator(options: GoogleAuthenticatorOptions): Authenticator {
  if (!options || typeof options.identity !== 'function') throw new MayuraError('INVALID_CONFIG', 'googleAuthenticator(): identity decides what a Google account may do.');
  const clientIds = clientIdList(options.clientIds, 'googleAuthenticator()');
  const hostedDomain = checkDomain(options.hostedDomain, 'googleAuthenticator()');
  const verifier = jwtVerifier({
    issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: clientIds, algorithms: ['RS256'], clockSkewMs: options.clockSkewMs ?? 5_000,
    keys: remoteJwks({ url: googleJwksUrl, ...(options.fetch ? { fetch: options.fetch } : {}) }),
  });
  return jwtAuthenticator({
    verifier, ...(options.maxIdentityMs !== undefined ? { maxIdentityMs: options.maxIdentityMs } : {}),
    identity: claims => {
      const session = googleSession(claims);
      if (!session) return null;
      if (hostedDomain !== undefined && (session.hostedDomain === null || (hostedDomain !== '*' && session.hostedDomain.toLowerCase() !== hostedDomain))) return null;
      return options.identity(session);
    },
  });
}

/** Google sign-in for better-auth's `socialProviders.google`, as `googleSignIn` makes it. */
export interface GoogleSignInOptions {
  readonly clientId: string | string[];
  readonly clientSecret: string;
  readonly accessType: 'online' | 'offline';
  readonly includeGrantedScopes: boolean;
  readonly scope?: string[];
  readonly hd?: string;
}

/**
 * Google sign-in for better-auth (`socialProviders: { google: googleSignIn({ clientId, clientSecret }) }`), asking no
 * more than signing in needs: online access (no refresh token) unless `offline`, only the scopes asked for this time,
 * and with `hostedDomain` only that Workspace domain's accounts (better-auth checks it against the returned token).
 */
export function googleSignIn(options: { readonly clientId: string | readonly string[]; readonly clientSecret: string; readonly hostedDomain?: string; readonly offline?: boolean; readonly scopes?: readonly string[] }): GoogleSignInOptions {
  const clientIds = clientIdList(options?.clientId, 'googleSignIn()');
  if (typeof options.clientSecret !== 'string' || options.clientSecret === '') throw new MayuraError('INVALID_CONFIG', 'googleSignIn(): clientSecret is your OAuth client\'s secret.');
  const hostedDomain = checkDomain(options.hostedDomain, 'googleSignIn()');
  if (options.offline !== undefined && typeof options.offline !== 'boolean') throw new MayuraError('INVALID_CONFIG', 'googleSignIn(): offline must be a boolean.');
  if (options.scopes !== undefined && (!Array.isArray(options.scopes) || options.scopes.some(scope => typeof scope !== 'string' || scope === '' || /\s/u.test(scope)))) {
    throw new MayuraError('INVALID_CONFIG', 'googleSignIn(): scopes are extra OAuth scopes, such as https://www.googleapis.com/auth/calendar.readonly.');
  }
  return Object.freeze({
    clientId: clientIds.length === 1 ? clientIds[0]! : clientIds, clientSecret: options.clientSecret,
    accessType: options.offline === true ? 'offline' as const : 'online' as const, includeGrantedScopes: false,
    ...(options.scopes?.length ? { scope: [...options.scopes] } : {}), ...(hostedDomain !== undefined ? { hd: hostedDomain } : {}),
  });
}
