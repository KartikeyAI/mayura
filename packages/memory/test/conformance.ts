import { createHash } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { MayuraError, type JsonObject } from '@mayura/core';
import { StorageError, type AggregateStore, type CreateRecord } from '@mayura/storage';
import { createMemoryStore, type MemoryInput, type MemoryStore, type MemoryStoreOptions } from '../src/index.js';
import type { MemoryFixture } from './fixtures.js';

const allGrants = ['memory:read', 'memory:write', 'memory:delete', 'memory:export'];
export function memoryInput(overrides: Partial<MemoryInput> = {}): MemoryInput {
  return {
    id: 'memory-1', content: 'The project uses TypeScript for reliable agents.', metadata: { accepted: true },
    provenance: { sourceId: 'spec-1', reference: 'local:requirements.md', revision: 'v1', sha256: 'a'.repeat(64), author: 'human:owner', observedAt: '2026-01-01T00:00:00.000Z', origin: 'observed', confidence: 1 },
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(complete => { resolve = complete; }); return { promise, resolve };
}

export function memoryConformance(name: string, factory: () => Promise<MemoryFixture>): void {
  describe(`${name} native memory`, () => {
    let fixture: MemoryFixture; let store: AggregateStore; let memory: MemoryStore;
    const service = (overrides: Partial<MemoryStoreOptions> = {}) => createMemoryStore({
      store, scope: { principalId: 'owner', projectId: 'project-a' }, permissions: { allow: allGrants }, ...overrides,
    });
    beforeEach(async () => { fixture = await factory(); store = fixture.store; await store.initialize(); memory = service(); });
    afterEach(async () => { await store?.close(); await fixture?.cleanup(); });

    it('persists exact provenance and offers read-your-writes with immutable API/snapshots', async () => {
      const input = memoryInput(); const created = await memory.add(input);
      expect(created).toMatchObject({ id: input.id, version: 1, status: 'active', category: 'fact', sensitivity: 'internal', scope: { principalId: 'owner', projectId: 'project-a' } });
      expect(created.provenance).toEqual(input.provenance);
      expect(created.contentSha256).toBe(createHash('sha256').update(input.content).digest('hex'));
      expect(await memory.get(input.id)).toEqual(created);
      expect(Object.isFrozen(memory)).toBe(true); expect(Object.isFrozen(created)).toBe(true); expect(Object.isFrozen(created.metadata)).toBe(true);
      expect(() => { (created.metadata as JsonObject)['accepted'] = false; }).toThrow();
      expect((await memory.get(input.id))?.status).toBe('active');
    });

    it('serves empty scopes without any persistent initialization writes', async () => {
      const create = vi.fn(store.create.bind(store)); const update = vi.fn(store.update.bind(store));
      const reader = service({ store: { ...store, create, update }, permissions: { allow: ['memory:read', 'memory:export'] } });
      expect(await reader.get('missing')).toBeUndefined(); expect((await reader.list()).records).toEqual([]);
      expect((await reader.search('missing')).hits).toEqual([]); expect((await reader.exportSnapshot()).records).toEqual([]);
      expect(create).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
    });

    it('denies missing grants before touching storage', async () => {
      const read = vi.fn(store.read.bind(store)); const denied = service({ store: { ...store, read }, permissions: { allow: [] } });
      for (const action of [() => denied.get('memory-1'), () => denied.list(), () => denied.search('project'), () => denied.exportSnapshot(), () => denied.add(memoryInput()), () => denied.forget({ id: 'memory-1', expectedVersion: 1 })]) {
        await expect(action()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      }
      expect(read).not.toHaveBeenCalled();
      const exportOnly = service({ permissions: { allow: ['memory:export'] } });
      await expect(exportOnly.exportSnapshot()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    });

    it('isolates identical IDs by both principal and project', async () => {
      await memory.add(memoryInput());
      for (const scope of [{ principalId: 'other', projectId: 'project-a' }, { principalId: 'owner', projectId: 'project-b' }]) {
        const isolated = service({ scope }); expect(await isolated.get('memory-1')).toBeUndefined();
        expect((await isolated.list()).records).toEqual([]); expect((await isolated.search('TypeScript')).hits).toEqual([]);
        expect((await isolated.exportSnapshot()).records).toEqual([]);
        await expect(isolated.correct({ ...memoryInput(), expectedVersion: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect((await isolated.add(memoryInput({ content: 'isolated scope' }))).version).toBe(1);
      }
      expect((await memory.search('TypeScript')).hits).toHaveLength(1);
    });

    it('filters sensitivity before get/list/search/export and enforces it on mutations', async () => {
      const privileged = service({ allowedSensitivities: ['public', 'internal', 'confidential', 'restricted'] });
      const restricted = await privileged.add(memoryInput({ sensitivity: 'restricted', content: 'restricted needle' }));
      expect(await memory.get(restricted.id)).toBeUndefined(); expect((await memory.list()).records).toEqual([]);
      expect((await memory.search('needle')).hits).toEqual([]); expect((await memory.exportSnapshot()).records).toEqual([]);
      await expect(memory.add(memoryInput({ id: 'another', sensitivity: 'restricted' }))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      await expect(memory.correct({ ...memoryInput(), expectedVersion: 1 })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      await expect(memory.forget({ id: restricted.id, expectedVersion: 1 })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      await privileged.forget({ id: restricted.id, expectedVersion: 1 });
      expect(await memory.get(restricted.id, { includeDeleted: true })).toBeUndefined();
      expect((await privileged.exportSnapshot()).records[0]?.status).toBe('deleted');
    });

    it('corrects with explicit provenance and rejects stale record versions', async () => {
      const first = await memory.add(memoryInput());
      const nextInput = memoryInput({ content: 'The accepted decision now uses PostgreSQL.', provenance: { ...memoryInput().provenance, revision: 'v2', origin: 'inferred', confidence: 0.8 } });
      const corrected = await memory.correct({ ...nextInput, expectedVersion: first.version });
      expect(corrected.version).toBe(2); expect(corrected.createdAt).toBe(first.createdAt); expect(corrected.provenance).toEqual(nextInput.provenance);
      expect((await memory.search('TypeScript')).hits).toEqual([]); expect((await memory.search('PostgreSQL')).hits).toHaveLength(1);
      await expect(memory.correct({ ...memoryInput(), expectedVersion: 1 })).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('serializes concurrent same-record corrections while preserving unrelated writes', async () => {
      const first = await memory.add(memoryInput()); const secondService = service();
      const corrections = await Promise.allSettled([memory, secondService].map((candidate, index) => candidate.correct({ ...memoryInput({ content: `winner ${index}` }), expectedVersion: first.version })));
      expect(corrections.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(corrections.filter(result => result.status === 'rejected')).toHaveLength(1);
      expect((await memory.get(first.id))?.version).toBe(2);
      await Promise.all([memory.add(memoryInput({ id: 'a' })), secondService.add(memoryInput({ id: 'b' }))]);
      expect((await memory.list()).records.map(record => record.id)).toEqual(['a', 'b', 'memory-1']);
    });

    it('scrubs forgotten plaintext from current state/events/all public views and prevents resurrection', async () => {
      let aggregate: CreateRecord | undefined;
      const capturing: AggregateStore = { ...store, create: async command => { aggregate = command; return store.create(command); } };
      const writer = service({ store: capturing });
      const secret = 'delete secret needle'; const reference = 'local:private-source-reference';
      const input = memoryInput({ content: secret, metadata: { secret }, provenance: { ...memoryInput().provenance, reference } });
      const created = await writer.add(input);
      expect((await writer.search('needle')).hits).toHaveLength(1);
      const deleted = await writer.forget({ id: created.id, expectedVersion: created.version });
      expect(deleted).toMatchObject({ id: created.id, version: 2, status: 'deleted' });
      expect('content' in deleted).toBe(false); expect('provenance' in deleted).toBe(false); expect('metadata' in deleted).toBe(false);
      expect(await writer.get(created.id)).toBeUndefined(); expect((await writer.list()).records).toEqual([]); expect((await writer.search('needle')).hits).toEqual([]);
      expect(await writer.get(created.id, { includeDeleted: true })).toEqual(deleted);
      const exported = await writer.exportSnapshot(); expect(exported.records).toEqual([deleted]);
      const current = await store.read(aggregate!.scope, aggregate!.id); const events = await store.events(aggregate!.scope, aggregate!.id);
      const serialized = JSON.stringify({ current, events, exported }); expect(serialized).not.toContain(secret); expect(serialized).not.toContain(reference);
      await expect(writer.correct({ ...input, expectedVersion: 1 })).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(writer.correct({ ...input, expectedVersion: 2 })).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(writer.add(input)).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('provides deterministic lexical matches, not semantic or substring claims', async () => {
      await memory.add(memoryInput({ id: 'a', content: 'TypeScript supports agents. TypeScript helps.' }));
      await memory.add(memoryInput({ id: 'b', content: 'TypeScript supports applications.' }));
      await memory.add(memoryInput({ id: 'c', content: 'JavaScript supports applications.' }));
      const found = await memory.search('TYPESCRIPT supports');
      expect(found.mode).toBe('lexical'); expect(found.hits.map(hit => hit.record.id)).toEqual(['a', 'b']);
      expect(found.hits.map(hit => hit.score)).toEqual([3, 2]); expect(found.hits[0]?.matchedTerms).toEqual(['typescript', 'supports']);
      expect((await memory.search('type')).hits).toEqual([]); expect((await memory.search('coding')).hits).toEqual([]);
      await expect(memory.search('!?!')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });

    it('excludes expired/future facts from retrieval while preserving authorized inspection', async () => {
      await memory.add(memoryInput({ id: 'expired', content: 'expired evidence', validity: { from: '2000-01-01T00:00:00.000Z', until: '2001-01-01T00:00:00.000Z' } }));
      await memory.add(memoryInput({ id: 'future', content: 'future evidence', validity: { from: '2099-01-01T00:00:00.000Z', until: null } }));
      expect((await memory.search('evidence')).hits).toEqual([]); expect((await memory.list()).records).toHaveLength(2);
      expect((await memory.get('expired'))?.status).toBe('active');
    });

    it('paginates stable snapshots and rejects changed or cross-scope cursors', async () => {
      for (const id of ['c', 'a', 'b']) await memory.add(memoryInput({ id }));
      const first = await memory.list({ limit: 1 }); expect(first.records[0]?.id).toBe('a'); expect(first.nextCursor).toBeDefined();
      const second = await memory.list({ limit: 1, cursor: first.nextCursor! }); expect(second.records[0]?.id).toBe('b');
      const other = service({ scope: { principalId: 'owner', projectId: 'other' } });
      await expect(other.list({ cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'CONFLICT' });
      await memory.correct({ ...memoryInput({ id: 'a', content: 'corrected' }), expectedVersion: 1 });
      await expect(memory.list({ cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('retains canonical records, corrections and tombstones after reopening storage', async () => {
      await memory.add(memoryInput()); await memory.add(memoryInput({ id: 'deleted' }));
      await memory.correct({ ...memoryInput({ content: 'persisted correction' }), expectedVersion: 1 });
      await memory.forget({ id: 'deleted', expectedVersion: 1 });
      await store.close(); store = fixture.reopen(); await store.initialize(); memory = service();
      expect((await memory.get('memory-1'))?.version).toBe(2); expect((await memory.search('persisted')).hits).toHaveLength(1);
      expect((await memory.get('deleted', { includeDeleted: true }))?.status).toBe('deleted');
      expect((await memory.exportSnapshot()).records).toHaveLength(2);
    });

    it('bounds content/metadata/provenance and rejects mutation typos before write', async () => {
      const invalid = [
        { ...memoryInput(), content: 'x'.repeat(4_097) }, { ...memoryInput(), metadata: { text: 'x'.repeat(2_049) } },
        { ...memoryInput(), provenance: { ...memoryInput().provenance, confidence: 2 } },
        { ...memoryInput(), provenance: { ...memoryInput().provenance, sha256: 'not-a-hash' } },
        { ...memoryInput(), provenance: { ...memoryInput().provenance, observedAt: '2026-01-01' } },
        { ...memoryInput(), contentTypo: 'bad field' },
      ];
      for (const item of invalid) await expect(memory.add(item)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect((await memory.list()).records).toEqual([]);
      await expect(memory.list({ limit: 51 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });

    it('snapshots constructor permissions/scope and get disclosure options before await', async () => {
      const scope = { principalId: 'owner', projectId: 'project-a' }; const allow = [...allGrants];
      const created = service({ scope, permissions: { allow } }); scope.projectId = 'changed'; allow.length = 0;
      const active = await created.add(memoryInput()); await created.forget({ id: active.id, expectedVersion: 1 });
      const began = deferred<void>(); const release = deferred<void>();
      const blocking: AggregateStore = { ...store, read: async (owner, id) => { began.resolve(); await release.promise; return store.read(owner, id); } };
      const reader = service({ store: blocking }); const query = { includeDeleted: false };
      const pending = reader.get(active.id, query); await began.promise; query.includeDeleted = true; release.resolve();
      expect(await pending).toBeUndefined();
    });

    it('fails closed on corrupt canonical content or unexpected persisted fields', async () => {
      let aggregate: CreateRecord | undefined;
      const capturing: AggregateStore = { ...store, create: async command => { aggregate = command; return store.create(command); } };
      const writer = service({ store: capturing }); await writer.add(memoryInput());
      const current = (await store.read(aggregate!.scope, aggregate!.id))!;
      const records = current.state['records'] as JsonObject; (records['memory-1'] as JsonObject)['content'] = 'tampered';
      await store.update({ scope: current.scope, id: current.id, expectedVersion: current.version, state: current.state, events: [] });
      await expect(writer.get('memory-1')).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(writer.search('tampered')).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('sanitizes arbitrary read/create/update adapter exceptions and does not blindly retry them', async () => {
      for (const method of ['read', 'create', 'update'] as const) {
        const throwing = vi.fn(async () => { throw new MayuraError('TOOL_FAILED', `private-${method}-secret`); });
        const custom = { ...store, [method]: throwing } as AggregateStore;
        const target = service({ store: custom });
        const action = method === 'read' ? target.get('memory-1') : target.add(memoryInput());
        let caught: unknown;
        try { await action; } catch (error) { caught = error; }
        expect(caught).toMatchObject({ code: 'STORAGE_UNAVAILABLE' }); expect(String(caught)).not.toContain(`private-${method}-secret`);
        expect(throwing).toHaveBeenCalledTimes(1);
      }
    });

    it('bounds conflict retries while redacting custom conflict messages', async () => {
      await memory.add(memoryInput());
      const update = vi.fn(async () => { throw new StorageError('CONFLICT', 'private-conflict-message'); });
      const target = service({ store: { ...store, update } });
      let caught: unknown;
      try { await target.correct({ ...memoryInput({ content: 'never committed' }), expectedVersion: 1 }); } catch (error) { caught = error; }
      expect(caught).toMatchObject({ code: 'CONFLICT' }); expect(String(caught)).not.toContain('private-conflict-message');
      expect(update).toHaveBeenCalledTimes(32); expect((await memory.get('memory-1'))?.version).toBe(1);
    });
  });
}
