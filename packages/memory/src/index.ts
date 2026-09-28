import { MayuraError, jsonValue, type JsonObject, type Scope } from '@mayura/core';
import { evaluateLifecycleControl, evaluateLifecycleObserver, snapshotHookOptions } from '@mayura/core/host';
import { StorageError, type StoredRecord } from '@mayura/storage-contracts';
import type { AfterMemoryWriteEvent, BeforeMemoryWriteEvent, MemoryEntry, MemoryHooks, MemoryListOptions, MemoryRecord, MemoryStore, MemoryStoreOptions, MemoryTombstone, MemoryWriteOperation } from './contracts.js';
import { MAX_AGGREGATE_BYTES, MAX_RECORDS, SENSITIVITIES, activeRecord, allowedKeys, exactKeys, immutable, integer, memoryId, object, parseEntry, sensitivity, sha256, text } from './validation.js';

export * from './contracts.js';
const aggregateId = 'mayura.native-memory.v1';
const definitionHash = 'mayura.native-memory.v1';
interface State { format: 1; scope: Scope; records: Record<string, MemoryEntry> }
interface ReadState { record?: StoredRecord; state: State }
const inputFields = ['id', 'category', 'content', 'metadata', 'sensitivity', 'provenance', 'validity'];

/** Never reflect arbitrary custom-adapter messages, including framework-shaped exceptions. */
async function adapter<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    let conflict = false;
    try {
      if (error instanceof StorageError || error instanceof MayuraError) {
        const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
        conflict = descriptor !== undefined && 'value' in descriptor && descriptor.value === 'CONFLICT';
      }
    } catch { /* Untrusted exception proxies/accessors cannot control the public error channel. */ }
    if (conflict) throw new StorageError('CONFLICT', 'Memory storage version changed.');
    throw new MayuraError('STORAGE_UNAVAILABLE', 'Memory storage is unavailable. Check protected local diagnostics.');
  }
}

function pageLimit(value: unknown): number {
  const limit = value === undefined ? 20 : integer(value, 'Page limit');
  if (limit > 50) throw new MayuraError('INVALID_INPUT', 'Memory pages are limited to 50 records.');
  return limit;
}
interface WriteHooks {
  before(event: BeforeMemoryWriteEvent): Promise<void>;
  after(event: AfterMemoryWriteEvent): Promise<void>;
}
/** Snapshot hook options once as own data properties. */
function memoryWriteHooks(value: MemoryHooks | undefined): WriteHooks {
  const { handlers, timeoutMs } = snapshotHookOptions(value, ['beforeMemoryWrite', 'afterMemoryWrite'] as const,
    'Memory hooks require callable beforeMemoryWrite/afterMemoryWrite handlers and a bounded timeout.');
  const before = handlers.beforeMemoryWrite as MemoryHooks['beforeMemoryWrite']; const after = handlers.afterMemoryWrite as MemoryHooks['afterMemoryWrite'];
  return Object.freeze({
    before: async (event: BeforeMemoryWriteEvent) => { if (before) await evaluateLifecycleControl({ stage: 'beforeMemoryWrite', handler: before, event: structuredClone(event), timeoutMs }); },
    after: async (event: AfterMemoryWriteEvent) => {
      if (!after) return;
      try { await evaluateLifecycleObserver({ stage: 'afterMemoryWrite', handler: after, event: structuredClone(event), timeoutMs }); }
      catch { throw new MayuraError('GUARD_UNAVAILABLE', 'The memory write committed, but a required after-write hook failed.'); }
    },
  });
}
function candidateView(record: MemoryRecord): NonNullable<BeforeMemoryWriteEvent['candidate']> {
  return { content: record.content, category: record.category, sensitivity: record.sensitivity, provenance: record.provenance, validity: record.validity, metadata: record.metadata };
}
function committed(operation: MemoryWriteOperation, entry: MemoryEntry): AfterMemoryWriteEvent {
  return { operation, scope: entry.scope, id: entry.id, version: entry.version, status: entry.status };
}

function nextVersion(version: number): number {
  if (version === Number.MAX_SAFE_INTEGER) throw new MayuraError('CONFLICT', 'Memory version exhausted.');
  return version + 1;
}

/**
 * Creates a bounded native canonical memory service over caller-owned initialized storage.
 * Scope/permissions must come from a trusted identity boundary. No external requests are made.
 */
