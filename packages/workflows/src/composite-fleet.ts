import { freezeJson, jsonValue, MayuraError, type ErrorCode, type InferInput, type JsonObject, type JsonValue } from '@mayura/core';
import type { WorkflowDrainOptions, WorkflowDrainReport } from './drain.js';
import { StorageError, type StoredRecord } from '@mayura/storage-contracts';
import { digest } from './definition.js';
import { assertWorkflowLoop, type AnyWorkflowLoop } from './loop-definition.js';
import { createWorkflowLoopRuntime, type WorkflowLoopRuntime, type WorkflowLoopSnapshot } from './loop-runtime.js';
import { assertWorkflowSaga, type AnyWorkflowSaga } from './saga-definition.js';
import { createWorkflowSagaRuntime, type WorkflowSagaRuntime, type WorkflowSagaRuntimeOptions,
  type WorkflowSagaSnapshot } from './saga-runtime.js';

export type WorkflowCompositeKind = 'saga' | 'loop';
export interface WorkflowCompositeCursor { readonly format: 1; readonly scope: string; readonly shard: number; readonly afterId: string }
export interface WorkflowCompositeCandidate { readonly kind: WorkflowCompositeKind; readonly runId: string;
  readonly definitionHash: string; readonly version: number }
export interface WorkflowCompositePage { readonly candidates: readonly WorkflowCompositeCandidate[]; readonly examined: number;
  readonly shardReads: number; readonly nextCursor: WorkflowCompositeCursor | null }
export type WorkflowCompositeOutcome =
  | { readonly kind: 'advanced'; readonly runId: string; readonly workflowKind: WorkflowCompositeKind; readonly status: string }
  | { readonly kind: 'skipped'; readonly runId: string; readonly workflowKind: WorkflowCompositeKind; readonly reason: 'unregistered_definition' }
  | { readonly kind: 'failed'; readonly runId: string; readonly workflowKind: WorkflowCompositeKind; readonly code: ErrorCode };
export interface WorkflowCompositeReport { readonly page: WorkflowCompositePage; readonly outcomes: readonly WorkflowCompositeOutcome[] }
export interface WorkflowCompositeFleetOptions extends WorkflowSagaRuntimeOptions {
  readonly indexMaxEntriesPerShard?: number; readonly indexMaxConflictRetries?: number;
}
export interface WorkflowCompositeFleetRuntime {
  readonly profile: 'composite-fleet-v1'; readonly sagas: WorkflowSagaRuntime; readonly loops: WorkflowLoopRuntime;
  submitSaga<D extends AnyWorkflowSaga>(definition: D, command: { readonly input: InferInput<D['input']>; readonly idempotencyKey: string }): Promise<WorkflowSagaSnapshot>;
  submitLoop<D extends AnyWorkflowLoop>(definition: D, command: { readonly input: InferInput<D['input']>; readonly idempotencyKey: string }): Promise<WorkflowLoopSnapshot>;
  scan(command?: { readonly cursor?: WorkflowCompositeCursor | null; readonly limit?: number; readonly maxShardReads?: number }): Promise<WorkflowCompositePage>;
  runPage(catalog: { readonly sagas?: readonly AnyWorkflowSaga[]; readonly loops?: readonly AnyWorkflowLoop[] },
    command?: { readonly cursor?: WorkflowCompositeCursor | null; readonly limit?: number; readonly maxShardReads?: number }): Promise<WorkflowCompositeReport>;
  close(): void;
  /** Drain saga and loop children in parallel within one deadline, then close. */
  drain(options?: WorkflowDrainOptions): Promise<WorkflowDrainReport>;
}

