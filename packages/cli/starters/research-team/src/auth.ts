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
 * - operators use the console and the workflow API to watch research runs, pause, resume or cancel them and hold
 *   the fleet; they can read every registered agent but submit none;
 * - desk callers (your application) submit requests to the research desk and read their results, and nothing else.
 * Identities last one minute; clients re-present their token on each request.
 */
export function authenticate(config: Config, agents: { readonly desk: string; readonly all: readonly string[] }) {
  return async ({ token }: { readonly token: string }): Promise<ServerIdentity | null> => {
    const expiresAtMs = Date.now() + 60_000;
    if (matches(token, config.operatorTokens)) {
      // Operator commands are journaled under the service scope; per-person attribution needs your identity provider.
      return { scope: config.scope, agentIds: [...agents.all], expiresAtMs,
        capabilities: ['runs:read', 'operations:read', 'workflows:read', 'workflows:control', 'workflows:fleet'] };
    }
    if (matches(token, config.deskTokens)) {
      return { scope: { principalId: 'research-desk', projectId: config.scope.projectId }, agentIds: [agents.desk], expiresAtMs,
        capabilities: ['runs:submit', 'runs:read'] };
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
