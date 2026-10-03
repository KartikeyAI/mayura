import { MayuraError } from 'mayura';
import {
  hmacSecret, jwtAuthenticator, jwtVerifier, remoteJwks,
  type Authenticator, type IdentityGrant, type JwtAlgorithm, type JwtClaims, type JwtKeySource,
} from 'mayura/auth';

/** A verified Supabase Auth user, from the access token's claims. */
export interface SupabaseSession {
  readonly userId: string;
  readonly email: string | null;
  readonly phone: string | null;
  /** The Postgres role the token stands for: `authenticated` for signed-in users. */
  readonly role: string;
  /** How strongly the user signed in: `aal1`, or `aal2` with a second factor. */
  readonly aal: string | null;
  /** The session, to check against `auth.sessions` where a signed-out session must stop before its token expires. */
  readonly sessionId: string | null;
  readonly anonymous: boolean;
  /** Set only by your server (and Supabase): safe to grant from. */
  readonly appMetadata: Readonly<Record<string, unknown>>;
  /** Editable by the user themselves: never grant from it. */
  readonly userMetadata: Readonly<Record<string, unknown>>;
  /** The token's claims, as verified. */
  readonly claims: JwtClaims;
}

export interface SupabaseAuthenticatorOptions {
  /** Your project's URL, such as `https://abcdefghijklmnopqrst.supabase.co` (or its custom domain). */
  readonly projectUrl: string;
  /** What a signed-in user may do, or null to refuse; for example from `session.appMetadata`. */
  readonly identity: (session: SupabaseSession) => IdentityGrant | null | Promise<IdentityGrant | null>;
  /**
   * Your project's legacy JWT secret, only while tokens may still be signed with it (HS256). The project's asymmetric
   * keys (ES256, RS256) are always used for the tokens they sign.
   */
  readonly jwtSecret?: string;
  /** The roles accepted; `['authenticated']` by default, so the public anon key and `service_role` tokens never are. */
  readonly roles?: readonly string[];
  /** The audience tokens must have; `authenticated` by default, as Supabase issues them to signed-in users. */
  readonly audience?: string | readonly string[];
  /** Accept anonymous users (`is_anonymous`); refused by default. */
  readonly allowAnonymous?: boolean;
  /** Accept only users who signed in with a second factor (`aal2`). */
  readonly requireAal2?: boolean;
  /** Clock difference allowed; 5 s by default. */
  readonly clockSkewMs?: number;
  /** The longest an identity lasts before the token is checked again; 60 s by default. */
  readonly maxIdentityMs?: number;
  /** For tests and proxies: the fetch to use for the JWKS. */
  readonly fetch?: typeof fetch;
}

const text = (value: unknown) => typeof value === 'string' && value !== '' ? value : null;
const record = (value: unknown): Readonly<Record<string, unknown>> => value && typeof value === 'object' && !Array.isArray(value) ? Object.freeze({ ...(value as Record<string, unknown>) }) : Object.freeze({});

/** A Supabase session from verified claims; undefined without a user and role. */
export function supabaseSession(claims: JwtClaims): SupabaseSession | undefined {
  if (typeof claims.sub !== 'string' || claims.sub === '' || typeof claims['role'] !== 'string') return undefined;
  return Object.freeze({
    userId: claims.sub, email: text(claims['email']), phone: text(claims['phone']), role: claims['role'], aal: text(claims['aal']),
    sessionId: text(claims['session_id']), anonymous: claims['is_anonymous'] === true,
    appMetadata: record(claims['app_metadata']), userMetadata: record(claims['user_metadata']), claims,
  });
}

/** The project's asymmetric keys for ES256 and RS256 tokens, and the legacy secret for HS256 ones. */
function keysFor(jwks: JwtKeySource, secret: JwtKeySource | undefined): JwtKeySource {
  return Object.freeze({
    key: (header: { readonly alg: JwtAlgorithm; readonly kid?: string }, options: { readonly signal: AbortSignal }) =>
      // A JWKS never supplies an HMAC secret, so without one HS256 finds no key.
      header.alg === 'HS256' && secret ? secret.key(header, options) : jwks.key(header, options),
  });
}

/**
 * A server `authenticate` for Supabase Auth access tokens: issued by your project (`<projectUrl>/auth/v1`) to signed-in
 * users (audience `authenticated`), signed with its asymmetric keys (or, while you still use it, its legacy secret).
 * Only the roles you accept pass (`authenticated` alone by default), anonymous users only if you allow them.
 * `identity` decides what the user may do.
 */
export function supabaseAuthenticator(options: SupabaseAuthenticatorOptions): Authenticator {
  if (!options || typeof options.identity !== 'function') throw new MayuraError('INVALID_CONFIG', 'supabaseAuthenticator(): identity decides what a signed-in user may do.');
  let url: URL;
  try { url = new URL(options.projectUrl); } catch { throw new MayuraError('INVALID_CONFIG', 'supabaseAuthenticator(): projectUrl is your project\'s URL, such as https://<ref>.supabase.co.'); }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new MayuraError('INVALID_CONFIG', 'supabaseAuthenticator(): projectUrl is an https origin, such as https://<ref>.supabase.co.');
  const roles = options.roles ?? ['authenticated'];
  if (!Array.isArray(roles) || roles.length === 0 || roles.some(role => typeof role !== 'string' || role === '')) throw new MayuraError('INVALID_CONFIG', 'supabaseAuthenticator(): roles are the Postgres roles accepted, such as authenticated.');
  for (const name of ['allowAnonymous', 'requireAal2'] as const) {
    if (options[name] !== undefined && typeof options[name] !== 'boolean') throw new MayuraError('INVALID_CONFIG', `supabaseAuthenticator(): ${name} must be a boolean.`);
  }
  if (options.jwtSecret !== undefined && typeof options.jwtSecret !== 'string') throw new MayuraError('INVALID_CONFIG', 'supabaseAuthenticator(): jwtSecret is your project\'s legacy JWT secret.');
  const issuer = `${url.origin}/auth/v1`;
  // Supabase caches its JWKS for 10 minutes and asks applications not to keep it longer.
  const jwks = remoteJwks({ url: `${issuer}/.well-known/jwks.json`, maxAgeMs: 600_000, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const secret = options.jwtSecret !== undefined ? hmacSecret(options.jwtSecret) : undefined;
  const verifier = jwtVerifier({
    issuer, audience: options.audience ?? 'authenticated', clockSkewMs: options.clockSkewMs ?? 5_000,
    algorithms: secret ? ['ES256', 'RS256', 'HS256'] : ['ES256', 'RS256'], keys: keysFor(jwks, secret),
  });
  return jwtAuthenticator({
    verifier, ...(options.maxIdentityMs !== undefined ? { maxIdentityMs: options.maxIdentityMs } : {}),
    identity: claims => {
      const session = supabaseSession(claims);
      if (!session || !roles.includes(session.role)) return null;
      if (session.anonymous && options.allowAnonymous !== true) return null;
      if (options.requireAal2 === true && session.aal !== 'aal2') return null;
      return options.identity(session);
    },
  });
}