export function createMemoryStore(options: MemoryStoreOptions): MemoryStore {
  if (!options || typeof options !== 'object' || !options.store || !['read', 'create', 'update'].every(method => typeof (options.store as unknown as Record<string, unknown>)[method] === 'function')) throw new MayuraError('INVALID_CONFIG', 'Memory requires a storage adapter and verified scope.');
  let scope: Scope;
  try { scope = Object.freeze({ principalId: text(options.scope?.principalId, 'Principal ID', 128), projectId: text(options.scope?.projectId, 'Project ID', 128) }); }
  catch { throw new MayuraError('INVALID_CONFIG', 'Memory requires bounded principal and project identifiers.'); }
  if (!Array.isArray(options.permissions?.allow) || options.permissions.allow.length > 4096) throw new MayuraError('INVALID_CONFIG', 'Memory permissions require a bounded grant list.');
  const grants = new Set(options.permissions.allow.map(grant => text(grant, 'Grant', 384)));
  const profile = options.allowedSensitivities ?? ['public', 'internal'];
  if (!Array.isArray(profile) || profile.length > SENSITIVITIES.length || new Set(profile).size !== profile.length) throw new MayuraError('INVALID_CONFIG', 'Memory sensitivity profile is invalid.');
  const sensitivities = new Set(profile.map(value => sensitivity(value)));
  const { store } = options;
  const hooks = memoryWriteHooks(options.hooks);
  const scopeKey = sha256(`mayura:memory-scope:v1\n${JSON.stringify([scope.principalId, scope.projectId])}`);
  const profileHash = sha256(`mayura:memory-profile:v1\n${JSON.stringify([...sensitivities].sort())}`);
  const permission = (grant: string): void => { if (!grants.has(grant)) throw new MayuraError('PERMISSION_DENIED', 'The memory operation requires a capability that was not granted.'); };
  const admitted = (record: MemoryEntry): boolean => sensitivities.has(record.sensitivity);
  const authorizeRecord = (record: MemoryEntry): void => { if (!admitted(record)) throw new MayuraError('PERMISSION_DENIED', 'The memory record exceeds the permitted sensitivity profile.'); };
  const empty = (): State => ({ format: 1, scope: { ...scope }, records: {} });
  const serialize = (state: State): JsonObject => {
    try { return jsonValue(state, { maxBytes: MAX_AGGREGATE_BYTES, maxNodes: 100_000 }) as JsonObject; }
    catch { throw new MayuraError('LIMIT_EXCEEDED', 'The experimental memory scope exceeded its bounded storage capacity.'); }
  };
  const parse = (record: StoredRecord): State => {
    try {
      if (record.scope !== scopeKey || record.id !== aggregateId || record.definitionHash !== definitionHash) throw new Error();
      const state = object(record.state, MAX_AGGREGATE_BYTES, 32, 100_000); exactKeys(state, ['format', 'scope', 'records']);
      const owner = object(state['scope'], 512, 2); exactKeys(owner, ['principalId', 'projectId']);
      if (state['format'] !== 1 || owner['principalId'] !== scope.principalId || owner['projectId'] !== scope.projectId) throw new Error();
      const values = object(state['records'], MAX_AGGREGATE_BYTES, 31, 100_000);
      if (Object.keys(values).length > MAX_RECORDS) throw new Error();
      const records: Record<string, MemoryEntry> = {};
      for (const [id, raw] of Object.entries(values)) {
        const entry = parseEntry(raw, scope);
        if (entry.id !== id) throw new Error();
        records[id] = entry;
      }
      return { format: 1, scope: { ...scope }, records };
    } catch { throw new MayuraError('CONFLICT', 'Stored memory failed its scope, version or integrity checks.'); }
  };
  const read = async (): Promise<ReadState> => {
    const record = await adapter(() => store.read(scopeKey, aggregateId));
    return record ? { record, state: parse(record) } : { state: empty() };
  };
  const mutate = async <T extends MemoryEntry>(allowCreate: boolean, operation: string, transform: (state: State) => T): Promise<T> => {
    for (let attempt = 0; attempt < 32; attempt++) {
      let { record, state } = await read();
      if (!record) {
        if (!allowCreate) throw new MayuraError('NOT_FOUND', 'Memory record was not found in this scope.');
        record = await adapter(async () => {
          const created = await store.create({ scope: scopeKey, id: aggregateId, idempotencyKey: aggregateId, definitionHash, state: serialize(empty()), events: [] });
          if (!created || typeof created !== 'object') throw new Error();
          return created.record;
        });
        state = parse(record);
      }
      const result = transform(state);
      const persisted = serialize(state);
      try {
        const expectedVersion = record.version;
        const updated = await adapter(async () => {
          const response = await store.update({ scope: scopeKey, id: aggregateId, expectedVersion, state: persisted, events: [{ type: operation, data: { memoryId: result.id, version: result.version } }] });
          if (!response || response.version !== expectedVersion + 1) throw new Error();
          return response;
        });
        parse(updated);
        return immutable(result);
      } catch (error) { if (!(error instanceof StorageError) || error.storageCode !== 'CONFLICT') throw error; }
    }
    throw new MayuraError('CONFLICT', 'Memory contention exceeded the bounded retry limit.');
  };
  const currentActive = (state: State, id: string, expectedVersion: number): MemoryRecord => {
    const current = state.records[id];
    if (!current) throw new MayuraError('NOT_FOUND', 'Memory record was not found in this scope.');
    authorizeRecord(current);
    if (current.status !== 'active' || current.version !== expectedVersion) throw new MayuraError('CONFLICT', 'Memory was changed or deleted; refresh its current version.');
    return current;
  };
  const filtered = (state: State, includeDeleted: boolean): MemoryEntry[] => Object.values(state.records)
    .filter(entry => admitted(entry) && (includeDeleted || entry.status === 'active'))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  return Object.freeze<MemoryStore>({
    add: async input => {
      permission('memory:write');
      const source = object(input); allowedKeys(source, inputFields); const now = new Date().toISOString();
      const candidate = activeRecord(source, scope, 1, now, now); authorizeRecord(candidate);
      await hooks.before({ operation: 'add', scope, id: candidate.id, candidate: candidateView(candidate) });
      const added = await mutate(true, 'memory.added', state => {
        if (state.records[candidate.id]) throw new MayuraError('CONFLICT', 'Memory ID already exists or is retained by a tombstone.');
        if (Object.keys(state.records).length >= MAX_RECORDS) throw new MayuraError('LIMIT_EXCEEDED', 'Experimental memory scopes support at most 128 lifetime record IDs.');
        state.records[candidate.id] = candidate; return candidate;
      });
      await hooks.after(committed('add', added)); return added;
    },
    correct: async input => {
      permission('memory:write'); const source = object(input); allowedKeys(source, [...inputFields, 'expectedVersion']);
      const id = memoryId(source['id']); const expectedVersion = integer(source['expectedVersion'], 'Expected memory version');
      // Validate the replacement before reading/mutating persistent state.
      const provisional = activeRecord(source, scope, 1, new Date().toISOString(), new Date().toISOString()); authorizeRecord(provisional);
      await hooks.before({ operation: 'correct', scope, id, expectedVersion, candidate: candidateView(provisional) });
      const corrected = await mutate(false, 'memory.corrected', state => {
        const current = currentActive(state, id, expectedVersion);
        const updatedAt = new Date(Math.max(Date.now(), Date.parse(current.updatedAt))).toISOString();
        const next = activeRecord(source, scope, nextVersion(current.version), current.createdAt, updatedAt);
        state.records[id] = next; return next;
      });
      await hooks.after(committed('correct', corrected)); return corrected;
    },
    forget: async input => {
      permission('memory:delete'); const command = object(input, 1_024, 2); exactKeys(command, ['id', 'expectedVersion']);
      const id = memoryId(command['id']); const expectedVersion = integer(command['expectedVersion'], 'Expected memory version');
      await hooks.before({ operation: 'forget', scope, id, expectedVersion });
      const forgotten = await mutate(false, 'memory.forgotten', state => {
        const current = currentActive(state, id, expectedVersion);
        const deletedAt = new Date(Math.max(Date.now(), Date.parse(current.updatedAt))).toISOString();
        const tombstone: MemoryTombstone = { id, version: nextVersion(current.version), status: 'deleted', scope: { ...scope }, sensitivity: current.sensitivity, createdAt: current.createdAt, updatedAt: deletedAt, deletedAt };
        state.records[id] = tombstone; return tombstone;
      });
      await hooks.after(committed('forget', forgotten)); return forgotten;
    },
    get: async (id, query = {}) => {
      permission('memory:read'); memoryId(id); const request = object(query, 256, 2); allowedKeys(request, ['includeDeleted']);
      const includeDeleted = request['includeDeleted'] ?? false;
      if (typeof includeDeleted !== 'boolean') throw new MayuraError('INVALID_INPUT', 'includeDeleted must be boolean.');
      const { state } = await read(); const entry = state.records[id];
      return entry && admitted(entry) && (includeDeleted || entry.status === 'active') ? immutable(entry) : undefined;
    },
    list: async (query: MemoryListOptions = {}) => {
      permission('memory:read'); const request = object(query, 2_048, 2); allowedKeys(request, ['limit', 'cursor', 'includeDeleted']);
      const limit = pageLimit(request['limit']); const includeDeleted = request['includeDeleted'] ?? false; const requestCursor = request['cursor'];
      if (typeof includeDeleted !== 'boolean') throw new MayuraError('INVALID_INPUT', 'includeDeleted must be boolean.');
      const { record, state } = await read(); const revision = record?.version ?? 0;
      let after = '';
      if (requestCursor !== undefined) {
        try {
          if (typeof requestCursor !== 'string' || requestCursor.length > 1_024 || !/^[A-Za-z0-9_-]+$/.test(requestCursor)) throw new Error();
          const value = object(JSON.parse(Buffer.from(requestCursor, 'base64url').toString('utf8')), 1_024, 2);
          exactKeys(value, ['format', 'scope', 'profile', 'revision', 'after', 'includeDeleted']);
          if (value['format'] !== 1 || value['scope'] !== scopeKey || value['profile'] !== profileHash || value['revision'] !== revision || value['includeDeleted'] !== includeDeleted) throw new Error();
          after = memoryId(value['after']);
        } catch { throw new MayuraError('CONFLICT', 'Memory cursor is invalid or its scoped snapshot has changed.'); }
      }
      const candidates = filtered(state, includeDeleted).filter(entry => entry.id > after);
      const records = candidates.slice(0, limit);
      const last = records.at(-1);
      const nextCursor = last && candidates.length > records.length
        ? Buffer.from(JSON.stringify({ format: 1, scope: scopeKey, profile: profileHash, revision, after: last.id, includeDeleted })).toString('base64url') : undefined;
      return immutable({ records, revision, ...(nextCursor ? { nextCursor } : {}) });
    },
    search: async (query, searchOptions = {}) => {
      permission('memory:read'); text(query, 'Search query', 512); const request = object(searchOptions, 128, 2); allowedKeys(request, ['limit']); const limit = pageLimit(request['limit']);
      const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])];
      if (terms.length === 0 || terms.length > 16) throw new MayuraError('INVALID_INPUT', 'Lexical search requires 1–16 query terms.');
      const { record, state } = await read(); const now = Date.now();
      const hits = filtered(state, false).flatMap(entry => {
        if (entry.status !== 'active' || Date.parse(entry.validity.from) > now || (entry.validity.until !== null && Date.parse(entry.validity.until) <= now)) return [];
        const tokens = entry.content.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
        const counts = new Map<string, number>(); for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
        if (!terms.every(term => counts.has(term))) return [];
        return [{ record: entry, score: terms.reduce((score, term) => score + counts.get(term)!, 0), matchedTerms: terms }];
      }).sort((a, b) => b.score - a.score || (a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0)).slice(0, limit);
      return immutable({ mode: 'lexical', revision: record?.version ?? 0, hits });
    },
    exportSnapshot: async () => {
      permission('memory:read'); permission('memory:export');
      const { record, state } = await read();
      return immutable({ format: 'mayura.memory.export.v1', scope: { ...scope }, revision: record?.version ?? 0, exportedAt: new Date().toISOString(), records: filtered(state, true) });
    },
  });
}
export { createNativeMemory, type NativeMemory, type NativeMemoryOptions, type NativeMemoryEntry, type MemoryEdge, type MemoryEdgeInput,
  type MemoryEdgeTombstone, type MemorySubgraph, type MemoryIndexReport, type SemanticSearchResult, type MemoryExportPage, type MemoryImportReport } from './native.js';
export { hashingEmbedder, type MemoryEmbedder } from './vectors.js';
