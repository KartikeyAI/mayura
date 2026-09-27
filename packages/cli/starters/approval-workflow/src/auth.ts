import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ServerIdentity } from 'mayura/server-node';
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
 * Two kinds of caller:
 * - operators use the console and the workflow API to review, approve, pause, migrate and hold refunds;
 * - the support system (intake) submits refund requests to the intake agent and reads their results.
 * Identities last one minute; clients re-present their token on each request.
 */
export function authenticate(config: Config, intakeAgentId: string) {
  return async ({ token }: { readonly token: string }): Promise<ServerIdentity | null> => {
    const expiresAtMs = Date.now() + 60_000;
    if (matches(token, config.operatorTokens)) {
      // Operator commands are journaled under the service scope; per-person attribution needs your identity provider.
      return { scope: config.scope, agentIds: [intakeAgentId], expiresAtMs,
        capabilities: ['runs:read', 'operations:read', 'workflows:read', 'workflows:control', 'workflows:fleet', 'workflows:migrate'] };
    }
    if (matches(token, config.intakeTokens)) {
      return { scope: { principalId: 'support-intake', projectId: config.scope.projectId }, agentIds: [intakeAgentId], expiresAtMs,
        capabilities: ['runs:submit', 'runs:read'] };
    }
    return null;
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

/**
 * Development secrets, kept in `.data/dev-secrets.json` (owner-only, ignored by git) so a restart under `mayura dev`
 * keeps the same tokens and an open console stays signed in. Production never uses this: it configures digests.
 */
export async function devSecrets<const N extends string>(names: readonly N[], file = '.data/dev-secrets.json'): Promise<Record<N, string>> {
  let stored: Record<string, unknown> = {};
  try { stored = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>; } catch { /* The first run creates them. */ }
  const valid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
  const secrets = Object.fromEntries(names.map(name => [name, valid(stored[name]) ? stored[name] : newToken()])) as Record<N, string>;
  if (names.some(name => secrets[name] !== stored[name])) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ ...stored, ...secrets }, null, 2)}\n`, { mode: 0o600 });
  }
  return secrets;
}
