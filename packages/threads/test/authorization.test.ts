import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthorizer, type AuthorizationAuditEvent, type AuthorizationRequest, type Authorizer } from '@mayura/core';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { createThreads } from '../src/index.js';

const scope = { principalId: 'alice', projectId: 'shop' };
const permissions = { allow: ['thread:read', 'thread:write', 'thread:delete'] };
let store: ReturnType<typeof createSqliteStore>;
const owners: Authorizer[] = [];
beforeEach(async () => { store = createSqliteStore({ filename: ':memory:' }); store = { ...store, threads: { ...store.threads }, runCheckpoints: { ...store.runCheckpoints } }; await store.initialize(); await store.threads.initialize(); });
afterEach(async () => { owners.splice(0).forEach(owner => owner.close()); await store.close(); });
function policy(deny: (request: AuthorizationRequest) => boolean) {
  const events: AuthorizationAuditEvent[] = [];
  const authorization = createAuthorizer({ permissions: { allow: ['authz:evaluate', 'authz:audit'] },
    audit: { sink: event => { events.push(event); } }, policy: { version: 'v1', authorize: request => deny(request)
      ? { effect: 'deny', reason: 'explicit_deny', policyVersion: 'v1', ruleId: null }
      : { effect: 'allow', reason: 'allowed', policyVersion: 'v1', ruleId: null } } });
  owners.push(authorization); return { authorization, events };
}

describe('scoped thread authorization', () => {
  it('denies creation before storage and emits metadata without title or content', async () => {
    const { authorization, events } = policy(request => request.action === 'create');
    const create = vi.spyOn(store.threads, 'create');
    const threads = createThreads({ store, scope, permissions, authorization });
    await expect(threads.create({ id: 'private', title: 'SECRET title' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(create).not.toHaveBeenCalled(); await authorization.flushAudit();
    expect(events).toHaveLength(1); expect(events[0]?.request?.resource).toEqual({ kind: 'thread', id: 'private', scope, ownerId: 'alice' });
    expect(JSON.stringify(events)).not.toContain('SECRET');
  });

  it('enforces static grants before consulting policy', async () => {
    const { authorization, events } = policy(() => false);
    const threads = createThreads({ store, scope, permissions: { allow: [] }, authorization });
    await expect(threads.get('private')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await authorization.flushAudit(); expect(events).toEqual([]);
  });

  it('filters forbidden rows but preserves an opaque scanned continuation across scoped service instances', async () => {
    const raw = createThreads({ store, scope, permissions });
    await raw.create({ id: 'private-1' }); await raw.create({ id: 'private-2' }); await raw.create({ id: 'visible' });
    const { authorization } = policy(request => request.action === 'read' && request.resource.id.startsWith('private'));
    const guarded = createThreads({ store, scope, permissions, authorization });
    let cursor: string | undefined; const seen: string[] = [];
    for (let page = 0; page < 4; page++) {
      const service = createThreads({ store, scope, permissions, authorization });
      const result = await service.list({ limit: 1, ...(cursor ? { cursor } : {}) });
      seen.push(...result.threads.map(thread => thread.id));
      if (result.cursor === null) break;
      expect(result.cursor).toMatch(/^thauth1\./); expect(result.cursor).not.toContain('private');
      cursor = result.cursor;
    }
    expect(seen).toEqual(['visible']);
    const first = await guarded.list({ limit: 1 }); expect(first.cursor).not.toBeNull();
    await expect(guarded.list({ cursor: first.cursor!, status: 'archived' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const other = createThreads({ store, scope: { ...scope, principalId: 'bob' }, permissions, authorization });
    await expect(other.list({ cursor: first.cursor! })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('withholds a read revoked during storage without disclosing the thread', async () => {
    await createThreads({ store, scope, permissions }).create({ id: 'private', title: 'SECRET' });
    let revoked = false; const { authorization } = policy(() => revoked);
    const original = store.threads.get.bind(store.threads);
    const wrapped = { threads: { ...store.threads, get: async (command: Parameters<typeof original>[0]) => {
      const result = await original(command); revoked = true; return result;
    } } };
    const guarded = createThreads({ store: wrapped, scope, permissions, authorization });
    await expect(guarded.get('private')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('does not silently filter policy failures into a successful empty list', async () => {
    await createThreads({ store, scope, permissions }).create({ id: 'private' });
    const { authorization } = policy(request => { if (request.action === 'read') throw new Error('SECRET policy diagnostic'); return false; });
    const guarded = createThreads({ store, scope, permissions, authorization });
    await expect(guarded.list()).rejects.toMatchObject({ code: 'PERMISSION_DENIED', message: 'Thread operation is not authorized.' });
  });

  it('cancels a policy wait before storage and leaves the host authorizer open', async () => {
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); let waiting = true;
    const authorization = createAuthorizer({ permissions: { allow: ['authz:evaluate'] }, policy: { version: 'v1',
      authorize: async (_request, { signal }) => { if (waiting) { entered(); await new Promise<void>(resolve => {
        if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true });
      }); } return { effect: 'allow', reason: 'allowed', policyVersion: 'v1', ruleId: null }; },
    } }); owners.push(authorization);
    const control = new AbortController(); const get = vi.spyOn(store.threads, 'get');
    const threads = createThreads({ store, scope, permissions, authorization, signal: control.signal });
    const pending = threads.get('private'); const denied = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await started; control.abort(); await denied; expect(get).not.toHaveBeenCalled(); waiting = false;
    expect((await authorization.authorize(scope, 'read', { kind: 'thread', id: 'private', scope })).effect).toBe('allow');
  });
});
