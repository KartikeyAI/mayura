import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ServerIdentity } from '@mayura/server-node';
import type { Config } from './config.js';

// Bearer tokens are 64 hex characters. Configuration holds only their SHA-256 digests, never the tokens themselves.
export const newToken = (): string => randomBytes(32).toString('hex');
export const tokenDigest = (token: string): string => createHash('sha256').update(token).digest('hex');

function matches(token: string, digests: readonly string[]): boolean {
  if (!/^[a-f0-9]{64}$/u.test(token)) return false;
  const supplied = createHash('sha256').update(token).digest(); let found = false;
  // Compare against every configured digest so the time taken does not reveal which one matched.
  for (const digest of digests) found = timingSafeEqual(supplied, Buffer.from(digest, 'hex')) || found;
  return found;
}

/**
 * One kind of API caller: operators, who use the console and the workflow API to watch runs and approve escalations.
 * Nobody here may submit agent runs over the API: work starts only from verified webhook deliveries, which the
 * separate ingress (src/ingress.ts) authenticates by signature, not by bearer token.
 * Identities last one minute; clients re-present their token on each request.
 */
export function authenticate(config: Config, agentIds: readonly string[]) {
  return async ({ token }: { readonly token: string }): Promise<ServerIdentity | null> => {
    if (!matches(token, config.operatorTokens)) return null;
    // Operator commands are journaled under the service scope; per-person attribution needs your identity provider.
    return { scope: config.scope, agentIds: [...agentIds], expiresAtMs: Date.now() + 60_000,
      capabilities: ['runs:read', 'operations:read', 'workflows:read', 'workflows:control', 'workflows:fleet'] };
  };
}

// Approvals: the operator API turns the authenticated operator into a credential, and the workflow runtime verifies it.
// Only credentials minted here in this process verify, so an approval cannot be forged from request data.
const minted = new WeakSet<object>();
export function approvalCredential(actorId: string): object {
  const credential = Object.freeze({ actorId }); minted.add(credential); return credential;
}
export function verifyApprover(projectId: string) {
  return async (credential: unknown): Promise<{ readonly id: string; readonly projectId: string; readonly canApprove: boolean }> => {
    if (typeof credential !== 'object' || credential === null || !minted.has(credential)) throw new Error('Unverified approval credential.');
    return { id: (credential as { readonly actorId: string }).actorId, projectId, canApprove: true };
  };
}
