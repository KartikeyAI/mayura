import { freezeJson, jsonValue, MayuraError, type JsonValue } from '@mayura/core';
import {
  StorageError, workflowManifest, workflowState, workflowGraphState,
  type Claim, type JobRecord, type ScheduledWorkflowSnapshot, type StorageErrorCode, type StoredEvent, type StoredRecord, type WorkflowManifest,
  type WorkflowGraphStoreSnapshot,
} from '@mayura/storage-contracts';
import type { AnyWorkflow } from './definition.js';
import type { WorkflowSnapshot } from './runtime.js';
import type { WorkflowGraphSnapshot } from './graphs.js';

export type ScheduledProfile = 'scheduled-v1' | 'scheduled-v2';
export type ScheduledStoredSnapshot = ScheduledWorkflowSnapshot | WorkflowGraphStoreSnapshot;
export type ScheduledPublicSnapshot = WorkflowSnapshot | WorkflowGraphSnapshot;

type ScheduledState = ReturnType<typeof workflowState> | ReturnType<typeof workflowGraphState>;
// Only this module's deep-owned, fully validated views may enter these caches. In
// particular, neither adapter object identity nor Object.isFrozen grants trust.
const ownedViews = new WeakSet<object>();
const ownedStates = new WeakMap<StoredRecord, { readonly profile: ScheduledProfile; readonly state: ScheduledState }>();

/** Select an exact profile decoder. Legacy validators never learn new-format acceptance. */
export function scheduledState(record: StoredRecord, profile: ScheduledProfile) {
  const known = ownedStates.get(record);
  if (known?.profile === profile) return known.state;
  return profile === 'scheduled-v1' ? workflowState(record) : workflowGraphState(record);
}

const storageCodes = new Set<StorageErrorCode>(['INVALID_INPUT', 'CONFLICT', 'NOT_FOUND', 'STORAGE_UNAVAILABLE',
  'STORE_CLOSED', 'STORE_NOT_INITIALIZED', 'QUEUE_FULL', 'STALE_CLAIM', 'LIMIT_EXCEEDED', 'SCHEDULED_WRITER_REQUIRED']);

