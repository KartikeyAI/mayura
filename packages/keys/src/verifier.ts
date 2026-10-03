import { MayuraError } from '@mayura/core';
import { serverIdentity, type Authenticator, type ServerCapability } from '@mayura/auth';
import type { ServerIdentity } from '@mayura/server';

/** Why a key was refused. */
export type KeyRefusal = 'malformed' | 'not_found' | 'disabled' | 'revoked' | 'expired' | 'rate_limited' | 'exhausted' | 'forbidden';

/** What a key may do, or why it may not. */
export type KeyVerification =
  | { readonly ok: true; readonly principalId: string; readonly projectId: string; readonly agentIds: readonly string[]; readonly capabilities: readonly ServerCapability[];
    readonly expiresAtMs: number | null; readonly remaining: number | null }
  | { readonly ok: false; readonly reason: KeyRefusal; readonly retryAfterMs?: number };

/** Anything that checks API keys: Mayura's own key manager, or a provider's (`@mayurajs/km-*`). */
export interface KeyVerifier {
  /** Whether a token looks like one of this verifier's keys (by its prefix), checked before anything else. */
  accepts(key: string): boolean;
  /** Checks a key, spending `cost` credits where the key has any. Throws only when keys cannot be checked. */
  verify(key: string, options?: { readonly signal?: AbortSignal; readonly cost?: number }): Promise<KeyVerification>;
}

export interface KeyAuthenticatorOptions {
  /** Credits each request spends, for keys with credits; 1 by default (0 checks without spending). */
  readonly cost?: number;
  /** The longest an identity lasts before the key is checked again; 60 s by default (1 s to 1 hour). */
  readonly maxIdentityMs?: number;
}

/**
 * A server `authenticate` for API keys: each request's key is verified (and charged its cost), and its grant becomes
 * the identity. A key refused for any reason is refused; a verifier that cannot answer makes the server answer that
 * authentication is unavailable.
 */
export function keyAuthenticator(verifier: KeyVerifier, options: KeyAuthenticatorOptions = {}): Authenticator {
  if (!verifier || typeof verifier.verify !== 'function' || typeof verifier.accepts !== 'function') throw new MayuraError('INVALID_CONFIG', 'keyAuthenticator(): verifier is a key manager or a km provider.');
  const cost = options.cost ?? 1;
  if (!Number.isSafeInteger(cost) || cost < 0 || cost > 1e9) throw new MayuraError('INVALID_CONFIG', 'keyAuthenticator(): cost is 0 to 1,000,000,000 credits.');
  const maxIdentityMs = options.maxIdentityMs ?? 60_000;
  if (!Number.isSafeInteger(maxIdentityMs) || maxIdentityMs < 1_000 || maxIdentityMs > 3_600_000) throw new MayuraError('INVALID_CONFIG', 'keyAuthenticator(): maxIdentityMs is 1,000 to 3,600,000.');
  const accepts = (token: string) => typeof token === 'string' && verifier.accepts(token);
  const authenticate = async ({ token, signal }: { readonly token: string; readonly signal: AbortSignal }): Promise<ServerIdentity | null> => {
    if (!accepts(token)) return null;
    const result = await verifier.verify(token, { signal, cost });
    if (!result.ok) return null;
    return serverIdentity({ principalId: result.principalId, projectId: result.projectId, agentIds: result.agentIds, capabilities: result.capabilities },
      { credentialExpiresAtMs: result.expiresAtMs ?? Number.MAX_SAFE_INTEGER, maxIdentityMs });
  };
  return Object.assign(authenticate, { accepts });
}
