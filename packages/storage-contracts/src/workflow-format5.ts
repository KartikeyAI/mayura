import { freezeJson, jsonValue, type JsonObject, type JsonValue } from '@mayura/core';
import { StorageError, type StoredRecord } from './contracts.js';
import type { WorkflowBinding, WorkflowManifestNode } from './scheduled-workflow-contracts.js';
import { workflowManifest, workflowState, type WorkflowFormat2Step, type WorkflowFormat2StepStatus } from './workflow-format2.js';

export type WorkflowLifecycleHumanKind = 'information' | 'correction' | 'plan_selection';

export interface WorkflowLifecycleHumanNodeManifest {
  readonly kind: 'human';
  readonly id: string;
  readonly dependsOn: readonly string[];
  readonly requestKind: WorkflowLifecycleHumanKind;
  readonly schemaId: string;
  readonly schemaDigest: string;
  readonly prompt: string;
  readonly context: WorkflowBinding | null;
  readonly subjectDigest: WorkflowBinding | null;
  readonly deadlineAtMs: WorkflowBinding | null;
  readonly when?: WorkflowBinding;
}

export interface WorkflowLifecycleTimerNodeManifest {
  readonly kind: 'timer';
  readonly id: string;
  readonly dependsOn: readonly string[];
  readonly fireAtMs: WorkflowBinding;
  readonly when?: WorkflowBinding;
}

/**
 * Waits for one named signal delivered from outside the run. `name` is what a sender addresses (unique among the
 * definition's signal nodes); `deadlineAtMs`, when set, times the step out if no signal arrived by then. The payload
 * validator is code, like a tool's validators, and is not part of this material.
 */
export interface WorkflowLifecycleSignalNodeManifest {
  readonly kind: 'signal';
  readonly id: string;
  readonly dependsOn: readonly string[];
  readonly name: string;
  readonly deadlineAtMs: WorkflowBinding | null;
  readonly when?: WorkflowBinding;
}

/**
 * Any lifecycle node may carry `when`: a binding over the input or a dependency's output. The node runs only when it
 * resolves to a value other than `null` or `false`; otherwise it is `bypassed` without being admitted or charged.
 * The key is present only when declared, so definitions without it keep their digest.
 */
export type WorkflowLifecycleManifestNode = (WorkflowManifestNode & { readonly when?: WorkflowBinding })
  | WorkflowLifecycleHumanNodeManifest
  | WorkflowLifecycleTimerNodeManifest
  | WorkflowLifecycleSignalNodeManifest;

/** Immutable data-only definition material for explicit lifecycle suspension nodes. */
export interface WorkflowLifecycleManifest {
  readonly format: 5;
  readonly id: string;
  readonly version: string;
  readonly graph: readonly WorkflowLifecycleManifestNode[];
  readonly result: WorkflowBinding;
}

export type WorkflowLifecycleStatus = 'running' | 'waiting' | 'paused' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'outcome_unknown';
export type WorkflowLifecycleHumanStepStatus = 'pending' | 'waiting' | 'succeeded' | 'timed_out' | 'skipped' | 'bypassed';
export type WorkflowLifecycleTimerStepStatus = 'pending' | 'waiting' | 'succeeded' | 'skipped' | 'bypassed';
export type WorkflowLifecycleSignalStepStatus = 'pending' | 'waiting' | 'succeeded' | 'timed_out' | 'skipped' | 'bypassed';
/** `bypassed`: the step's `when` condition did not hold, so it never started. Dependents treat it like success with output `null`. */
export type WorkflowLifecycleToolStepStatus = WorkflowFormat2StepStatus | 'bypassed';
export type WorkflowLifecycleToolStep = Omit<WorkflowFormat2Step, 'status'> & { status: WorkflowLifecycleToolStepStatus };

export interface WorkflowLifecycleHumanStep {
  readonly kind: 'human';
  status: WorkflowLifecycleHumanStepStatus;
  readonly callId: string;
  output: JsonValue;
  requestDigest: string | null;
  responseDigest: string | null;
  actorId: string | null;
  deadlineAtMs: number | null;
}

