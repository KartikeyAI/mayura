import { useMemo, useSyncExternalStore } from 'react';
import { createHumanRequestView, createRunActivityProjection, type HeadlessRunState, type HeadlessRunStore, type HumanRequestView,
  type RunActivityProjection } from '@mayura/client/headless';
import type { RemoteHumanRequest } from '@mayura/client';
import type { HumanResponseCommandState, HumanResponseController } from '@mayura/client/forms';
import { createWorkflowGraphProjection, type WorkflowGraphProjection, type WorkflowViewInput } from '@mayura/client/workflows';

export interface MayuraRunActions {
  readonly refresh: HeadlessRunStore['refresh'];
  readonly observe: HeadlessRunStore['observe'];
  readonly cancel: HeadlessRunStore['cancel'];
}

export class MayuraReactError extends Error {
  override readonly name = 'MayuraReactError';
  constructor(readonly code: 'INVALID_REACT_STORE' | 'INVALID_RESPONSE_CONTROLLER' | 'INVALID_COMPONENT_PROPS') { super(`Mayura React binding failed (${code}).`); Object.freeze(this); }
}

/** Subscribe to caller-owned human command state without submitting, retrying or starting any effect. */
export function useMayuraHumanResponseCommand(controller: HumanResponseController): HumanResponseCommandState {
  if (!controller || typeof controller.getSnapshot !== 'function' || typeof controller.subscribe !== 'function'
    || typeof controller.submit !== 'function' || typeof controller.reset !== 'function' || typeof controller.dispose !== 'function')
    throw new MayuraReactError('INVALID_RESPONSE_CONTROLLER');
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
