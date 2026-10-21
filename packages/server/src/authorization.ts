import { fromBase64Url, toBase64Url, sha256Hex } from '@mayura/core/host';
import { MayuraError, type AuthorizerOptions, type AuthorizationResourceKind } from '@mayura/core';
import type { ServerIdentity } from './index.js';
export interface ServerAuthorizationOptions extends AuthorizerOptions {
  /** Optional 32-byte AES key shared by replicas. Omission generates a process-local key; cursors expire after five minutes. */
  readonly cursorKey?: Uint8Array;
}
/** Sealed adapter continuations prevent forbidden row identifiers leaking through filtered pages. */
export function authorizationCursors(options: ServerAuthorizationOptions) {
  if (options.cursorKey !== undefined && (!(options.cursorKey instanceof Uint8Array) || options.cursorKey.byteLength !== 32))
    throw new MayuraError('INVALID_CONFIG', 'Authorization cursor keys require 32 bytes.');
  const bytes = options.cursorKey === undefined ? crypto.getRandomValues(new Uint8Array(32)) : new Uint8Array(options.cursorKey);
  const key = crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']); void key.catch(() => {});
  const version = options.policy.version; const encoder = new TextEncoder();
  const aad = (identity: ServerIdentity, context: string) => encoder.encode(sha256Hex(JSON.stringify([identity.scope.principalId, identity.scope.projectId, [...identity.agentIds].sort(), version, context])));
  const bad = (): never => { throw new MayuraError('INVALID_INPUT', 'Invalid authorization cursor.'); };
  return {
    async encode(cursor: string | null, identity: ServerIdentity, context: string): Promise<string | null> {
      if (cursor === null) return null;
      if (typeof cursor !== 'string' || cursor.length > 256) return bad();
      const payload = encoder.encode(JSON.stringify({ cursor, expiresAtMs: Math.min(Date.now() + 300_000, identity.expiresAtMs) }));
      if (payload.length > 320) return bad();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(identity, context) }, await key, payload));
      const output = new Uint8Array(iv.length + sealed.length); output.set(iv); output.set(sealed, iv.length);
      return `authz1.${toBase64Url(output)}`;
    },
    async decode(cursor: string | null, identity: ServerIdentity, context: string): Promise<string | null> {
      if (cursor === null) return null;
      try {
        if (!/^authz1\.[A-Za-z0-9_-]{40,500}$/.test(cursor)) return bad();
        const bytes = fromBase64Url(cursor.slice(7)); if (!bytes || bytes.length > 348 || bytes.length < 29 || toBase64Url(bytes) !== cursor.slice(7)) return bad();
        const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(bytes.slice(0, 12)), additionalData: aad(identity, context) }, await key, new Uint8Array(bytes.slice(12)));
        const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clear)) as Record<string, unknown>;
        if (!raw || Object.keys(raw).sort().join(',') !== 'cursor,expiresAtMs' || typeof raw['cursor'] !== 'string' || raw['cursor'].length > 256
          || !Number.isSafeInteger(raw['expiresAtMs']) || (raw['expiresAtMs'] as number) <= Date.now()) return bad();
        return raw['cursor'];
      } catch { return bad(); }
    },
  };
}
export interface ServerAuthorizationCheck {
  readonly kind: AuthorizationResourceKind; readonly id: string; readonly action: string;
  readonly capabilities: readonly ServerIdentity['capabilities'][number][];
}
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
function decoded(value: string): string {
  let id: string; try { id = decodeURIComponent(value); } catch { throw new MayuraError('INVALID_INPUT', 'Invalid scoped resource address.'); }
  if (!identifier.test(id)) throw new MayuraError('INVALID_INPUT', 'Invalid scoped resource address.'); return id;
}
/** Explicit HTTP authorization inventory. Unmapped authenticated paths fail closed when enforcement is enabled. */
export function serverAuthorizationRoute(method: string, path: string): readonly ServerAuthorizationCheck[] | null {
  const check = (kind: AuthorizationResourceKind, id: string, action: string, ...capabilities: ServerAuthorizationCheck['capabilities']): readonly ServerAuthorizationCheck[] => [{ kind, id, action, capabilities }];
  // Session exposes only the verified caller's own identity. These two creates bind concrete resources after body validation.
  if ((method === 'GET' && path === '/v1/session') || (method === 'POST' && ['/v1/runs', '/v1/threads'].includes(path))) return [];
  if (method === 'GET' && path === '/v1/agents') return check('agent', 'collection', 'list', 'runs:read');
  if (method === 'GET' && path === '/v1/tools') return check('tool', 'collection', 'list', 'operations:read');
  if (method === 'GET' && path === '/v1/operations/health') return check('server', 'health', 'read', 'operations:read');
  if (method === 'GET' && path === '/v1/threads') return check('thread', 'collection', 'list', 'threads:read');
  if (method === 'GET' && path === '/v1/workflow-runs') return check('workflow', 'collection', 'list', 'workflows:read');
  if (method === 'GET' && path === '/v1/human-requests') return check('human_request', 'collection', 'list', 'humans:read');
  const thread = /^\/v1\/threads\/([^/]+)(?:\/(entries|archive|restore))?$/.exec(path);
  if (thread) {
    const id = decoded(thread[1]!); const action = thread[2];
    if (method === 'GET' && (!action || action === 'entries')) return check('thread', id, 'read', 'threads:read');
    if (method === 'DELETE' && !action) return check('thread', id, 'delete', 'threads:delete');
    if (method === 'POST' && action === 'entries') return [...check('thread', id, 'import', 'threads:import', 'threads:write', 'threads:read'), ...check('thread', id, 'read', 'threads:read')];
    if (method === 'POST' && action !== 'entries') return [...check('thread', id, action ?? 'update', 'threads:write'), ...check('thread', id, 'read', 'threads:read')];
  }
  const compaction = /^\/v1\/threads\/([^/]+)\/compactions(?:\/([^/]+)(?:\/(cancel))?)?$/.exec(path);
  if (compaction) {
    const id = decoded(compaction[1]!); if (compaction[2]) decoded(compaction[2]);
    const action = method === 'GET' && compaction[2] && !compaction[3] ? 'inspect_compaction'
      : method === 'POST' && compaction[3] ? 'cancel_compaction' : method === 'POST' && !compaction[2] ? 'compact' : null;
    if (action) return [...check('thread', id, action, 'threads:compact', 'threads:read', ...(method === 'POST' ? ['threads:write' as const] : [])),
      ...check('thread', id, 'read', 'threads:read')];
  }
  const continuation = /^\/v1\/runs\/([a-f0-9-]{36})\/tool-results\/resume$/.exec(path);
  if (continuation && method === 'POST') return check('run', continuation[1]!, 'resume_tool', 'runs:resume', 'runs:read', 'threads:read', 'threads:write');
  const run = /^\/v1\/runs\/([a-f0-9-]{36})(?:\/(events|cancel|approvals))?$/.exec(path);
  if (run) {
    if (method === 'GET' && (!run[2] || run[2] === 'events')) return check('run', run[1]!, 'read', 'runs:read');
    if (method === 'POST' && ['cancel', 'approvals'].includes(run[2] ?? '')) return check('run', run[1]!, run[2] === 'cancel' ? 'cancel' : 'approve', run[2] === 'cancel' ? 'runs:cancel' : 'runs:approve');
  }
  const workflow = /^\/v1\/workflow-runs\/([a-f0-9]{64})(?:\/(cancel|approvals|signals|resume|pause|migrations)(?:\/([A-Za-z0-9][A-Za-z0-9._-]{0,127}))?)?$/.exec(path);
  if (workflow) {
    if (method === 'GET' && (!workflow[2] || workflow[2] === 'migrations')) return check('workflow', workflow[1]!, 'read', 'workflows:read');
    if (method === 'POST' && workflow[2]) {
      const action = ({ approvals: 'approve', signals: 'signal', migrations: 'migrate' } as Record<string, string>)[workflow[2]] ?? workflow[2];
      return [...check('workflow', workflow[1]!, action, action === 'migrate' ? 'workflows:migrate' : 'workflows:control'), ...check('workflow', workflow[1]!, 'read', 'workflows:read')];
    }
  }
  const fleet = /^\/v1\/workflow-fleet(?:\/(hold|release|sweeps\/pause|sweeps\/resume))?$/.exec(path);
  if (fleet && ((method === 'GET' && !fleet[1]) || (method === 'POST' && fleet[1]))) return check('server', 'workflow-fleet', fleet[1]?.replace('/', '_') ?? 'read', fleet[1] ? 'workflows:fleet' : 'workflows:read');
  const human = /^\/v1\/human-requests\/([A-Za-z0-9][A-Za-z0-9._-]{0,79})(?:\/(responses))?$/.exec(path);
  if (human && method === 'GET' && !human[2]) return check('human_request', human[1]!, 'read', 'humans:read');
  if (human && method === 'POST' && human[2]) return [...check('human_request', human[1]!, 'respond', 'humans:respond'), ...check('human_request', human[1]!, 'read', 'humans:read')];
  return null;
}