export interface WorkflowLifecycleTimerStep {
  readonly kind: 'timer';
  status: WorkflowLifecycleTimerStepStatus;
  readonly callId: string;
  output: JsonValue;
  fireAtMs: number | null;
  firedAtMs: number | null;
}

/**
 * A signal step. A signal delivered before the step starts is kept on the `pending` step (`signalId` set) and
 * completes it as soon as it starts, provided it arrived before the deadline. `output` is the validated payload.
 */
export interface WorkflowLifecycleSignalStep {
  readonly kind: 'signal';
  status: WorkflowLifecycleSignalStepStatus;
  readonly callId: string;
  output: JsonValue;
  signalId: string | null;
  payloadDigest: string | null;
  receivedAtMs: number | null;
  deadlineAtMs: number | null;
}

export type WorkflowLifecycleStep = WorkflowLifecycleToolStep | WorkflowLifecycleHumanStep | WorkflowLifecycleTimerStep | WorkflowLifecycleSignalStep;

export interface WorkflowLifecycleState {
  readonly format: 5;
  readonly definition: string;
  readonly policy: string;
  readonly input: JsonValue;
  status: WorkflowLifecycleStatus;
  readonly steps: Record<string, WorkflowLifecycleStep>;
  readonly maxCostMicros: number;
  spentMicros: number;
  reservedMicros: number;
  output: JsonValue;
}

const forbidden = new Set(['constructor', 'prototype', '__proto__']);
const idPattern = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const schemaIdPattern = /^[A-Za-z][A-Za-z0-9._/-]{0,127}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const humanKinds = new Set<WorkflowLifecycleHumanKind>(['information', 'correction', 'plan_selection']);
const lifecycleStatuses = new Set<WorkflowLifecycleStatus>(['running', 'waiting', 'paused', 'succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown']);
const humanStepStatuses = new Set<WorkflowLifecycleHumanStepStatus>(['pending', 'waiting', 'succeeded', 'timed_out', 'skipped', 'bypassed']);
const timerStepStatuses = new Set<WorkflowLifecycleTimerStepStatus>(['pending', 'waiting', 'succeeded', 'skipped', 'bypassed']);
const signalStepStatuses = new Set<WorkflowLifecycleSignalStepStatus>(['pending', 'waiting', 'succeeded', 'timed_out', 'skipped', 'bypassed']);
/** Signal names and ids: what the operator API accepts for `signalName` and `signalId`. */
const signalPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
/** Statuses a dependent step may build on. */
const satisfied = new Set(['succeeded', 'bypassed']);

function invalid(): never {
  throw new StorageError('INVALID_INPUT', 'Invalid bounded workflow lifecycle metadata.');
}

function corrupt(): never {
  throw new StorageError('CONFLICT', 'Stored workflow lifecycle state failed integrity validation.');
}

function object(value: JsonValue | undefined): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value;
}

function fields(value: JsonObject, names: readonly string[]): void {
  if (Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) invalid();
}

function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) invalid();
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !hashPattern.test(value)) invalid();
  return value;
}

function identity(value: unknown, maximum = 256): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || value.includes('\0')) invalid();
  return value;
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
}

function binding(value: JsonValue | undefined, ids: ReadonlySet<string>, dependencies: readonly string[]): WorkflowBinding {
  const candidate = object(value);
  if (candidate['kind'] === 'literal') fields(candidate, ['kind', 'value']);
  else if (candidate['kind'] === 'input' || candidate['kind'] === 'step') {
    fields(candidate, candidate['kind'] === 'input' ? ['kind', 'path'] : ['kind', 'stepId', 'path']);
    if (!Array.isArray(candidate['path']) || candidate['path'].length > 32
      || candidate['path'].some(segment => typeof segment !== 'string' || forbidden.has(segment))) invalid();
    if (candidate['kind'] === 'step') {
      if (typeof candidate['stepId'] !== 'string' || !ids.has(candidate['stepId'])
        || !dependencies.includes(candidate['stepId'])) invalid();
    }
  } else invalid();
  return candidate as unknown as WorkflowBinding;
}

