import { MayuraError } from 'mayura';
import { jwtAuthenticator, jwtVerifier, remoteJwks, type Authenticator, type IdentityGrant, type JwtClaims } from 'mayura/auth';

/** A verified Firebase user, from the ID token's claims. */
export interface FirebaseSession {
  /** The user's uid (`sub`). */
  readonly userId: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly phoneNumber: string | null;
  readonly name: string | null;
  /** How the user signed in: `password`, `google.com`, `phone`, `anonymous`, `custom`, ... */
  readonly signInProvider: string | null;
  /** The Identity Platform tenant the user belongs to, when multi-tenancy is on. */
  readonly tenant: string | null;
  /** When the user signed in, in milliseconds since the epoch. */
  readonly authTimeMs: number;
  /** The token's claims, as verified; custom claims you set with the Admin SDK are among them. */
  readonly claims: JwtClaims;
}

export interface FirebaseAuthenticatorOptions {
  /** Your Firebase project ID. */
  readonly projectId: string;
  /** What a signed-in user may do, or null to refuse; custom claims (`session.claims`) are set only by your server. */
  readonly identity: (session: FirebaseSession) => IdentityGrant | null | Promise<IdentityGrant | null>;
  /** The Identity Platform tenants accepted; a tenant's users are refused unless their tenant is listed. */
  readonly tenants?: readonly string[];
  /** Accept anonymous users (`sign_in_provider: anonymous`); refused by default. */
  readonly allowAnonymous?: boolean;
  /** Clock difference allowed; 5 s by default. */
  readonly clockSkewMs?: number;
  /** The longest an identity lasts before the token is checked again; 60 s by default (ID tokens last an hour). */
  readonly maxIdentityMs?: number;
  /** For tests and proxies: the fetch to use for Google's keys. */
  readonly fetch?: typeof fetch;
}

/** Google's keys for Firebase ID tokens as a JWKS: the same keys as the X.509 certificates Firebase's docs name. */
export const firebaseJwksUrl = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const text = (value: unknown) => typeof value === 'string' && value !== '' ? value : null;

/** A Firebase session from verified claims; undefined when they are not a Firebase ID token's (no user or sign-in time). */
export function firebaseSession(claims: JwtClaims): FirebaseSession | undefined {
  const authTime = claims['auth_time'];
  if (typeof claims.sub !== 'string' || claims.sub === '' || claims.sub.length > 128 || typeof authTime !== 'number' || !Number.isFinite(authTime)) return undefined;
  // Any value that is not an object has neither field.
  const firebase = (claims['firebase'] ?? {}) as { sign_in_provider?: unknown; tenant?: unknown };
  return Object.freeze({
    userId: claims.sub, email: text(claims['email']), emailVerified: claims['email_verified'] === true, phoneNumber: text(claims['phone_number']), name: text(claims['name']),
    signInProvider: text(firebase.sign_in_provider), tenant: text(firebase.tenant), authTimeMs: authTime * 1_000, claims,
  });
}

/**
 * A server `authenticate` for Firebase Authentication ID tokens, checked as Firebase specifies: RS256, signed by
 * Google's keys for Firebase, issued by `https://securetoken.google.com/<projectId>` for your project, by a user
 * signed in already (`auth_time`). Anonymous users, and users of tenants not listed, are refused. `identity` decides
 * what the user may do.
 */
export function firebaseAuthenticator(options: FirebaseAuthenticatorOptions): Authenticator {
  if (!options || typeof options.identity !== 'function') throw new MayuraError('INVALID_CONFIG', 'firebaseAuthenticator(): identity decides what a signed-in user may do.');
  if (typeof options.projectId !== 'string' || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(options.projectId)) throw new MayuraError('INVALID_CONFIG', 'firebaseAuthenticator(): projectId is your Firebase project ID.');
  if (options.tenants !== undefined && (!Array.isArray(options.tenants) || options.tenants.length === 0 || options.tenants.some(tenant => typeof tenant !== 'string' || tenant === ''))) {
    throw new MayuraError('INVALID_CONFIG', 'firebaseAuthenticator(): tenants are the Identity Platform tenant ids accepted.');
  }
  if (options.allowAnonymous !== undefined && typeof options.allowAnonymous !== 'boolean') throw new MayuraError('INVALID_CONFIG', 'firebaseAuthenticator(): allowAnonymous must be a boolean.');
  const skew = options.clockSkewMs ?? 5_000;
  const verifier = jwtVerifier({
    issuer: `https://securetoken.google.com/${options.projectId}`, audience: options.projectId, algorithms: ['RS256'], clockSkewMs: skew,
    keys: remoteJwks({ url: firebaseJwksUrl, ...(options.fetch ? { fetch: options.fetch } : {}) }),
  });
  const tenants = options.tenants;
  return jwtAuthenticator({
    verifier, ...(options.maxIdentityMs !== undefined ? { maxIdentityMs: options.maxIdentityMs } : {}),
    identity: claims => {
      const session = firebaseSession(claims);
      // auth_time must be in the past, as Firebase requires.
      if (!session || session.authTimeMs - skew > Date.now()) return null;
      if (session.tenant !== null ? !tenants?.includes(session.tenant) : tenants !== undefined) return null;
      if (session.signInProvider === 'anonymous' && options.allowAnonymous !== true) return null;
      return options.identity(session);
    },
  });
}
