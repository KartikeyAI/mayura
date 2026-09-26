import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MemoryIndexAggregateStore } from '@mayura/storage-contracts';
import { createMemoryStore, createNativeMemory, hashingEmbedder, type MemoryEmbedder, type MemoryInput, type NativeMemoryOptions } from '../src/index.js';
import { memoryInput } from './conformance.js';

export interface NativeFixture { readonly store: MemoryIndexAggregateStore; reopen(): MemoryIndexAggregateStore; cleanup(): Promise<void> }
const scope = { principalId: 'owner', projectId: 'native' };
const all = ['memory:read', 'memory:write', 'memory:delete', 'memory:export', 'memory:import', 'memory:index'];
const input = (id: string, content: string, overrides: Partial<MemoryInput> = {}): MemoryInput => memoryInput({ id, content, ...overrides });
const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa'];

export function nativeMemoryConformance(name: string, open: () => Promise<NativeFixture>): void {
  describe(`native memory on ${name}`, () => {
    const opened: NativeFixture[] = [];
    afterEach(async () => { for (const fixture of opened.splice(0)) { await fixture.store.close(); await fixture.cleanup(); } });
    const setup = async (overrides: Partial<NativeMemoryOptions> = {}) => {
      const fixture = await open(); opened.push(fixture); await fixture.store.initialize(); await fixture.store.memory.initialize();
      const memory = createNativeMemory({ store: fixture.store, scope, permissions: { allow: all }, allowedSensitivities: ['public', 'internal', 'confidential'], ...overrides });
      return { fixture, memory };
    };

    it('adds, corrects and forgets with compare-and-set, and keeps tombstones permanent', async () => {
      const { memory } = await setup();
      const added = await memory.add(input('fact-1', 'The build uses strict TypeScript.'));
      expect(added).toMatchObject({ id: 'fact-1', version: 1, status: 'active' });
      await expect(memory.add(input('fact-1', 'duplicate'))).rejects.toMatchObject({ code: 'CONFLICT' });
      const corrected = await memory.correct({ ...input('fact-1', 'The build uses strict TypeScript 5.'), expectedVersion: 1 });
      expect(corrected.version).toBe(2);
      await expect(memory.correct({ ...input('fact-1', 'stale'), expectedVersion: 1 })).rejects.toMatchObject({ code: 'CONFLICT' });
      const tombstone = await memory.forget({ id: 'fact-1', expectedVersion: 2 });
      expect(tombstone).toMatchObject({ status: 'deleted', version: 3 }); expect(tombstone).not.toHaveProperty('content');
      await expect(memory.add(input('fact-1', 'resurrected'))).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await memory.get('fact-1')).toBeUndefined();
      expect(await memory.get('fact-1', { includeDeleted: true })).toMatchObject({ status: 'deleted' });
      expect((await memory.changes()).map(change => [change.id, change.version, change.status])).toEqual([['fact-1', 1, 'active'], ['fact-1', 2, 'active'], ['fact-1', 3, 'deleted']]);
    });

    it('filters sensitivity, validity and scope before ranking', async () => {
      const { fixture, memory } = await setup();
      await memory.add(input('visible', 'deployment runbook for staging'));
      await memory.add(input('secret', 'deployment runbook for production', { sensitivity: 'confidential' }));
      await memory.add(input('future', 'deployment runbook next quarter', { validity: { from: '2999-01-01T00:00:00.000Z', until: null } }));
      const narrow = createNativeMemory({ store: fixture.store, scope, permissions: { allow: all } });
      expect((await narrow.search('deployment runbook')).hits.map(hit => hit.record.id)).toEqual(['visible']);
      expect((await memory.search('deployment runbook')).hits.map(hit => hit.record.id).sort()).toEqual(['secret', 'visible']);
      expect(await narrow.get('secret')).toBeUndefined();
      const other = createNativeMemory({ store: fixture.store, scope: { principalId: 'owner', projectId: 'other' }, permissions: { allow: all } });
      expect((await other.search('deployment')).hits).toEqual([]);
      await expect(narrow.add(input('too-high', 'x', { sensitivity: 'restricted' }))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      await expect(createNativeMemory({ store: fixture.store, scope, permissions: { allow: ['memory:read'] } }).add(input('x', 'y'))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    });

    it('ranks lexical results with BM25 and lists in id order with cursors', async () => {
      const { memory } = await setup();
      await memory.add(input('a', 'postgres postgres postgres replication'));
      await memory.add(input('b', 'postgres backup'));
      await memory.add(input('c', 'sqlite backup and restore'));
      const result = await memory.search('postgres backup');
      expect(result.hits.map(hit => hit.record.id)).toEqual(['b', 'a', 'c']);
      expect(result.hits[0]!.matchedTerms).toEqual(['postgres', 'backup']);
      const first = await memory.list({ limit: 2 });
      expect(first.records.map(record => record.id)).toEqual(['a', 'b']);
      expect((await memory.list({ limit: 2, cursor: first.nextCursor! })).records.map(record => record.id)).toEqual(['c']);
    });

    it('supersedes records without returning history from search', async () => {
      const { memory } = await setup();
      await memory.add(input('policy-1', 'retention is thirty days'));
      const { superseded, replacement } = await memory.supersede({ id: 'policy-1', expectedVersion: 1, replacement: input('policy-2', 'retention is ninety days') });
      expect(superseded).toMatchObject({ status: 'superseded', supersededBy: 'policy-2', version: 2 });
      expect(replacement.id).toBe('policy-2');
      expect((await memory.search('retention days')).hits.map(hit => hit.record.id)).toEqual(['policy-2']);
      expect(await memory.get('policy-1')).toMatchObject({ status: 'superseded', content: 'retention is thirty days' });
    });

    it('relates records, traverses bounded subgraphs and tombstones edges when a record is deleted', async () => {
      const { memory } = await setup();
      for (const id of ['service', 'database', 'backup', 'vault']) await memory.add(input(id, `${id} component`));
      const provenance = memoryInput().provenance;
      await memory.relate({ id: 'e1', from: 'service', to: 'database', relation: 'depends_on', confidence: 0.9, provenance });
      await memory.relate({ id: 'e2', from: 'database', to: 'backup', relation: 'backed_up_by', confidence: 1, provenance });
      await memory.relate({ id: 'e3', from: 'backup', to: 'vault', relation: 'stored_in', confidence: 0.5, provenance: { ...provenance, origin: 'inferred' } });
      await expect(memory.relate({ id: 'e4', from: 'service', to: 'missing', relation: 'depends_on', confidence: 1, provenance })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const neighbors = await memory.neighbors('database');
      expect(neighbors.edges.map(edge => edge.id)).toEqual(['e1', 'e2']);
      expect(neighbors.records.map(record => record.id).sort()).toEqual(['backup', 'service']);
      expect((await memory.neighbors('database', { direction: 'out' })).edges.map(edge => edge.id)).toEqual(['e2']);
      const two = await memory.traverse('service', { maxDepth: 2 });
      expect(two.records.map(record => record.id).sort()).toEqual(['backup', 'database', 'service']); expect(two.truncated).toBe(true);
      const full = await memory.traverse('service', { maxDepth: 4 });
      expect(full.edges.map(edge => edge.id)).toEqual(['e1', 'e2', 'e3']); expect(full.truncated).toBe(false);
      expect((await memory.traverse('service', { maxDepth: 4, relations: ['depends_on'] })).records.map(record => record.id).sort()).toEqual(['database', 'service']);
      const database = (await memory.get('database'))!;
      await memory.forget({ id: 'database', expectedVersion: database.version });
      expect((await memory.traverse('service', { maxDepth: 4 })).records.map(record => record.id)).toEqual(['service']);
      const edgeChanges = (await memory.changes()).filter(change => change.kind === 'edge' && change.status === 'deleted').map(change => change.id).sort();
      expect(edgeChanges).toEqual(['e1', 'e2']);
      await expect(memory.forgetEdge({ id: 'e1', expectedVersion: 1 })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await memory.forgetEdge({ id: 'e3', expectedVersion: 1 })).toMatchObject({ status: 'deleted', version: 2 });
    });

    it('indexes and searches semantically, exact below the threshold, with stale vectors never used', async () => {
      const { memory } = await setup({ embedder: hashingEmbedder({ dimensions: 64 }) });
      await memory.add(input('deploy', 'rolling deployment of the api gateway'));
      await memory.add(input('backup', 'nightly database backup to object storage'));
      await memory.add(input('cooking', 'recipe for tomato soup'));
      expect(await memory.index()).toMatchObject({ embedded: 3, stale: 0, remaining: false, lists: 0 });
      const result = await memory.semanticSearch('database backup');
      expect(result.mode).toBe('exact'); expect(result.hits[0]!.record.id).toBe('backup');
      await memory.correct({ ...input('backup', 'weekly tape archive'), expectedVersion: 1 });
      expect((await memory.semanticSearch('database backup')).hits.map(hit => hit.record.id)).not.toContain('backup');
      expect(await memory.index()).toMatchObject({ embedded: 1 });
      const hybrid = await memory.hybridSearch('api deployment');
      expect(hybrid.hits[0]!.record.id).toBe('deploy'); expect(hybrid.fused).toBe(true);
    });

    it('falls back to lexical retrieval with a visible limitation and never sends restricted records to a hosted embedder', async () => {
      const { fixture, memory } = await setup();
      await memory.add(input('doc', 'incident response checklist'));
      expect(await memory.semanticSearch('incident checklist')).toMatchObject({ mode: 'lexical', limitation: 'semantic_unavailable', hits: [{ record: { id: 'doc' } }] });
      await memory.add(input('private', 'confidential incident notes', { sensitivity: 'confidential' }));
      const embed = vi.fn<MemoryEmbedder['embed']>(async texts => texts.map(() => [1, 0, 0, 0]));
      const hosted = createNativeMemory({ store: fixture.store, scope, permissions: { allow: all }, allowedSensitivities: ['public', 'internal', 'confidential'],
        embedder: { id: 'hosted.test', dimensions: 4, maxBatch: 8, location: 'hosted', embed } });
      await hosted.index();
      expect(embed.mock.calls.flatMap(([texts]) => texts)).toEqual(['incident response checklist']);
      await expect(createNativeMemory({ store: fixture.store, scope, permissions: { allow: ['memory:read'] }, embedder: hashingEmbedder() }).index()).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    });

    it('trains an IVF index above the threshold with high recall against exact search', async () => {
      const embedder = hashingEmbedder({ dimensions: 48 });
      const { fixture, memory } = await setup({ embedder, exactThreshold: 128 });
      for (let index = 0; index < 600; index++) {
        const text = `${words[index % 16]} ${words[(index * 7) % 16]} ${words[(index * 11 + 3) % 16]} item${index}`;
        await memory.add(input(`doc-${String(index).padStart(4, '0')}`, text));
      }
      while ((await memory.index({ limit: 999 })).remaining) { /* index every record */ }
      const report = await memory.index();
      expect(report.lists).toBeGreaterThan(1);
      const exact = createNativeMemory({ store: fixture.store, scope, permissions: { allow: all }, embedder, exactThreshold: 1_000_000 });
      let found = 0; let total = 0;
      for (const query of ['alpha bravo', 'delta echo golf', 'kilo lima', 'oscar papa india', 'charlie hotel']) {
        const approximate = await memory.semanticSearch(query, { limit: 10, nprobe: 8 });
        expect(approximate.mode).toBe('ivf');
        const truth = (await exact.semanticSearch(query, { limit: 10 })).hits.map(hit => hit.record.id);
        found += approximate.hits.filter(hit => truth.includes(hit.record.id)).length; total += truth.length;
      }
      expect(found / total).toBeGreaterThanOrEqual(0.9);
    }, 120_000);

    it('exports pages and imports them into an empty scope with identical records, never resurrecting tombstones', async () => {
      const { fixture, memory } = await setup();
      for (let index = 0; index < 5; index++) await memory.add(input(`r${index}`, `record ${index}`));
      await memory.forget({ id: 'r1', expectedVersion: 1 });
      const provenance = memoryInput().provenance;
      await memory.relate({ id: 'link', from: 'r0', to: 'r2', relation: 'mentions', confidence: 0.7, provenance });
      const pages = []; let cursor: string | undefined;
      do { const page = await memory.exportPage({ limit: 2, ...(cursor ? { cursor } : {}) }); pages.push(page); cursor = page.nextCursor; } while (cursor);
      expect(pages.flatMap(page => page.records).map(record => record.id)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
      expect(pages.flatMap(page => page.edges).map(edge => edge.id)).toEqual(['link']);
      const target = createNativeMemory({ store: fixture.store, scope: { principalId: 'owner', projectId: 'copy' }, permissions: { allow: all }, allowedSensitivities: ['public', 'internal', 'confidential'] });
      for (const page of pages) await target.importSnapshot(page, { mode: 'merge' });
      expect((await target.list({ includeDeleted: true, limit: 50 })).records.map(record => record.id)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4']);
      expect(await target.get('r3')).toEqual({ ...(await memory.get('r3'))!, scope: { principalId: 'owner', projectId: 'copy' } });
      expect((await target.neighbors('r0')).edges.map(edge => edge.id)).toEqual(['link']);
      // Re-importing an older active version of a deleted record never resurrects it.
      await target.importSnapshot({ format: 'mayura.memory.export.v1', scope, revision: 0, exportedAt: '2026-01-01T00:00:00.000Z',
        records: [{ ...(await memory.get('r0'))!, id: 'r1' } as never] }, { mode: 'merge' });
      expect(await target.get('r1', { includeDeleted: true })).toMatchObject({ status: 'deleted' });
      await expect(target.importSnapshot(pages[0]!, { mode: 'replace-empty' })).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(createNativeMemory({ store: fixture.store, scope, permissions: { allow: ['memory:read', 'memory:write'] } }).importSnapshot(pages[0]!, { mode: 'merge' }))
        .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    });

    it('imports a compact-profile export as the migration path', async () => {
      const { fixture, memory } = await setup();
      const compact = createMemoryStore({ store: fixture.store, scope: { principalId: 'owner', projectId: 'compact' }, permissions: { allow: all } });
      await compact.add(input('c1', 'compact record one')); await compact.add(input('c2', 'compact record two'));
      await compact.forget({ id: 'c2', expectedVersion: 1 });
      const exported = await compact.exportSnapshot();
      expect(await memory.importSnapshot({ ...exported, scope }, { mode: 'replace-empty' })).toEqual({ imported: 2, skipped: 0, edges: 0 });
      expect((await memory.search('compact record')).hits.map(hit => hit.record.id)).toEqual(['c1']);
      expect(await memory.get('c2', { includeDeleted: true })).toMatchObject({ status: 'deleted', version: 2 });
    });

    it('enforces its own guarantees at the storage boundary', async () => {
      const { fixture } = await setup(); const store = fixture.store.memory; const key = 'direct-scope';
      const row = (id: string, version: number, sensitivity: 'public' | 'internal', extra: Record<string, unknown> = {}) => ({ id, version, status: 'active' as const, sensitivity,
        body: { content: id }, validFrom: '2026-01-01T00:00:00.000Z', validUntil: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
        deletedAt: null, supersededBy: null, ...extra });
      await store.putRecord({ scope: key, record: row('pub', 1, 'public'), expectedVersion: 0, terms: [['shared', 1]] });
      await store.putRecord({ scope: key, record: row('int', 1, 'internal'), expectedVersion: 0, terms: [['shared', 3]] });
      const asOf = '2026-06-01T00:00:00.000Z';
      const publicOnly = await store.postings({ scope: key, terms: ['shared'], limit: 100, sensitivities: ['public'], asOf });
      expect(publicOnly.postings.map(posting => posting.id)).toEqual(['pub']); expect(publicOnly.documents).toBe(1);
      const vector = Buffer.alloc(8).toString('base64');
      expect(await store.putVectors({ scope: key, embedderId: 'e', dimensions: 2, entries: [{ recordId: 'pub', recordVersion: 1, vector, list: null }, { recordId: 'int', recordVersion: 9, vector, list: null }] }))
        .toEqual({ written: 1, stale: ['int'] });
      expect((await store.indexState({ scope: key, embedderId: 'e' })).vectors).toBe(1);
      await store.putRecord({ scope: key, record: row('pub', 2, 'public'), expectedVersion: 1, terms: [['shared', 1]] });
      expect((await store.indexState({ scope: key, embedderId: 'e' })).vectors).toBe(0);
      const tombstone = { ...row('pub', 3, 'public'), status: 'deleted' as const, body: null, validFrom: null, deletedAt: '2026-01-02T00:00:00.000Z' };
      await store.putRecord({ scope: key, record: tombstone, expectedVersion: 2, terms: [] });
      await expect(store.putRecord({ scope: key, record: row('pub', 4, 'public'), expectedVersion: 3, terms: [] })).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(store.putRecord({ scope: key, record: row('int', 6, 'internal'), expectedVersion: 5, terms: [] })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect((await store.postings({ scope: key, terms: ['shared'], limit: 100, sensitivities: ['public', 'internal'], asOf })).postings.map(posting => posting.id)).toEqual(['int']);
    });

    it('runs write hooks around native writes and writes nothing when blocked', async () => {
      const seen: string[] = [];
      const { memory } = await setup({ hooks: {
        beforeMemoryWrite: event => { seen.push(`before:${event.operation}:${event.id}`); return { decision: event.id === 'blocked' ? 'block' : 'continue' }; },
        afterMemoryWrite: event => { seen.push(`after:${event.operation}:${event.id}`); },
      } });
      await memory.add(input('ok', 'allowed')); await memory.add(input('ok-2', 'allowed too'));
      await expect(memory.add(input('blocked', 'nope'))).rejects.toMatchObject({ code: 'GUARD_BLOCKED' });
      expect(await memory.get('blocked', { includeDeleted: true })).toBeUndefined();
      await memory.relate({ id: 'edge', from: 'ok', to: 'ok-2', relation: 'related', confidence: 1, provenance: memoryInput().provenance });
      expect(seen).toEqual(['before:add:ok', 'after:add:ok', 'before:add:ok-2', 'after:add:ok-2', 'before:add:blocked', 'before:relate:edge', 'after:relate:edge']);
    });
  });
}
