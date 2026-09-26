import { MayuraError, type JsonObject, type LifecycleObserver, type Scope } from '@mayura/core';
import { evaluateLifecycleObserver, snapshotHookOptions } from '@mayura/core/host';
import { StorageError, type AggregateStore, type StoredEvent, type StoredRecord } from '@mayura/storage-contracts';
import { digest } from './definition.js';

/** Durable lifecycle points delivered from a workflow run's stored event log. */
export type WorkflowHookStage = 'onWait' | 'onResume' | 'onApprovalRequested' | 'onApprovalResolved'
  | 'afterExecution' | 'onError' | 'onCancel' | 'onBlocked' | 'onFinally';

/** Metadata-only view of one stored event. `eventId` is the deduplication identity for at-least-once delivery. */
export interface WorkflowHookEvent {
  readonly stage: WorkflowHookStage;
  readonly runId: string;
  readonly sequence: number;
  /** `<relayId>:<runId>:<sequence>:<stage>`; stable across redelivery. */
  readonly eventId: string;
  /** The stored event type, for example `approval.requested` or `lifecycle.timer.fired`. */
  readonly type: string;
  readonly nodeId?: string;
  /** Terminal status, present for terminal stages. */
  readonly status?: string;
}
export type WorkflowHooks = { readonly [S in WorkflowHookStage]?: LifecycleObserver<WorkflowHookEvent, S> } & { readonly timeoutMs?: number };

/** Any workflow runtime: every format exposes its ordered durable log as `events(id, after)`. */
export interface WorkflowEventSource { events(id: string, after?: number): Promise<readonly StoredEvent[]> }

export interface WorkflowHookRelayOptions {
  readonly source: WorkflowEventSource;
  /** Holds one delivery cursor per (relay, run). May be the same store the workflows use. */
  readonly store: AggregateStore;
  readonly scope: Scope;
  /** Separates independent consumers of the same runs, for example `audit` and `notifications`. */
  readonly relayId: string;
  readonly hooks: WorkflowHooks;
}
export interface WorkflowHookDelivery {
  /** Callbacks that completed during this call. */
  readonly delivered: number;
  /** Last stored event whose callbacks all completed; delivery resumes after it. */
  readonly sequence: number;
  /** Present when a callback failed; the next `deliver` retries this event. */
  readonly failure?: { readonly sequence: number; readonly stage: WorkflowHookStage; readonly code: string };
}
export interface WorkflowHookRelay {
  /** Deliver callbacks for stored events after the durable cursor, in order, for at most `limit` events (default 1000). */
  deliver(runId: string, options?: { readonly signal?: AbortSignal; readonly limit?: number }): Promise<WorkflowHookDelivery>;
  /** The durable cursor for a run (0 before any delivery). */
  cursor(runId: string): Promise<number>;
}

const stages: readonly WorkflowHookStage[] = ['onWait', 'onResume', 'onApprovalRequested', 'onApprovalResolved', 'afterExecution', 'onError', 'onCancel', 'onBlocked', 'onFinally'];
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const eventStages: Readonly<Record<string, WorkflowHookStage>> = Object.freeze({
  'approval.requested': 'onApprovalRequested', 'lifecycle.approval.requested': 'onApprovalRequested',
  'approval.resolved': 'onApprovalResolved', 'lifecycle.approval.resolved': 'onApprovalResolved',
  'approval.expired': 'onApprovalResolved', 'lifecycle.approval.expired': 'onApprovalResolved',
  'wait.registered': 'onWait', 'run.waiting': 'onWait', 'lifecycle.run.waiting': 'onWait', 'workflow.waiting': 'onWait',
  'run.paused': 'onWait', 'lifecycle.run.paused': 'onWait', 'lifecycle.human.requested': 'onWait', 'lifecycle.timer.scheduled': 'onWait',
  'saga.forward.waiting': 'onWait', 'saga.compensation.waiting': 'onWait', 'loop.child.waiting': 'onWait',
  'wait.resolved': 'onResume', 'run.resumed': 'onResume', 'lifecycle.run.resumed': 'onResume',
  'lifecycle.human.responded': 'onResume', 'lifecycle.timer.fired': 'onResume',
});
/** Terminal events of every format; the value is the status used when the event data carries none. */
const terminalEvents: Readonly<Record<string, string>> = Object.freeze({
  'run.completed': 'unknown', 'lifecycle.run.completed': 'unknown', 'workflow.terminated': 'unknown',
  'run.cancelled': 'cancelled', 'lifecycle.run.cancelled': 'cancelled', 'saga.run.cancelled': 'cancelled', 'loop.run.cancelled': 'cancelled',
  'saga.run.succeeded': 'succeeded', 'loop.run.succeeded': 'succeeded',
  'saga.run.failed': 'failed', 'saga.run.compensated': 'compensated',
  'loop.output.rejected': 'failed', 'loop.condition.rejected': 'failed', 'loop.input.rejected': 'failed', 'loop.child.rejected': 'failed',
  'loop.child.failed': 'failed', 'loop.limit.exceeded': 'limit_exceeded',
});