/** Preserve only stable storage codes; never copy adapter messages or inspect exception getters. */
/** Fixed storage answer when an approval expired before admission: final for that call, and a new review is needed. */
export const reviewExpiredMessage = 'The approval expired; request a new review before admission.';
export const isReviewExpired = (error: unknown): boolean => error instanceof StorageError && error.storageCode === 'CONFLICT' && error.message === reviewExpiredMessage;
export async function scheduledStorage<T>(operation: () => Promise<T>, timeoutMs = 10_000, signal?: AbortSignal): Promise<T> {
  try { return await scheduledCallback(operation, timeoutMs, signal ?? new AbortController().signal); }
  catch (error) {
    let code: StorageErrorCode = 'STORAGE_UNAVAILABLE'; let refusal: string | undefined;
    try {
      const own = error instanceof StorageError ? Object.getOwnPropertyDescriptor(error, 'storageCode') : undefined;
      if (own && 'value' in own && storageCodes.has(own.value as StorageErrorCode)) code = own.value as StorageErrorCode;
      // A migration refusal is fixed storage text plus step ids; it is the reviewer's answer, so it is kept verbatim.
      const message = error instanceof StorageError ? Object.getOwnPropertyDescriptor(error, 'message') : undefined;
      if (code === 'CONFLICT' && message && 'value' in message && typeof message.value === 'string'
        && (/^Migration refused: [A-Za-z0-9 .,;:"'()_-]{1,240}$/.test(message.value) || message.value === reviewExpiredMessage)) refusal = message.value;
    } catch { /* Exception proxies do not become public diagnostics. */ }
    throw new StorageError(code, refusal ?? 'Scheduled persistence could not confirm the requested transition. Inspect current state before retrying effects.');
  }
}

export function isStorageCode(error: unknown, code: StorageErrorCode): boolean {
  return error instanceof StorageError && error.storageCode === code;
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
export function scheduledSnapshot(record: StoredRecord): WorkflowSnapshot;
export function scheduledSnapshot(record: StoredRecord, profile: ScheduledProfile): ScheduledPublicSnapshot;
export function scheduledSnapshot(record: StoredRecord, profile: ScheduledProfile = 'scheduled-v1'): ScheduledPublicSnapshot {
  const state = scheduledState(record, profile);
  return freezeJson(jsonValue({ id: record.id, version: record.version, status: state.status, steps: state.steps,
    output: state.output, budget: { spentMicros: state.spentMicros, reservedMicros: state.reservedMicros, maxCostMicros: state.maxCostMicros },
  })) as unknown as ScheduledPublicSnapshot;
}

/** Snapshot an adapter-owned response before using it for a later decision. */
export function scheduledView(raw: ScheduledWorkflowSnapshot, scope: string, id: string, policyHash: string): ScheduledWorkflowSnapshot;
export function scheduledView(raw: ScheduledStoredSnapshot, scope: string, id: string, policyHash: string, profile: ScheduledProfile): ScheduledStoredSnapshot;
export function scheduledView(raw: ScheduledStoredSnapshot, scope: string, id: string, policyHash: string, profile: ScheduledProfile = 'scheduled-v1'): ScheduledStoredSnapshot {
  try {
    const view = ownedViews.has(raw) ? raw
      : freezeJson(jsonValue(raw, { maxBytes: 8_388_608, maxNodes: 300_000 })) as unknown as ScheduledStoredSnapshot;
    return checkOwnedView(view, scope, id, policyHash, profile);
  } catch { throw new MayuraError('STORAGE_UNAVAILABLE', 'Scheduled state failed identity or integrity validation.'); }
}

/** Call only with JSON already copied and recursively frozen by this module. */
function checkOwnedView(view: ScheduledStoredSnapshot, scope: string, id: string, policyHash: string, profile: ScheduledProfile): ScheduledStoredSnapshot {
  if (view.profile !== profile || view.record.scope !== scope || view.record.id !== id
    || view.policyHash !== policyHash || view.record.state['policy'] !== policyHash) throw new Error();
  // Requested authority is checked even for internal reuse; immutable structural
  // checks and decoding need happen only once for this exact owned snapshot.
  if (ownedViews.has(view)) return view;
  if (!Array.isArray(view.jobs)
    || view.jobs.length > 128 || !Number.isSafeInteger(view.record.version) || view.record.version < 1
    || !/^[a-f0-9]{64}$/.test(view.manifestHash) || !/^[a-f0-9]{64}$/.test(view.resourceHash)
    || view.record.definitionHash !== view.manifestHash) throw new Error();
  const state = scheduledState(view.record, profile);
  if (state.definition !== view.manifestHash || new Set(view.jobs.map(job => job.jobId)).size !== view.jobs.length
    || new Set(view.jobs.map(job => job.nodeId)).size !== view.jobs.length) throw new Error();
  for (const job of view.jobs) {
    checkJob(job, scope, id);
    const step = state.steps[job.nodeId];
    if (!step || step.kind !== 'tool' || step.candidateHash !== job.candidateHash) throw new Error();
  }
  freezeJson(state as unknown as JsonValue);
  ownedStates.set(view.record, { profile, state }); ownedViews.add(view);
  return view;
}

/** Own the complete submission acknowledgement before accessing nested adapter-owned data. */
export function scheduledSubmission(raw: unknown): { readonly snapshot: ScheduledStoredSnapshot; readonly created: boolean } {
  try {
    const value = freezeJson(jsonValue(raw, { maxBytes: 8_388_608, maxNodes: 300_000 }));
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
      || !Object.hasOwn(value, 'snapshot') || typeof value['created'] !== 'boolean') throw new Error();
    return value as unknown as { readonly snapshot: ScheduledStoredSnapshot; readonly created: boolean };
  } catch { throw new MayuraError('STORAGE_UNAVAILABLE', 'Scheduled submission response failed integrity validation.'); }
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

export type ScheduledTransition = ScheduledStoredSnapshot | { readonly status: 'started' | 'already_started'; readonly snapshot: ScheduledStoredSnapshot };

/** Every mutation response crosses the same identity boundary as an ordinary inspect response. */
export function scheduledTransition<T extends ScheduledTransition>(raw: T, scope: string, id: string, policyHash: string, profile: ScheduledProfile = 'scheduled-v1'): T {
  try {
    if (ownedViews.has(raw)) return scheduledView(raw as ScheduledStoredSnapshot, scope, id, policyHash, profile) as T;
    const value = freezeJson(jsonValue(raw, { maxBytes: 8_388_608, maxNodes: 300_000 })) as unknown as T;
    if ('snapshot' in value) {
      if (value.status !== 'started' && value.status !== 'already_started') throw new Error();
      const snapshot = checkOwnedView(value.snapshot, scope, id, policyHash, profile);
      return Object.freeze({ ...value, snapshot }) as T;
    }
    return checkOwnedView(value, scope, id, policyHash, profile) as T;
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
