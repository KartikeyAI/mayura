import { jsonValue, MayuraError, type ErrorCode, type JsonObject, type JsonValue } from '@mayura/core';
import { StorageError, workflowGraphDiscoveryCommand, workflowGraphDiscoveryPage, workflowPolicy,
  type WorkflowGraphDiscoveryAggregateStore, type WorkflowGraphDiscoveryCursor, type WorkflowGraphDiscoveryPage,
  type WorkflowGraphDiscoveryScan, type WorkflowGraphDiscoveryStore } from '@mayura/storage-contracts';
import { digest } from './definition.js';
import { scheduledCallback } from './scheduled-helpers.js';
import type { WorkflowRuntimeOptions } from './runtime.js';

export type { WorkflowGraphDiscoveryCandidate, WorkflowGraphDiscoveryCursor, WorkflowGraphDiscoveryPage } from '@mayura/storage-contracts';

export interface WorkflowGraphDiscoveryOptions extends Pick<WorkflowRuntimeOptions,
  'scope' | 'permissions' | 'policyVersion' | 'maxCostMicros' | 'maxOutputBytes' | 'approvalTtlMs'> {
  readonly store: WorkflowGraphDiscoveryAggregateStore;
  /** Bounds the acknowledgement wait, not the adapter's actual callback lifetime. */
  readonly storageTimeoutMs?: number;
  /** Timed-out callbacks keep these slots until their underlying promises settle. */
  readonly maxPendingStorageOperations?: number;
}
export interface WorkflowGraphDiscovery {
  /** One finite page of examined owners; candidates are hints, never dispatch authority. */
  scan(command?: { readonly cursor?: WorkflowGraphDiscoveryCursor | null; readonly limit?: number }): Promise<WorkflowGraphDiscoveryPage>;
  /** The cursor that continues a scan after `runId`, for callers that persist only the last run id. */
  cursorAfter(runId: string): WorkflowGraphDiscoveryCursor;
  /** Stops this facade without closing caller-owned storage or changing durable executions. */
  close(): Promise<void>;
}

const invalid = (): MayuraError => new MayuraError('INVALID_INPUT', 'Graph discovery requires exact bounded scan fields and a cursor matching its configured scope and policy.');
const unavailable = (): MayuraError => new MayuraError('STORAGE_UNAVAILABLE', 'Graph discovery could not confirm a valid observation page. Retry explicitly when storage is available.');
function object(value: JsonValue): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value;
}
function positive(value: unknown, fallback: number, maximum: number): number {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 1 || result > maximum) throw invalid();
  return result;
}

/** Read only data descriptors; ordinary class methods retain their original receiver. */
function member(value: object, name: string): unknown {
  let current: object | null = value;
  for (let depth = 0; current && depth < 16; depth++, current = Object.getPrototypeOf(current) as object | null) {
    const field = Object.getOwnPropertyDescriptor(current, name);
    if (field) { if (!('value' in field)) throw invalid(); return field.value; }
  }
  throw invalid();
}
function adapter(store: unknown): WorkflowGraphDiscoveryStore {
  try {
    if (!store || typeof store !== 'object') throw invalid();
    const source = member(store, 'workflowGraphDiscovery');
    if (!source || typeof source !== 'object') throw invalid();
    const captured: Record<string, (...args: unknown[]) => unknown> = {};
    for (const name of ['initialize', 'scan'] as const) {
      const method = member(source, name); if (typeof method !== 'function') throw invalid();
      captured[name] = (...args: unknown[]) => Reflect.apply(method, source, args);
    }
    return Object.freeze(captured) as unknown as WorkflowGraphDiscoveryStore;
  } catch { throw new MayuraError('UNSUPPORTED_PROFILE', 'This adapter does not provide the optional graph discovery capability.'); }
}
function storageFailure(error: unknown): MayuraError {
  let code: ErrorCode = 'STORAGE_UNAVAILABLE';
  try {
    const descriptor = error instanceof StorageError ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
    const value: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    if (value === 'QUEUE_FULL') code = 'LIMIT_EXCEEDED';
    else if (value === 'INVALID_INPUT' || value === 'CONFLICT' || value === 'NOT_FOUND' || value === 'LIMIT_EXCEEDED') code = value;
  } catch { /* Provider exceptions, getters and diagnostics never cross the public boundary. */ }
  return new MayuraError(code, 'Graph discovery persistence could not confirm this scan. Retry explicitly after checking storage availability.');
}

/**
 * Discover finite scoped graph continuation candidates without advancing their state.
 * Cursors are plain metadata, not a stable database snapshot or authorization grant.
 */
