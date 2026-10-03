import { MayuraError } from 'mayura';
import {
  jwtVerifier, peekIssuer, remoteJwks, serverIdentity,
  type Authenticator, type IdentityGrant, type JwtClaims, type JwtVerifier,
} from 'mayura/auth';

/** A verified WorkOS token: an AuthKit session's, or a Connect token's (a user's, or a machine's). */
export interface WorkOSSession {
  /** `authkit` for a signed-in user's session token; `connect` for an OAuth access token from your AuthKit domain. */
  readonly kind: 'authkit' | 'connect';
  /** The user (`sub`), or for a machine its application's client ID. */
  readonly subject: string;
  /** Whether a machine holds it: a Connect token from the client credentials grant. */
  readonly machine: boolean;
  /** The AuthKit session (`sid`), or the Connect consent. */
  readonly sessionId: string | null;
  /** The application a Connect token was issued to (`client_id`). */
  readonly clientId: string | null;
  /** The organization selected at sign-in, or a machine's organization (`org_id`). */
  readonly orgId: string | null;
  /** The user's role, and roles, in that organization. */
  readonly role: string | null;
  readonly roles: readonly string[];
  /** The role's permissions (AuthKit). */
  readonly permissions: readonly string[];
  /** The scopes granted (Connect). */
  readonly scopes: readonly string[];
  /** The token's claims, as verified. */
  readonly claims: JwtClaims;
}

export interface WorkOSAuthenticatorOptions {
  /** Your WorkOS environment's client ID (`client_...`). */
  readonly clientId: string;
  /** What a token's holder may do, or null to refuse; for example from `session.permissions` with `mapCapabilities`. */
  readonly identity: (session: WorkOSSession) => IdentityGrant | null | Promise<IdentityGrant | null>;
  /** The issuer of AuthKit session tokens: your custom auth domain, if you set one; `https://api.workos.com/` otherwise. */
  readonly issuer?: string;
  /**
   * Also accept Connect access tokens (OAuth, and machine-to-machine with client credentials) from your AuthKit domain,
   * such as `https://acme.authkit.app`, for `audience` (your client ID by default, or your resource indicators).
   */
  readonly connect?: { readonly domain: string; readonly audience?: string | readonly string[] };
  /** Accept machine (client credentials) Connect tokens; refused by default. */
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

/** A WorkOS session from verified claims; undefined without a subject. */
export function workosSession(claims: JwtClaims, kind: 'authkit' | 'connect'): WorkOSSession | undefined {
  if (typeof claims.sub !== 'string' || claims.sub === '') return undefined;
  const role = text(claims['role']);
  return Object.freeze({
    kind, subject: claims.sub,
    // A Connect token without a consent (sid), whose subject is its own client, is a machine's.
    machine: kind === 'connect' && claims['sid'] === undefined && claims.sub === claims['client_id'],
    sessionId: text(claims['sid']), clientId: text(claims['client_id']), orgId: text(claims['org_id']), role,
    roles: Object.freeze(strings(claims['roles']).length ? strings(claims['roles']) : role ? [role] : []),
    permissions: Object.freeze(strings(claims['permissions'])),
    scopes: Object.freeze(typeof claims['scope'] === 'string' ? claims['scope'].split(' ').filter(Boolean) : []), claims,
  });
}

function origin(value: string, name: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new MayuraError('INVALID_CONFIG', `workosAuthenticator(): ${name} is an https URL.`); }
  if (url.protocol !== 'https:' || url.search || url.hash || url.username || url.password) throw new MayuraError('INVALID_CONFIG', `workosAuthenticator(): ${name} is an https URL.`);
  return url.origin;
}

/**
 * A server `authenticate` for WorkOS tokens: AuthKit session access tokens (RS256, from `https://api.workos.com/` or
 * your custom auth domain, checked against your client's JWKS), and with `connect`, Connect access tokens from your
 * AuthKit domain for your audience. Machines (client credentials) only with `allowMachines`. `identity` decides what
 * the holder may do.
 */
export function workosAuthenticator(options: WorkOSAuthenticatorOptions): Authenticator {
  if (!options || typeof options.identity !== 'function') throw new MayuraError('INVALID_CONFIG', 'workosAuthenticator(): identity decides what a token\'s holder may do.');
  if (typeof options.clientId !== 'string' || !/^client_[A-Za-z0-9]{6,64}$/u.test(options.clientId)) throw new MayuraError('INVALID_CONFIG', 'workosAuthenticator(): clientId is your WorkOS client ID, client_....');
  if (options.allowMachines !== undefined && typeof options.allowMachines !== 'boolean') throw new MayuraError('INVALID_CONFIG', 'workosAuthenticator(): allowMachines must be a boolean.');
  const fetchOption = options.fetch ? { fetch: options.fetch } : {};
  const skew = options.clockSkewMs ?? 5_000;
  // AuthKit writes its issuer with a trailing slash; a custom auth domain is taken as given.
  const issuer = options.issuer === undefined ? 'https://api.workos.com/' : (origin(options.issuer, 'issuer'), options.issuer);
  const verifiers: { readonly kind: 'authkit' | 'connect'; readonly verifier: JwtVerifier }[] = [{
    kind: 'authkit',
    verifier: jwtVerifier({ issuer, audience: false, algorithms: ['RS256'], clockSkewMs: skew, keys: remoteJwks({ url: `https://api.workos.com/sso/jwks/${options.clientId}`, ...fetchOption }) }),
  }];
  if (options.connect !== undefined) {
    const domain = origin(options.connect?.domain, 'connect.domain');
    verifiers.push({ kind: 'connect', verifier: jwtVerifier({ issuer: domain, audience: options.connect.audience ?? options.clientId, algorithms: ['RS256'], clockSkewMs: skew, keys: remoteJwks({ url: `${domain}/oauth2/jwks`, ...fetchOption }) }) });
  }
  const maxIdentityMs = options.maxIdentityMs ?? 60_000;
  if (!Number.isSafeInteger(maxIdentityMs) || maxIdentityMs < 1_000 || maxIdentityMs > 3_600_000) throw new MayuraError('INVALID_CONFIG', 'workosAuthenticator(): maxIdentityMs is 1,000 to 3,600,000.');
  const accepts = (token: string) => { const iss = peekIssuer(token); return iss !== undefined && verifiers.some(item => item.verifier.issuers.includes(iss)); };
  const authenticate = async ({ token, signal }: { readonly token: string; readonly signal: AbortSignal }) => {
    const iss = peekIssuer(token);
    // A custom auth domain may also be the AuthKit domain: each verifier for this issuer is tried in turn.
    for (const { kind, verifier } of verifiers) {
      if (iss === undefined || !verifier.issuers.includes(iss)) continue;
      const result = await verifier.verify(token, { signal });
      if (!result.ok) continue;
      const session = workosSession(result.claims, kind);
      if (!session || (session.machine && options.allowMachines !== true)) return null;
      return serverIdentity(await options.identity(session), { credentialExpiresAtMs: result.claims.exp * 1_000, maxIdentityMs });
    }
    return null;
  };
  return Object.assign(authenticate, { accepts });
}
