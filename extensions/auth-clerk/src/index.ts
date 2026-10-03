import { MayuraError } from 'mayura';
import {
  jwtAuthenticator, jwtVerifier, remoteJwks,
  type Authenticator, type IdentityGrant, type JwtClaims, type JwtKeySource,
} from 'mayura/auth';

/** A verified Clerk session, from its token's claims (version 2, or the older version 1). */
export interface ClerkSession {
  /** The user (`sub`). */
  readonly userId: string;
  /** The session (`sid`). */
  readonly sessionId: string;
  /** The session's status (`sts`), such as `active` or `pending`. */
  readonly status: string | null;
  /** The active organization, when there is one. */
  readonly orgId: string | null;
  readonly orgSlug: string | null;
  /** The user's role in it, as Clerk names roles: `org:admin`. */
  readonly orgRole: string | null;
  /** The user's permissions in it, as Clerk names them: `org:invoices:read`. */
  readonly orgPermissions: readonly string[];
  /** Someone acting as the user (impersonation), from the `act` claim. */
  readonly actor: { readonly sub?: string; readonly sid?: string; readonly iss?: string } | null;
  /** The token's claims, as verified. */
  readonly claims: JwtClaims;
}

export interface ClerkAuthenticatorOptions {
  /**
   * Your Clerk publishable key (`pk_live_...` or `pk_test_...`), from which your Frontend API URL (the tokens' issuer
   * and where its keys are published) is read. Or give `frontendApi`.
   */
  readonly publishableKey?: string;
  /** Your Clerk Frontend API URL, such as `https://clerk.example.com`. */
  readonly frontendApi?: string;
  /**
   * Your instance's JWKS public key (PEM, from the API keys page), to verify with no network at all. Without it, the
   * keys are fetched from your Frontend API.
   */
  readonly jwtKey?: string;
  /**
   * The origins your users sign in from, which a token's `azp` must be one of, as Clerk advises against CSRF. `false`
   * only where no browser is involved.
   */
  readonly authorizedParties: readonly string[] | false;
  /** What a signed-in user may do, or null to refuse; for example from `session.orgPermissions` with `mapCapabilities`. */
  readonly identity: (session: ClerkSession) => IdentityGrant | null | Promise<IdentityGrant | null>;
  /** Accept sessions Clerk marks `pending` (tasks such as choosing an organization not done yet); refused by default. */
  readonly allowPending?: boolean;
  /** Clock difference allowed; 5 s by default, as Clerk's own SDK. */
  readonly clockSkewMs?: number;
  /** The longest an identity lasts before the token is checked again; 60 s by default (Clerk tokens last 60 s). */
  readonly maxIdentityMs?: number;
  /** For tests and proxies: the fetch to use for the JWKS. */
  readonly fetch?: typeof fetch;
}

const decoder = new TextDecoder('utf-8', { fatal: true });

/** The Frontend API URL in a publishable key: `pk_<live|test>_` and the base64 of `<host>$`. */
export function clerkFrontendApi(publishableKey: string): string {
  const match = typeof publishableKey === 'string' ? /^pk_(?:live|test)_([A-Za-z0-9+/=_-]+)$/u.exec(publishableKey) : null;
  let host: string | undefined;
  try { host = match ? decoder.decode(Uint8Array.from(atob(match[1]!.replace(/-/gu, '+').replace(/_/gu, '/')), char => char.charCodeAt(0))) : undefined; } catch { host = undefined; }
  if (!host || !host.endsWith('$') || !/^[a-z0-9.-]+(?::\d{1,5})?$/iu.test(host.slice(0, -1))) throw new MayuraError('INVALID_CONFIG', 'publishableKey is a Clerk publishable key, pk_live_... or pk_test_....');
  return `https://${host.slice(0, -1)}`;
}

