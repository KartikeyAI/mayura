import { freezeJson, jsonValue, MayuraError, type ErrorCode, type JsonObject, type JsonValue } from '@mayura/core';
import { StorageError, type StoredRecord } from '@mayura/storage-contracts';
import { digest } from './definition.js';
import { assertWorkflowLifecycle, type AnyWorkflowLifecycle } from './lifecycle-definition.js';
import { createWorkflowLifecycleRuntime, type WorkflowLifecycleRuntime,
  type WorkflowLifecycleRuntimeOptions, type WorkflowLifecycleSnapshot } from './lifecycle-runtime.js';

export interface WorkflowLifecycleFleetCursor {
  readonly format: 1;
  readonly scope: string;
  readonly shard: number;
  readonly afterId: string;
}
export interface WorkflowLifecycleFleetCandidate {
  readonly runId: string;
  readonly definitionHash: string;
  readonly version: number;
  readonly status: 'running' | 'waiting' | 'paused';
  readonly nextWakeAtMs: number | null;
}
export interface WorkflowLifecycleFleetPage {
  readonly candidates: readonly WorkflowLifecycleFleetCandidate[];
  readonly examined: number;
  readonly shardReads: number;
  readonly nextCursor: WorkflowLifecycleFleetCursor | null;
}
export type WorkflowLifecycleFleetOutcome =
  | { readonly kind: 'advanced'; readonly runId: string; readonly status: WorkflowLifecycleSnapshot['status'] }
  | { readonly kind: 'deferred'; readonly runId: string; readonly nextWakeAtMs: number | null }
  | { readonly kind: 'skipped'; readonly runId: string; readonly reason: 'unregistered_definition' }
  | { readonly kind: 'failed'; readonly runId: string; readonly code: ErrorCode };
export interface WorkflowLifecycleFleetReport {
  readonly page: WorkflowLifecycleFleetPage;
  readonly outcomes: readonly WorkflowLifecycleFleetOutcome[];
}
/** A run that reached a final status, kept in a bounded per-scope list for operators. */
export interface WorkflowLifecycleSettledEntry {
  readonly runId: string;
  readonly definitionHash: string;
  readonly version: number;
  readonly status: 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'outcome_unknown';
  readonly settledAtMs: number;
}
export interface WorkflowLifecycleSettledPage {
  readonly entries: readonly WorkflowLifecycleSettledEntry[];
  readonly shardReads: number;
  readonly nextCursor: WorkflowLifecycleFleetCursor | null;
}
export interface WorkflowLifecycleFleetRuntime extends WorkflowLifecycleRuntime {
  /**
   * Recently settled runs, for operators: at most 64 per shard (16,384 per scope), oldest dropped first, and a run
   * whose outcome is unknown (it needs reconciliation) is kept in preference to finished ones.
   */
  settled(command?: { readonly cursor?: WorkflowLifecycleFleetCursor | null; readonly limit?: number;
    readonly maxShardReads?: number }): Promise<WorkflowLifecycleSettledPage>;
  scan(command?: { readonly cursor?: WorkflowLifecycleFleetCursor | null; readonly limit?: number;
    readonly maxShardReads?: number }): Promise<WorkflowLifecycleFleetPage>;
  runPage(definitions: readonly AnyWorkflowLifecycle[], command?: { readonly cursor?: WorkflowLifecycleFleetCursor | null;
    readonly limit?: number; readonly maxShardReads?: number }): Promise<WorkflowLifecycleFleetReport>;
}
export interface WorkflowLifecycleFleetRuntimeOptions extends WorkflowLifecycleRuntimeOptions {
  readonly indexMaxEntriesPerShard?: number;
  readonly indexMaxConflictRetries?: number;
}

interface IndexEntry {
  runId: string; definitionHash: string; version: number; status: 'running' | 'waiting' | 'paused'; nextWakeAtMs: number | null;
}
interface IndexState { format: 1; shard: string; entries: IndexEntry[] }
const hashPattern = /^[a-f0-9]{64}$/;
const terminal = new Set<WorkflowLifecycleSnapshot['status']>(['succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown']);
const hex = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, '0'));

