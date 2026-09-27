import { freezeJson, jsonValue, type JsonObject, type JsonValue } from '@mayura/core';
import { StorageError, type StoredRecord } from './contracts.js';
import type { WorkflowBinding } from './scheduled-workflow-contracts.js';

export type WorkflowLoopBinding =
  | { readonly kind: 'literal'; readonly value: JsonValue }
  | { readonly kind: 'input'; readonly path: readonly string[] }
  | { readonly kind: 'current'; readonly path: readonly string[] };

export interface WorkflowLoopManifest {
  readonly format: 1; readonly id: string; readonly version: string;
  readonly body: { readonly definitionHash: string; readonly maxCostMicros: number; readonly maxCalls: number };
  readonly maxIterations: number; readonly initial: WorkflowBinding; readonly next: WorkflowLoopBinding;
  readonly continueWhen: WorkflowLoopBinding; readonly result: WorkflowLoopBinding;
  readonly maxCostMicros: number; readonly maxCalls: number;
}
export type WorkflowLoopStatus = 'running' | 'waiting' | 'paused' | 'succeeded' | 'failed' | 'limit_exceeded' | 'cancelled';
export interface WorkflowLoopState {
  readonly format: 1; readonly definition: string; readonly policy: string; readonly input: JsonValue;
  status: WorkflowLoopStatus; iteration: number; childRunId: string | null; current: JsonValue;
  readonly maxIterations: number; readonly maxCostMicros: number; spentMicros: number;
  activeSpentMicros: number; output: JsonValue;
}

const idPattern = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/; const hashPattern = /^[a-f0-9]{64}$/;
const forbidden = new Set(['constructor', 'prototype', '__proto__']);
const statuses = new Set<WorkflowLoopStatus>(['running', 'waiting', 'paused', 'succeeded', 'failed', 'limit_exceeded', 'cancelled']);
function invalid(): never { throw new StorageError('INVALID_INPUT', 'Invalid bounded workflow loop metadata.'); }
function corrupt(): never { throw new StorageError('CONFLICT', 'Stored workflow loop state failed integrity validation.'); }
function object(value: JsonValue | undefined): JsonObject { if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(); return value; }
function fields(value: JsonObject, names: readonly string[]): void { if (Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) invalid(); }
function integer(value: unknown, minimum = 0): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) invalid(); return value; }
function hash(value: unknown): string { if (typeof value !== 'string' || !hashPattern.test(value)) invalid(); return value; }
function path(value: unknown): void { if (!Array.isArray(value) || value.length > 32 || value.some(part => typeof part !== 'string' || forbidden.has(part))) invalid(); }
function binding(value: JsonValue | undefined, current: boolean): WorkflowLoopBinding {
  const item = object(value);
  if (item['kind'] === 'literal') fields(item, ['kind', 'value']);
  else if (item['kind'] === 'input' || (current && item['kind'] === 'current')) { fields(item, ['kind', 'path']); path(item['path']); }
  else invalid();
  return item as unknown as WorkflowLoopBinding;
}

/** Strict data-only bounded-loop manifest. */
export function workflowLoopManifest(value: unknown): WorkflowLoopManifest {
  try {
    const manifest = object(jsonValue(value)); fields(manifest, ['format', 'id', 'version', 'body', 'maxIterations',
      'initial', 'next', 'continueWhen', 'result', 'maxCostMicros', 'maxCalls']);
    if (manifest['format'] !== 1 || typeof manifest['id'] !== 'string' || !idPattern.test(manifest['id'])
      || typeof manifest['version'] !== 'string' || manifest['version'].length < 1 || manifest['version'].length > 128) invalid();
    const body = object(manifest['body']); fields(body, ['definitionHash', 'maxCostMicros', 'maxCalls']);
    hash(body['definitionHash']); const bodyCost = integer(body['maxCostMicros']); const bodyCalls = integer(body['maxCalls']);
    const iterations = integer(manifest['maxIterations'], 1); if (iterations > 1_024) invalid();
    const cost = bodyCost * iterations; const calls = bodyCalls * iterations;
    if (!Number.isSafeInteger(cost) || !Number.isSafeInteger(calls)
      || integer(manifest['maxCostMicros']) !== cost || integer(manifest['maxCalls']) !== calls) invalid();
    binding(manifest['initial'], false); binding(manifest['next'], true);
    binding(manifest['continueWhen'], true); binding(manifest['result'], true);
    return freezeJson(manifest) as unknown as WorkflowLoopManifest;
  } catch { return invalid(); }
}

export function initialWorkflowLoopState(manifest: WorkflowLoopManifest, input: JsonValue, definitionHash: string,
  policyHash: string, maxCostMicros: number): WorkflowLoopState {
  try {
    const definition = workflowLoopManifest(manifest); hash(definitionHash); hash(policyHash); integer(maxCostMicros);
    if (definition.maxCostMicros > maxCostMicros) invalid();
    return jsonValue({ format: 1, definition: definitionHash, policy: policyHash, input, status: 'running',
      iteration: 0, childRunId: null, current: null, maxIterations: definition.maxIterations,
      maxCostMicros, spentMicros: 0, activeSpentMicros: 0, output: null }) as unknown as WorkflowLoopState;
  } catch { return invalid(); }
}

export function workflowLoopState(record: Pick<StoredRecord, 'id' | 'state'>): WorkflowLoopState {
  try {
    const identity = Object.getOwnPropertyDescriptor(record, 'id'); const descriptor = Object.getOwnPropertyDescriptor(record, 'state');
    if (!identity || !('value' in identity) || typeof identity.value !== 'string' || !hashPattern.test(identity.value)
      || !descriptor || !('value' in descriptor)) invalid();
    const state = object(jsonValue(descriptor.value)); fields(state, ['format', 'definition', 'policy', 'input', 'status',
      'iteration', 'childRunId', 'current', 'maxIterations', 'maxCostMicros', 'spentMicros', 'activeSpentMicros', 'output']);
    if (state['format'] !== 1 || !statuses.has(state['status'] as WorkflowLoopStatus)) invalid();
    hash(state['definition']); hash(state['policy']); const iteration = integer(state['iteration']);
    const maximumIterations = integer(state['maxIterations'], 1); if (maximumIterations > 1_024 || iteration > maximumIterations) invalid();
    const maximum = integer(state['maxCostMicros']); const spent = integer(state['spentMicros']);
    const activeSpent = integer(state['activeSpentMicros']); if (spent > maximum || activeSpent > spent) invalid();
    if (state['childRunId'] !== null) hash(state['childRunId']);
    if (iteration === 0 && state['current'] !== null) invalid();
    if (state['status'] === 'waiting' && state['childRunId'] === null) invalid();
    if (state['childRunId'] === null && activeSpent !== 0) invalid();
    if (['succeeded', 'limit_exceeded'].includes(String(state['status'])) && state['childRunId'] !== null) invalid();
    if (state['status'] === 'succeeded' && iteration < 1) invalid();
    if (state['status'] === 'limit_exceeded' && iteration !== maximumIterations) invalid();
    if (state['status'] !== 'succeeded' && state['output'] !== null) invalid();
    return state as unknown as WorkflowLoopState;
  } catch { return corrupt(); }
}

export function assertWorkflowLoopStateMatchesManifest(state: WorkflowLoopState, manifest: WorkflowLoopManifest): void {
  try {
    const definition = workflowLoopManifest(manifest);
    if (state.maxIterations !== definition.maxIterations || state.iteration > definition.maxIterations) invalid();
  } catch { return corrupt(); }
}
