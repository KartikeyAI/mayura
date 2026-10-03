import { MayuraError } from '@mayura/core';
import type { ServerIdentity } from '@mayura/server';
import { checkMaxIdentityMs, identityFrom, type Authenticator, type IdentityGrant } from './identity.js';
import { jwtVerifier, type JwtVerifier } from './jwt.js';
import { remoteJwks } from './keys.js';
import type { JwtAlgorithm } from './keys.js';

/** A signed-in user's session, as better-auth's `getSession` returns it. */
export interface BetterAuthSession {
  readonly user: { readonly id: string; readonly email?: string | null; readonly emailVerified?: boolean; readonly name?: string | null; readonly [field: string]: unknown };
  readonly session: { readonly id: string; readonly userId: string; readonly expiresAt: Date | string; readonly activeOrganizationId?: string | null; readonly [field: string]: unknown };
}

/** An API key, as better-auth's apiKey plugin verifies it. */
export interface BetterAuthApiKey {
  readonly id: string;
  /** Who the key belongs to: a user, or an organization when the key is an organization's. */
  readonly referenceId: string;
  readonly name?: string | null;
  readonly enabled?: boolean;
  readonly expiresAt?: Date | string | null;
  /** Permissions as better-auth keeps them: `{ runs: ['read', 'submit'] }`. */
  readonly permissions?: Readonly<Record<string, readonly string[]>> | null;
  readonly metadata?: unknown;
  readonly [field: string]: unknown;
}

/**
 * The parts of a better-auth instance (`betterAuth(...)`, 1.7) Mayura uses. Nothing is imported from better-auth:
 * your own instance, with your database and plugins, is what runs. What it returns is checked when it arrives.
 */
export interface BetterAuthInstance {
  handler(request: Request): Promise<Response>;
  readonly api: {
    getSession(input: { headers: Headers }): Promise<unknown>;
    verifyApiKey?(input: { body: { key: string } }): Promise<unknown>;
  };
}

const time = (value: Date | string | null | undefined): number | undefined => {
  if (value === null || value === undefined) return undefined;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
};
/** A better-auth bearer token: the session token, signed (`<token>.<signature>`) or not. */
const sessionToken = /^[A-Za-z0-9]{32}(?:\.[A-Za-z0-9+/_=%-]{20,128})?$/u;

export interface BetterAuthAuthenticatorOptions {
  /**
   * What a signed-in user may do, or null to refuse. Grant only what your application decides; for example from the
   * user's role in `session.activeOrganizationId` (organization plugin).
   */
  readonly identity: (session: BetterAuthSession) => IdentityGrant | null | Promise<IdentityGrant | null>;
  /** The longest an identity lasts before the session is checked again; 60 s by default (1 s to 1 hour). */
  readonly maxIdentityMs?: number;
  /** Which tokens are better-auth session tokens; its bearer tokens (`<32 characters>[.<signature>]`) by default. */
  readonly accepts?: (token: string) => boolean;
}

/**
 * A server `authenticate` for better-auth sessions, presented as bearer tokens (better-auth's `bearer` plugin): each
 * request's session is read from better-auth, so a session signed out or revoked stops working at once, and the
 * identity lasts no longer than the session. `identity` decides what the user may do.
 */
export function betterAuthAuthenticator(auth: BetterAuthInstance, options: BetterAuthAuthenticatorOptions): Authenticator {
  if (!auth || typeof auth.api?.getSession !== 'function') throw new MayuraError('INVALID_CONFIG', 'betterAuthAuthenticator(): auth is your betterAuth(...) instance.');
  if (typeof options?.identity !== 'function') throw new MayuraError('INVALID_CONFIG', 'betterAuthAuthenticator(): identity decides what a signed-in user may do.');
  if (options.accepts !== undefined && typeof options.accepts !== 'function') throw new MayuraError('INVALID_CONFIG', 'betterAuthAuthenticator(): accepts is a function.');
  const maxIdentityMs = checkMaxIdentityMs(options.maxIdentityMs, 'betterAuthAuthenticator()');
  const accepts = (token: string) => typeof token === 'string' && (options.accepts ? options.accepts(token) : sessionToken.test(token));
  const authenticate = async ({ token }: { readonly token: string; readonly signal: AbortSignal }): Promise<ServerIdentity | null> => {
    if (!accepts(token)) return null;
    const found = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) }) as BetterAuthSession | null;
    // A session better-auth returns in a shape Mayura does not know is not trusted.
    if (!found || typeof found !== 'object' || typeof found.user?.id !== 'string' || typeof found.session?.id !== 'string') return null;
    const expiresAtMs = time(found.session.expiresAt);
    // An expiry already past is refused by the identity itself.
    if (expiresAtMs === undefined) return null;
    return identityFrom(await options.identity(found), expiresAtMs, maxIdentityMs);
  };
  return Object.assign(authenticate, { accepts });
}

/** better-auth's key permissions as `resource:action` strings, such as `runs:read`, for `mapCapabilities`. */
export function betterAuthPermissions(permissions: Readonly<Record<string, readonly string[]>> | null | undefined): string[] {
  if (!permissions || typeof permissions !== 'object') return [];
  return Object.entries(permissions).flatMap(([resource, actions]) => Array.isArray(actions) ? actions.filter(action => typeof action === 'string').map(action => `${resource}:${action}`) : []);
}

