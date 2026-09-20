import { freezeJson, jsonValue, MayuraError, type JsonValue } from '@mayura/core';
import {
  StorageError, workflowManifest, workflowState,
  type Claim, type JobRecord, type ScheduledWorkflowSnapshot, type StorageErrorCode, type StoredEvent, type StoredRecord, type WorkflowManifest,
} from '@mayura/storage-contracts';
import type { AnyWorkflow } from './definition.js';
import type { WorkflowSnapshot } from './runtime.js';

const storageCodes = new Set<StorageErrorCode>(['INVALID_INPUT', 'CONFLICT', 'NOT_FOUND', 'STORAGE_UNAVAILABLE',
  'STORE_CLOSED', 'STORE_NOT_INITIALIZED', 'QUEUE_FULL', 'STALE_CLAIM', 'LIMIT_EXCEEDED', 'SCHEDULED_WRITER_REQUIRED']);

/** Preserve only stable storage codes; never copy adapter messages or inspect exception getters. */
export async function scheduledStorage<T>(operation: () => Promise<T>, timeoutMs = 10_000, signal?: AbortSignal): Promise<T> {
  try { return await scheduledCallback(operation, timeoutMs, signal ?? new AbortController().signal); }
  catch (error) {
    let code: StorageErrorCode = 'STORAGE_UNAVAILABLE';
    try {
      const own = error instanceof StorageError ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
      if (own && 'value' in own && storageCodes.has(own.value as StorageErrorCode)) code = own.value as StorageErrorCode;
    } catch { /* Exception proxies do not become public diagnostics. */ }
    throw new StorageError(code, 'Scheduled persistence could not confirm the requested transition. Inspect current state before retrying effects.');
  }
}

export function isStorageCode(error: unknown, code: StorageErrorCode): boolean {
  return error instanceof StorageError && error.code === code;
}

/** One bounded callback window. Late results/rejections are handled without further admission. */
export async function scheduledCallback<T>(operation: () => T | PromiseLike<T>, timeoutMs: number, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new MayuraError('CANCELLED', 'The scheduled worker is closing.');
  return await new Promise<T>((resolve, reject) => {
    let finished = false;
    const clear = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const end = (action: () => void): void => { if (!finished) { finished = true; clear(); action(); } };
    const abort = (): void => { end(() => reject(new MayuraError('CANCELLED', 'The scheduled operation was cancelled.'))); };
    const timer = setTimeout(() => { end(() => reject(new MayuraError('TIMEOUT', 'The scheduled callback exceeded its deadline.'))); }, timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw new MayuraError('CANCELLED', 'The scheduled operation was cancelled.');
      return operation();
    }).then(value => { end(() => resolve(value)); }, (error: unknown) => { end(() => reject(error)); });
    if (signal.aborted) abort();
  });
}

/** Construct the original data-only definition material without changing its version hash. */
export function scheduledManifest(definition: AnyWorkflow): WorkflowManifest {
  return workflowManifest({ id: definition.id, version: definition.version,
    graph: definition.nodes.map(node => node.kind === 'join'
      ? { id: node.id, kind: node.kind, dependsOn: node.dependsOn }
      : { id: node.id, kind: node.kind, dependsOn: node.dependsOn ?? [], tool: node.tool.id,
          toolVersion: node.tool.version, effects: node.tool.effects, capabilities: node.tool.capabilities,
          costMicros: node.tool.costMicros, approval: node.approval ?? false, input: node.input }),
    result: definition.result,
  });
}

/** Public workflow views retain effect/accounting truth without exposing persisted input. */
export function scheduledSnapshot(record: StoredRecord): WorkflowSnapshot {
  const state = workflowState(record);
  return freezeJson(jsonValue({ id: record.id, version: record.version, status: state.status, steps: state.steps,
    output: state.output, budget: { spentMicros: state.spentMicros, reservedMicros: state.reservedMicros, maxCostMicros: state.maxCostMicros },
  })) as unknown as WorkflowSnapshot;
}

/** Snapshot an adapter-owned response before using it for a later decision. */
export function scheduledView(raw: ScheduledWorkflowSnapshot, scope: string, id: string, policyHash: string): ScheduledWorkflowSnapshot {
  try {
    const view = freezeJson(jsonValue(raw, { maxBytes: 8_388_608, maxNodes: 300_000 })) as unknown as ScheduledWorkflowSnapshot;
    if (view.profile !== 'scheduled-v1' || view.record.scope !== scope || view.record.id !== id
      || view.policyHash !== policyHash || view.record.state['policy'] !== policyHash || !Array.isArray(view.jobs)
      || view.jobs.length > 128 || !Number.isSafeInteger(view.record.version) || view.record.version < 1
      || !/^[a-f0-9]{64}$/.test(view.manifestHash) || !/^[a-f0-9]{64}$/.test(view.resourceHash)
      || view.record.definitionHash !== view.manifestHash) throw new Error();
    const state = workflowState(view.record);
    if (state.definition !== view.manifestHash || new Set(view.jobs.map(job => job.jobId)).size !== view.jobs.length
      || new Set(view.jobs.map(job => job.nodeId)).size !== view.jobs.length) throw new Error();
    for (const job of view.jobs) {
      checkJob(job, scope, id);
      const step = state.steps[job.nodeId];
      if (!step || step.kind !== 'tool' || step.candidateHash !== job.candidateHash) throw new Error();
    }
    return view;
  } catch { throw new MayuraError('STORAGE_UNAVAILABLE', 'Scheduled state failed identity or integrity validation.'); }
}

