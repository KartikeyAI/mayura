import { MayuraError } from '@mayura/core';
import { sha256, toBase64Url } from '@mayura/core/host';
import type { ServerIdentity } from '@mayura/server';
import { peekIssuer, type JwtClaims, type JwtHeader, type JwtVerifier } from './jwt.js';

/** A permission Mayura's server knows. */
export type ServerCapability = ServerIdentity['capabilities'][number];
/** Every permission Mayura's server knows, for mapping tables and checks. */
export const serverCapabilities: readonly ServerCapability[] = Object.freeze(['runs:read', 'runs:submit', 'runs:cancel', 'operations:read',
  'humans:read', 'humans:respond', 'workflows:read', 'workflows:control', 'workflows:fleet', 'workflows:migrate']);

/** What a verified caller may do, as an identity mapping returns it; `expiresAtMs` defaults to the credential's expiry. */
export interface IdentityGrant {
  readonly principalId: string;
  readonly projectId: string;
  readonly agentIds: readonly string[];
  readonly capabilities: readonly ServerCapability[];
  readonly expiresAtMs?: number;
}

/** Mayura's server `authenticate` callback, with a way to tell which tokens it is for. */
export interface Authenticator {
  (request: { readonly token: string; readonly signal: AbortSignal }): Promise<ServerIdentity | null>;
  /** Whether this authenticator is for a token of this shape (an issuer, a key prefix), checked before any verification. */
  readonly accepts: (token: string) => boolean;
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const namespacePattern = /^[a-z0-9][a-z0-9.-]{0,31}$/u;

/**
 * A principal id for a subject of an identity provider, as Mayura's server accepts one: `<namespace>/<subject>`. A
 * subject with characters the server does not accept (such as Auth0's `auth0|123`), or too long, becomes `_` and the
 * base64url of its SHA-256: stable, and never equal to a subject kept as it is.
 */
export function principalId(namespace: string, subject: string): string {
  if (typeof namespace !== 'string' || !namespacePattern.test(namespace)) throw new MayuraError('INVALID_CONFIG', 'principalId(): namespace is 1-32 lowercase letters, digits, "." or "-".');
  if (typeof subject !== 'string' || subject === '') throw new MayuraError('INVALID_INPUT', 'principalId(): subject is a non-empty string.');
  const id = `${namespace}/${subject}`;
  if (!subject.startsWith('_') && identifier.test(id)) return id;
  return `${namespace}/_${toBase64Url(sha256(subject))}`;
}

/**
 * Mayura capabilities for an identity provider's permissions or roles, through an explicit table: each listed value
 * grants its capabilities, and anything not in the table grants nothing.
 */
export function mapCapabilities(values: unknown, table: Readonly<Record<string, readonly ServerCapability[]>>): ServerCapability[] {
  if (!table || typeof table !== 'object') throw new MayuraError('INVALID_CONFIG', 'mapCapabilities(): table maps permission names to capabilities.');
  for (const [name, granted] of Object.entries(table)) {
    if (!Array.isArray(granted) || granted.some(capability => !serverCapabilities.includes(capability))) throw new MayuraError('INVALID_CONFIG', `mapCapabilities(): ${name} maps to capabilities Mayura's server knows.`);
  }
  const list = typeof values === 'string' ? values.split(' ') : Array.isArray(values) ? values : [];
  const found = new Set<ServerCapability>();
  for (const value of list) if (typeof value === 'string' && Object.hasOwn(table, value)) for (const capability of table[value]!) found.add(capability);
  return serverCapabilities.filter(capability => found.has(capability));
}

/** @internal An identity the server accepts, from a grant; null when the grant is unusable or already expired. */
export function identityFrom(grant: IdentityGrant | null | undefined, credentialExpiresAtMs: number, maxIdentityMs: number): ServerIdentity | null {
  if (!grant) return null;
  const { principalId: principal, projectId, agentIds, capabilities } = grant;
  if (typeof principal !== 'string' || !identifier.test(principal) || typeof projectId !== 'string' || !identifier.test(projectId)) {
    throw new MayuraError('INVALID_CONFIG', 'The identity mapping returned a principalId or projectId Mayura cannot use: 1-128 letters, digits, ".", "_", "/" or "-", starting with a letter or digit.');
  }
  if (!Array.isArray(agentIds) || agentIds.length > 256 || agentIds.some(id => typeof id !== 'string' || !identifier.test(id))) throw new MayuraError('INVALID_CONFIG', 'The identity mapping returned agentIds Mayura cannot use.');
  if (!Array.isArray(capabilities) || capabilities.some(capability => !serverCapabilities.includes(capability))) throw new MayuraError('INVALID_CONFIG', 'The identity mapping returned capabilities Mayura\'s server does not know.');
  const now = Date.now();
  const requested = grant.expiresAtMs ?? credentialExpiresAtMs;
  if (!Number.isSafeInteger(requested)) throw new MayuraError('INVALID_CONFIG', 'The identity mapping returned an expiresAtMs that is not a whole number of milliseconds.');
  // Never past the credential, and never longer than maxIdentityMs: the caller presents the credential again.
  const expiresAtMs = Math.min(requested, credentialExpiresAtMs, now + maxIdentityMs);
  if (expiresAtMs <= now) return null;
  return Object.freeze({
    scope: Object.freeze({ principalId: principal, projectId }), agentIds: Object.freeze([...new Set(agentIds)]),
    capabilities: Object.freeze(serverCapabilities.filter(capability => capabilities.includes(capability))), expiresAtMs,
  });
}

/**
 * The identity Mayura's server takes, from what a verified credential may do: checked against what the server accepts,
 * and lasting no longer than the credential nor `maxIdentityMs` (60 s by default). Null for no grant, or one already
 * over. For authenticators of your own; the ones here use it.
 */
export function serverIdentity(grant: IdentityGrant | null | undefined, options: { readonly credentialExpiresAtMs: number; readonly maxIdentityMs?: number }): ServerIdentity | null {
  if (!options || typeof options.credentialExpiresAtMs !== 'number' || Number.isNaN(options.credentialExpiresAtMs)) throw new MayuraError('INVALID_CONFIG', 'serverIdentity(): credentialExpiresAtMs is when the credential expires.');
  return identityFrom(grant, options.credentialExpiresAtMs, checkMaxIdentityMs(options.maxIdentityMs, 'serverIdentity()'));
}

export interface JwtAuthenticatorOptions {
  readonly verifier: JwtVerifier;
  /**
   * What a verified token's holder may do, or null to refuse. Grant only what your application decides: a valid token
   * proves who someone is, not what they may do here.
   */
  readonly identity: (claims: JwtClaims, header: JwtHeader) => IdentityGrant | null | Promise<IdentityGrant | null>;
  /** The longest an identity lasts before the token is checked again; 60 s by default (1 s to 1 hour). */
  readonly maxIdentityMs?: number;
}

/** @internal */
export function checkMaxIdentityMs(value: number | undefined, owner: string): number {
  const result = value ?? 60_000;
  if (!Number.isSafeInteger(result) || result < 1_000 || result > 3_600_000) throw new MayuraError('INVALID_CONFIG', `${owner}: maxIdentityMs is 1,000 to 3,600,000.`);
  return result;
}

/**
 * A server `authenticate` for JWTs from one issuer: the verifier checks the token, then `identity` decides what its
 * holder may do. It accepts only tokens naming the verifier's issuer, so several can be chained.
 */
export function jwtAuthenticator(options: JwtAuthenticatorOptions): Authenticator {
  if (!options?.verifier || typeof options.verifier.verify !== 'function') throw new MayuraError('INVALID_CONFIG', 'jwtAuthenticator(): verifier is jwtVerifier(...).');
  if (typeof options.identity !== 'function') throw new MayuraError('INVALID_CONFIG', 'jwtAuthenticator(): identity decides what a verified caller may do.');
  const maxIdentityMs = checkMaxIdentityMs(options.maxIdentityMs, 'jwtAuthenticator()');
  const issuers = options.verifier.issuers;
  const accepts = (token: string) => { const iss = peekIssuer(token); return iss !== undefined && issuers.includes(iss); };
  const authenticate = async ({ token, signal }: { readonly token: string; readonly signal: AbortSignal }): Promise<ServerIdentity | null> => {
    if (!accepts(token)) return null;
    const result = await options.verifier.verify(token, { signal });
    if (!result.ok) return null;
    return identityFrom(await options.identity(result.claims, result.header), result.claims.exp * 1_000, maxIdentityMs);
  };
  return Object.assign(authenticate, { accepts });
}

/**
 * One server `authenticate` from several: a token goes to the first authenticator that accepts it (by issuer or key
 * prefix), and nothing else sees it. A token none accepts is refused.
 */
export function chainAuthenticators(...authenticators: readonly Authenticator[]): Authenticator {
  if (authenticators.length === 0 || authenticators.some(item => typeof item !== 'function' || typeof item.accepts !== 'function')) {
    throw new MayuraError('INVALID_CONFIG', 'chainAuthenticators() takes one or more authenticators.');
  }
  const list = [...authenticators];
  const accepts = (token: string) => list.some(item => item.accepts(token));
  const authenticate = async (request: { readonly token: string; readonly signal: AbortSignal }): Promise<ServerIdentity | null> => {
    const chosen = list.find(item => item.accepts(request.token));
    return chosen ? chosen(request) : null;
  };
  return Object.assign(authenticate, { accepts });
}
