import { MayuraError, type Authorizer, type Scope } from '@mayura/core';
import { fromBase64Url, toBase64Url } from '@mayura/core/host';

// Services sharing one host authorizer can resume each other's cursors. No row IDs or allow decisions are retained.
const cursorKeys = new WeakMap<Authorizer, Promise<CryptoKey>>();
export function threadAuthorization(authorization: Authorizer | undefined, scope: Scope, defaultSignal?: AbortSignal) {
  let evaluate: Authorizer['authorize'] | undefined;
  try {
    if (defaultSignal !== undefined && !(defaultSignal instanceof AbortSignal)) throw new Error();
    if (authorization !== undefined) {
      if (!authorization || typeof authorization.authorize !== 'function') throw new Error();
      evaluate = authorization.authorize.bind(authorization);
    }
  } catch { throw new MayuraError('INVALID_CONFIG', 'Thread authorization requires a core authorizer and a valid optional signal.'); }
  const check = (signal = defaultSignal): void => { if (signal?.aborted || defaultSignal?.aborted) throw new MayuraError('CANCELLED', 'Thread operation was cancelled.'); };
  const can = async (id: string, action: string, signal = defaultSignal): Promise<boolean> => {
    check(signal); if (!evaluate) return true;
    const effectiveSignal = defaultSignal && signal && defaultSignal !== signal ? AbortSignal.any([defaultSignal, signal]) : signal;
    try {
      const decision = await evaluate(scope, action, { kind: 'thread', id, scope, ...(action === 'list' ? {} : { ownerId: scope.principalId }) },
        { ...(effectiveSignal === undefined ? {} : { signal: effectiveSignal }) });
      check(signal);
      if (decision?.effect === 'allow') return true;
      if (decision?.effect === 'deny' && ['no_match', 'explicit_deny', 'permission_denied', 'scope_mismatch'].includes(decision.reason)) return false;
    } catch { check(signal); }
    throw new MayuraError('PERMISSION_DENIED', 'Thread operation is not authorized.');
  };
  const require = async (id: string, action: string, signal?: AbortSignal): Promise<void> => {
    if (!await can(id, action, signal)) throw new MayuraError('PERMISSION_DENIED', 'Thread operation is not authorized.');
  };
  const badCursor = (): never => { throw new MayuraError('INVALID_INPUT', 'Invalid thread authorization cursor.'); };
  const encoder = new TextEncoder();
  const aad = (view: string) => encoder.encode(JSON.stringify([scope.principalId, scope.projectId, view]));
  const key = (): Promise<CryptoKey> => {
    let saved = cursorKeys.get(authorization!);
    if (!saved) {
      saved = crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), 'AES-GCM', false, ['encrypt', 'decrypt']);
      cursorKeys.set(authorization!, saved); void saved.catch(() => {});
    }
    return saved;
  };
  return Object.freeze({ require, can, check,
    async encode(cursor: string | null, view: string): Promise<string | null> {
      if (!evaluate || cursor === null) return cursor;
      if (typeof cursor !== 'string' || cursor.length > 256) return badCursor();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const clear = encoder.encode(JSON.stringify({ cursor, expiresAtMs: Date.now() + 300_000 }));
      const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(view) }, await key(), clear));
      const bytes = new Uint8Array(iv.length + encrypted.length); bytes.set(iv); bytes.set(encrypted, iv.length);
      check(); return `thauth1.${toBase64Url(bytes)}`;
    },
    async decode(cursor: string | undefined, view: string): Promise<string | undefined> {
      if (!evaluate || cursor === undefined) return cursor;
      try {
        if (typeof cursor !== 'string' || !/^thauth1\.[A-Za-z0-9_-]{40,700}$/.test(cursor)) return badCursor();
        const bytes = fromBase64Url(cursor.slice(8));
        if (!bytes || bytes.length < 29 || bytes.length > 500 || toBase64Url(bytes) !== cursor.slice(8)) return badCursor();
        const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(bytes.slice(0, 12)), additionalData: aad(view) },
          await key(), new Uint8Array(bytes.slice(12)));
        const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clear)) as Record<string, unknown>;
        if (!raw || Object.keys(raw).sort().join(',') !== 'cursor,expiresAtMs' || typeof raw['cursor'] !== 'string' || raw['cursor'].length > 256
          || !Number.isSafeInteger(raw['expiresAtMs']) || (raw['expiresAtMs'] as number) <= Date.now()) return badCursor();
        check(); return raw['cursor'];
      } catch { check(); return badCursor(); }
    },
  });
}
export type ThreadAuthorization = ReturnType<typeof threadAuthorization>;