/** Structural response checks supplement, not replace, the adapter's transactional integrity checks. */
function checkJob(job: JobRecord, scope: string, id: string): void {
  if (job.scope !== scope || job.runId !== id || typeof job.jobId !== 'string' || !job.jobId.length || job.jobId.length > 256
    || typeof job.nodeId !== 'string' || !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(job.nodeId)
    || !/^[a-f0-9]{64}$/.test(job.candidateHash) || !/^[a-f0-9]{64}$/.test(job.definitionHash)
    || !Number.isSafeInteger(job.version) || job.version < 1 || !Number.isSafeInteger(job.fence) || job.fence < 0
    || !['ready', 'leased', 'started', 'succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown'].includes(job.state)
    || !job.intent || typeof job.intent !== 'object' || Array.isArray(job.intent)
    || !Array.isArray(job.resourceKeys) || job.resourceKeys.length > 32 || job.resourceKeys.some(key => typeof key !== 'string')
    || typeof job.leaseRevoked !== 'boolean' || typeof job.cancelRequested !== 'boolean') throw new Error();
  for (const value of [job.leaseUntilMs, job.startedAtMs, job.deadlineAtMs]) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new Error();
  }
}

/** Renewal responses cannot change the identity of an admitted local execution. */
export function scheduledClaim(raw: Claim, expected: Pick<Claim, 'scope' | 'jobId' | 'workerId' | 'fence'>): Claim {
  try {
    const claim = freezeJson(jsonValue(raw, { maxBytes: 2_048 })) as unknown as Claim;
    if (claim.scope !== expected.scope || claim.jobId !== expected.jobId || claim.workerId !== expected.workerId || claim.fence !== expected.fence
      || !Number.isSafeInteger(claim.fence) || claim.fence < 1 || !Number.isSafeInteger(claim.leaseUntilMs) || claim.leaseUntilMs < 1) throw new Error();
    return claim;
  } catch { throw new MayuraError('STORAGE_UNAVAILABLE', 'Scheduled claim failed identity or integrity validation.'); }
}

/** Bound and snapshot a claim batch before reserving local executor slots or invoking any tool. */
export function scheduledClaims(raw: readonly { readonly job: JobRecord; readonly claim: Claim }[], scope: string, id: string, workerId: string, limit: number): readonly { readonly job: JobRecord; readonly claim: Claim }[] {
  try {
    const values = freezeJson(jsonValue(raw, { maxBytes: 8_388_608, maxNodes: 300_000 })) as unknown as typeof raw;
    if (!Array.isArray(values) || values.length > limit || new Set(values.map(value => value.job.jobId)).size !== values.length) throw new Error();
    for (const value of values) {
      checkJob(value.job, scope, id);
      scheduledClaim(value.claim, { scope, jobId: value.job.jobId, workerId, fence: value.job.fence });
      if (value.job.state !== 'leased' || value.job.workerId !== workerId || value.job.leaseUntilMs !== value.claim.leaseUntilMs
        || value.job.leaseRevoked || value.job.cancelRequested || value.job.startedAtMs !== null) throw new Error();
    }
    return values;
  } catch { throw new MayuraError('STORAGE_UNAVAILABLE', 'Scheduled claim batch failed integrity validation.'); }
}

export type ScheduledTransition = ScheduledWorkflowSnapshot | { readonly status: 'started' | 'already_started'; readonly snapshot: ScheduledWorkflowSnapshot };

/** Every mutation response crosses the same identity boundary as an ordinary inspect response. */
export function scheduledTransition<T extends ScheduledTransition>(raw: T, scope: string, id: string, policyHash: string): T {
  try {
    const value = freezeJson(jsonValue(raw, { maxBytes: 8_388_608, maxNodes: 300_000 })) as unknown as T;
    if ('snapshot' in value) {
      if (value.status !== 'started' && value.status !== 'already_started') throw new Error();
      scheduledView(value.snapshot, scope, id, policyHash);
    } else scheduledView(value, scope, id, policyHash);
    return value;
  } catch { throw new MayuraError('STORAGE_UNAVAILABLE', 'Scheduled transition response failed identity or integrity validation.'); }
}

/** Validate bounded canonical event pages; no adapter getters or malformed sequences reach callers. */
export function scheduledEvents(raw: StoredEvent[], after: number): StoredEvent[] {
  try {
    const events = freezeJson(jsonValue(raw, { maxBytes: 8_388_608, maxNodes: 300_000 })) as unknown as StoredEvent[];
    if (!Array.isArray(events) || events.length > 1_000) throw new Error();
    let previous = after;
    for (const event of events) {
      if (!Number.isSafeInteger(event.sequence) || event.sequence !== previous + 1 || typeof event.type !== 'string' || !event.type.length || event.type.length > 128
        || typeof event.createdAt !== 'string' || !Number.isFinite(Date.parse(event.createdAt)) || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) throw new Error();
      previous = event.sequence;
    }
    return events;
  } catch { throw new MayuraError('STORAGE_UNAVAILABLE', 'Scheduled event page failed integrity validation.'); }
}

export function safeScheduledJson(value: unknown, maxBytes: number, boundary: 'input' | 'output'): JsonValue {
  try { return freezeJson(jsonValue(value, { maxBytes })); }
  catch { throw new MayuraError(boundary === 'input' ? 'INVALID_INPUT' : 'INVALID_OUTPUT', 'Scheduled data exceeds its bounded JSON boundary.'); }
}