/** The callbacks one stored event produces, in order. Unrelated events produce none. */
export function workflowHookStages(type: string, data: JsonObject): readonly { readonly stage: WorkflowHookStage; readonly status?: string }[] {
  const stage = eventStages[type];
  if (stage) return [{ stage }];
  const fallback = terminalEvents[type];
  if (fallback === undefined) return [];
  const status = typeof data['status'] === 'string' && identifier.test(data['status']) ? data['status'] : fallback;
  const terminal: WorkflowHookStage = status === 'succeeded' ? 'afterExecution' : status === 'cancelled' ? 'onCancel' : status === 'blocked' ? 'onBlocked' : 'onError';
  return [{ stage: terminal, status }, { stage: 'onFinally', status }];
}

/**
 * Durable, recoverable delivery of workflow lifecycle callbacks. Delivery is at-least-once: the cursor advances
 * only after an event's callbacks complete, so a crash or failure redelivers from that event with the same `eventId`.
 */
export function createWorkflowHookRelay(options: WorkflowHookRelayOptions): WorkflowHookRelay {
  const { store, source } = options;
  if (!store || typeof store.read !== 'function' || typeof store.create !== 'function' || typeof store.update !== 'function'
    || !source || typeof source.events !== 'function' || typeof options.relayId !== 'string' || !identifier.test(options.relayId)
    || typeof options.scope?.principalId !== 'string' || typeof options.scope?.projectId !== 'string') {
    throw new MayuraError('INVALID_CONFIG', 'A workflow hook relay requires a store, an event source, a scope and a bounded relay identity.');
  }
  const { handlers, timeoutMs } = snapshotHookOptions(options.hooks, stages, 'Workflow hooks require callable handlers for known stages and a bounded timeout.');
  const relayId = options.relayId;
  const scope = digest('mayura:scope:v1', { principalId: options.scope.principalId, projectId: options.scope.projectId });
  const cursorId = (runId: string): string => digest('mayura:workflow-hook-relay:v1', { relayId, runId });
  const guarded = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); }
    catch (error) { if (error instanceof MayuraError || (error instanceof StorageError && error.code === 'CONFLICT')) throw error;
      throw new MayuraError('STORAGE_UNAVAILABLE', 'Workflow hook relay storage is unavailable.'); }
  };
  const read = async (runId: string): Promise<{ record?: StoredRecord; sequence: number }> => {
    const id = cursorId(runId); const record = await guarded(() => store.read(scope, id));
    if (!record) return { sequence: 0 };
    const state = record.state;
    if (record.scope !== scope || record.id !== id || state['format'] !== 1 || state['relayId'] !== relayId || state['runId'] !== runId
      || !Number.isSafeInteger(state['sequence']) || (state['sequence'] as number) < 0) {
      throw new MayuraError('STORAGE_UNAVAILABLE', 'Stored hook relay cursor failed integrity validation.');
    }
    return { record, sequence: state['sequence'] as number };
  };
  /** Compare-and-set advance; a concurrent relay that got further wins and this one resumes from its cursor. */
  const advance = async (runId: string, current: { record?: StoredRecord; sequence: number }, sequence: number): Promise<{ record?: StoredRecord; sequence: number }> => {
    const state = { format: 1, relayId, runId, sequence }; const event = { type: 'hook-relay.advanced', data: { sequence } };
    try {
      const record = current.record
        ? await guarded(() => store.update({ scope, id: current.record!.id, expectedVersion: current.record!.version, state, events: [event] }))
        : (await guarded(() => store.create({ scope, id: cursorId(runId), idempotencyKey: cursorId(runId),
          definitionHash: digest('mayura:workflow-hook-relay-format:v1', {}), state, events: [event] }))).record;
      return { record, sequence };
    } catch (error) {
      if (!(error instanceof StorageError && error.code === 'CONFLICT')) throw error;
      const latest = await read(runId);
      return latest.sequence >= sequence ? latest : advance(runId, latest, sequence);
    }
  };
  const validRun = (runId: unknown): string => {
    if (typeof runId !== 'string' || !identifier.test(runId)) throw new MayuraError('INVALID_INPUT', 'A bounded workflow run identity is required.');
    return runId;
  };
  return Object.freeze<WorkflowHookRelay>({
    async cursor(runId) { return (await read(validRun(runId))).sequence; },
    async deliver(runId, deliveryOptions = {}) {
      validRun(runId);
      const limit = deliveryOptions.limit ?? 1_000; const signal = deliveryOptions.signal;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new MayuraError('INVALID_INPUT', 'Delivery limit must be 1–10000 events.');
      let current = await read(runId); let scanned = 0; let delivered = 0;
      while (scanned < limit) {
        if (signal?.aborted) throw new MayuraError('CANCELLED', 'Workflow hook delivery was cancelled.');
        const page = await guarded(() => source.events(runId, current.sequence));
        if (!Array.isArray(page)) throw new MayuraError('STORAGE_UNAVAILABLE', 'The workflow event source returned an invalid page.');
        let expected = current.sequence; let unsaved = current.sequence;
        for (const stored of page) {
          if (scanned >= limit) break;
          if (!stored || stored.sequence !== expected + 1 || typeof stored.type !== 'string' || !stored.data || typeof stored.data !== 'object') {
            throw new MayuraError('STORAGE_UNAVAILABLE', 'The workflow event source returned events out of order.');
          }
          expected = stored.sequence; scanned++;
          const callbacks = workflowHookStages(stored.type, stored.data).filter(entry => handlers[entry.stage] !== undefined);
          for (const { stage, status } of callbacks) {
            const nodeId = stored.data['nodeId'];
            const event: WorkflowHookEvent = { stage, runId, sequence: stored.sequence, eventId: `${relayId}:${runId}:${stored.sequence}:${stage}`, type: stored.type,
              ...(typeof nodeId === 'string' && identifier.test(nodeId) ? { nodeId } : {}), ...(status === undefined ? {} : { status }) };
            try {
              await evaluateLifecycleObserver({ stage, handler: handlers[stage] as LifecycleObserver<WorkflowHookEvent>, event, timeoutMs, ...(signal ? { signal } : {}) });
            } catch (error) {
              if (unsaved > current.sequence) current = await advance(runId, current, unsaved);
              if (error instanceof MayuraError && error.code === 'CANCELLED') throw error;
              const code = error instanceof MayuraError ? error.code : 'GUARD_UNAVAILABLE';
              return Object.freeze({ delivered, sequence: current.sequence, failure: Object.freeze({ sequence: stored.sequence, stage, code }) });
            }
            delivered++;
          }
          unsaved = stored.sequence;
          // Persist after every callback-bearing event so a crash never repeats completed callbacks of earlier events.
          if (callbacks.length > 0) current = await advance(runId, current, unsaved);
        }
        if (unsaved > current.sequence) current = await advance(runId, current, unsaved);
        if (page.length < 1_000) break;
      }
      return Object.freeze({ delivered, sequence: current.sequence });
    },
  });
}
