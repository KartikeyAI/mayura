import { MayuraError, type JsonObject, type Scope } from '@mayura/core';
import { evaluateLifecycleControl, evaluateLifecycleObserver, snapshotHookOptions } from '@mayura/core/host';
import { StorageError, type MemoryChange, type MemoryEdgeRow, type MemoryIndexStore, type MemoryRow, type MemoryRowSensitivity } from '@mayura/storage-contracts';
import type {
  AfterMemoryWriteEvent, BeforeMemoryWriteEvent, CorrectMemoryInput, ForgetMemoryInput, MemoryCategory, MemoryEntry, MemoryExport, MemoryHooks,
  MemoryInput, MemoryListOptions, MemoryPage, MemoryProvenance, MemoryRecord, MemorySupersededRecord, MemorySearchResult, MemorySensitivity, MemoryStore, MemoryTombstone, MemoryValidity,
} from './contracts.js';
import { SENSITIVITIES, activeRecord, allowedKeys, exactKeys, immutable, integer, memoryId, object, parseEntry, provenance, sensitivity, text, timestamp, validity } from './validation.js';
import {
  admitEmbeddings, decodeVector, dot, encodeVector, nearestCentroids, reciprocalRankFusion, tokens, trainCentroids, type MemoryEmbedder,
} from './vectors.js';

export type NativeMemoryEntry = MemoryEntry;
export interface MemoryEdgeInput {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  /** Bounded identifier, for example `depends_on` or `decided_by`. */
  readonly relation: string;
  readonly confidence: number;
  readonly provenance: MemoryProvenance;
  readonly validity?: MemoryValidity;
  readonly metadata?: JsonObject;
}
export interface MemoryEdge {
  readonly id: string; readonly version: number; readonly status: 'active'; readonly from: string; readonly to: string; readonly relation: string;
  readonly confidence: number; readonly provenance: MemoryProvenance; readonly validity: MemoryValidity; readonly metadata: JsonObject;
  readonly createdAt: string; readonly updatedAt: string;
}
export interface MemoryEdgeTombstone { readonly id: string; readonly version: number; readonly status: 'deleted'; readonly from: string; readonly to: string; readonly relation: string; readonly updatedAt: string }
export interface MemorySubgraph { readonly records: readonly MemoryRecord[]; readonly edges: readonly MemoryEdge[]; readonly truncated: boolean }
export interface MemoryIndexReport { readonly embedded: number; readonly stale: number; readonly remaining: boolean; readonly lists: number }
export interface SemanticSearchResult {
  readonly mode: 'exact' | 'ivf' | 'lexical';
  readonly hits: readonly { readonly record: MemoryRecord; readonly score: number }[];
  /** Present when semantic retrieval was unavailable and lexical evidence was used instead. */
  readonly limitation?: 'semantic_unavailable';
}
export interface MemoryExportPage {
  readonly format: 'mayura.memory.export.v2';
  readonly scope: Scope;
  /** Change sequence observed when this page was read. */
  readonly sequence: number;
  readonly exportedAt: string;
  readonly records: readonly NativeMemoryEntry[];
  readonly edges: readonly (MemoryEdge | MemoryEdgeTombstone)[];
  readonly nextCursor?: string;
}
export interface MemoryImportReport { readonly imported: number; readonly skipped: number; readonly edges: number }

export interface NativeMemoryOptions {
  readonly store: { readonly memory: MemoryIndexStore };
  readonly scope: Scope;
  readonly permissions: { readonly allow: readonly string[] };
  readonly allowedSensitivities?: readonly MemorySensitivity[];
  readonly hooks?: MemoryHooks;
  readonly embedder?: MemoryEmbedder;
  /** Sensitivities a **hosted** embedder may receive (default public and internal). Local embedders receive the whole profile. */
  readonly embedSensitivities?: readonly MemorySensitivity[];
  /** Vectors per scope and embedder before the IVF index is trained (default 2048). */
  readonly exactThreshold?: number;
  readonly now?: () => number;
}

export interface NativeMemory extends MemoryStore {
  get(id: string, options?: { readonly includeDeleted?: boolean }): Promise<NativeMemoryEntry | undefined>;
  /** Mark `id` superseded by a new record in one ordered pair of writes; the replacement is written first. */
  supersede(input: { readonly id: string; readonly expectedVersion: number; readonly replacement: MemoryInput }): Promise<{ readonly superseded: MemorySupersededRecord; readonly replacement: MemoryRecord }>;
  relate(input: MemoryEdgeInput): Promise<MemoryEdge>;
  forgetEdge(input: { readonly id: string; readonly expectedVersion: number }): Promise<MemoryEdgeTombstone>;
  neighbors(id: string, options?: { readonly direction?: 'out' | 'in' | 'both'; readonly relations?: readonly string[]; readonly limit?: number }): Promise<MemorySubgraph>;
  traverse(id: string, options?: { readonly maxDepth?: number; readonly maxNodes?: number; readonly relations?: readonly string[] }): Promise<MemorySubgraph>;
  /** Embed records lacking a current vector and maintain the IVF index. Requires an embedder and `memory:index`. */
  index(options?: { readonly limit?: number; readonly signal?: AbortSignal }): Promise<MemoryIndexReport>;
  semanticSearch(query: string, options?: { readonly limit?: number; readonly nprobe?: number; readonly minScore?: number; readonly signal?: AbortSignal }): Promise<SemanticSearchResult>;
  hybridSearch(query: string, options?: { readonly limit?: number; readonly signal?: AbortSignal }): Promise<SemanticSearchResult & { readonly fused: true }>;
  exportPage(options?: { readonly cursor?: string; readonly limit?: number }): Promise<MemoryExportPage>;
  importSnapshot(snapshot: MemoryExport | MemoryExportPage, options: { readonly mode: 'merge' | 'replace-empty' }): Promise<MemoryImportReport>;
  /** Content-free change feed for cache invalidation and incremental export. */
  changes(options?: { readonly after?: number; readonly limit?: number }): Promise<readonly MemoryChange[]>;
}

