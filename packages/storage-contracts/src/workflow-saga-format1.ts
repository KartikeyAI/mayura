import { freezeJson, jsonValue, type JsonObject, type JsonValue } from '@mayura/core';
import { StorageError, type StoredRecord } from './contracts.js';
import type { WorkflowBinding } from './scheduled-workflow-contracts.js';

export interface WorkflowSagaChildManifest {
  readonly definitionHash: string; readonly maxCostMicros: number; readonly maxCalls: number;
}
export interface WorkflowSagaStepManifest {
  readonly id: string; readonly forward: WorkflowSagaChildManifest; readonly input: WorkflowBinding;
  readonly compensation: WorkflowSagaChildManifest | null; readonly compensationInput: WorkflowBinding | null;
}
export interface WorkflowSagaManifest {
  readonly format: 1; readonly id: string; readonly version: string; readonly steps: readonly WorkflowSagaStepManifest[];
  readonly result: WorkflowBinding; readonly maxCostMicros: number; readonly maxCalls: number;
}
export type WorkflowSagaStepStatus = 'pending' | 'forward_waiting' | 'succeeded' | 'failed' | 'compensation_waiting'
  | 'compensated' | 'compensation_failed' | 'skipped';
export interface WorkflowSagaStepState {
  status: WorkflowSagaStepStatus; forwardRunId: string | null; compensationRunId: string | null;
  output: JsonValue; forwardSpentMicros: number; compensationSpentMicros: number;
}
export type WorkflowSagaStatus = 'running' | 'waiting' | 'paused' | 'compensating' | 'succeeded' | 'failed'
  | 'compensated' | 'compensation_failed' | 'cancelled';
export interface WorkflowSagaState {
  readonly format: 1; readonly definition: string; readonly policy: string; readonly input: JsonValue;
  status: WorkflowSagaStatus; cursor: number; readonly steps: Record<string, WorkflowSagaStepState>;
  readonly maxCostMicros: number; spentMicros: number; output: JsonValue;
}

const idPattern = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/; const hashPattern = /^[a-f0-9]{64}$/;
const forbidden = new Set(['constructor', 'prototype', '__proto__']);
const stepStatuses = new Set<WorkflowSagaStepStatus>(['pending', 'forward_waiting', 'succeeded', 'failed', 'compensation_waiting', 'compensated', 'compensation_failed', 'skipped']);
const statuses = new Set<WorkflowSagaStatus>(['running', 'waiting', 'paused', 'compensating', 'succeeded', 'failed', 'compensated', 'compensation_failed', 'cancelled']);
function invalid(): never { throw new StorageError('INVALID_INPUT', 'Invalid bounded workflow saga metadata.'); }
function corrupt(): never { throw new StorageError('CONFLICT', 'Stored workflow saga state failed integrity validation.'); }
function object(value: JsonValue | undefined): JsonObject { if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(); return value; }
function fields(value: JsonObject, names: readonly string[]): void { if (Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) invalid(); }
function hash(value: unknown): string { if (typeof value !== 'string' || !hashPattern.test(value)) invalid(); return value; }
function integer(value: unknown, minimum = 0): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) invalid(); return value; }
function identifier(value: unknown): string { if (typeof value !== 'string' || !idPattern.test(value) || forbidden.has(value)) invalid(); return value; }
function binding(value: JsonValue | undefined, ids: ReadonlySet<string>, allowed: ReadonlySet<string>): WorkflowBinding {
  const item = object(value);
  if (item['kind'] === 'literal') fields(item, ['kind', 'value']);
  else if (item['kind'] === 'input' || item['kind'] === 'step') {
    fields(item, item['kind'] === 'input' ? ['kind', 'path'] : ['kind', 'stepId', 'path']);
    if (!Array.isArray(item['path']) || item['path'].length > 32 || item['path'].some(part => typeof part !== 'string' || forbidden.has(part))) invalid();
    if (item['kind'] === 'step' && (typeof item['stepId'] !== 'string' || !ids.has(item['stepId']) || !allowed.has(item['stepId']))) invalid();
  } else invalid();
  return item as unknown as WorkflowBinding;
}
function child(value: JsonValue | undefined): WorkflowSagaChildManifest {
  const item = object(value); fields(item, ['definitionHash', 'maxCostMicros', 'maxCalls']);
  hash(item['definitionHash']); integer(item['maxCostMicros']); integer(item['maxCalls']); return item as unknown as WorkflowSagaChildManifest;
}

