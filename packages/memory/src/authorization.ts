import { MayuraError, type Authorizer, type Scope } from '@mayura/core';
import { fromBase64Url, toBase64Url } from '@mayura/core/host';
/** Internal memory boundary. The host owns the core authorizer and its audit/close lifecycle. */
export function memoryAuthorization(scope: Scope, authorizer: Authorizer | undefined) {
  if (authorizer !== undefined && (!authorizer || typeof authorizer.authorize !== 'function'))
    throw new MayuraError('INVALID_CONFIG', 'Memory authorization requires a core authorizer.');
  const evaluate = authorizer?.authorize.bind(authorizer);
  const refused = (): never => { throw new MayuraError('PERMISSION_DENIED', 'The memory operation is not authorized.'); };
  const can = async (id: string, action = 'read', signal?: AbortSignal): Promise<boolean> => {
    if (signal?.aborted) throw new MayuraError('CANCELLED', 'Memory authorization was cancelled.');
    if (!evaluate) return true;
    const decision = await evaluate(scope, action, { kind: 'memory', id, scope, ...(id === 'collection' && ['list', 'search', 'export', 'index', 'import', 'changes'].includes(action) ? {} : { ownerId: scope.principalId }) }, signal ? { signal } : undefined);
    if (decision.effect === 'allow') return true;
    // Policy outages and cancellation must not become an empty successful result or a fallback retrieval.
    if (!['no_match', 'explicit_deny', 'permission_denied', 'scope_mismatch', 'invalid_request'].includes(decision.reason)) return refused();
    return false;
  };
  let key: Promise<CryptoKey> | undefined;
  const secret = () => key ??= crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const aad = (view: string) => new TextEncoder().encode(JSON.stringify([scope.principalId, scope.projectId, view]));
  const invalid = (): never => { throw new MayuraError('INVALID_INPUT', 'The memory authorization cursor is invalid or expired.'); };
  return Object.freeze({
    enabled: evaluate !== undefined, can,
    async require(id: string, action: string, signal?: AbortSignal): Promise<void> { if (!await can(id, action, signal)) return refused(); },
    async seal(cursor: string | undefined, view: string): Promise<string | undefined> {
      if (!evaluate || cursor === undefined) return cursor;
      if (cursor.length > 1024) return invalid();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const bytes = new TextEncoder().encode(JSON.stringify({ cursor, expiresAt: Date.now() + 300_000 }));
      const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(view) }, await secret(), bytes));
      const output = new Uint8Array(iv.length + sealed.length); output.set(iv); output.set(sealed, iv.length); return `ma1.${toBase64Url(output)}`;
    },
    async open(cursor: unknown, view: string): Promise<unknown> {
      if (!evaluate || cursor === undefined) return cursor;
      try {
        if (typeof cursor !== 'string' || !/^ma1\.[A-Za-z0-9_-]{40,1600}$/.test(cursor)) return invalid();
        const bytes = fromBase64Url(cursor.slice(4)); if (!bytes || toBase64Url(bytes) !== cursor.slice(4)) return invalid();
        const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(bytes.slice(0, 12)), additionalData: aad(view) }, await secret(), new Uint8Array(bytes.slice(12)));
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clear)) as Record<string, unknown>;
        if (!value || Object.keys(value).sort().join(',') !== 'cursor,expiresAt' || typeof value['cursor'] !== 'string' || value['cursor'].length > 1024
          || !Number.isSafeInteger(value['expiresAt']) || (value['expiresAt'] as number) <= Date.now()) return invalid();
        return value['cursor'];
      } catch { return invalid(); }
    },
  });
}
