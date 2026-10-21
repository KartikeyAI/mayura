import { useMemo, useSyncExternalStore } from 'react';
import { createHumanRequestView, createRunActivityProjection, type HeadlessRunState, type HeadlessRunStore, type HumanRequestView,
  type RunActivityProjection } from '@mayura/client/headless';
import type { HeadlessThreadState, HeadlessThreadStore, HeadlessThreadsState, HeadlessThreadsStore, RunApprovalCommandState, RunApprovalController, ThreadCompactionController, ThreadCompactionState } from '@mayura/client/headless';
import type { RemoteHumanRequest } from '@mayura/client';
import type { HumanResponseCommandState, HumanResponseController } from '@mayura/client/forms';
import { createWorkflowGraphProjection, type WorkflowCommandController, type WorkflowCommandState, type WorkflowGraphProjection,
  type WorkflowViewInput } from '@mayura/client/workflows';

export interface MayuraRunActions {
  readonly refresh: HeadlessRunStore['refresh'];
  readonly observe: HeadlessRunStore['observe'];
  readonly cancel: HeadlessRunStore['cancel'];
}

export class MayuraReactError extends Error {
  override readonly name = 'MayuraReactError';
  constructor(readonly code: 'INVALID_REACT_STORE' | 'INVALID_RESPONSE_CONTROLLER' | 'INVALID_WORKFLOW_CONTROLLER' | 'INVALID_APPROVAL_CONTROLLER' | 'INVALID_COMPACTION_CONTROLLER' | 'INVALID_COMPONENT_PROPS') {
    super(`Mayura React binding failed (${code}).`); Object.freeze(this);
  }
}

/** Subscribe to caller-owned human command state without submitting, retrying or starting any effect. */
export function useMayuraHumanResponseCommand(controller: HumanResponseController): HumanResponseCommandState {
  if (!controller || typeof controller.getSnapshot !== 'function' || typeof controller.subscribe !== 'function'
    || typeof controller.submit !== 'function' || typeof controller.reset !== 'function' || typeof controller.dispose !== 'function')
    throw new MayuraReactError('INVALID_RESPONSE_CONTROLLER');
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}

/** Subscribe to caller-owned workflow command state without reading or mutating on mount. */
export function useMayuraWorkflowCommand(controller: WorkflowCommandController): WorkflowCommandState {
  if (!controller || typeof controller.getSnapshot !== 'function' || typeof controller.subscribe !== 'function'
    || typeof controller.cancel !== 'function' || typeof controller.approve !== 'function' || typeof controller.signal !== 'function'
    || typeof controller.resume !== 'function' || typeof controller.pause !== 'function' || typeof controller.reset !== 'function'
    || typeof controller.dispose !== 'function') throw new MayuraReactError('INVALID_WORKFLOW_CONTROLLER');
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}

function store(value: HeadlessRunStore): HeadlessRunStore {
  if (!value || typeof value.getSnapshot !== 'function' || typeof value.subscribe !== 'function' || typeof value.refresh !== 'function'
    || typeof value.observe !== 'function' || typeof value.cancel !== 'function') throw new MayuraReactError('INVALID_REACT_STORE');
  return value;
}

/** Subscribe to one caller-owned headless store. This hook starts no reads, streams, timers or commands. */
export function useMayuraRun(value: HeadlessRunStore): HeadlessRunState {
  const selected = store(value);
  return useSyncExternalStore(selected.subscribe, selected.getSnapshot, selected.getSnapshot);
}

/** Stable explicit actions for event handlers. Observation and cancellation are never invoked by an effect. */
export function useMayuraRunActions(value: HeadlessRunStore): MayuraRunActions {
  const selected = store(value);
  return useMemo(() => Object.freeze({ refresh: selected.refresh, observe: selected.observe, cancel: selected.cancel }), [selected]);
}

/** Derive text-only human request metadata during render without copying it into component state. */
export function useMayuraHumanRequest(request: RemoteHumanRequest, nowMs: number): HumanRequestView {
  return useMemo(() => createHumanRequestView(request, nowMs), [request, nowMs]);
}

