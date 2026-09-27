import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ServerIdentity } from 'mayura/server-node';
import type { Config } from './config.js';
import { customerIdPattern, verifySessionToken } from './session.js';

// Operator bearer tokens are 64 hex characters. Configuration holds only their SHA-256 digests, never the tokens.
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
 * Every signed-in customer runs in their own scope. The server keys runs by it (a customer can never read another
 * customer's run), native memory is partitioned by it, and every tool reads the customer from it.
 * (The server accepts `[A-Za-z0-9._/-]` in principal ids, so the namespace separator is `/`.)
 */
export const customerPrincipal = (customerId: string): string => `customer/${customerId}`;
export function customerFromScope(scope: { readonly principalId: string; readonly projectId: string }, projectId: string): string | undefined {
  const match = /^customer\/(.+)$/u.exec(scope.principalId);
  return match && customerIdPattern.test(match[1]!) && scope.projectId === projectId ? match[1] : undefined;
}

/**
 * Two kinds of caller:
 * - customers, with a session token your backend minted (src/session.ts), may start and read their own chat runs;
 * - operators, with a bearer token, use the console at /inspector: agents, tools, and the return follow-up workflows.
 * Identities last at most one minute and never outlive the session; clients re-present their token on each request.
 */
export function authenticate(config: Config, agentIds: readonly string[]) {
  return async ({ token }: { readonly token: string }): Promise<ServerIdentity | null> => {
    const now = Date.now();
    if (token.startsWith('v1.')) {
      const session = verifySessionToken(config.sessionSecret, token, now);
      if (!session) return null;
      return { scope: { principalId: customerPrincipal(session.customerId), projectId: config.projectId }, agentIds: [...agentIds],
        capabilities: ['runs:submit', 'runs:read'], expiresAtMs: Math.min(session.expiresAtMs, now + 60_000) };
    }
    if (matches(token, config.operatorTokens)) {
      // Operators observe and steer the service; they cannot chat as a customer (no runs:submit) or read customer chats.
      return { scope: config.scope, agentIds: [...agentIds], expiresAtMs: now + 60_000,
        capabilities: ['runs:read', 'operations:read', 'workflows:read', 'workflows:control', 'workflows:fleet'] };
    }
    return null;
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