function temporalBinding(value: JsonValue | undefined, ids: ReadonlySet<string>, dependencies: readonly string[]): WorkflowBinding {
  const candidate = binding(value, ids, dependencies);
  if (candidate.kind === 'literal' && (typeof candidate.value !== 'number'
    || !Number.isSafeInteger(candidate.value) || candidate.value < 0)) invalid();
  return candidate;
}

function digestBinding(value: JsonValue | undefined, ids: ReadonlySet<string>, dependencies: readonly string[]): WorkflowBinding {
  const candidate = binding(value, ids, dependencies);
  if (candidate.kind === 'literal' && (typeof candidate.value !== 'string' || !hashPattern.test(candidate.value))) invalid();
  return candidate;
}

/**
 * Strict format-5 decoder. It deliberately reuses the immutable format-2 graph
 * projection for common tool/join validation while retaining lifecycle nodes.
 */
export function workflowLifecycleManifest(value: unknown): WorkflowLifecycleManifest {
  try {
    const manifest = object(jsonValue(value));
    fields(manifest, ['format', 'id', 'version', 'graph', 'result']);
    if (manifest['format'] !== 5 || !Array.isArray(manifest['graph'])) invalid();
    const graph = manifest['graph'];
    if (graph.length < 1 || graph.length > 128) invalid();

    const projected = graph.map(raw => {
      const node = object(raw);
      if (node['kind'] === 'tool' || node['kind'] === 'join') {
        if (!Object.hasOwn(node, 'when')) return node;
        const { when: _when, ...rest } = node; return rest;
      }
      if (node['kind'] !== 'human' && node['kind'] !== 'timer' && node['kind'] !== 'signal') invalid();
      return { kind: 'join', id: node['id'], dependsOn: node['dependsOn'] };
    });
    const common = workflowManifest({ id: manifest['id'], version: manifest['version'], graph: projected, result: manifest['result'] });
    const ids = new Set(common.graph.map(node => node.id));
    let humans = 0; let timers = 0; const signals = new Set<string>();

    for (const raw of graph) {
      const node = object(raw);
      const id = typeof node['id'] === 'string' && idPattern.test(node['id']) ? node['id'] : invalid();
      const projectedNode = common.graph.find(item => item.id === id)!;
      const dependencies = projectedNode.dependsOn;
      const conditional = Object.hasOwn(node, 'when');
      if (conditional) binding(node['when'], ids, dependencies);
      if (node['kind'] === 'tool' || node['kind'] === 'join') continue;
      const optional = conditional ? ['when'] : [];
      if (node['kind'] === 'timer') {
        timers += 1;
        fields(node, ['kind', 'id', 'dependsOn', 'fireAtMs', ...optional]);
        temporalBinding(node['fireAtMs'], ids, dependencies);
        continue;
      }
      if (node['kind'] === 'signal') {
        fields(node, ['kind', 'id', 'dependsOn', 'name', 'deadlineAtMs', ...optional]);
        if (typeof node['name'] !== 'string' || !signalPattern.test(node['name']) || signals.has(node['name'])) invalid();
        signals.add(node['name']);
        if (node['deadlineAtMs'] !== null) temporalBinding(node['deadlineAtMs'], ids, dependencies);
        continue;
      }
      humans += 1;
      fields(node, ['kind', 'id', 'dependsOn', 'requestKind', 'schemaId', 'schemaDigest', 'prompt', 'context', 'subjectDigest', 'deadlineAtMs', ...optional]);
      if (!humanKinds.has(node['requestKind'] as WorkflowLifecycleHumanKind)
        || typeof node['schemaId'] !== 'string' || !schemaIdPattern.test(node['schemaId'])
        || typeof node['schemaDigest'] !== 'string' || !hashPattern.test(node['schemaDigest'])
        || typeof node['prompt'] !== 'string' || node['prompt'].length < 1
        || new TextEncoder().encode(node['prompt']).byteLength > 1_024) invalid();
      if ((node['requestKind'] === 'correction') !== (node['subjectDigest'] !== null)) invalid();
      if (node['context'] !== null) binding(node['context'], ids, dependencies);
      if (node['subjectDigest'] !== null) digestBinding(node['subjectDigest'], ids, dependencies);
      if (node['deadlineAtMs'] !== null) temporalBinding(node['deadlineAtMs'], ids, dependencies);
    }
    if (humans > 32 || timers > 64 || signals.size > 64) invalid();
    return freezeJson(manifest) as unknown as WorkflowLifecycleManifest;
  } catch {
    return invalid();
  }
}

