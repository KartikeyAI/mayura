import { MayuraError } from 'mayura';
import { jwtAuthenticator, jwtVerifier, remoteJwks, type Authenticator, type IdentityGrant, type JwtClaims } from 'mayura/auth';

/** A verified Neon Auth user, from the token's claims. */
export interface NeonAuthSession {
  readonly userId: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly name: string | null;
  /** The user's role, such as `authenticated` (or one the admin plugin set). */
  readonly role: string | null;
  /** The token's claims, as verified. */
  readonly claims: JwtClaims;
}

export interface NeonAuthAuthenticatorOptions {
  /** Your Neon Auth URL (`NEON_AUTH_BASE_URL`), such as `https://ep-xxx.neonauth.us-east-1.aws.neon.tech/neondb/auth`. */
  readonly authUrl: string;
  /** What a signed-in user may do, or null to refuse. */
  readonly identity: (session: NeonAuthSession) => IdentityGrant | null | Promise<IdentityGrant | null>;
  /** Clock difference allowed; 5 s by default. */
  readonly clockSkewMs?: number;
  /** The longest an identity lasts before the token is checked again; 60 s by default (tokens last 15 minutes). */
  readonly maxIdentityMs?: number;
  /** For tests and proxies: the fetch to use for the JWKS. */
  readonly fetch?: typeof fetch;
}

const text = (value: unknown) => typeof value === 'string' && value !== '' ? value : null;

/** A Neon Auth session from verified claims; undefined without a user. */
export function neonAuthSession(claims: JwtClaims): NeonAuthSession | undefined {
  if (typeof claims.sub !== 'string' || claims.sub === '') return undefined;
  return Object.freeze({ userId: claims.sub, email: text(claims['email']), emailVerified: claims['emailVerified'] === true, name: text(claims['name']), role: text(claims['role']), claims });
}

/** Whether the claims say the user is banned now: `banned`, with no `banExpires` or one still ahead. */
export function neonAuthBanned(claims: JwtClaims): boolean {
  if (claims['banned'] !== true) return false;
  const expires = claims['banExpires'];
  // No expiry (null), or one that cannot be read, means the ban holds.
  const at = typeof expires === 'number' ? expires * (expires < 1e12 ? 1_000 : 1) : Date.parse(String(expires));
  return !Number.isFinite(at) || at > Date.now();
}

/**
 * A server `authenticate` for Neon Auth (Neon's managed better-auth) JWTs: EdDSA tokens whose issuer and audience are
 * your Neon Auth URL's origin, checked against its published keys. A banned user is refused. `identity` decides what
 * the user may do. Applications still on the earlier Stack Auth-based Neon Auth use `@mayurajs/auth-hexclave`.
 */
export function neonAuthAuthenticator(options: NeonAuthAuthenticatorOptions): Authenticator {
  if (!options || typeof options.identity !== 'function') throw new MayuraError('INVALID_CONFIG', 'neonAuthAuthenticator(): identity decides what a signed-in user may do.');
  let url: URL;
  try { url = new URL(options.authUrl); } catch { throw new MayuraError('INVALID_CONFIG', 'neonAuthAuthenticator(): authUrl is your Neon Auth URL (NEON_AUTH_BASE_URL).'); }
  if (url.protocol !== 'https:' || url.search || url.hash || url.username || url.password) throw new MayuraError('INVALID_CONFIG', 'neonAuthAuthenticator(): authUrl is an https URL, such as https://ep-xxx.neonauth.us-east-1.aws.neon.tech/neondb/auth.');
  const base = url.href.replace(/\/$/u, '');
  const verifier = jwtVerifier({
    issuer: url.origin, audience: url.origin, algorithms: ['EdDSA'], clockSkewMs: options.clockSkewMs ?? 5_000,
    keys: remoteJwks({ url: `${base}/.well-known/jwks.json`, ...(options.fetch ? { fetch: options.fetch } : {}) }),
  });
  return jwtAuthenticator({
    verifier, ...(options.maxIdentityMs !== undefined ? { maxIdentityMs: options.maxIdentityMs } : {}),
    identity: claims => {
      const session = neonAuthSession(claims);
      return session && !neonAuthBanned(claims) ? options.identity(session) : null;
    },
  });
}
