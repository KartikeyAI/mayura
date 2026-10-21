import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthorizer, type AuthorizationAuditEvent, type Authorizer } from '@mayura/core';
import type { MemoryRecord, MemoryStore } from '@mayura/memory';
import { createRemoteMemoryBridge, type RemoteMemoryAdapter } from '../src/index.js';
const scope = { principalId: 'alice', projectId: 'shop' }; const owners: Authorizer[] = [];
afterEach(() => owners.splice(0).forEach(owner => owner.close()));
const record: MemoryRecord = { id: 'private-record', version: 1, status: 'active', scope, content: 'SECRET payload', category: 'fact',
  contentSha256: 'a'.repeat(64), metadata: {}, sensitivity: 'internal', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  validity: { from: '2026-10-01T00:00:00.000Z', until: null }, provenance: { sourceId: 'source', reference: 'source://one', revision: '1',
    sha256: 'b'.repeat(64), author: 'alice', observedAt: '2026-10-01T00:00:00.000Z', origin: 'observed', confidence: 1 } };
function setup(denied = new Set<string>()) {
  const events: AuthorizationAuditEvent[] = []; const authorization = createAuthorizer({ policy: { version: 'v1', authorize: request => denied.has(request.action)
    ? { effect: 'deny', reason: 'explicit_deny', policyVersion: 'v1', ruleId: null } : { effect: 'allow', reason: 'allowed', policyVersion: 'v1', ruleId: null } },
    permissions: { allow: ['authz:evaluate', 'authz:audit'] }, audit: { sink: event => { events.push(event); } } }); owners.push(authorization);
  const get = vi.fn(async () => record); const canonical = { get } as unknown as MemoryStore;
  const publish = vi.fn(async () => ({ status: 'applied' as const, reference: { provider: 'fake', kind: 'entry' as const, id: 'remote' } }));
  const search = vi.fn<RemoteMemoryAdapter['search']>(async () => []);
  const adapter: RemoteMemoryAdapter = { id: 'fake', publish, remove: vi.fn(async () => {}), search };
  const bridge = createRemoteMemoryBridge({ scope, canonical, adapter, authorization });
  return { bridge, authorization, events, get, publish, search, denied, canonical, adapter };
}
describe('remote memory authorization', () => {
  it('denies publication before canonical storage or remote writes, with metadata-only auditing', async () => {
    const { bridge, authorization, events, get, publish } = setup(new Set(['publish']));
    await expect(bridge.publish(record)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' }); await authorization.flushAudit();
    expect(get).not.toHaveBeenCalled(); expect(publish).not.toHaveBeenCalled(); expect(events).toHaveLength(1); expect(JSON.stringify(events)).not.toContain('SECRET');
  });
  it('denies remote search admission before query disclosure', async () => {
    const { bridge, search } = setup(new Set(['search_remote'])); await expect(bridge.search('SECRET query')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' }); expect(search).not.toHaveBeenCalled();
  });
  it('filters denied canonical candidates before lookup without exposing references or denial diagnostics', async () => {
    const { bridge, search, get } = setup(new Set(['read']));
    search.mockResolvedValue([{ namespace: bridge.namespace, canonicalId: record.id, canonicalVersion: 1, contentSha256: record.contentSha256,
      score: 1, reference: { provider: 'fake', kind: 'entry', id: 'private-reference' } }]);
    const result = await bridge.search('query'); expect(result.hits).toEqual([]); expect(get).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain('private-reference');
  });
  it('rechecks after hooks and refuses cross-scope publication through the core boundary', async () => {
    const { authorization, denied, canonical, adapter, publish } = setup();
    const bridge = createRemoteMemoryBridge({ scope, canonical, adapter, authorization, hooks: { beforeMemoryWrite: () => { denied.add('publish'); return { decision: 'continue' }; } } });
    await expect(bridge.publish(record)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' }); expect(publish).not.toHaveBeenCalled();
    await expect(bridge.publish({ ...record, scope: { ...scope, projectId: 'other' } })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});