/** Strict data-only saga manifest. Step references may only point backward; compensation may also reference its own forward output. */
export function workflowSagaManifest(value: unknown): WorkflowSagaManifest {
  try {
    const manifest = object(jsonValue(value)); fields(manifest, ['format', 'id', 'version', 'steps', 'result', 'maxCostMicros', 'maxCalls']);
    if (manifest['format'] !== 1 || typeof manifest['id'] !== 'string' || !idPattern.test(manifest['id']) || typeof manifest['version'] !== 'string'
      || manifest['version'].length < 1 || manifest['version'].length > 128 || !Array.isArray(manifest['steps'])
      || manifest['steps'].length < 1 || manifest['steps'].length > 128) invalid();
    const ids = new Set<string>();
    for (const raw of manifest['steps']) { const id = identifier(object(raw)['id']); if (ids.has(id)) invalid(); ids.add(id); }
    const previous = new Set<string>(); let cost = 0; let calls = 0;
    for (const raw of manifest['steps']) {
      const step = object(raw); fields(step, ['id', 'forward', 'input', 'compensation', 'compensationInput']); const id = identifier(step['id']);
      const forward = child(step['forward']); cost += forward.maxCostMicros; calls += forward.maxCalls;
      binding(step['input'], ids, previous);
      if ((step['compensation'] === null) !== (step['compensationInput'] === null)) invalid();
      if (step['compensation'] !== null) {
        const compensation = child(step['compensation']); cost += compensation.maxCostMicros; calls += compensation.maxCalls;
        binding(step['compensationInput'], ids, new Set([...previous, id]));
      }
      if (!Number.isSafeInteger(cost) || !Number.isSafeInteger(calls)) invalid(); previous.add(id);
    }
    const declaredCost = integer(manifest['maxCostMicros']); const declaredCalls = integer(manifest['maxCalls']);
    if (cost !== declaredCost || calls !== declaredCalls) invalid();
    binding(manifest['result'], ids, ids);
    return freezeJson(manifest) as unknown as WorkflowSagaManifest;
  } catch { return invalid(); }
}

export function initialWorkflowSagaState(manifest: WorkflowSagaManifest, input: JsonValue, definitionHash: string,
  policyHash: string, maxCostMicros: number): WorkflowSagaState {
  try {
    const definition = workflowSagaManifest(manifest); hash(definitionHash); hash(policyHash); integer(maxCostMicros);
    if (definition.maxCostMicros > maxCostMicros) invalid();
    return jsonValue({ format: 1, definition: definitionHash, policy: policyHash, input, status: 'running', cursor: 0,
      steps: Object.fromEntries(definition.steps.map(step => [step.id, { status: 'pending', forwardRunId: null,
        compensationRunId: null, output: null, forwardSpentMicros: 0, compensationSpentMicros: 0 }])),
      maxCostMicros, spentMicros: 0, output: null }) as unknown as WorkflowSagaState;
  } catch { return invalid(); }
}

