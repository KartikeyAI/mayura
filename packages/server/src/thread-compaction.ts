import { MayuraError, type Authorizer, type Permissions, type Scope } from '@mayura/core';
import { sha256Hex } from '@mayura/core/host';
import { assertAgent } from '@mayura/runtime';
import { createThreads, type ThreadCompactionOptions, type ThreadsOptions } from '@mayura/threads';

/** Trusted policy shared by the explicitly listed conversation agents. Never accepted from HTTP input. */
export interface ServerThreadCompactionOptions extends Omit<ThreadCompactionOptions, 'commandId' | 'through' | 'previousSummarySequence' | 'signal' | 'authorization'> {
  readonly agentIds: readonly string[];
  /** Explicit thread:read, thread:write, thread:compact and model:<summarizer model id> grants. */
  readonly permissions: Permissions;
  /** Concurrent paid commands in this process; defaults to four, at most 64. */
  readonly maxConcurrent?: number;
}
export interface ServerThreadCompactionCommand {
  readonly commandId: string; readonly through: number; readonly previousSummarySequence?: number;
}
function invalid(): never { throw new MayuraError('INVALID_CONFIG', 'Invalid thread compaction policy or grants.'); }
/** Snapshot paid-operation policy before accepting requests; all numeric limits are checked without executing a model. */
export function createThreadCompactionService(supplied: ServerThreadCompactionOptions | undefined, store: ThreadsOptions['store'] | undefined,
  registered: (id: string) => boolean, authorization?: Authorizer) {
  const operations = new Map<string, AbortController>(); const settling = new Set<Promise<unknown>>();
  let stopped = false;
  if (supplied === undefined) return undefined;
  if (!supplied || !store || typeof store.threads?.compaction !== 'function') invalid();
  const agent = supplied.agent; assertAgent(agent);
  if (agent.handoffs?.length || agent.tools.length || agent.hooks.length || agent.guards.input.length || agent.guards.output.length || agent.stream || agent.media) invalid();
  if (!Array.isArray(supplied.agentIds) || supplied.agentIds.length < 1 || supplied.agentIds.length > 1_024
    || supplied.agentIds.some(id => typeof id !== 'string' || !registered(id)) || new Set(supplied.agentIds).size !== supplied.agentIds.length) invalid();
  if (!Array.isArray(supplied.permissions?.allow) || supplied.permissions.allow.length > 4_096) invalid();
  const required = ['thread:read', 'thread:write', 'thread:compact', `model:${agent.model.id}`];
  if (required.some(grant => !supplied.permissions.allow.includes(grant))) invalid();
  const permissions = Object.freeze({ allow: Object.freeze(required) }); const agentIds = new Set(supplied.agentIds);
  const bound = (value: number | undefined, fallback: number, min: number, max: number): number => {
    const actual = value ?? fallback;
    if (!Number.isSafeInteger(actual) || actual < min || actual > max) invalid(); return actual;
  };
  const policy = Object.freeze({ agent, ...(authorization === undefined ? {} : { authorization }), maxCostMicros: bound(supplied.maxCostMicros, -1, 0, Number.MAX_SAFE_INTEGER),
    maxDurationMs: bound(supplied.maxDurationMs, 60_000, 100, 300_000), maxSourceEntries: bound(supplied.maxSourceEntries, 2_000, 1, 10_000),
    maxSourceBytes: bound(supplied.maxSourceBytes, 524_288, 1_024, 2_097_152), maxSummaryBytes: bound(supplied.maxSummaryBytes, 16_384, 256, 65_536) });
  const maxConcurrent = bound(supplied.maxConcurrent, 4, 1, 64);
  const threads = (scope: Scope, signal?: AbortSignal) => createThreads({ store, scope, permissions, ...(authorization === undefined ? {} : { authorization }), ...(signal === undefined ? {} : { signal }) });
  const inspectAuthorization = async (scope: Scope, id: string, signal?: AbortSignal): Promise<void> => {
    if (!authorization) return;
    for (const action of ['read', 'inspect_compaction']) {
      let allowed = false;
      try { allowed = (await authorization.authorize(scope, action, { kind: 'thread', id, scope, ownerId: scope.principalId }, { ...(signal === undefined ? {} : { signal }) })).effect === 'allow'; } catch { /* Fixed diagnostics. */ }
      if (!allowed) throw new MayuraError('PERMISSION_DENIED', 'Thread compaction inspection is not authorized.');
    }
  };
  const key = (scope: Scope, id: string, commandId: string) => JSON.stringify([scope.principalId, scope.projectId, id, commandId]);
  return Object.freeze({
    maxDurationMs: policy.maxDurationMs,
    allows: (agentId: string) => agentIds.has(agentId),
    compact(scope: Scope, id: string, command: ServerThreadCompactionCommand, signal: AbortSignal, expiresAtMs: number) {
      if (stopped || signal.aborted || expiresAtMs <= Date.now()) throw new MayuraError('CANCELLED', 'Compaction is cancelled.');
      const operationKey = key(scope, id, command.commandId);
      if (operations.has(operationKey)) throw new MayuraError('CONFLICT', 'Compaction is already pending.');
      if (operations.size >= maxConcurrent) throw new MayuraError('LIMIT_EXCEEDED', 'Compaction concurrency limit reached.');
      const control = new AbortController(); const abort = () => control.abort();
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      // Identity expiration and shutdown cancel paid work even if the HTTP connection has already gone away.
      const timer = setTimeout(abort, Math.max(0, expiresAtMs - Date.now()));
      operations.set(operationKey, control);
      const task = threads(scope, control.signal).compact(id, { ...policy, ...command, signal: control.signal }).finally(() => {
        clearTimeout(timer); signal.removeEventListener('abort', abort); operations.delete(operationKey); settling.delete(task);
      });
      settling.add(task); return task;
    },
    async inspect(scope: Scope, id: string, commandId: string, signal?: AbortSignal) {
      await inspectAuthorization(scope, id, signal);
      const record = await store.threads.compaction({ scope: sha256Hex(`mayura:thread-scope:v1\0${scope.principalId}\0${scope.projectId}`), id, commandId, action: 'read' });
      if (!record) { await inspectAuthorization(scope, id, signal); return null; }
      const cost = record.costMicros;
      const validCost = cost === null || (typeof cost === 'number' && Number.isSafeInteger(cost) && cost >= 0)
        || (typeof cost === 'string' && /^[0-9]{1,30}$/.test(cost));
      if (record.threadId !== id || record.commandId !== commandId || !['pending', 'ready', 'committed', 'failed'].includes(record.status)
        || !record.covers || record.covers.from !== 1 || !Number.isSafeInteger(record.covers.to) || record.covers.to < 1 || record.covers.to > 999_999_997
        || !Number.isSafeInteger(record.maxCostMicros) || record.maxCostMicros < 0 || !validCost
        || (cost !== null && BigInt(cost) > BigInt(record.maxCostMicros))
        || (record.status === 'committed') !== (record.entrySequence !== null)
        || (record.entrySequence !== null && (!Number.isSafeInteger(record.entrySequence) || record.entrySequence <= record.covers.to || record.entrySequence > 1_000_000_000))
        || (['ready', 'committed'].includes(record.status) && cost === null) || (record.status === 'pending' && cost !== null))
        throw new MayuraError('STORAGE_UNAVAILABLE', 'The compaction inspection is unavailable.');
      // No executor tokens, staged text, provider errors, model definitions or private journal contents leave the host.
      await inspectAuthorization(scope, id, signal);
      return Object.freeze({ commandId: record.commandId, status: record.status, through: record.covers.to,
        maxCostMicros: record.maxCostMicros, costMicros: record.costMicros, entrySequence: record.entrySequence });
    },
    async cancel(scope: Scope, id: string, commandId: string, signal?: AbortSignal) {
      const result = await threads(scope, signal).cancelCompaction(id, commandId);
      if (result.status !== 'committed') operations.get(key(scope, id, commandId))?.abort();
      return result;
    },
    stop() { stopped = true; for (const control of operations.values()) control.abort(); },
    settled: () => Promise.allSettled([...settling]),
  });
}
