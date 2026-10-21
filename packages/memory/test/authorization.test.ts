import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuthorizer, type AuthorizationAuditEvent, type Authorizer } from '@mayura/core';
import { createMemoryStore, createNativeMemory, hashingEmbedder, type MemoryStore, type NativeMemory } from '../src/index.js';
import { memoryInput } from './conformance.js';
import { sqliteFixture, type MemoryFixture } from './fixtures.js';
const scope = { principalId: 'owner', projectId: 'authz' };
const grants = ['memory:read', 'memory:write', 'memory:delete', 'memory:export', 'memory:import', 'memory:index'];
const owners: Authorizer[] = [];
function policy(denied = new Set<string>()) {
  const events: AuthorizationAuditEvent[] = [];
  const owner = createAuthorizer({ policy: { version: 'v1', authorize: request => ({ effect: denied.has(`${request.action}:${request.resource.id}`) ? 'deny' : 'allow',
    reason: denied.has(`${request.action}:${request.resource.id}`) ? 'explicit_deny' : 'allowed', policyVersion: 'v1', ruleId: null }) as never },
    permissions: { allow: ['authz:evaluate', 'authz:audit'] }, audit: { sink: event => { events.push(event); } } }); owners.push(owner); return { owner, events, denied };
}
for (const native of [false, true]) describe(native ? 'native memory authorization' : 'aggregate memory authorization', () => {
  let fixture: MemoryFixture; let base: MemoryStore;
  beforeEach(async () => { fixture = await sqliteFixture(); fixture = { ...fixture, store: { ...fixture.store, memory: { ...fixture.store.memory } } }; await fixture.store.initialize(); await fixture.store.memory.initialize();
    base = native ? createNativeMemory({ store: fixture.store, scope, permissions: { allow: grants } }) : createMemoryStore({ store: fixture.store, scope, permissions: { allow: grants } });
    for (const id of ['alpha', 'hidden', 'zeta']) await base.add(memoryInput({ id, content: `typescript ${id} private payload` })); });
  afterEach(async () => { owners.splice(0).forEach(owner => owner.close()); await fixture.store.close(); await fixture.cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
  function guarded(authorization: Authorizer, extra = {}) {
    const options = { store: fixture.store, scope, permissions: { allow: grants }, authorization, ...extra };
    return native ? createNativeMemory(options) : createMemoryStore(options);
  }
  it('denies direct reads and writes before storage, without disclosing content to audit sinks', async () => {
    const { owner, events } = policy(new Set(['read:hidden', 'create:new'])); const memory = guarded(owner);
    const read = native ? vi.spyOn(fixture.store.memory, 'getRecords') : vi.spyOn(fixture.store, 'read');
    await expect(memory.get('hidden')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' }); expect(read).not.toHaveBeenCalled();
    await expect(memory.add(memoryInput({ id: 'new' }))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' }); expect(read).not.toHaveBeenCalled();
    await owner.flushAudit(); expect(JSON.stringify(events)).not.toContain('private payload'); expect(events.some(event => event.decision.effect === 'deny')).toBe(true);
  });
  it('filters bounded pages/search/export and seals continuations across denied rows', async () => {
    const { owner } = policy(new Set(['read:hidden'])); const memory = guarded(owner);
    const one = await memory.list({ limit: 1 }); expect(one.records.map(row => row.id)).toEqual(['alpha']); expect(one.nextCursor).toMatch(/^ma1\./);
    const two = await memory.list({ limit: 1, cursor: one.nextCursor! }); expect(two.records).toEqual([]); expect(two.nextCursor).toMatch(/^ma1\./);
    const three = await memory.list({ limit: 1, cursor: two.nextCursor! }); expect(three.records.map(row => row.id)).toEqual(['zeta']);
    expect((await memory.search('typescript')).hits.map(hit => hit.record.id).sort()).toEqual(['alpha', 'zeta']);
    expect((await memory.exportSnapshot()).records.map(row => row.id)).not.toContain('hidden');
    await expect(memory.list({ cursor: one.nextCursor!, includeDeleted: true })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(guarded(owner).list({ cursor: one.nextCursor! })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('rechecks after write hooks and does not turn authorization denial into a storage exception', async () => {
    const { owner, denied } = policy(); const memory = guarded(owner, { hooks: { beforeMemoryWrite: () => { denied.add('correct:alpha'); return { decision: 'continue' }; } } });
    await expect(memory.correct({ ...memoryInput({ id: 'alpha', content: 'Changed' }), expectedVersion: 1 })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect((await base.get('alpha') as { content: string }).content).toContain('typescript');
  });
  it('keeps static capability admission before policy evaluation and refuses unavailable policies', async () => {
    const evaluate = vi.fn(() => { throw new Error('SECRET policy diagnostics'); });
    const owner = createAuthorizer({ policy: { version: 'v1', authorize: evaluate }, permissions: { allow: ['authz:evaluate'] } }); owners.push(owner);
    await expect(guarded(owner, { permissions: { allow: [] } }).get('alpha')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' }); expect(evaluate).not.toHaveBeenCalled();
    await expect(guarded(owner).search('typescript')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
  if (native) {
    it('does not expose or traverse graph edges with a denied endpoint', async () => {
      const raw = base as NativeMemory; const provenance = memoryInput().provenance;
      await raw.relate({ id: 'edge', from: 'alpha', to: 'hidden', relation: 'related', confidence: 1, provenance });
      const { owner } = policy(new Set(['read:hidden'])); const memory = guarded(owner) as NativeMemory;
      expect((await memory.neighbors('alpha')).edges).toEqual([]); expect((await memory.traverse('alpha')).records.map(row => row.id)).not.toContain('hidden');
      await expect(memory.changes()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    });
    it('gates paid indexing and every record before embedding content', async () => {
      const embedder = hashingEmbedder(); const embed = vi.fn(embedder.embed.bind(embedder)); const { owner } = policy(new Set(['index:hidden']));
      const memory = guarded(owner, { embedder: { ...embedder, embed } }) as NativeMemory;
      await memory.index(); expect(embed.mock.calls.flatMap(([texts]) => texts).join(' ')).not.toContain('hidden');
    });
    it('rechecks authorization before each embedding batch when policy changes during indexing', async () => {
      const local = hashingEmbedder(); const { owner, denied } = policy();
      const embed = vi.fn(async (texts: readonly string[], signal: AbortSignal) => { denied.add('index:zeta'); return local.embed(texts, signal); });
      const memory = guarded(owner, { embedder: { ...local, maxBatch: 1, embed } }) as NativeMemory;
      await expect(memory.index()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      expect(embed.mock.calls.flatMap(([texts]) => texts).join(' ')).not.toContain('zeta');
    });
    it('preflights every imported resource before writing any record', async () => {
      const { owner } = policy(new Set(['import:hidden'])); const memory = guarded(owner) as NativeMemory;
      const snapshot = await base.exportSnapshot(); const put = vi.spyOn(fixture.store.memory, 'putRecord');
      await expect(memory.importSnapshot(snapshot, { mode: 'merge' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' }); expect(put).not.toHaveBeenCalled();
    });
  }
});