export function createWorkflowGraphDiscovery(options: WorkflowGraphDiscoveryOptions): WorkflowGraphDiscovery {
  let fields: PropertyDescriptorMap; let policy: ReturnType<typeof workflowPolicy>;
  let storageTimeoutMs: number; let maxPending: number;
  try {
    if (!options || typeof options !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) throw invalid();
    fields = Object.getOwnPropertyDescriptors(options);
    const allowed = ['store', 'scope', 'permissions', 'policyVersion', 'maxCostMicros', 'maxOutputBytes', 'approvalTtlMs', 'storageTimeoutMs', 'maxPendingStorageOperations'];
    if (Reflect.ownKeys(fields).some(name => typeof name !== 'string' || !allowed.includes(name))
      || Object.values(fields).some(field => !field.enumerable || !('value' in field))) throw invalid();
    const raw = object(jsonValue({ scope: fields['scope']?.value, permissions: fields['permissions']?.value,
      policyVersion: fields['policyVersion']?.value, maxCostMicros: fields['maxCostMicros']?.value,
      maxOutputBytes: fields['maxOutputBytes']?.value === undefined ? 65_536 : fields['maxOutputBytes'].value,
      approvalTtlMs: fields['approvalTtlMs']?.value === undefined ? 3_600_000 : fields['approvalTtlMs'].value }));
    const permissions = object(raw['permissions']!);
    if (Object.keys(permissions).length !== 1 || !Object.hasOwn(permissions, 'allow')) throw invalid();
    policy = workflowPolicy({ ...raw, permissions: permissions['allow'] });
    storageTimeoutMs = positive(fields['storageTimeoutMs']?.value, 10_000, 30_000);
    maxPending = positive(fields['maxPendingStorageOperations']?.value, 64, 1_024);
  } catch { throw new MayuraError('INVALID_CONFIG', 'Graph discovery requires explicit graph-compatible scope, permissions, policy and finite callback limits.'); }
  const api = adapter(fields['store']?.value);
  const scope = digest('mayura:scope:v1', policy.scope);
  const policyHash = digest('mayura:policy:v1', { ...policy, permissions: [...policy.permissions].sort() });
  const shutdown = new AbortController(); let pending = 0; let initialized: Promise<void> | undefined;
  const open = (): void => { if (shutdown.signal.aborted) throw new MayuraError('CANCELLED', 'The graph discovery facade is closed.'); };

  /** Only actual settlement returns capacity, including after local timeout or close. */
  const call = async <T>(operation: () => Promise<T>): Promise<T> => {
    open();
    if (pending >= maxPending) throw new MayuraError('LIMIT_EXCEEDED', 'The bounded graph discovery callback capacity is occupied.');
    pending++;
    const actual = Promise.resolve().then(() => { open(); return operation(); }).finally(() => { pending--; });
    // A synchronous close can abort scheduledCallback before its microtask adopts
    // actual. Observe rejection eagerly; only actual settlement releases capacity.
    void actual.catch(() => {});
    try { return await scheduledCallback(() => actual, storageTimeoutMs, shutdown.signal); }
    catch (error) { open(); throw storageFailure(error); }
  };
  const initialize = async (): Promise<void> => {
    open();
    initialized ??= (async () => {
      if (await call(() => api.initialize()) !== undefined) throw unavailable();
      open();
    })().catch((error: unknown) => { initialized = undefined; throw error; });
    await initialized; open();
  };

  return Object.freeze<WorkflowGraphDiscovery>({
    cursorAfter(runId: string): WorkflowGraphDiscoveryCursor {
      if (typeof runId !== 'string' || !/^[a-f0-9]{64}$/.test(runId)) throw invalid();
      return Object.freeze({ format: 1, scope, policyHash, afterId: runId }) as WorkflowGraphDiscoveryCursor;
    },
    async scan(command = {}): Promise<WorkflowGraphDiscoveryPage> {
      open(); let admitted: WorkflowGraphDiscoveryScan;
      try {
        // Own caller data before initialization or any other asynchronous callback.
        const raw = object(jsonValue(command, { maxBytes: 1_024 }));
        if (Object.keys(raw).some(name => name !== 'cursor' && name !== 'limit')) throw invalid();
        admitted = workflowGraphDiscoveryCommand('scan', { scope, policyHash,
          cursor: Object.hasOwn(raw, 'cursor') ? raw['cursor'] : null,
          limit: Object.hasOwn(raw, 'limit') ? raw['limit'] : 16 }) as unknown as WorkflowGraphDiscoveryScan;
      } catch { throw invalid(); }
      await initialize();
      const raw = await call(() => api.scan(admitted)); open();
      try { return workflowGraphDiscoveryPage(raw, admitted); }
      catch { throw unavailable(); }
    },
    async close(): Promise<void> { shutdown.abort(); },
  });
}