/** A key source for one PEM public key (SPKI), RS256, as Clerk publishes it for networkless verification. */
function pemKey(pem: string): JwtKeySource {
  const body = typeof pem === 'string' ? /-----BEGIN PUBLIC KEY-----([A-Za-z0-9+/=\s]+)-----END PUBLIC KEY-----/u.exec(pem)?.[1]?.replace(/\s+/gu, '') : undefined;
  let der: Uint8Array;
  try { der = Uint8Array.from(atob(body ?? '!'), char => char.charCodeAt(0)); } catch { throw new MayuraError('INVALID_CONFIG', 'jwtKey is your instance\'s PEM public key (-----BEGIN PUBLIC KEY-----...).'); }
  const key = crypto.subtle.importKey('spki', der as Uint8Array<ArrayBuffer>, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']).catch(() => undefined);
  return Object.freeze({
    key: async () => {
      const imported = await key;
      if (!imported) throw new MayuraError('INVALID_CONFIG', 'jwtKey is not an RSA public key Mayura can use.');
      // The verifier accepts RS256 alone.
      return imported;
    },
  });
}

/** Clerk's organization permissions from a version 2 token: features (`fea`), names (`o.per`) and bitmasks (`o.fpm`). */
export function clerkPermissions(claims: { readonly fea?: unknown; readonly o?: unknown; readonly [claim: string]: unknown }): string[] {
  const org = claims.o as { per?: unknown; fpm?: unknown } | undefined;
  if (typeof claims.fea !== 'string' || typeof org?.per !== 'string' || typeof org.fpm !== 'string') return [];
  // Features scoped to organizations: `o:<feature>`, or both (`ou`, `uo`); as Clerk's own SDK reads them.
  const features: string[] = [];
  for (const part of claims.fea.split(',')) {
    const item = part.trim(); const colon = item.indexOf(':');
    if (colon === -1) return [];
    if (['o', 'ou', 'uo'].includes(item.slice(0, colon))) features.push(item.slice(colon + 1));
  }
  const names = org.per.split(',').map(name => name.trim());
  const masks = org.fpm.split(',').map(mask => mask.trim());
  const permissions: string[] = [];
  for (const [index, feature] of features.entries()) {
    const mask = masks[index];
    if (mask === undefined || !/^\d{1,300}$/u.test(mask)) continue;
    // Bit 0 (the rightmost) is the first permission name.
    const bits = BigInt(mask);
    for (const [bit, name] of names.entries()) if ((bits >> BigInt(bit)) & 1n) permissions.push(`org:${feature}:${name}`);
  }
  return permissions;
}

/** A Clerk session from verified claims, either token version. */
export function clerkSession(claims: JwtClaims): ClerkSession | undefined {
  if (typeof claims.sub !== 'string' || claims.sub === '' || typeof claims['sid'] !== 'string') return undefined;
  const text = (value: unknown) => typeof value === 'string' && value !== '' ? value : null;
  const actor = claims['act'] && typeof claims['act'] === 'object' ? claims['act'] as ClerkSession['actor'] : null;
  const base = { userId: claims.sub, sessionId: claims['sid'], status: text(claims['sts']), actor, claims };
  if (claims['v'] === 2) {
    const org = claims['o'] as { id?: unknown; slg?: unknown; rol?: unknown } | undefined;
    const orgId = text(org?.id);
    return Object.freeze({ ...base, orgId, orgSlug: orgId ? text(org?.slg) : null, orgRole: orgId && text(org?.rol) ? `org:${org!.rol as string}` : null,
      orgPermissions: Object.freeze(orgId ? clerkPermissions(claims) : []) });
  }
  // Version 1 (Clerk stopped issuing these in April 2025).
  const orgId = text(claims['org_id']); const permissions = claims['org_permissions'];
  return Object.freeze({ ...base, orgId, orgSlug: orgId ? text(claims['org_slug']) : null, orgRole: orgId ? text(claims['org_role']) : null,
    orgPermissions: Object.freeze(orgId && Array.isArray(permissions) ? permissions.filter((item): item is string => typeof item === 'string') : []) });
}

/**
 * A server `authenticate` for Clerk session tokens: RS256 tokens issued by your Frontend API, verified with its
 * published keys (or your PEM key, with no network), from your own origins (`azp`), active (not `pending`), and
 * no older than Clerk's 60-second lifetime allows. `identity` decides what the user may do.
 */
export function clerkAuthenticator(options: ClerkAuthenticatorOptions): Authenticator {
  if (!options || typeof options.identity !== 'function') throw new MayuraError('INVALID_CONFIG', 'clerkAuthenticator(): identity decides what a signed-in user may do.');
  let frontendApi: string;
  if (options.frontendApi !== undefined) {
    let url: URL;
    try { url = new URL(options.frontendApi); } catch { throw new MayuraError('INVALID_CONFIG', 'clerkAuthenticator(): frontendApi is your Clerk Frontend API URL.'); }
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new MayuraError('INVALID_CONFIG', 'clerkAuthenticator(): frontendApi is an https origin, such as https://clerk.example.com.');
    frontendApi = url.origin;
    if (options.publishableKey !== undefined && clerkFrontendApi(options.publishableKey) !== frontendApi) throw new MayuraError('INVALID_CONFIG', 'clerkAuthenticator(): publishableKey and frontendApi name different instances.');
  } else if (options.publishableKey !== undefined) frontendApi = clerkFrontendApi(options.publishableKey);
  else throw new MayuraError('INVALID_CONFIG', 'clerkAuthenticator(): give publishableKey (or frontendApi): tokens are checked against your instance.');
  const parties = options.authorizedParties;
  if (parties !== false && (!Array.isArray(parties) || parties.length === 0 || parties.some(party => typeof party !== 'string' || !/^https?:\/\/[^/\s]+$/u.test(party)))) {
    throw new MayuraError('INVALID_CONFIG', 'clerkAuthenticator(): authorizedParties are the origins your users sign in from, such as https://app.example.com, or false where no browser is involved.');
  }
  if (options.allowPending !== undefined && typeof options.allowPending !== 'boolean') throw new MayuraError('INVALID_CONFIG', 'clerkAuthenticator(): allowPending must be a boolean.');
  const keys = options.jwtKey !== undefined ? pemKey(options.jwtKey) : remoteJwks({ url: `${frontendApi}/.well-known/jwks.json`, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const verifier = jwtVerifier({ issuer: frontendApi, audience: false, algorithms: ['RS256'], keys, clockSkewMs: options.clockSkewMs ?? 5_000 });
  return jwtAuthenticator({
    verifier, ...(options.maxIdentityMs !== undefined ? { maxIdentityMs: options.maxIdentityMs } : {}),
    identity: claims => {
      // Clerk tokens carry no audience: the origin a token was made for (azp) stands for it.
      if (parties !== false && (typeof claims['azp'] !== 'string' || !parties.includes(claims['azp']))) return null;
      const session = clerkSession(claims);
      if (!session || (session.status === 'pending' && options.allowPending !== true)) return null;
      return options.identity(session);
    },
  });
}