function object(value: JsonValue | undefined): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new MayuraError('CONFLICT', 'Lifecycle fleet index failed integrity validation.');
  return value;
}
function indexId(shard: string): string { return `lifecycle-index.${shard}`; }
function settledId(shard: string): string { return `lifecycle-settled.${shard}`; }
const settledPerShard = 64;
/**
 * Keep at most `maximum` entries: drop the oldest finished run first, and a run whose outcome is unknown only when
 * nothing else is left, because those are the runs an operator must still reconcile. Sorted by run id for paging.
 * @internal
 */
export function retainSettled(entries: readonly WorkflowLifecycleSettledEntry[], maximum: number): WorkflowLifecycleSettledEntry[] {
  const kept = [...entries];
  while (kept.length > maximum) {
    const oldest = (unknown: boolean) => kept.reduce<number>((found, entry, position) => (entry.status === 'outcome_unknown') === unknown
      && (found < 0 || entry.settledAtMs < kept[found]!.settledAtMs) ? position : found, -1);
    const finished = oldest(false);
    kept.splice(finished >= 0 ? finished : oldest(true), 1);
  }
  return kept.sort((left, right) => left.runId.localeCompare(right.runId));
}
interface SettledState { format: 1; shard: string; entries: WorkflowLifecycleSettledEntry[] }
function settledFrom(record: StoredRecord, scope: string, shard: string): SettledState {
  try {
    if (record.scope !== scope || record.id !== settledId(shard)
      || record.definitionHash !== digest('mayura:workflow-lifecycle-settled-format:v1', { shard })) throw new Error();
    const raw = object(record.state);
    if (Object.keys(raw).length !== 3 || raw['format'] !== 1 || raw['shard'] !== shard || !Array.isArray(raw['entries']) || raw['entries'].length > settledPerShard) throw new Error();
    const entries = raw['entries'].map(value => {
      const entry = object(value);
      if (Object.keys(entry).length !== 5 || typeof entry['runId'] !== 'string' || !hashPattern.test(entry['runId']) || !entry['runId'].startsWith(shard)
        || typeof entry['definitionHash'] !== 'string' || !hashPattern.test(entry['definitionHash']) || !Number.isSafeInteger(entry['version'])
        || !terminal.has(entry['status'] as WorkflowLifecycleSnapshot['status']) || !Number.isSafeInteger(entry['settledAtMs'])) throw new Error();
      return entry as unknown as WorkflowLifecycleSettledEntry;
    });
    return { format: 1, shard, entries };
  } catch { throw new MayuraError('CONFLICT', 'Lifecycle settled index failed integrity validation.'); }
}
function stateFrom(record: StoredRecord, scope: string, shard: string, maximum: number): IndexState {
  try {
    if (record.scope !== scope || record.id !== indexId(shard)
      || record.definitionHash !== digest('mayura:workflow-lifecycle-index-format:v1', { shard })) throw new Error();
    const raw = object(jsonValue(record.state, { maxBytes: 1_048_576 }));
    if (Object.keys(raw).length !== 3 || raw['format'] !== 1 || raw['shard'] !== shard || !Array.isArray(raw['entries']) || raw['entries'].length > maximum) throw new Error();
    const entries = raw['entries'].map(item => {
      const entry = object(item);
      if (Object.keys(entry).length !== 5 || typeof entry['runId'] !== 'string' || !hashPattern.test(entry['runId']) || !entry['runId'].startsWith(shard)
        || typeof entry['definitionHash'] !== 'string' || !hashPattern.test(entry['definitionHash'])
        || typeof entry['version'] !== 'number' || !Number.isSafeInteger(entry['version']) || entry['version'] < 1
        || !['running', 'waiting', 'paused'].includes(String(entry['status']))
        || (entry['nextWakeAtMs'] !== null && (typeof entry['nextWakeAtMs'] !== 'number' || !Number.isSafeInteger(entry['nextWakeAtMs']) || entry['nextWakeAtMs'] < 0))) throw new Error();
      return entry as unknown as IndexEntry;
    });
    if (entries.some((entry, index) => index > 0 && entry.runId <= entries[index - 1]!.runId)) throw new Error();
    return { format: 1, shard, entries };
  } catch { throw new MayuraError('CONFLICT', 'Lifecycle fleet index failed integrity validation.'); }
}
function failure(error: unknown): ErrorCode {
  if (error instanceof MayuraError) return error.code;
  if (error instanceof StorageError) {
    if (error.code === 'QUEUE_FULL' || error.code === 'LIMIT_EXCEEDED') return 'LIMIT_EXCEEDED';
    if (['INVALID_INPUT', 'CONFLICT', 'NOT_FOUND'].includes(error.code)) return error.code as 'INVALID_INPUT' | 'CONFLICT' | 'NOT_FOUND';
  }
  return 'STORAGE_UNAVAILABLE';
}