/** Derive a stable, content-free activity timeline from the current bounded run state. */
export function useMayuraRunActivity(state: HeadlessRunState): RunActivityProjection {
  return useMemo(() => createRunActivityProjection(state), [state]);
}

/** Validate and memoize one content-free durable workflow DAG supplied by an authenticated application adapter. */
export function useMayuraWorkflowGraph(input: WorkflowViewInput): WorkflowGraphProjection {
  return useMemo(() => createWorkflowGraphProjection(input), [input]);
}

export type MayuraThreadActions = Pick<HeadlessThreadStore, 'refresh' | 'update' | 'archive' | 'restore' | 'delete' | 'submit' | 'append'>;

function threadStore(value: HeadlessThreadStore): HeadlessThreadStore {
  if (!value || ['getSnapshot', 'subscribe', 'refresh', 'update', 'archive', 'restore', 'delete', 'submit', 'dispose'].some(key => typeof value[key as keyof HeadlessThreadStore] !== 'function'))
    throw new MayuraReactError('INVALID_REACT_STORE'); return value;
}
/** Subscribe to the caller's conversation page without starting requests or owning its lifecycle. */
export function useMayuraThread(value: HeadlessThreadStore): HeadlessThreadState {
  const selected = threadStore(value); return useSyncExternalStore(selected.subscribe, selected.getSnapshot, selected.getSnapshot);
}
/** Stable conversation actions for event handlers; no mutations run during render or effects. */
export function useMayuraThreadActions(value: HeadlessThreadStore): MayuraThreadActions {
  const selected = threadStore(value);
  return useMemo(() => Object.freeze({ refresh: selected.refresh, update: selected.update, archive: selected.archive,
    restore: selected.restore, delete: selected.delete, submit: selected.submit, append: selected.append }), [selected]);
}
/** Subscribe to a bounded caller-owned thread index. Call refresh explicitly to change pages. */
export function useMayuraThreads(value: HeadlessThreadsStore): HeadlessThreadsState {
  if (!value || typeof value.getSnapshot !== 'function' || typeof value.subscribe !== 'function' || typeof value.refresh !== 'function' || typeof value.dispose !== 'function')
    throw new MayuraReactError('INVALID_REACT_STORE');
  return useSyncExternalStore(value.subscribe, value.getSnapshot, value.getSnapshot);
}
/** Subscribe to one captured approval's explicit command feedback. Mounting never makes a decision. */
export function useMayuraRunApprovalCommand(value: RunApprovalController): RunApprovalCommandState {
  if (!value || typeof value.getSnapshot !== 'function' || typeof value.subscribe !== 'function' || typeof value.submit !== 'function' || typeof value.dispose !== 'function')
    throw new MayuraReactError('INVALID_APPROVAL_CONTROLLER');
  return useSyncExternalStore(value.subscribe, value.getSnapshot, value.getSnapshot);
}

export type MayuraThreadCompactionActions = Pick<ThreadCompactionController, 'compact' | 'refresh' | 'cancel'>;
function compactionController(value: ThreadCompactionController): ThreadCompactionController {
  if (!value || ['getSnapshot', 'subscribe', 'compact', 'refresh', 'cancel', 'dispose'].some(key => typeof value[key as keyof ThreadCompactionController] !== 'function'))
    throw new MayuraReactError('INVALID_COMPACTION_CONTROLLER'); return value;
}
/** Subscribe to a caller-owned, command-bound compaction view. Rendering never reads, spends or cancels. */
export function useMayuraThreadCompactionCommand(value: ThreadCompactionController): ThreadCompactionState {
  const selected = compactionController(value);
  return useSyncExternalStore(selected.subscribe, selected.getSnapshot, selected.getSnapshot);
}
/** Stable explicit event actions. The application owns command selection, inspection policy and disposal. */
export function useMayuraThreadCompactionActions(value: ThreadCompactionController): MayuraThreadCompactionActions {
  const selected = compactionController(value);
  return useMemo(() => Object.freeze({ compact: selected.compact, refresh: selected.refresh, cancel: selected.cancel }), [selected]);
}