const inputFields = ['id', 'category', 'content', 'metadata', 'sensitivity', 'provenance', 'validity'];
const edgeFields = ['id', 'from', 'to', 'relation', 'confidence', 'provenance', 'validity', 'metadata'];
const relationPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_TERMS = 4_096;

function storage<T>(operation: () => Promise<T>): Promise<T> {
  return operation().catch((error: unknown) => {
    if (error instanceof MayuraError) throw error;
    if (error instanceof StorageError && error.code === 'INVALID_INPUT') throw new MayuraError('INVALID_INPUT', 'The memory storage command was rejected as invalid.');
    if (error instanceof StorageError && error.code === 'STORE_NOT_INITIALIZED') {
      throw new MayuraError('INVALID_CONFIG', 'Native memory storage is not initialized: call `await store.memory.initialize()` after `await store.initialize()`.');
    }
    if (error instanceof StorageError && ['CONFLICT', 'NOT_FOUND'].includes(error.code)) {
      throw new MayuraError(error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'CONFLICT', 'The memory operation conflicts with current storage state; refresh and retry.');
    }
    throw new MayuraError('STORAGE_UNAVAILABLE', 'Memory storage is unavailable. Check protected local diagnostics.');
  });
}
function termsOf(content: string): [string, number][] {
  const counts = new Map<string, number>();
  for (const word of tokens(content)) if (word.length <= 64) counts.set(word, (counts.get(word) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, MAX_TERMS);
}

/**
 * Scalable native memory over the SQLite/PostgreSQL `memory` capability: lexical BM25, semantic and hybrid retrieval,
 * scoped graph relationships, supersession, streamed import/export and a change feed. No external request is made
 * unless a hosted embedder is configured.
 */
export function createNativeMemory(options: NativeMemoryOptions): NativeMemory {
  const database = options?.store?.memory;
  if (!database || typeof database.putRecord !== 'function') throw new MayuraError('INVALID_CONFIG', 'Native memory requires a store with the memory capability.');
  let scope: Scope;
  try { scope = Object.freeze({ principalId: text(options.scope?.principalId, 'Principal ID', 128), projectId: text(options.scope?.projectId, 'Project ID', 128) }); }
  catch { throw new MayuraError('INVALID_CONFIG', 'Native memory requires bounded principal and project identifiers.'); }
  if (!Array.isArray(options.permissions?.allow) || options.permissions.allow.length > 4_096) throw new MayuraError('INVALID_CONFIG', 'Memory permissions require a bounded grant list.');
  const grants = new Set(options.permissions.allow.map(grant => text(grant, 'Grant', 384)));
  const profile = [...new Set((options.allowedSensitivities ?? ['public', 'internal']).map(value => sensitivity(value)))];
  const embedder = options.embedder;
  if (embedder !== undefined && (typeof embedder.embed !== 'function' || !relationPattern.test(embedder.id) || !Number.isSafeInteger(embedder.dimensions)
    || embedder.dimensions < 1 || embedder.dimensions > 4_096 || !Number.isSafeInteger(embedder.maxBatch) || embedder.maxBatch < 1 || !['local', 'hosted'].includes(embedder.location))) {
    throw new MayuraError('INVALID_CONFIG', 'The memory embedder must declare a bounded id, dimensions, batch size and location.');
  }
  const embedProfile = embedder?.location === 'local' ? profile
    : [...new Set((options.embedSensitivities ?? ['public', 'internal']).map(value => sensitivity(value)))].filter(value => profile.includes(value));
  const exactThreshold = options.exactThreshold ?? 2_048;
  if (!Number.isSafeInteger(exactThreshold) || exactThreshold < 16 || exactThreshold > 1_000_000) throw new MayuraError('INVALID_CONFIG', 'exactThreshold must be 16–1000000.');
  const { handlers, timeoutMs } = snapshotHookOptions(options.hooks, ['beforeMemoryWrite', 'afterMemoryWrite'] as const,
    'Memory hooks require callable beforeMemoryWrite/afterMemoryWrite handlers and a bounded timeout.');
  const before = async (event: BeforeMemoryWriteEvent): Promise<void> => {
    if (handlers.beforeMemoryWrite) await evaluateLifecycleControl({ stage: 'beforeMemoryWrite', handler: handlers.beforeMemoryWrite as NonNullable<MemoryHooks['beforeMemoryWrite']>, event: structuredClone(event), timeoutMs });
  };
  const after = async (event: AfterMemoryWriteEvent): Promise<void> => {
    if (!handlers.afterMemoryWrite) return;
    try { await evaluateLifecycleObserver({ stage: 'afterMemoryWrite', handler: handlers.afterMemoryWrite as NonNullable<MemoryHooks['afterMemoryWrite']>, event: structuredClone(event), timeoutMs }); }
    catch { throw new MayuraError('GUARD_UNAVAILABLE', 'The memory write committed, but a required after-write hook failed.'); }
  };
  const clock = (): string => {
    const value = (options.now ?? Date.now)();
    if (!Number.isSafeInteger(value) || value < 0) throw new MayuraError('INVALID_CONFIG', 'The memory clock returned an invalid time.');
    return new Date(value).toISOString();
  };
  const key = `mayura.native-memory.v1:${Buffer.from(JSON.stringify([scope.principalId, scope.projectId])).toString('base64url')}`.slice(0, 255);
  const permission = (grant: string): void => { if (!grants.has(grant)) throw new MayuraError('PERMISSION_DENIED', 'The memory operation requires a capability that was not granted.'); };
  const admitted = (value: string): boolean => profile.includes(value as MemorySensitivity);
  const filter = () => ({ sensitivities: profile as MemoryRowSensitivity[], asOf: clock() });
  const limitOf = (value: unknown, fallback: number, maximum: number): number => {
    const limit = value === undefined ? fallback : integer(value, 'Limit');
    if (limit < 1 || limit > maximum) throw new MayuraError('INVALID_INPUT', `Limit must be 1–${maximum}.`); return limit;
  };

  const toRow = (entry: MemoryRecord | MemorySupersededRecord | MemoryTombstone): MemoryRow => entry.status === 'deleted'
    ? { id: entry.id, version: entry.version, status: 'deleted', sensitivity: entry.sensitivity, body: null, validFrom: null, validUntil: null,
      createdAt: entry.createdAt, updatedAt: entry.updatedAt, deletedAt: entry.deletedAt, supersededBy: null }
    : { id: entry.id, version: entry.version, status: entry.status, sensitivity: entry.sensitivity,
      body: { category: entry.category, content: entry.content, contentSha256: entry.contentSha256, metadata: entry.metadata, provenance: entry.provenance as unknown as JsonObject, validity: entry.validity as unknown as JsonObject },
      validFrom: entry.validity.from, validUntil: entry.validity.until, createdAt: entry.createdAt, updatedAt: entry.updatedAt, deletedAt: null,
      supersededBy: entry.status === 'superseded' ? entry.supersededBy : null };
  const fromRow = (row: MemoryRow): NativeMemoryEntry => {
    try {
      if (row.status === 'deleted') return parseEntry({ id: row.id, version: row.version, status: 'deleted', scope, sensitivity: row.sensitivity, createdAt: row.createdAt, updatedAt: row.updatedAt, deletedAt: row.deletedAt }, scope);
      const body = row.body!;
      const active = parseEntry({ id: row.id, version: row.version, status: 'active', scope, sensitivity: row.sensitivity, createdAt: row.createdAt, updatedAt: row.updatedAt,
        category: body['category'], content: body['content'], contentSha256: body['contentSha256'], metadata: body['metadata'], provenance: body['provenance'], validity: body['validity'] }, scope) as MemoryRecord;
      return row.status === 'superseded' ? { ...active, status: 'superseded', supersededBy: row.supersededBy! } : active;
    } catch { throw new MayuraError('STORAGE_UNAVAILABLE', 'Stored memory failed its integrity checks.'); }
  };
  const edgeFromRow = (row: MemoryEdgeRow): MemoryEdge | MemoryEdgeTombstone => {
    if (row.status === 'deleted') return { id: row.id, version: row.version, status: 'deleted', from: row.from, to: row.to, relation: row.relation, updatedAt: row.updatedAt };
    const body = row.body!;
    return { id: row.id, version: row.version, status: 'active', from: row.from, to: row.to, relation: row.relation, confidence: body['confidence'] as number,
      provenance: body['provenance'] as unknown as MemoryProvenance, validity: body['validity'] as unknown as MemoryValidity, metadata: body['metadata'] as JsonObject,
      createdAt: row.createdAt, updatedAt: row.updatedAt };
  };
  const readRows = async (ids: readonly string[]): Promise<Map<string, MemoryRow>> => {
    const rows = new Map<string, MemoryRow>();
    for (let index = 0; index < ids.length; index += 1_000) {
      for (const row of await storage(() => database.getRecords({ scope: key, ids: ids.slice(index, index + 1_000) }))) rows.set(row.id, row);
    }
    return rows;
  };
  const current = async (id: string): Promise<MemoryRow | undefined> => (await readRows([id])).get(id);
  const write = async (entry: MemoryRecord | MemorySupersededRecord | MemoryTombstone, expectedVersion: number): Promise<void> => {
    await storage(() => database.putRecord({ scope: key, record: toRow(entry), expectedVersion, terms: entry.status === 'active' ? termsOf(entry.content) : [] }));
  };
  const later = (previous: string): string => new Date(Math.max(Date.parse(clock()), Date.parse(previous))).toISOString();
  const nextVersion = (version: number): number => { if (version >= Number.MAX_SAFE_INTEGER) throw new MayuraError('CONFLICT', 'Memory version exhausted.'); return version + 1; };
  const liveRecord = (row: MemoryRow | undefined, expectedVersion: number): MemoryRecord => {
    if (!row || !admitted(row.sensitivity)) throw new MayuraError('NOT_FOUND', 'Memory record was not found in this scope.');
    if (row.status !== 'active' || row.version !== expectedVersion) throw new MayuraError('CONFLICT', 'Memory was changed or deleted; refresh its current version.');
    return fromRow(row) as MemoryRecord;
  };
  const candidate = (record: MemoryRecord): NonNullable<BeforeMemoryWriteEvent['candidate']> =>
    ({ content: record.content, category: record.category, sensitivity: record.sensitivity, provenance: record.provenance, validity: record.validity, metadata: record.metadata });
  const visibleRecords = async (ids: readonly string[]): Promise<MemoryRecord[]> => {
    const rows = await readRows(ids); const now = Date.parse(clock());
    return ids.flatMap(id => {
      const row = rows.get(id);
      if (!row || row.status !== 'active' || !admitted(row.sensitivity)) return [];
      const record = fromRow(row) as MemoryRecord;
      if (Date.parse(record.validity.from) > now || (record.validity.until !== null && Date.parse(record.validity.until) <= now)) return [];
      return [record];
    });
  };

  const addRecord = async (input: MemoryInput, hooked = true): Promise<MemoryRecord> => {
    const source = object(input); allowedKeys(source, inputFields); const now = clock();
    const record = activeRecord(source, scope, 1, now, now);
    if (!admitted(record.sensitivity)) throw new MayuraError('PERMISSION_DENIED', 'The memory record exceeds the permitted sensitivity profile.');
    if (hooked) await before({ operation: 'add', scope, id: record.id, candidate: candidate(record) });
    await write(record, 0);
    if (hooked) await after({ operation: 'add', scope, id: record.id, version: 1, status: 'active' });
    return immutable(record);
  };

  const lexical = async (query: string, limit: number): Promise<{ id: string; score: number }[]> => {
    const terms = [...new Set(tokens(text(query, 'Search query', 512)))].filter(term => term.length <= 64);
    if (terms.length === 0 || terms.length > 16) throw new MayuraError('INVALID_INPUT', 'Lexical search requires 1–16 query terms.');
    const result = await storage(() => database.rank({ scope: key, terms, limit, ...filter() }));
    return result.hits.map(hit => ({ id: hit.id, score: hit.score }));
  };

  const embed = async (texts: readonly string[], signal: AbortSignal): Promise<number[][]> => {
    const vectors: number[][] = [];
    for (let index = 0; index < texts.length; index += embedder!.maxBatch) {
      const batch = texts.slice(index, index + embedder!.maxBatch);
      let raw: unknown;
      try { raw = await embedder!.embed(batch, signal); }
      catch { if (signal.aborted) throw new MayuraError('CANCELLED', 'Embedding was cancelled.'); throw new MayuraError('MODEL_FAILED', 'The embedder failed; semantic retrieval is unavailable.'); }
      vectors.push(...admitEmbeddings(raw, batch.length, embedder!.dimensions));
    }
    return vectors;
  };
  const centroidsOf = async (): Promise<{ vectors: number; trainedAt: number; centroids: Float32Array[] }> => {
    const state = await storage(() => database.indexState({ scope: key, embedderId: embedder!.id }));
    return { vectors: state.vectors, trainedAt: state.trainedAt, centroids: state.centroids.map(value => decodeVector(value, embedder!.dimensions)) };
  };
  /** Train (or retrain once the corpus doubled) and assign every vector to its nearest list. */
  const maintain = async (): Promise<number> => {
    const state = await centroidsOf();
    if (state.vectors < exactThreshold || (state.trainedAt > 0 && state.vectors < state.trainedAt * 2)) {
      if (state.centroids.length > 0) await assignUnassigned(state.centroids);
      return state.centroids.length;
    }
    const all: { id: string; vector: Float32Array }[] = []; let cursor: string | undefined;
    const everything = { sensitivities: SENSITIVITIES as unknown as MemoryRowSensitivity[], asOf: clock() };
    do {
      const page = await storage(() => database.vectors({ scope: key, embedderId: embedder!.id, limit: 5_000, ...everything, ...(cursor ? { after: cursor } : {}) }));
      for (const row of page) all.push({ id: row.recordId, vector: decodeVector(row.vector, embedder!.dimensions) });
      cursor = page.length === 5_000 ? page.at(-1)!.recordId : undefined;
    } while (cursor);
    const lists = Math.min(1_024, Math.max(1, Math.round(Math.sqrt(all.length))));
    const stride = Math.max(1, Math.floor(all.length / Math.min(all.length, lists * 64)));
    const centroids = trainCentroids(all.filter((_, index) => index % stride === 0).map(entry => entry.vector), lists);
    await storage(() => database.setCentroids({ scope: key, embedderId: embedder!.id, dimensions: embedder!.dimensions,
      centroids: centroids.map(centroid => encodeVector([...centroid])), trainedAt: all.length }));
    const assignments = all.map(entry => [entry.id, nearestCentroids(entry.vector, centroids, 1)[0]!] as const);
    for (let index = 0; index < assignments.length; index += 10_000) {
      const chunk = assignments.slice(index, index + 10_000);
      await storage(() => database.assignLists({ scope: key, embedderId: embedder!.id, entries: chunk }));
    }
    return centroids.length;
  };
  const assignUnassigned = async (centroids: Float32Array[]): Promise<void> => {
    const everything = { sensitivities: SENSITIVITIES as unknown as MemoryRowSensitivity[], asOf: clock() };
    // `lists: []` returns only unassigned vectors.
    for (;;) {
      const page = await storage(() => database.vectors({ scope: key, embedderId: embedder!.id, lists: [], limit: 5_000, ...everything }));
      const pending = page.filter(row => row.list === null);
      if (pending.length === 0) return;
      await storage(() => database.assignLists({ scope: key, embedderId: embedder!.id,
        entries: pending.map(row => [row.recordId, nearestCentroids(decodeVector(row.vector, embedder!.dimensions), centroids, 1)[0]!] as const) }));
      if (page.length < 5_000) return;
    }
  };

  const semantic = async (query: string, limit: number, nprobe: number, minScore: number, signal: AbortSignal): Promise<SemanticSearchResult> => {
    const [vector] = await embed([text(query, 'Search query', 2_048)], signal);
    const { centroids } = await centroidsOf();
    const lists = centroids.length > 0 ? nearestCentroids(vector!, centroids, Math.min(nprobe, centroids.length)) : undefined;
    const scored: { id: string; score: number }[] = []; let cursor: string | undefined;
    do {
      const page = await storage(() => database.vectors({ scope: key, embedderId: embedder!.id, limit: 5_000, ...filter(), ...(lists ? { lists } : {}), ...(cursor ? { after: cursor } : {}) }));
      for (const row of page) {
        const score = dot(vector!, decodeVector(row.vector, embedder!.dimensions));
        if (score >= minScore) scored.push({ id: row.recordId, score });
      }
      cursor = page.length === 5_000 ? page.at(-1)!.recordId : undefined;
    } while (cursor);
    scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    const top = scored.slice(0, limit); const records = new Map((await visibleRecords(top.map(hit => hit.id))).map(record => [record.id, record]));
    return immutable({ mode: lists ? 'ivf' : 'exact', hits: top.flatMap(hit => records.has(hit.id) ? [{ record: records.get(hit.id)!, score: hit.score }] : []) });
  };

  const importEntry = async (raw: unknown, mode: 'merge' | 'replace-empty'): Promise<boolean> => {
    const item = object(raw, 262_144);
    let entry: NativeMemoryEntry;
    if (item['status'] === 'superseded') {
      const { supersededBy, ...rest } = item as JsonObject & { supersededBy: unknown };
      entry = { ...(parseEntry({ ...rest, status: 'active', scope }, scope) as MemoryRecord), status: 'superseded', supersededBy: memoryId(supersededBy) };
    } else entry = parseEntry({ ...item, scope }, scope);
    if (!admitted(entry.sensitivity)) throw new MayuraError('PERMISSION_DENIED', 'An imported record exceeds the permitted sensitivity profile.');
    const existing = await current(entry.id);
    if (existing && (mode === 'replace-empty' || existing.status === 'deleted' || existing.version >= entry.version)) {
      if (mode === 'replace-empty') throw new MayuraError('CONFLICT', 'replace-empty import requires an empty scope.');
      return false;
    }
    await write(entry, existing?.version ?? 0);
    return true;
  };

  const self: NativeMemory = {
    add: async input => { permission('memory:write'); return addRecord(input); },
    correct: async (input: CorrectMemoryInput) => {
      permission('memory:write'); const source = object(input); allowedKeys(source, [...inputFields, 'expectedVersion']);
      const id = memoryId(source['id']); const expectedVersion = integer(source['expectedVersion'], 'Expected memory version');
      const provisional = activeRecord(source, scope, 1, clock(), clock());
      if (!admitted(provisional.sensitivity)) throw new MayuraError('PERMISSION_DENIED', 'The memory record exceeds the permitted sensitivity profile.');
      await before({ operation: 'correct', scope, id, expectedVersion, candidate: candidate(provisional) });
      const existing = liveRecord(await current(id), expectedVersion);
      const next = activeRecord(source, scope, nextVersion(existing.version), existing.createdAt, later(existing.updatedAt));
      await write(next, expectedVersion);
      await after({ operation: 'correct', scope, id, version: next.version, status: 'active' });
      return immutable(next);
    },
    forget: async (input: ForgetMemoryInput) => {
      permission('memory:delete'); const command = object(input, 1_024, 2); exactKeys(command, ['id', 'expectedVersion']);
      const id = memoryId(command['id']); const expectedVersion = integer(command['expectedVersion'], 'Expected memory version');
      await before({ operation: 'forget', scope, id, expectedVersion });
      const row = await current(id);
      if (!row || !admitted(row.sensitivity)) throw new MayuraError('NOT_FOUND', 'Memory record was not found in this scope.');
      if (row.status === 'deleted' || row.version !== expectedVersion) throw new MayuraError('CONFLICT', 'Memory was changed or deleted; refresh its current version.');
      const deletedAt = later(row.updatedAt);
      const tombstone: MemoryTombstone = { id, version: nextVersion(row.version), status: 'deleted', scope: { ...scope }, sensitivity: row.sensitivity, createdAt: row.createdAt, updatedAt: deletedAt, deletedAt };
      await write(tombstone, expectedVersion);
      await after({ operation: 'forget', scope, id, version: tombstone.version, status: 'deleted' });
      return immutable(tombstone);
    },
    get: async (id, query = {}) => {
      permission('memory:read'); memoryId(id); const request = object(query, 256, 2); allowedKeys(request, ['includeDeleted']);
      const includeDeleted = request['includeDeleted'] ?? false;
      if (typeof includeDeleted !== 'boolean') throw new MayuraError('INVALID_INPUT', 'includeDeleted must be boolean.');
      const row = await current(id);
      return row && admitted(row.sensitivity) && (includeDeleted || row.status !== 'deleted') ? immutable(fromRow(row)) : undefined;
    },
    list: async (query: MemoryListOptions = {}) => {
      permission('memory:read'); const request = object(query, 2_048, 2); allowedKeys(request, ['limit', 'cursor', 'includeDeleted']);
      const limit = limitOf(request['limit'], 20, 50); const includeDeleted = request['includeDeleted'] ?? false;
      if (typeof includeDeleted !== 'boolean') throw new MayuraError('INVALID_INPUT', 'includeDeleted must be boolean.');
      const cursor = request['cursor'] === undefined ? undefined : memoryId(request['cursor']);
      const rows = await storage(() => database.listRecords({ scope: key, limit: limit + 1, statuses: includeDeleted ? ['active', 'superseded', 'deleted'] : ['active'],
        sensitivities: profile as MemoryRowSensitivity[], ...(cursor ? { after: cursor } : {}) }));
      const records = rows.slice(0, limit).map(fromRow) as MemoryEntry[];
      const stats = await storage(() => database.stats({ scope: key }));
      return immutable<MemoryPage>({ records, revision: stats.sequence, ...(rows.length > limit ? { nextCursor: records.at(-1)!.id } : {}) });
    },
    search: async (query, searchOptions = {}) => {
      permission('memory:read'); const request = object(searchOptions, 128, 2); allowedKeys(request, ['limit']);
      const ranked = await lexical(query, limitOf(request['limit'], 20, 50));
      const records = new Map((await visibleRecords(ranked.map(hit => hit.id))).map(record => [record.id, record]));
      const terms = [...new Set(tokens(query))];
      const stats = await storage(() => database.stats({ scope: key }));
      return immutable<MemorySearchResult>({ mode: 'lexical', revision: stats.sequence, hits: ranked.flatMap(hit => {
        const record = records.get(hit.id); if (!record) return [];
        const words = new Set(tokens(record.content)); return [{ record, score: hit.score, matchedTerms: terms.filter(term => words.has(term)) }];
      }) });
    },
    exportSnapshot: async () => {
      permission('memory:read'); permission('memory:export');
      const records: NativeMemoryEntry[] = []; let cursor: string | undefined;
      do {
        const page = await self.exportPage({ limit: 1_000, ...(cursor ? { cursor } : {}) });
        records.push(...page.records); cursor = page.nextCursor;
        if (records.length > 10_000) throw new MayuraError('LIMIT_EXCEEDED', 'Use exportPage for scopes larger than 10,000 records.');
      } while (cursor);
      const stats = await storage(() => database.stats({ scope: key }));
      return immutable<MemoryExport>({ format: 'mayura.memory.export.v1', scope: { ...scope }, revision: stats.sequence, exportedAt: clock(),
        records: records.filter(entry => entry.status !== 'superseded') as MemoryEntry[] });
    },
    supersede: async input => {
      permission('memory:write'); const command = object(input, 262_144, 12); exactKeys(command, ['id', 'expectedVersion', 'replacement']);
      const id = memoryId(command['id']); const expectedVersion = integer(command['expectedVersion'], 'Expected memory version');
      const existing = liveRecord(await current(id), expectedVersion);
      if (object(command['replacement'], 262_144)['id'] === id) throw new MayuraError('INVALID_INPUT', 'A replacement needs a new id.');
      await before({ operation: 'supersede', scope, id, expectedVersion, candidate: candidate(existing) });
      const replacement = await addRecord(command['replacement'] as unknown as MemoryInput);
      const superseded: MemorySupersededRecord = { ...existing, version: nextVersion(existing.version), status: 'superseded', supersededBy: replacement.id, updatedAt: later(existing.updatedAt) };
      await write(superseded, expectedVersion);
      await after({ operation: 'supersede', scope, id, version: superseded.version, status: 'superseded' });
      return immutable({ superseded, replacement });
    },
    relate: async input => {
      permission('memory:write'); const source = object(input, 16_384, 8); allowedKeys(source, edgeFields);
      const id = memoryId(source['id']); const from = memoryId(source['from']); const to = memoryId(source['to']);
      const relation = source['relation'];
      if (typeof relation !== 'string' || !relationPattern.test(relation) || from === to) throw new MayuraError('INVALID_INPUT', 'An edge needs a bounded relation between two distinct records.');
      const confidence = source['confidence'];
      if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new MayuraError('INVALID_INPUT', 'Edge confidence must be 0–1.');
      const edgeProvenance = provenance(source['provenance']); const interval = validity(source['validity'], edgeProvenance.observedAt);
      const metadata = object(source['metadata'] ?? {}, 2_048, 8);
      const endpoints = await visibleRecords([from, to]);
      if (endpoints.length !== 2) throw new MayuraError('NOT_FOUND', 'Both edge endpoints must be current records in this scope.');
      await before({ operation: 'relate', scope, id });
      const now = clock();
      const row: MemoryEdgeRow = { id, version: 1, status: 'active', from, to, relation, body: { confidence, provenance: edgeProvenance as unknown as JsonObject,
        validity: interval as unknown as JsonObject, metadata }, validFrom: interval.from, validUntil: interval.until, createdAt: now, updatedAt: now };
      await storage(() => database.putEdge({ scope: key, edge: row, expectedVersion: 0 }));
      await after({ operation: 'relate', scope, id, version: 1, status: 'active' });
      return immutable(edgeFromRow(row) as MemoryEdge);
    },
    forgetEdge: async input => {
      permission('memory:delete'); const command = object(input, 1_024, 2); exactKeys(command, ['id', 'expectedVersion']);
      const id = memoryId(command['id']); const expectedVersion = integer(command['expectedVersion'], 'Expected edge version');
      const existing = await storage(() => database.getEdge({ scope: key, id }));
      if (!existing) throw new MayuraError('NOT_FOUND', 'Memory edge was not found in this scope.');
      if (existing.status !== 'active' || existing.version !== expectedVersion) throw new MayuraError('CONFLICT', 'Memory edge was changed or deleted; refresh its current version.');
      await before({ operation: 'unrelate', scope, id, expectedVersion });
      const row: MemoryEdgeRow = { ...existing, version: nextVersion(existing.version), status: 'deleted', body: null, validFrom: null, validUntil: null, updatedAt: later(existing.updatedAt) };
      await storage(() => database.putEdge({ scope: key, edge: row, expectedVersion }));
      await after({ operation: 'unrelate', scope, id, version: row.version, status: 'deleted' });
      return immutable(edgeFromRow(row) as MemoryEdgeTombstone);
    },
    neighbors: async (id, request = {}) => {
      permission('memory:read'); memoryId(id); const settings = object(request, 4_096, 3); allowedKeys(settings, ['direction', 'relations', 'limit']);
      const direction = settings['direction'] ?? 'both';
      if (!['out', 'in', 'both'].includes(direction as string)) throw new MayuraError('INVALID_INPUT', 'direction must be out, in or both.');
      const relations = settings['relations'] as string[] | undefined; const limit = limitOf(settings['limit'], 50, 1_000);
      if ((await visibleRecords([id])).length !== 1) return immutable<MemorySubgraph>({ records: [], edges: [], truncated: false });
      const rows = await storage(() => database.edges({ scope: key, recordIds: [id], direction: direction as 'out', limit: limit + 1, ...filter(), ...(relations ? { relations } : {}) }));
      const edges = rows.slice(0, limit).map(edgeFromRow) as MemoryEdge[];
      const records = await visibleRecords([...new Set(edges.flatMap(edge => [edge.from, edge.to]).filter(other => other !== id))]);
      return immutable<MemorySubgraph>({ records, edges, truncated: rows.length > limit });
    },
    traverse: async (id, request = {}) => {
      permission('memory:read'); memoryId(id); const settings = object(request, 4_096, 3); allowedKeys(settings, ['maxDepth', 'maxNodes', 'relations']);
      const maxDepth = limitOf(settings['maxDepth'], 2, 4); const maxNodes = limitOf(settings['maxNodes'], 64, 256);
      const relations = settings['relations'] as string[] | undefined;
      const start = await visibleRecords([id]);
      if (start.length !== 1) return immutable<MemorySubgraph>({ records: [], edges: [], truncated: false });
      const nodes = new Set([id]); const edges = new Map<string, MemoryEdge>(); let frontier = [id]; let truncated = false;
      for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
        const rows = await storage(() => database.edges({ scope: key, recordIds: frontier, direction: 'both', limit: 10_000, ...filter(), ...(relations ? { relations } : {}) }));
        const next: string[] = [];
        for (const edge of rows.map(edgeFromRow) as MemoryEdge[]) {
          for (const node of [edge.from, edge.to]) {
            if (nodes.has(node)) continue;
            if (nodes.size >= maxNodes) { truncated = true; continue; }
            nodes.add(node); next.push(node);
          }
          if (nodes.has(edge.from) && nodes.has(edge.to)) edges.set(edge.id, edge);
        }
        frontier = next;
      }
      if (frontier.length > 0) truncated = true;
      const records = await visibleRecords([...nodes]);
      return immutable<MemorySubgraph>({ records, edges: [...edges.values()].sort((a, b) => (a.id < b.id ? -1 : 1)), truncated });
    },
    index: async (request = {}) => {
      permission('memory:index');
      if (!embedder) throw new MayuraError('INVALID_CONFIG', 'Semantic indexing requires an embedder.');
      const { signal: requested, ...rest } = request; const settings = object(rest, 256, 2); allowedKeys(settings, ['limit']); const limit = limitOf(settings['limit'], 500, 999);
      const signal = requested ?? new AbortController().signal;
      const missing = embedProfile.length === 0 ? [] : await storage(() => database.missingVectors({ scope: key, embedderId: embedder.id, sensitivities: embedProfile as MemoryRowSensitivity[], limit: limit + 1 }));
      const batch = missing.slice(0, limit); const rows = await readRows(batch.map(entry => entry.id));
      const records = batch.flatMap(entry => { const row = rows.get(entry.id); return row && row.status === 'active' && row.version === entry.version ? [fromRow(row) as MemoryRecord] : []; });
      const vectors = records.length === 0 ? [] : await embed(records.map(record => record.content), signal);
      let embedded = 0; let stale = batch.length - records.length;
      for (let index = 0; index < records.length; index += 1_000) {
        const result = await storage(() => database.putVectors({ scope: key, embedderId: embedder.id, dimensions: embedder.dimensions,
          entries: records.slice(index, index + 1_000).map((record, offset) => ({ recordId: record.id, recordVersion: record.version, vector: encodeVector(vectors[index + offset]!), list: null })) }));
        embedded += result.written; stale += result.stale.length;
      }
      const lists = await maintain();
      return immutable({ embedded, stale, remaining: missing.length > limit, lists });
    },
    semanticSearch: async (query, request = {}) => {
      permission('memory:read');
      const { signal: _signal, ...rest } = request; void _signal; const settings = object(rest, 256, 2); allowedKeys(settings, ['limit', 'nprobe', 'minScore']);
      const limit = limitOf(settings['limit'], 10, 50); const nprobe = limitOf(settings['nprobe'], 8, 1_024);
      const minScore = settings['minScore'] ?? -1;
      if (typeof minScore !== 'number' || minScore < -1 || minScore > 1) throw new MayuraError('INVALID_INPUT', 'minScore must be -1–1.');
      if (!embedder || (embedder.location === 'hosted' && !grants.has('memory:index'))) {
        const ranked = await lexical(query, limit); const records = new Map((await visibleRecords(ranked.map(hit => hit.id))).map(record => [record.id, record]));
        return immutable<SemanticSearchResult>({ mode: 'lexical', limitation: 'semantic_unavailable', hits: ranked.flatMap(hit => records.has(hit.id) ? [{ record: records.get(hit.id)!, score: hit.score }] : []) });
      }
      return semantic(query, limit, nprobe, minScore, request.signal ?? new AbortController().signal);
    },
    hybridSearch: async (query, request = {}) => {
      permission('memory:read');
      const limit = limitOf(request.limit, 10, 50);
      const lexicalHits = await lexical(query, limit * 4);
      let semanticResult: SemanticSearchResult | undefined;
      if (embedder && !(embedder.location === 'hosted' && !grants.has('memory:index'))) {
        semanticResult = await semantic(query, limit * 4, 8, -1, request.signal ?? new AbortController().signal);
      }
      const fused = reciprocalRankFusion([lexicalHits.map(hit => hit.id), ...(semanticResult ? [semanticResult.hits.map(hit => hit.record.id)] : [])]).slice(0, limit);
      const records = new Map((await visibleRecords(fused.map(hit => hit.id))).map(record => [record.id, record]));
      return immutable({ mode: semanticResult?.mode ?? 'lexical', fused: true as const, ...(semanticResult ? {} : { limitation: 'semantic_unavailable' as const }),
        hits: fused.flatMap(hit => records.has(hit.id) ? [{ record: records.get(hit.id)!, score: hit.score }] : []) });
    },
    exportPage: async (request = {}) => {
      permission('memory:read'); permission('memory:export');
      const settings = object(request, 2_048, 2); allowedKeys(settings, ['cursor', 'limit']); const limit = limitOf(settings['limit'], 500, 1_000);
      let phase: 'records' | 'edges' = 'records'; let afterId: string | undefined;
      if (settings['cursor'] !== undefined) {
        try {
          const parsed = object(JSON.parse(Buffer.from(String(settings['cursor']), 'base64url').toString('utf8')), 512, 2); exactKeys(parsed, ['phase', 'after']);
          if (parsed['phase'] !== 'records' && parsed['phase'] !== 'edges') throw new Error();
          phase = parsed['phase']; afterId = parsed['after'] === null ? undefined : memoryId(parsed['after']);
        } catch { throw new MayuraError('INVALID_INPUT', 'The export cursor is invalid.'); }
      }
      const stats = await storage(() => database.stats({ scope: key }));
      let records: NativeMemoryEntry[] = []; let edges: (MemoryEdge | MemoryEdgeTombstone)[] = []; let nextCursor: string | undefined;
      const encode = (value: { phase: string; after: string | null }): string => Buffer.from(JSON.stringify(value)).toString('base64url');
      if (phase === 'records') {
        const rows = await storage(() => database.listRecords({ scope: key, limit: limit + 1, statuses: ['active', 'superseded', 'deleted'], sensitivities: profile as MemoryRowSensitivity[], ...(afterId ? { after: afterId } : {}) }));
        records = rows.slice(0, limit).map(fromRow);
        nextCursor = rows.length > limit ? encode({ phase: 'records', after: records.at(-1)!.id }) : encode({ phase: 'edges', after: null });
      } else {
        const rows = await storage(() => database.listEdges({ scope: key, limit: limit + 1, ...(afterId ? { after: afterId } : {}) }));
        const visible = new Set([...(await readRows([...new Set(rows.flatMap(row => [row.from, row.to]))])).values()].filter(row => admitted(row.sensitivity)).map(row => row.id));
        edges = rows.slice(0, limit).filter(row => visible.has(row.from) && visible.has(row.to)).map(edgeFromRow);
        nextCursor = rows.length > limit ? encode({ phase: 'edges', after: rows[limit - 1]!.id }) : undefined;
      }
      return immutable<MemoryExportPage>({ format: 'mayura.memory.export.v2', scope: { ...scope }, sequence: stats.sequence, exportedAt: clock(), records, edges, ...(nextCursor ? { nextCursor } : {}) });
    },
    importSnapshot: async (snapshot, request) => {
      permission('memory:write'); permission('memory:import');
      const settings = object(request, 128, 2); exactKeys(settings, ['mode']); const mode = settings['mode'];
      if (mode !== 'merge' && mode !== 'replace-empty') throw new MayuraError('INVALID_INPUT', 'Import mode must be merge or replace-empty.');
      const document = object(snapshot, 64 * 1_048_576, 14, 2_000_000);
      if (document['format'] !== 'mayura.memory.export.v1' && document['format'] !== 'mayura.memory.export.v2') throw new MayuraError('INVALID_INPUT', 'Unknown memory export format.');
      const records = document['records']; const edges = document['format'] === 'mayura.memory.export.v2' ? document['edges'] : [];
      if (!Array.isArray(records) || !Array.isArray(edges)) throw new MayuraError('INVALID_INPUT', 'Memory export records and edges must be arrays.');
      if (mode === 'replace-empty' && (await storage(() => database.stats({ scope: key }))).sequence > 0) throw new MayuraError('CONFLICT', 'replace-empty import requires an empty scope.');
      // Validate every entry before the first write.
      for (const raw of records) {
        const item = object(raw, 262_144);
        if (item['status'] === 'superseded') { const { supersededBy, ...rest } = item; memoryId(supersededBy); parseEntry({ ...rest, status: 'active', scope }, scope); }
        else parseEntry({ ...item, scope }, scope);
      }
      let imported = 0; let skipped = 0; let importedEdges = 0;
      for (const raw of records) { if (await importEntry(raw, mode)) imported++; else skipped++; }
      for (const raw of edges) {
        const edge = object(raw, 16_384, 8);
        if (edge['status'] !== 'active') { skipped++; continue; }
        const existing = await storage(() => database.getEdge({ scope: key, id: memoryId(edge['id']) }));
        if (existing) { skipped++; continue; }
        const interval = validity(edge['validity'], provenance(edge['provenance']).observedAt);
        const row: MemoryEdgeRow = { id: memoryId(edge['id']), version: integer(edge['version'], 'Edge version'), status: 'active', from: memoryId(edge['from']), to: memoryId(edge['to']),
          relation: String(edge['relation']), body: { confidence: edge['confidence']!, provenance: provenance(edge['provenance']) as unknown as JsonObject, validity: interval as unknown as JsonObject,
            metadata: object(edge['metadata'] ?? {}, 2_048, 8) }, validFrom: interval.from, validUntil: interval.until,
          createdAt: timestamp(edge['createdAt']), updatedAt: timestamp(edge['updatedAt']) };
        try { await storage(() => database.putEdge({ scope: key, edge: row, expectedVersion: 0 })); importedEdges++; }
        catch (error) { if (error instanceof MayuraError && error.code === 'CONFLICT') { skipped++; continue; } throw error; }
      }
      return immutable({ imported, skipped, edges: importedEdges });
    },
    changes: async (request = {}) => {
      permission('memory:read'); const settings = object(request, 128, 2); allowedKeys(settings, ['after', 'limit']);
      return storage(() => database.changes({ scope: key, after: settings['after'] === undefined || settings['after'] === 0 ? 0 : integer(settings['after'], 'Change cursor'), limit: limitOf(settings['limit'], 100, 1_000) }));
    },
  };
  return Object.freeze(self);
}
export type { MemoryCategory };