/** Construct a detached initial state without activating any suspension or effect. */
export function initialWorkflowLifecycleState(
  definition: WorkflowLifecycleManifest,
  input: JsonValue,
  definitionHash: string,
  policyHash: string,
  maxCostMicros: number,
): WorkflowLifecycleState {
  try {
    const manifest = workflowLifecycleManifest(definition);
    hash(definitionHash); hash(policyHash); integer(maxCostMicros);
    return jsonValue({
      format: 5, definition: definitionHash, policy: policyHash, input, status: 'running',
      steps: Object.fromEntries(manifest.graph.map(node => [node.id,
        node.kind === 'human'
          ? { kind: 'human', status: 'pending', callId: `step:${node.id}`, output: null,
              requestDigest: null, responseDigest: null, actorId: null, deadlineAtMs: null }
          : node.kind === 'timer'
            ? { kind: 'timer', status: 'pending', callId: `step:${node.id}`, output: null,
                fireAtMs: null, firedAtMs: null }
            : node.kind === 'signal'
              ? { kind: 'signal', status: 'pending', callId: `step:${node.id}`, output: null,
                  signalId: null, payloadDigest: null, receivedAtMs: null, deadlineAtMs: null }
            : { kind: node.kind, status: 'pending', callId: `step:${node.id}`, output: null,
                receipt: null, approval: null, costReserved: 0, candidateHash: null },
      ])),
      maxCostMicros, spentMicros: 0, reservedMicros: 0, output: null,
    }) as unknown as WorkflowLifecycleState;
  } catch { return invalid(); }
}