interface Entry { kind: WorkflowCompositeKind; runId: string; definitionHash: string; version: number }
interface IndexState { format: 1; shard: string; entries: Entry[] }
const hashes = /^[a-f0-9]{64}$/; const shards = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, '0'));
const sagaTerminal = new Set(['succeeded', 'failed', 'compensated', 'compensation_failed', 'cancelled']);
const loopTerminal = new Set(['succeeded', 'failed', 'limit_exceeded', 'cancelled']);
function indexId(shard: string): string { return `composite-index.${shard}`; }
function object(value: JsonValue | undefined): JsonObject { if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
function decode(record: StoredRecord, scope: string, shard: string, maximum: number): IndexState {
  try {
    if (record.scope !== scope || record.id !== indexId(shard) || record.definitionHash !== digest('mayura:workflow-composite-index:v1', { shard })) throw new Error();
    const state = object(jsonValue(record.state, { maxBytes: 1_048_576 }));
    if (Object.keys(state).length !== 3 || state['format'] !== 1 || state['shard'] !== shard || !Array.isArray(state['entries']) || state['entries'].length > maximum) throw new Error();
    const entries = state['entries'].map(raw => { const entry = object(raw);
      if (Object.keys(entry).length !== 4 || !['saga', 'loop'].includes(String(entry['kind']))
        || typeof entry['runId'] !== 'string' || !hashes.test(entry['runId']) || !entry['runId'].startsWith(shard)
        || typeof entry['definitionHash'] !== 'string' || !hashes.test(entry['definitionHash'])
        || typeof entry['version'] !== 'number' || !Number.isSafeInteger(entry['version']) || entry['version'] < 1) throw new Error();
      return entry as unknown as Entry; });
    if (entries.some((entry, index) => index > 0 && entry.runId <= entries[index - 1]!.runId)) throw new Error();
    return { format: 1, shard, entries };
  } catch { throw new MayuraError('CONFLICT', 'Composite workflow index failed integrity validation.'); }
}
function failure(error: unknown): ErrorCode { return error instanceof MayuraError ? error.code
  : error instanceof StorageError && error.code === 'LIMIT_EXCEEDED' ? 'LIMIT_EXCEEDED' : 'STORAGE_UNAVAILABLE'; }

/** Durable discovery and finite continuation for saga and loop parent aggregates. */
export function createWorkflowCompositeFleetRuntime(options: WorkflowCompositeFleetOptions): WorkflowCompositeFleetRuntime {
  const maximum = options.indexMaxEntriesPerShard ?? 256; const retries = options.indexMaxConflictRetries ?? 32;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 512 || !Number.isSafeInteger(retries) || retries < 1 || retries > 128) {
    throw new MayuraError('INVALID_CONFIG', 'Composite fleet index limits are invalid.');
  }
  const sagas = createWorkflowSagaRuntime(options); const loops = createWorkflowLoopRuntime(options); const store = options.store;
  const scope = digest('mayura:scope:v1', { principalId: options.scope.principalId, projectId: options.scope.projectId }); let closed = false;
  const open = (): void => { if (closed) throw new MayuraError('CANCELLED', 'Composite workflow fleet is closed.'); };
  const read = async (shard: string): Promise<{ record: StoredRecord; state: IndexState } | undefined> => {
    open(); try { const record = await store.read(scope, indexId(shard)); return record ? { record, state: decode(record, scope, shard, maximum) } : undefined; }
    catch (error) { if (error instanceof MayuraError) throw error; throw new MayuraError('STORAGE_UNAVAILABLE', 'Composite workflow index could not be read.'); }
  };
  const ensure = async (shard: string) => { const found = await read(shard); if (found) return found;
    const definitionHash = digest('mayura:workflow-composite-index:v1', { shard });
    try { const created = await store.create({ scope, id: indexId(shard), idempotencyKey: indexId(shard), definitionHash,
      state: { format: 1, shard, entries: [] }, events: [{ type: 'composite-index.created', data: { shard } }] });
      return { record: created.record, state: decode(created.record, scope, shard, maximum) }; }
    catch { throw new MayuraError('STORAGE_UNAVAILABLE', 'Composite workflow index could not be initialized.'); } };
  const write = async (entry: Entry, terminal: boolean): Promise<void> => { const shard = entry.runId.slice(0, 2);
    for (let attempt = 0; attempt < retries; attempt++) { const found = await read(shard); if (terminal && !found) return;
      const current = found ?? await ensure(shard); const index = current.state.entries.findIndex(value => value.runId === entry.runId);
      if (terminal) { if (index < 0) return; current.state.entries.splice(index, 1); }
      else if (index < 0) { if (current.state.entries.length >= maximum) throw new MayuraError('LIMIT_EXCEEDED', 'Composite workflow index shard is full.');
        current.state.entries.push(entry); current.state.entries.sort((a, b) => a.runId.localeCompare(b.runId)); }
      else { const previous = current.state.entries[index]!; if (previous.kind !== entry.kind || previous.definitionHash !== entry.definitionHash) throw new MayuraError('CONFLICT', 'Composite index identity changed.');
        if (previous.version > entry.version) return; if (previous.version === entry.version) return; current.state.entries[index] = entry; }
      try { await store.update({ scope, id: current.record.id, expectedVersion: current.record.version,
        state: jsonValue(current.state) as JsonObject, events: [{ type: terminal ? 'composite-index.removed' : 'composite-index.updated',
          data: { kind: entry.kind, runId: entry.runId, version: entry.version } }] }); return; }
      catch (error) { if (error instanceof StorageError && error.code === 'CONFLICT') continue;
        throw new MayuraError('STORAGE_UNAVAILABLE', 'Composite workflow index update could not be confirmed.'); }
    } throw new MayuraError('CONFLICT', 'Composite workflow index remained busy after bounded retries.'); };
  const cursor = (value: WorkflowCompositeCursor | null | undefined): WorkflowCompositeCursor => { if (!value) return { format: 1, scope, shard: 0, afterId: '' };
    try { const item = object(jsonValue(value, { maxBytes: 1_024 }));
      if (Object.keys(item).length !== 4 || item['format'] !== 1 || item['scope'] !== scope || typeof item['shard'] !== 'number'
        || !Number.isSafeInteger(item['shard']) || item['shard'] < 0 || item['shard'] > 255 || typeof item['afterId'] !== 'string'
        || (item['afterId'] !== '' && (!hashes.test(item['afterId']) || !item['afterId'].startsWith(shards[item['shard']]!)))) throw new Error();
      return item as unknown as WorkflowCompositeCursor; } catch { throw new MayuraError('INVALID_INPUT', 'Composite fleet cursor is invalid for this scope.'); } };
  const scan = async (command: { readonly cursor?: WorkflowCompositeCursor | null; readonly limit?: number; readonly maxShardReads?: number } = {}) => {
    const start = cursor(command.cursor); const limit = command.limit ?? 32; const maxReads = command.maxShardReads ?? 32;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128 || !Number.isSafeInteger(maxReads) || maxReads < 1 || maxReads > 256) throw new MayuraError('INVALID_INPUT', 'Composite fleet scan bounds are invalid.');
    let shard = start.shard; let afterId = start.afterId; let examined = 0; let shardReads = 0; const candidates: Entry[] = [];
    while (shard < 256 && examined < limit && shardReads < maxReads) { const current = await read(shards[shard]!); shardReads += 1;
      const entries = current?.state.entries.filter(entry => entry.runId > afterId) ?? []; let exhausted = true;
      for (const entry of entries) { if (examined >= limit) { exhausted = false; break; } examined += 1; afterId = entry.runId; candidates.push(entry); }
      if (exhausted) { shard += 1; afterId = ''; } }
    const nextCursor = shard >= 256 ? null : { format: 1 as const, scope, shard, afterId };
    return freezeJson(jsonValue({ candidates, examined, shardReads, nextCursor })) as unknown as WorkflowCompositePage; };
  const wrapped: WorkflowCompositeFleetRuntime = {
    profile: 'composite-fleet-v1', sagas, loops,
    submitSaga: async (definition, command) => { const result = await sagas.submit(definition, command);
      await write({ kind: 'saga', runId: result.id, definitionHash: definition.digest, version: result.version }, sagaTerminal.has(result.status)); return result; },
    submitLoop: async (definition, command) => { const result = await loops.submit(definition, command);
      await write({ kind: 'loop', runId: result.id, definitionHash: definition.digest, version: result.version }, loopTerminal.has(result.status)); return result; },
    scan,
    runPage: async (catalog, command = {}) => { const sagaCatalog = new Map<string, AnyWorkflowSaga>(); const loopCatalog = new Map<string, AnyWorkflowLoop>();
      for (const definition of catalog.sagas ?? []) { assertWorkflowSaga(definition); if (sagaCatalog.has(definition.digest)) throw new MayuraError('INVALID_INPUT', 'Duplicate saga definition.'); sagaCatalog.set(definition.digest, definition); }
      for (const definition of catalog.loops ?? []) { assertWorkflowLoop(definition); if (loopCatalog.has(definition.digest)) throw new MayuraError('INVALID_INPUT', 'Duplicate loop definition.'); loopCatalog.set(definition.digest, definition); }
      const page = await scan(command); const outcomes: WorkflowCompositeOutcome[] = [];
      for (const candidate of page.candidates) { const definition = candidate.kind === 'saga' ? sagaCatalog.get(candidate.definitionHash) : loopCatalog.get(candidate.definitionHash);
        if (!definition) { outcomes.push({ kind: 'skipped', runId: candidate.runId, workflowKind: candidate.kind, reason: 'unregistered_definition' }); continue; }
        try { if (candidate.kind === 'saga') { const result = await sagas.runUntilSettled(definition as AnyWorkflowSaga, candidate.runId);
            await write({ ...candidate, version: result.version }, sagaTerminal.has(result.status)); outcomes.push({ kind: 'advanced', runId: candidate.runId, workflowKind: candidate.kind, status: result.status }); }
          else { const result = await loops.runUntilSettled(definition as AnyWorkflowLoop, candidate.runId);
            await write({ ...candidate, version: result.version }, loopTerminal.has(result.status)); outcomes.push({ kind: 'advanced', runId: candidate.runId, workflowKind: candidate.kind, status: result.status }); } }
        catch (error) { outcomes.push({ kind: 'failed', runId: candidate.runId, workflowKind: candidate.kind, code: failure(error) }); } }
      return freezeJson(jsonValue({ page, outcomes })) as unknown as WorkflowCompositeReport; },
    close: () => { if (!closed) { closed = true; sagas.close(); loops.close(); } },
    drain: async options => {
      const [saga, loop] = await Promise.all([sagas.drain(options), loops.drain(options)]); closed = true;
      return Object.freeze({ drained: saga.drained && loop.drained, interrupted: saga.interrupted + loop.interrupted });
    },
  };
  return Object.freeze(wrapped);
}