export interface BetterAuthApiKeyAuthenticatorOptions {
  /** The prefix your apiKey plugin gives keys (`apiKey({ defaultPrefix })`), such as `acme_`: only such tokens are checked. */
  readonly prefix: string;
  /** What a key may do, or null to refuse; for example `mapCapabilities(betterAuthPermissions(key.permissions), table)`. */
  readonly identity: (key: BetterAuthApiKey) => IdentityGrant | null | Promise<IdentityGrant | null>;
  /** The longest an identity lasts before the key is checked again; 60 s by default (1 s to 1 hour). */
  readonly maxIdentityMs?: number;
}

/**
 * A server `authenticate` for keys from better-auth's apiKey plugin: each request's key is verified by better-auth
 * (which also applies the key's rate limit and remaining uses), and `identity` decides what it may do. Mayura's own
 * keys (`mayura/keys`) do the same on any Mayura store, without better-auth.
 */
export function betterAuthApiKeyAuthenticator(auth: BetterAuthInstance, options: BetterAuthApiKeyAuthenticatorOptions): Authenticator {
  if (!auth || typeof auth.api?.verifyApiKey !== 'function') throw new MayuraError('INVALID_CONFIG', 'betterAuthApiKeyAuthenticator(): auth is a betterAuth(...) instance with the apiKey plugin.');
  if (typeof options?.prefix !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/u.test(options.prefix)) throw new MayuraError('INVALID_CONFIG', 'betterAuthApiKeyAuthenticator(): prefix is the prefix your apiKey plugin gives keys, such as acme_.');
  if (typeof options.identity !== 'function') throw new MayuraError('INVALID_CONFIG', 'betterAuthApiKeyAuthenticator(): identity decides what a key may do.');
  const maxIdentityMs = checkMaxIdentityMs(options.maxIdentityMs, 'betterAuthApiKeyAuthenticator()');
  const verify = auth.api.verifyApiKey!.bind(auth.api);
  const accepts = (token: string) => typeof token === 'string' && token.length <= 512 && token.startsWith(options.prefix);
  const authenticate = async ({ token }: { readonly token: string; readonly signal: AbortSignal }): Promise<ServerIdentity | null> => {
    if (!accepts(token)) return null;
    const result = await verify({ body: { key: token } }) as { valid?: unknown; key?: BetterAuthApiKey | null } | null;
    if (!result || result.valid !== true || !result.key || typeof result.key.referenceId !== 'string' || result.key.enabled === false) return null;
    const expiresAtMs = time(result.key.expiresAt) ?? Number.MAX_SAFE_INTEGER;
    return identityFrom(await options.identity(result.key), expiresAtMs, maxIdentityMs);
  };
  return Object.assign(authenticate, { accepts });
}

/**
 * A verifier for JWTs from better-auth's jwt plugin, checked against its JWKS with no call to better-auth per request
 * (and on any runtime): issuer and audience are your better-auth `baseURL`, signed with EdDSA unless you chose another
 * algorithm. Give it to `jwtAuthenticator`.
 */
export function betterAuthJwtVerifier(options: { readonly baseURL: string; readonly basePath?: string; readonly algorithms?: readonly JwtAlgorithm[]; readonly audience?: string | readonly string[]; readonly fetch?: typeof fetch }): JwtVerifier {
  let base: URL;
  try { base = new URL(options?.baseURL); } catch { throw new MayuraError('INVALID_CONFIG', 'betterAuthJwtVerifier(): baseURL is your better-auth baseURL.'); }
  const basePath = options.basePath ?? '/api/auth';
  if (typeof basePath !== 'string' || !/^\/[A-Za-z0-9._~/-]*$/u.test(basePath)) throw new MayuraError('INVALID_CONFIG', 'betterAuthJwtVerifier(): basePath is a path such as /api/auth.');
  const issuer = base.href.replace(/\/$/u, '');
  return jwtVerifier({
    issuer, audience: options.audience ?? issuer, algorithms: options.algorithms ?? ['EdDSA'],
    keys: remoteJwks({ url: `${issuer}${basePath.replace(/\/$/u, '')}/jwks`, ...(options.fetch ? { fetch: options.fetch } : {}) }),
  });
}

/**
 * One fetch handler for better-auth and Mayura's server together: requests under `basePath` (`/api/auth` by default,
 * as better-auth's own) go to better-auth (sign-in, sign-up, sessions, JWKS), everything else to Mayura's server.
 */
export function withBetterAuth(auth: Pick<BetterAuthInstance, 'handler'>, next: (request: Request) => Response | Promise<Response>, options: { readonly basePath?: string } = {}): (request: Request) => Promise<Response> {
  if (!auth || typeof auth.handler !== 'function') throw new MayuraError('INVALID_CONFIG', 'withBetterAuth(): auth is your betterAuth(...) instance.');
  if (typeof next !== 'function') throw new MayuraError('INVALID_CONFIG', 'withBetterAuth(): next is the handler for everything else, such as server.fetch.');
  const basePath = (options.basePath ?? '/api/auth').replace(/\/$/u, '');
  if (!/^\/[A-Za-z0-9._~/-]+$/u.test(basePath)) throw new MayuraError('INVALID_CONFIG', 'withBetterAuth(): basePath is a path such as /api/auth.');
  return async (request: Request) => {
    const { pathname } = new URL(request.url);
    return pathname === basePath || pathname.startsWith(`${basePath}/`) ? auth.handler(request) : next(request);
  };
}