/** Strictly decode a mutable format-5 state copy suitable for a checked transition. */
export function workflowLifecycleState(record: Pick<StoredRecord, 'id' | 'state'>): WorkflowLifecycleState {
  try {
    const idDescriptor = Object.getOwnPropertyDescriptor(record, 'id');
    const stateDescriptor = Object.getOwnPropertyDescriptor(record, 'state');
    if (!idDescriptor || !('value' in idDescriptor) || !stateDescriptor || !('value' in stateDescriptor)) invalid();
    const runId = identity(idDescriptor.value, 512);
    const state = object(jsonValue(stateDescriptor.value));
    fields(state, ['format', 'definition', 'policy', 'input', 'status', 'steps', 'maxCostMicros', 'spentMicros', 'reservedMicros', 'output']);
    if (state['format'] !== 5 || !lifecycleStatuses.has(state['status'] as WorkflowLifecycleStatus)) invalid();
    const definitionHash = hash(state['definition']); const policyHash = hash(state['policy']);
    const input = jsonValue(state['input']);
    const maxCostMicros = integer(state['maxCostMicros']); const spentMicros = integer(state['spentMicros']); const reservedMicros = integer(state['reservedMicros']);
    if (spentMicros > maxCostMicros - reservedMicros) invalid();
    const steps = object(state['steps']); const entries = Object.entries(steps);
    if (entries.length < 1 || entries.length > 128) invalid();
    const common: Record<string, JsonValue> = {}; let computedReserved = 0; let waiting = 0;
    for (const [id, raw] of entries) {
      if (!idPattern.test(id) || forbidden.has(id)) invalid();
      const step = object(raw);
      if (step['callId'] !== `step:${id}`) invalid();
      if (step['kind'] === 'tool' || step['kind'] === 'join') {
        if (step['status'] === 'bypassed') {
          if (step['output'] !== null || step['receipt'] !== null || step['approval'] !== null || step['costReserved'] !== 0 || step['candidateHash'] !== null) invalid();
          common[id] = { ...step, status: 'skipped' }; continue;
        }
        common[id] = step; computedReserved += integer(step['costReserved']);
        if (step['status'] === 'waiting') waiting += 1;
        continue;
      }
      if (step['kind'] === 'human') {
        fields(step, ['kind', 'status', 'callId', 'output', 'requestDigest', 'responseDigest', 'actorId', 'deadlineAtMs']);
        if (!humanStepStatuses.has(step['status'] as WorkflowLifecycleHumanStepStatus)) invalid();
        if (step['requestDigest'] !== null) hash(step['requestDigest']);
        if (step['responseDigest'] !== null) hash(step['responseDigest']);
        if (step['actorId'] !== null) identity(step['actorId']);
        if (step['deadlineAtMs'] !== null) integer(step['deadlineAtMs']);
        if (step['status'] === 'pending' && [step['requestDigest'], step['responseDigest'], step['actorId'], step['deadlineAtMs'], step['output']].some(value => value !== null)) invalid();
        if (step['status'] === 'waiting' && (step['requestDigest'] === null || step['responseDigest'] !== null || step['actorId'] !== null || step['output'] !== null)) invalid();
        if (step['status'] === 'succeeded' && (step['requestDigest'] === null || step['responseDigest'] === null || step['actorId'] === null)) invalid();
        if (step['status'] === 'timed_out' && (step['requestDigest'] === null || step['deadlineAtMs'] === null || step['responseDigest'] !== null || step['actorId'] !== null || step['output'] !== null)) invalid();
        if ((step['status'] === 'skipped' || step['status'] === 'bypassed') && (step['requestDigest'] !== null || step['responseDigest'] !== null || step['actorId'] !== null || step['deadlineAtMs'] !== null || step['output'] !== null)) invalid();
        if (step['status'] === 'waiting') waiting += 1;
        continue;
      }
      if (step['kind'] === 'timer') {
        fields(step, ['kind', 'status', 'callId', 'output', 'fireAtMs', 'firedAtMs']);
        if (!timerStepStatuses.has(step['status'] as WorkflowLifecycleTimerStepStatus)) invalid();
        if (step['fireAtMs'] !== null) integer(step['fireAtMs']);
        if (step['firedAtMs'] !== null) integer(step['firedAtMs']);
        if (step['status'] === 'pending' || step['status'] === 'skipped' || step['status'] === 'bypassed') {
          if (step['fireAtMs'] !== null || step['firedAtMs'] !== null || step['output'] !== null) invalid();
        } else if (step['status'] === 'waiting') {
          if (step['fireAtMs'] === null || step['firedAtMs'] !== null || step['output'] !== null) invalid();
          waiting += 1;
        } else {
          if (step['fireAtMs'] === null || step['firedAtMs'] === null || Number(step['firedAtMs']) < Number(step['fireAtMs'])
            || canonical(step['output']!) !== canonical(jsonValue({ fireAtMs: step['fireAtMs'], firedAtMs: step['firedAtMs'] }))) invalid();
        }
        continue;
      }
      if (step['kind'] === 'signal') {
        fields(step, ['kind', 'status', 'callId', 'output', 'signalId', 'payloadDigest', 'receivedAtMs', 'deadlineAtMs']);
        if (!signalStepStatuses.has(step['status'] as WorkflowLifecycleSignalStepStatus)) invalid();
        if (step['signalId'] !== null && (typeof step['signalId'] !== 'string' || !signalPattern.test(step['signalId']))) invalid();
        if (step['payloadDigest'] !== null) hash(step['payloadDigest']);
        if (step['receivedAtMs'] !== null) integer(step['receivedAtMs']);
        if (step['deadlineAtMs'] !== null) integer(step['deadlineAtMs']);
        // A signal is recorded completely or not at all.
        const received = step['signalId'] !== null;
        if ([step['payloadDigest'], step['receivedAtMs']].some(value => (value !== null) !== received) || (!received && step['output'] !== null)) invalid();
        if (step['status'] === 'pending' && step['deadlineAtMs'] !== null) invalid();
        if (step['status'] === 'succeeded' && !received) invalid();
        if (step['status'] === 'waiting' && received) invalid();
        if (step['status'] === 'timed_out' && (received || step['deadlineAtMs'] === null)) invalid();
        if ((step['status'] === 'skipped' || step['status'] === 'bypassed') && (received || step['deadlineAtMs'] !== null)) invalid();
        if (step['status'] === 'waiting') waiting += 1;
        continue;
      }
      invalid();
    }
    if (computedReserved !== reservedMicros) invalid();
    if (Object.keys(common).length > 0) workflowState({ id: runId, state: {
      format: 2, definition: definitionHash, policy: policyHash, input, status: 'running',
      steps: common, maxCostMicros, spentMicros, reservedMicros, output: null,
    } });
    if (state['status'] === 'waiting' && waiting === 0) invalid();
    if (!['running', 'waiting', 'paused'].includes(state['status'] as string) && waiting > 0) invalid();
    if (state['status'] === 'succeeded' && entries.some(([, raw]) => !satisfied.has(object(raw)['status'] as string))) invalid();
    if (state['status'] !== 'succeeded' && state['output'] !== null) invalid();
    return state as unknown as WorkflowLifecycleState;
  } catch { return corrupt(); }
}