/** Durable sharded discovery over the base aggregate contract; the caller still owns storage lifecycle and scheduling. */
export function createWorkflowLifecycleFleetRuntime(options: WorkflowLifecycleFleetRuntimeOptions): WorkflowLifecycleFleetRuntime {
  const maximum = options.indexMaxEntriesPerShard ?? 256; const retries = options.indexMaxConflictRetries ?? 32;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 512 || !Number.isSafeInteger(retries) || retries < 1 || retries > 128) {
    throw new MayuraError('INVALID_CONFIG', 'Lifecycle fleet index limits are invalid.');
  }
  const runtime = createWorkflowLifecycleRuntime(options); const store = options.store;
  const scope = digest('mayura:scope:v1', { principalId: options.scope.principalId, projectId: options.scope.projectId });
  const now = (): number => {
    let value: unknown;
    try { value = (options.now ?? Date.now)(); }
    catch { throw new MayuraError('STORAGE_UNAVAILABLE', 'Lifecycle fleet clock is unavailable.'); }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new MayuraError('STORAGE_UNAVAILABLE', 'Lifecycle fleet clock is invalid.');
    return value;
  };
  let closed = false;
  const open = (): void => { if (closed) throw new MayuraError('CANCELLED', 'Lifecycle fleet runtime is closed.'); };
  const read = async (shard: string): Promise<{ record: StoredRecord; state: IndexState } | undefined> => {
    open();
    try {
      const record = await store.read(scope, indexId(shard)); return record ? { record, state: stateFrom(record, scope, shard, maximum) } : undefined;
    } catch (error) {
      if (error instanceof MayuraError) throw error;
      throw new MayuraError('STORAGE_UNAVAILABLE', 'Lifecycle fleet index could not be read.');
    }
  };
  const ensure = async (shard: string): Promise<{ record: StoredRecord; state: IndexState }> => {
    const existing = await read(shard); if (existing) return existing;
    const definitionHash = digest('mayura:workflow-lifecycle-index-format:v1', { shard });
    try {
      const created = await store.create({ scope, id: indexId(shard), idempotencyKey: indexId(shard), definitionHash,
        state: { format: 1, shard, entries: [] }, events: [{ type: 'lifecycle-index.created', data: { shard } }] });
      return { record: created.record, state: stateFrom(created.record, scope, shard, maximum) };
    } catch { throw new MayuraError('STORAGE_UNAVAILABLE', 'Lifecycle fleet index could not be initialized.'); }
  };
  const write = async (snapshot: WorkflowLifecycleSnapshot, definitionHash?: string): Promise<void> => {
    open(); const shard = snapshot.id.slice(0, 2);
    for (let attempt = 0; attempt < retries; attempt++) {
      const found = await read(shard);
      if (terminal.has(snapshot.status) && !found) return;
      const current = found ?? await ensure(shard); const index = current.state.entries.findIndex(entry => entry.runId === snapshot.id);
      if (terminal.has(snapshot.status)) {
        if (index < 0) return;
        // Record the outcome before the run leaves the active index, so a crash between the two leaves it in both.
        await settle(snapshot, current.state.entries[index]!.definitionHash);
        current.state.entries.splice(index, 1);
      } else {
        if (snapshot.status !== 'running' && snapshot.status !== 'waiting' && snapshot.status !== 'paused') {
          throw new MayuraError('CONFLICT', 'Lifecycle fleet received an invalid nonterminal state.');
        }
        const previous = current.state.entries[index]; const hash = definitionHash ?? previous?.definitionHash;
        if (!hash || !hashPattern.test(hash)) throw new MayuraError('CONFLICT', 'Lifecycle run is missing its durable fleet definition identity.');
        const entry: IndexEntry = { runId: snapshot.id, definitionHash: hash, version: snapshot.version,
          status: snapshot.status, nextWakeAtMs: snapshot.nextWakeAtMs };
        if (previous && previous.version > entry.version) return;
        if (previous && previous.version === entry.version && JSON.stringify(previous) !== JSON.stringify(entry)) {
          throw new MayuraError('CONFLICT', 'Equal lifecycle versions produced conflicting fleet evidence.');
        }
        if (previous && JSON.stringify(previous) === JSON.stringify(entry)) return;
        if (index < 0) {
          if (current.state.entries.length >= maximum) throw new MayuraError('LIMIT_EXCEEDED', 'Lifecycle fleet index shard is full.');
          current.state.entries.push(entry); current.state.entries.sort((left, right) => left.runId.localeCompare(right.runId));
        } else current.state.entries[index] = entry;
      }
      try {
        await store.update({ scope, id: current.record.id, expectedVersion: current.record.version,
          state: jsonValue(current.state) as JsonObject, events: [{ type: terminal.has(snapshot.status) ? 'lifecycle-index.removed' : 'lifecycle-index.updated',
            data: { runId: snapshot.id, version: snapshot.version, status: snapshot.status } }] }); return;
      } catch (error) {
        if (error instanceof StorageError && error.code === 'CONFLICT') continue;
        throw new MayuraError('STORAGE_UNAVAILABLE', 'Lifecycle fleet index update could not be confirmed.');
      }
    }
    throw new MayuraError('CONFLICT', 'Lifecycle fleet index remained busy after bounded retries.');
  };
  const readSettled = async (shard: string): Promise<{ record: StoredRecord; state: SettledState } | undefined> => {
    open();
    try { const record = await store.read(scope, settledId(shard)); return record ? { record, state: settledFrom(record, scope, shard) } : undefined; }
    catch (error) { if (error instanceof MayuraError) throw error; throw new MayuraError('STORAGE_UNAVAILABLE', 'Lifecycle settled index could not be read.'); }
  };
  /** Add or refresh one settled entry, keeping the shard bounded and runs needing reconciliation over finished ones. */
  async function settle(snapshot: WorkflowLifecycleSnapshot, definitionHash: string): Promise<void> {
    const shard = snapshot.id.slice(0, 2);
    for (let attempt = 0; attempt < retries; attempt++) {
      let current = await readSettled(shard);
      if (!current) {
        try {
          const created = await store.create({ scope, id: settledId(shard), idempotencyKey: settledId(shard),
            definitionHash: digest('mayura:workflow-lifecycle-settled-format:v1', { shard }), state: { format: 1, shard, entries: [] },
            events: [{ type: 'lifecycle-settled.created', data: { shard } }] });
          current = { record: created.record, state: settledFrom(created.record, scope, shard) };
        } catch { throw new MayuraError('STORAGE_UNAVAILABLE', 'Lifecycle settled index could not be initialized.'); }
      }
      const entries = current.state.entries.filter(entry => entry.runId !== snapshot.id);
      const previous = current.state.entries.find(entry => entry.runId === snapshot.id);
      if (previous && previous.version >= snapshot.version) return;
      entries.push({ runId: snapshot.id, definitionHash, version: snapshot.version, status: snapshot.status as WorkflowLifecycleSettledEntry['status'], settledAtMs: now() });
      const retained = retainSettled(entries, settledPerShard);
      try {
        await store.update({ scope, id: current.record.id, expectedVersion: current.record.version, state: jsonValue({ format: 1, shard, entries: retained }) as JsonObject,
          events: [{ type: 'lifecycle-settled.recorded', data: { runId: snapshot.id, status: snapshot.status } }] }); return;
      } catch (error) {
        if (error instanceof StorageError && error.code === 'CONFLICT') continue;
        throw new MayuraError('STORAGE_UNAVAILABLE', 'Lifecycle settled index update could not be confirmed.');
      }
    }
    throw new MayuraError('CONFLICT', 'Lifecycle settled index remained busy after bounded retries.');
  }
  const admittedCursor = (cursor: WorkflowLifecycleFleetCursor | null | undefined): WorkflowLifecycleFleetCursor => {
    if (cursor === undefined || cursor === null) return { format: 1, scope, shard: 0, afterId: '' };
    const value = object(jsonValue(cursor, { maxBytes: 1_024 }));
    if (Object.keys(value).length !== 4 || value['format'] !== 1 || value['scope'] !== scope
      || typeof value['shard'] !== 'number' || !Number.isSafeInteger(value['shard']) || value['shard'] < 0 || value['shard'] > 255
      || typeof value['afterId'] !== 'string' || (value['afterId'] !== '' && (!hashPattern.test(value['afterId']) || !value['afterId'].startsWith(hex[value['shard']!]!)))) {
      throw new MayuraError('INVALID_INPUT', 'Lifecycle fleet cursor is invalid for this scope.');
    }
    return value as unknown as WorkflowLifecycleFleetCursor;
  };
  const scan = async (command: { readonly cursor?: WorkflowLifecycleFleetCursor | null; readonly limit?: number; readonly maxShardReads?: number } = {}): Promise<WorkflowLifecycleFleetPage> => {
    open(); const cursor = admittedCursor(command.cursor); const limit = command.limit ?? 32; const maxShardReads = command.maxShardReads ?? 32;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128 || !Number.isSafeInteger(maxShardReads) || maxShardReads < 1 || maxShardReads > 256) {
      throw new MayuraError('INVALID_INPUT', 'Lifecycle fleet scan bounds are invalid.');
    }
    let shard = cursor.shard; let afterId = cursor.afterId; let examined = 0; let shardReads = 0;
    const candidates: WorkflowLifecycleFleetCandidate[] = [];
    while (shard < 256 && examined < limit && shardReads < maxShardReads) {
      const name = hex[shard]!; const current = await read(name); shardReads += 1;
      const entries = current?.state.entries.filter(entry => entry.runId > afterId) ?? [];
      let exhausted = true;
      for (const entry of entries) {
        if (examined >= limit) { exhausted = false; break; }
        examined += 1; afterId = entry.runId; candidates.push(freezeJson(jsonValue(entry)) as unknown as WorkflowLifecycleFleetCandidate);
      }
      if (exhausted) { shard += 1; afterId = ''; }
    }
    const nextCursor = shard >= 256 ? null : freezeJson(jsonValue({ format: 1, scope, shard, afterId })) as unknown as WorkflowLifecycleFleetCursor;
    return freezeJson(jsonValue({ candidates, examined, shardReads, nextCursor })) as unknown as WorkflowLifecycleFleetPage;
  };
  const settled = async (command: { readonly cursor?: WorkflowLifecycleFleetCursor | null; readonly limit?: number; readonly maxShardReads?: number } = {}): Promise<WorkflowLifecycleSettledPage> => {
    open(); const cursor = admittedCursor(command.cursor); const limit = command.limit ?? 32; const maxShardReads = command.maxShardReads ?? 32;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128 || !Number.isSafeInteger(maxShardReads) || maxShardReads < 1 || maxShardReads > 256) {
      throw new MayuraError('INVALID_INPUT', 'Lifecycle settled scan bounds are invalid.');
    }
    let shard = cursor.shard; let afterId = cursor.afterId; let shardReads = 0; const entries: WorkflowLifecycleSettledEntry[] = [];
    while (shard < 256 && entries.length < limit && shardReads < maxShardReads) {
      const current = await readSettled(hex[shard]!); shardReads += 1;
      const remaining = current?.state.entries.filter(entry => entry.runId > afterId) ?? []; let exhausted = true;
      for (const entry of remaining) {
        if (entries.length >= limit) { exhausted = false; break; }
        afterId = entry.runId; entries.push(entry);
      }
      if (exhausted) { shard += 1; afterId = ''; }
    }
    const nextCursor = shard >= 256 ? null : freezeJson(jsonValue({ format: 1, scope, shard, afterId })) as unknown as WorkflowLifecycleFleetCursor;
    return freezeJson(jsonValue({ entries, shardReads, nextCursor })) as unknown as WorkflowLifecycleSettledPage;
  };
  const wrapped = {
    ...runtime,
    submit: async (definition: AnyWorkflowLifecycle, command: { readonly input: unknown; readonly idempotencyKey: string }) => {
      const snapshot = await runtime.submit(definition, command); await write(snapshot, definition.digest); return snapshot;
    },
    runUntilSettled: async (definition: AnyWorkflowLifecycle, id: string) => {
      const snapshot = await runtime.runUntilSettled(definition, id); await write(snapshot, definition.digest); return snapshot;
    },
    migrate: async (migration: Parameters<WorkflowLifecycleRuntime['migrate']>[0], command: Parameters<WorkflowLifecycleRuntime['migrate']>[1]) => {
      const result = await runtime.migrate(migration, command);
      // The index entry follows the run to its new definition, so hosts dispatch it with the new version.
      if (result.snapshot) await write(result.snapshot, migration.to.digest);
      return result;
    },
    approve: async (command: Parameters<WorkflowLifecycleRuntime['approve']>[0]) => {
      const snapshot = await runtime.approve(command); await write(snapshot); return snapshot;
    },
    respond: async (definition: AnyWorkflowLifecycle, command: Parameters<WorkflowLifecycleRuntime['respond']>[1]) => {
      const snapshot = await runtime.respond(definition, command); await write(snapshot, definition.digest); return snapshot;
    },
    respondVerified: async (definition: AnyWorkflowLifecycle, command: Parameters<WorkflowLifecycleRuntime['respondVerified']>[1]) => {
      const snapshot = await runtime.respondVerified(definition, command); await write(snapshot, definition.digest); return snapshot;
    },
    pause: async (id: string) => { const snapshot = await runtime.pause(id); await write(snapshot); return snapshot; },
    resume: async (id: string) => { const snapshot = await runtime.resume(id); await write(snapshot); return snapshot; },
    cancel: async (id: string) => { const snapshot = await runtime.cancel(id); await write(snapshot); return snapshot; },
    recoverAbandoned: async (id: string) => { const snapshot = await runtime.recoverAbandoned(id); await write(snapshot); return snapshot; },
    scan,
    settled,
    runPage: async (definitions: readonly AnyWorkflowLifecycle[], command = {}): Promise<WorkflowLifecycleFleetReport> => {
      if (!Array.isArray(definitions) || definitions.length > 128) throw new MayuraError('INVALID_INPUT', 'Lifecycle fleet definition catalog is invalid.');
      const catalog = new Map<string, AnyWorkflowLifecycle>();
      for (const definition of definitions) { assertWorkflowLifecycle(definition); if (catalog.has(definition.digest)) throw new MayuraError('INVALID_INPUT', 'Lifecycle fleet definition catalog contains duplicates.'); catalog.set(definition.digest, definition); }
      const page = await scan(command); const outcomes: WorkflowLifecycleFleetOutcome[] = []; const observedAtMs = now();
      for (const candidate of page.candidates) {
        const definition = catalog.get(candidate.definitionHash);
        if (!definition) { outcomes.push({ kind: 'skipped', runId: candidate.runId, reason: 'unregistered_definition' }); continue; }
        if (candidate.status === 'paused' || (candidate.status === 'waiting' && (candidate.nextWakeAtMs === null || candidate.nextWakeAtMs > observedAtMs))) {
          outcomes.push({ kind: 'deferred', runId: candidate.runId, nextWakeAtMs: candidate.nextWakeAtMs }); continue;
        }
        try { const snapshot = await wrapped.runUntilSettled(definition, candidate.runId); outcomes.push({ kind: 'advanced', runId: candidate.runId, status: snapshot.status }); }
        catch (error) { outcomes.push({ kind: 'failed', runId: candidate.runId, code: failure(error) }); }
      }
      return freezeJson(jsonValue({ page, outcomes })) as unknown as WorkflowLifecycleFleetReport;
    },
    close: () => { if (!closed) { closed = true; runtime.close(); } },
    drain: async options => { const report = await runtime.drain(options); closed = true; return report; },
  } satisfies WorkflowLifecycleFleetRuntime;
  return Object.freeze(wrapped);
}
