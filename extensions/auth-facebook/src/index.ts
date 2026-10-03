import { MayuraError } from 'mayura';
import { sha256Hex } from 'mayura/core/host';
import {
  jwtVerifier, peekIssuer, remoteJwks, serverIdentity,
  type Authenticator, type IdentityGrant,
} from 'mayura/auth';

/** A verified Facebook user: from a Login access token (checked with Facebook) or a Limited Login token. */
export interface FacebookSession {
  /** `access_token` for a Facebook Login user access token; `limited_login` for an iOS Limited Login token. */
  readonly kind: 'access_token' | 'limited_login';
  /** The app-scoped user id: the same user has a different id in each of your apps. */
  readonly userId: string;
  /** The permissions the user granted your app (access tokens). */
  readonly scopes: readonly string[];
  readonly email: string | null;
  readonly name: string | null;
  /** When the token expires, in milliseconds since the epoch; null where Facebook gives none. */
  readonly expiresAtMs: number | null;
}

export interface FacebookAuthenticatorOptions {
  /** Your Facebook app's ID. */
  readonly appId: string;
  /** Your app's secret, to ask Facebook about access tokens; it stays on your server. */
  readonly appSecret: string;
  /** What a Facebook user may do, or null to refuse. */
  readonly identity: (session: FacebookSession) => IdentityGrant | null | Promise<IdentityGrant | null>;
  /** Permissions the user must have granted your app, such as `email`. */
  readonly requiredScopes?: readonly string[];
  /** Also accept iOS Limited Login tokens (OIDC JWTs, checked with Facebook's keys, with no call per request). */
  readonly limitedLogin?: boolean;
  /**
   * Keep what Facebook said about an access token for this long; 0 by default, so each request asks Facebook and a
   * token the user revoked stops at once. At most 5 minutes.
   */
  readonly cacheTtlMs?: number;
  /** The longest wait for Facebook; 5 s by default (1 s to 30 s). */
  readonly timeoutMs?: number;
  /** The Graph API version; `v26.0` by default. */
  readonly graphVersion?: string;
  /** Clock difference allowed for Limited Login tokens; 5 s by default. */
  readonly clockSkewMs?: number;
  /** The longest an identity lasts before the token is checked again; 60 s by default. */
  readonly maxIdentityMs?: number;
  /** For tests and proxies: the fetch to use. */
  readonly fetch?: typeof fetch;
}

/** Facebook Login user access tokens: opaque, starting `EA`. */
const accessToken = /^EA[A-Za-z0-9]{20,1024}$/u;
const limitedIssuer = 'https://www.facebook.com';
const text = (value: unknown) => typeof value === 'string' && value !== '' ? value : null;

function bounded(value: number | undefined, name: string, fallback: number, min: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new MayuraError('INVALID_CONFIG', `facebookAuthenticator(): ${name} is ${min.toLocaleString('en-US')} to ${max.toLocaleString('en-US')}.`);
  return result;
}

/**
 * A server `authenticate` for Facebook users. Login access tokens are opaque, so each is checked with Facebook's
 * `debug_token` (a call per request unless `cacheTtlMs`): it must be valid, a user's, for your app, and hold the
 * permissions you require. With `limitedLogin`, iOS Limited Login tokens are checked as JWTs: RS256 with Facebook's
 * keys, from `https://www.facebook.com`, for your app. `identity` decides what the user may do.
 */