/** Cross-check state node identities, kinds and successful dependency evidence. */
export function assertWorkflowLifecycleStateMatchesManifest(
  state: WorkflowLifecycleState,
  definition: WorkflowLifecycleManifest,
): void {
  try {
    const manifest = workflowLifecycleManifest(definition);
    const value = object(jsonValue(state)); const steps = object(value['steps']);
    if (Object.keys(steps).length !== manifest.graph.length) invalid();
    for (const node of manifest.graph) {
      const step = object(steps[node.id]);
      if (step['kind'] !== node.kind) invalid();
      // A step is bypassed only when it declares a condition, and only after its dependencies were satisfied.
      if (step['status'] === 'bypassed' && !Object.hasOwn(node, 'when')) invalid();
      if (satisfied.has(step['status'] as string) && node.dependsOn.some(id => !satisfied.has(object(steps[id])['status'] as string))) invalid();
      if (node.kind === 'tool') {
        if (step['receipt'] !== null && object(step['receipt'])['toolId'] !== node.tool) invalid();
        if (integer(step['costReserved']) > node.costMicros) invalid();
      }
      if ((node.kind === 'human' || node.kind === 'signal') && step['deadlineAtMs'] !== null && node.deadlineAtMs === null) invalid();
    }
  } catch { return corrupt(); }
}

/** Return detached outputs only for successfully completed nodes; a bypassed node's output is `null`. */
export function workflowLifecycleOutputs(state: WorkflowLifecycleState): Record<string, JsonValue> {
  try {
    const steps = object(object(jsonValue(state))['steps']);
    return Object.fromEntries(Object.entries(steps).filter(([, raw]) => satisfied.has(object(raw)['status'] as string))
      .map(([id, raw]) => {
        const step = object(raw);
        if (step['status'] === 'bypassed') return [id, null];
        if (step['kind'] === 'tool') {
          const evidence = object(step['receipt']);
          if (evidence['execution'] !== 'succeeded' || evidence['disclosure'] !== 'released'
            || step['candidateHash'] === null || integer(step['costReserved']) !== 0) invalid();
        } else if (step['kind'] === 'human') {
          hash(step['requestDigest']); hash(step['responseDigest']); identity(step['actorId']);
        } else if (step['kind'] === 'timer') {
          const fireAtMs = integer(step['fireAtMs']); const firedAtMs = integer(step['firedAtMs']);
          if (firedAtMs < fireAtMs || canonical(step['output']!) !== canonical(jsonValue({ fireAtMs, firedAtMs }))) invalid();
        } else if (step['kind'] === 'signal') {
          if (typeof step['signalId'] !== 'string') invalid(); hash(step['payloadDigest']); integer(step['receivedAtMs']);
        } else if (step['kind'] !== 'join') invalid();
        return [id, step['output']!];
      }));
  } catch { return corrupt(); }
}