export function workflowSagaState(record: Pick<StoredRecord, 'id' | 'state'>): WorkflowSagaState {
  try {
    const id = Object.getOwnPropertyDescriptor(record, 'id'); const descriptor = Object.getOwnPropertyDescriptor(record, 'state');
    if (!id || !('value' in id) || typeof id.value !== 'string' || !hashPattern.test(id.value) || !descriptor || !('value' in descriptor)) invalid();
    const state = object(jsonValue(descriptor.value)); fields(state, ['format', 'definition', 'policy', 'input', 'status', 'cursor', 'steps', 'maxCostMicros', 'spentMicros', 'output']);
    if (state['format'] !== 1 || !statuses.has(state['status'] as WorkflowSagaStatus)) invalid();
    hash(state['definition']); hash(state['policy']); const maximum = integer(state['maxCostMicros']); const spent = integer(state['spentMicros']);
    if (spent > maximum) invalid(); integer(state['cursor']); const steps = object(state['steps']); const entries = Object.entries(steps);
    if (entries.length < 1 || entries.length > 128) invalid(); let projected = 0;
    for (const [idValue, raw] of entries) {
      identifier(idValue); const step = object(raw); fields(step, ['status', 'forwardRunId', 'compensationRunId', 'output', 'forwardSpentMicros', 'compensationSpentMicros']);
      if (!stepStatuses.has(step['status'] as WorkflowSagaStepStatus)) invalid();
      if (step['forwardRunId'] !== null) hash(step['forwardRunId']); if (step['compensationRunId'] !== null) hash(step['compensationRunId']);
      const forwardSpent = integer(step['forwardSpentMicros']); const compensationSpent = integer(step['compensationSpentMicros']); projected += forwardSpent + compensationSpent;
      if (!Number.isSafeInteger(projected)) invalid();
      if (step['status'] === 'pending' || step['status'] === 'skipped') {
        if (step['forwardRunId'] !== null || step['compensationRunId'] !== null || step['output'] !== null || forwardSpent !== 0 || compensationSpent !== 0) invalid();
      } else if (step['status'] === 'forward_waiting') {
        if (step['forwardRunId'] === null || step['compensationRunId'] !== null || step['output'] !== null || compensationSpent !== 0) invalid();
      } else if (step['status'] === 'failed') {
        if (step['compensationRunId'] !== null || step['output'] !== null || compensationSpent !== 0) invalid();
      } else if (step['status'] === 'succeeded') {
        if (step['forwardRunId'] === null || step['compensationRunId'] !== null) invalid();
      } else if (step['status'] === 'compensation_failed') {
        if (step['forwardRunId'] === null) invalid();
      } else if (step['forwardRunId'] === null || step['compensationRunId'] === null) invalid();
    }
    if (projected !== spent || integer(state['cursor']) > entries.length) invalid();
    if (state['status'] === 'succeeded' && entries.some(([, raw]) => object(raw)['status'] !== 'succeeded')) invalid();
    if (state['status'] !== 'succeeded' && state['output'] !== null) invalid();
    if (state['status'] === 'compensation_failed' && entries.every(([, raw]) => object(raw)['status'] !== 'compensation_failed')) invalid();
    if (state['status'] === 'compensated' && entries.every(([, raw]) => object(raw)['status'] !== 'compensated')) invalid();
    return state as unknown as WorkflowSagaState;
  } catch { return corrupt(); }
}

export function assertWorkflowSagaStateMatchesManifest(state: WorkflowSagaState, manifest: WorkflowSagaManifest): void {
  try {
    const definition = workflowSagaManifest(manifest); const value = object(jsonValue(state)); const steps = object(value['steps']);
    if (Object.keys(steps).length !== definition.steps.length || definition.steps.some(step => !Object.hasOwn(steps, step.id))) invalid();
    for (const step of definition.steps) {
      const current = object(steps[step.id]);
      if (step.compensation === null && ['compensation_waiting', 'compensated', 'compensation_failed'].includes(String(current['status']))) invalid();
    }
    const ordered = definition.steps.map(step => object(steps[step.id]));
    const cursor = integer(value['cursor']);
    // A paused saga keeps the shape of the phase it paused in: forward (running) or compensation (compensating).
    const compensationPhase = ordered.some(step => ['failed', 'compensation_waiting', 'compensated', 'compensation_failed'].includes(String(step['status'])));
    const status = value['status'] === 'paused' ? (compensationPhase ? 'compensating' : 'running') : value['status'] as WorkflowSagaStatus;
    if (status === 'running' || status === 'waiting') {
      if (cursor > ordered.length || (cursor === ordered.length
        ? status !== 'running' || ordered.some(step => step['status'] !== 'succeeded')
        : ordered.some((step, index) => index < cursor
        ? step['status'] !== 'succeeded'
        : index === cursor
          ? !['pending', 'forward_waiting'].includes(String(step['status']))
          : step['status'] !== 'pending'))) invalid();
      if (status === 'waiting' && ordered[cursor]?.['status'] !== 'forward_waiting') invalid();
    } else if (status === 'compensating' || status === 'failed' || status === 'compensated' || status === 'compensation_failed') {
      const failedIndex = ordered.findIndex(step => step['status'] === 'failed');
      if (failedIndex < 0) {
        if (ordered.some(step => !['succeeded', 'compensation_waiting', 'compensated', 'compensation_failed'].includes(String(step['status'])))) invalid();
      } else {
        if (ordered.filter(step => step['status'] === 'failed').length !== 1) invalid();
        if (ordered.some((step, index) => index > failedIndex && step['status'] !== 'skipped')) invalid();
        if (ordered.slice(0, failedIndex).some(step => !['succeeded', 'compensation_waiting', 'compensated', 'compensation_failed'].includes(String(step['status'])))) invalid();
      }
    }
  } catch { return corrupt(); }
}
