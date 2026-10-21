import { sha256Hex } from 'mayura/core/host';

export const agentId = 'notebook.assistant';
export const capabilities = Object.freeze(['runs:read', 'runs:submit', 'runs:cancel', 'runs:approve', 'threads:read', 'threads:write']);
/** Snapshot a bounded host-owned identity directory. Browser claims never set scope or capabilities. */
export function identityDirectory(projectId, sessions) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(projectId) || !Array.isArray(sessions) || !sessions.length || sessions.length > 32) throw new Error('Invalid identity configuration.');
  const seen = new Set();
  const entries = sessions.map(item => {
    if (!item || Object.keys(item).some(key => !['tokenSha256', 'principalId', 'expiresAtMs'].includes(key))
      || !/^[a-f0-9]{64}$/u.test(item.tokenSha256) || seen.has(item.tokenSha256)
      || typeof item.principalId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(item.principalId)
      || !Number.isSafeInteger(item.expiresAtMs) || item.expiresAtMs < 1) throw new Error('Invalid identity configuration.');
    seen.add(item.tokenSha256);
    return Object.freeze({ ...item, scope: Object.freeze({ principalId: item.principalId, projectId }) });
  });
  const scopes = [...new Map(entries.map(item => [item.principalId, item.scope])).values()];
  return Object.freeze({ scopes: Object.freeze(scopes), authenticate: async ({ token, signal }) => {
    if (signal.aborted || typeof token !== 'string' || !/^[a-f0-9]{64}$/u.test(token)) return null;
    const digest = await sha256Hex(token); if (signal.aborted) return null;
    const entry = entries.find(item => item.tokenSha256 === digest);
    return entry && entry.expiresAtMs > Date.now() ? { scope: entry.scope, agentIds: [agentId], capabilities, expiresAtMs: entry.expiresAtMs } : null;
  } });
}