export function facebookAuthenticator(options: FacebookAuthenticatorOptions): Authenticator {
  if (!options || typeof options.identity !== 'function') throw new MayuraError('INVALID_CONFIG', 'facebookAuthenticator(): identity decides what a Facebook user may do.');
  if (typeof options.appId !== 'string' || !/^\d{5,20}$/u.test(options.appId)) throw new MayuraError('INVALID_CONFIG', 'facebookAuthenticator(): appId is your Facebook app\'s ID.');
  if (typeof options.appSecret !== 'string' || !/^[A-Za-z0-9]{16,128}$/u.test(options.appSecret)) throw new MayuraError('INVALID_CONFIG', 'facebookAuthenticator(): appSecret is your app\'s secret.');
  const required = options.requiredScopes ?? [];
  if (!Array.isArray(required) || required.some(scope => typeof scope !== 'string' || !/^[a-z_]{1,64}$/u.test(scope))) throw new MayuraError('INVALID_CONFIG', 'facebookAuthenticator(): requiredScopes are permissions such as email or public_profile.');
  if (options.limitedLogin !== undefined && typeof options.limitedLogin !== 'boolean') throw new MayuraError('INVALID_CONFIG', 'facebookAuthenticator(): limitedLogin must be a boolean.');
  const cacheTtlMs = bounded(options.cacheTtlMs, 'cacheTtlMs', 0, 0, 300_000);
  const timeoutMs = bounded(options.timeoutMs, 'timeoutMs', 5_000, 1_000, 30_000);
  const maxIdentityMs = bounded(options.maxIdentityMs, 'maxIdentityMs', 60_000, 1_000, 3_600_000);
  const version = options.graphVersion ?? 'v26.0';
  if (typeof version !== 'string' || !/^v\d{1,3}\.\d{1,2}$/u.test(version)) throw new MayuraError('INVALID_CONFIG', 'facebookAuthenticator(): graphVersion is a Graph API version such as v26.0.');
  const fetcher = options.fetch ?? globalThis.fetch;
  const appToken = `${options.appId}|${options.appSecret}`;
  const cache = new Map<string, { readonly session: FacebookSession | null; readonly until: number }>();
  const limited = options.limitedLogin === true ? jwtVerifier({
    issuer: limitedIssuer, audience: options.appId, algorithms: ['RS256'], clockSkewMs: options.clockSkewMs ?? 5_000,
    keys: remoteJwks({ url: 'https://www.facebook.com/.well-known/oauth/openid/jwks/', ...(options.fetch ? { fetch: options.fetch } : {}) }),
  }) : undefined;

  /** What Facebook says about an access token; null when it is not a valid user token for this app. */
  const inspect = async (token: string, signal: AbortSignal): Promise<FacebookSession | null> => {
    const url = `https://graph.facebook.com/${version}/debug_token?${new URLSearchParams({ input_token: token, access_token: appToken })}`;
    let response: Response;
    try { response = await fetcher(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]), headers: { accept: 'application/json' }, redirect: 'error' }); }
    // The URL holds the app secret: no error may carry it.
    catch { throw signal.aborted ? new MayuraError('CANCELLED', 'Authentication was cancelled.') : new MayuraError('TOOL_FAILED', 'Facebook could not be reached to check the token.'); }
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new MayuraError('TOOL_FAILED', `Facebook answered HTTP ${response.status} when checking the token.`); }
    const body = await response.json().catch(() => undefined) as { data?: Record<string, unknown> } | undefined;
    const data = body?.data;
    if (!data || typeof data !== 'object') throw new MayuraError('TOOL_FAILED', 'Facebook\'s answer about the token is not one Mayura knows.');
    if (data['is_valid'] !== true || data['app_id'] !== options.appId || data['type'] !== 'USER' || typeof data['user_id'] !== 'string' || data['user_id'] === '') return null;
    const scopes = Array.isArray(data['scopes']) ? data['scopes'].filter((scope): scope is string => typeof scope === 'string') : [];
    if (required.some(scope => !scopes.includes(scope))) return null;
    const expires = data['expires_at'];
    // 0 is Facebook's "does not expire".
    const expiresAtMs = typeof expires === 'number' && expires > 0 ? expires * 1_000 : null;
    return Object.freeze({ kind: 'access_token' as const, userId: data['user_id'], scopes: Object.freeze(scopes), email: null, name: null, expiresAtMs });
  };

  const accepts = (token: string) => typeof token === 'string' && (accessToken.test(token) || (limited !== undefined && peekIssuer(token) === limitedIssuer));
  const authenticate = async ({ token, signal }: { readonly token: string; readonly signal: AbortSignal }) => {
    if (typeof token !== 'string') return null;
    let session: FacebookSession | null = null;
    if (accessToken.test(token)) {
      const key = sha256Hex(token); const cached = cache.get(key);
      if (cached && cached.until > Date.now()) session = cached.session;
      else {
        session = await inspect(token, signal);
        // Without cacheTtlMs an answer is out of date the moment it is kept.
        if (cache.size >= 10_000) cache.delete(cache.keys().next().value!);
        cache.set(key, { session, until: Date.now() + cacheTtlMs });
      }
    } else if (limited !== undefined && peekIssuer(token) === limitedIssuer) {
      const result = await limited.verify(token, { signal });
      if (result.ok && typeof result.claims.sub === 'string' && result.claims.sub !== '') {
        session = Object.freeze({ kind: 'limited_login' as const, userId: result.claims.sub, scopes: Object.freeze([]), email: text(result.claims['email']), name: text(result.claims['name']), expiresAtMs: result.claims.exp * 1_000 });
      }
    }
    if (!session) return null;
    return serverIdentity(await options.identity(session), { credentialExpiresAtMs: session.expiresAtMs ?? Number.MAX_SAFE_INTEGER, maxIdentityMs });
  };
  return Object.assign(authenticate, { accepts });
}

/** Facebook sign-in for better-auth's `socialProviders.facebook`, as `facebookSignIn` makes it. */
export interface FacebookSignInOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly fields: string[];
  readonly scope?: string[];
}

/**
 * Facebook sign-in for better-auth (`socialProviders: { facebook: facebookSignIn({ clientId, clientSecret }) }`), reading
 * no more of the profile than signing in needs (`id`, `name`, `email`; `picture` only if asked), and asking for no
 * permissions beyond better-auth's `email` and `public_profile` unless given.
 */
export function facebookSignIn(options: { readonly clientId: string; readonly clientSecret: string; readonly picture?: boolean; readonly scopes?: readonly string[] }): FacebookSignInOptions {
  if (!options || typeof options.clientId !== 'string' || !/^\d{5,20}$/u.test(options.clientId)) throw new MayuraError('INVALID_CONFIG', 'facebookSignIn(): clientId is your Facebook app\'s ID.');
  if (typeof options.clientSecret !== 'string' || options.clientSecret === '') throw new MayuraError('INVALID_CONFIG', 'facebookSignIn(): clientSecret is your app\'s secret.');
  if (options.picture !== undefined && typeof options.picture !== 'boolean') throw new MayuraError('INVALID_CONFIG', 'facebookSignIn(): picture must be a boolean.');
  if (options.scopes !== undefined && (!Array.isArray(options.scopes) || options.scopes.some(scope => typeof scope !== 'string' || !/^[a-z_]{1,64}$/u.test(scope)))) throw new MayuraError('INVALID_CONFIG', 'facebookSignIn(): scopes are extra permissions such as user_birthday.');
  return Object.freeze({
    clientId: options.clientId, clientSecret: options.clientSecret, fields: ['id', 'name', 'email', ...(options.picture === true ? ['picture'] : [])],
    ...(options.scopes?.length ? { scope: [...options.scopes] } : {}),
  });
}

