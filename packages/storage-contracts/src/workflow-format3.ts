import { freezeJson, jsonValue, type ExecutionReceipt, type JsonObject, type JsonValue } from '@mayura/core';
import { StorageError, type StoredRecord } from './contracts.js';
import { executionCompletion, executionRef, type ExecutionCompletion, type ExecutionRef } from './execution-wait-contracts.js';
import { mergeWorkflowReceipt, resolveWorkflowBinding, workflowHashMaterial, workflowManifest, workflowResources } from './workflow-format2.js';
import type { WorkflowBinding, WorkflowManifest, WorkflowResourcePlan } from './scheduled-workflow-contracts.js';
import type { WorkflowGraphFormat3State, WorkflowGraphManifest } from './workflow-graph-contracts.js';

const forbidden = new Set(['constructor', 'prototype', '__proto__']);
const idPattern = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const statuses = new Set(['running', 'waiting', 'paused', 'succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown']);
const stepStatuses = new Set(['pending', 'waiting', 'approved', 'dispatching', 'succeeded', 'failed', 'blocked', 'unknown', 'skipped']);
const waitStatuses = new Set(['pending', 'waiting', 'succeeded', 'failed', 'skipped']);
// Only this decoder's successfully validated, detached and recursively frozen results qualify.
// Weak ownership does not retain manifests or cache mutable adapter state between database loads.
const ownedManifests = new WeakSet<object>();
function invalid(): never { throw new StorageError('INVALID_INPUT', 'Invalid bounded workflow graph metadata.'); }
function corrupt(): never { throw new StorageError('CONFLICT', 'Stored workflow graph failed integrity validation.'); }
function object(value: JsonValue | undefined): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(); return value;
}
function fields(value: JsonObject, names: readonly string[]): void {
  if (Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) invalid();
}
function hash(value: unknown): string { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid(); return value; }
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) invalid(); return value;
}
function id(value: unknown): string { if (typeof value !== 'string' || !idPattern.test(value) || forbidden.has(value)) invalid(); return value; }
function same(a: unknown, b: unknown): boolean { return workflowHashMaterial('compare', a) === workflowHashMaterial('compare', b); }
function targets(value: unknown): readonly ExecutionRef[] {
  const copy = jsonValue(value, { maxBytes: 65_536 });
  if (!Array.isArray(copy) || copy.length < 1 || copy.length > 32) invalid();
  const values = copy.map(executionRef);
  if (new Set(values.map(item => item.runId)).size !== values.length || values.some(item => item.policyHash !== values[0]!.policyHash)) invalid();
  return Object.freeze(values);
}
function binding(raw: JsonValue | undefined, ids: ReadonlySet<string>, wait = false): WorkflowBinding {
  const value = object(raw);
  if (value['kind'] === 'literal') { fields(value, ['kind', 'value']); if (wait) targets(value['value']); }
  else if (value['kind'] === 'input' || (!wait && value['kind'] === 'step')) {
    fields(value, value['kind'] === 'input' ? ['kind', 'path'] : ['kind', 'stepId', 'path']);
    if (!Array.isArray(value['path']) || value['path'].length > 32 || value['path'].some(key => typeof key !== 'string' || forbidden.has(key))) invalid();
    if (value['kind'] === 'step' && !ids.has(id(value['stepId']))) invalid();
  } else invalid();
  return value as unknown as WorkflowBinding;
}
/** Common tool/join graph validation is reused only for those nodes; waits keep their own exact codec. */
function commonManifest(definition: WorkflowGraphManifest): WorkflowManifest {
  return { id: definition.id, version: definition.version, graph: definition.graph.map(node => node.kind === 'wait'
    ? { kind: 'join', id: node.id, dependsOn: node.dependsOn } : node), result: definition.result };
}

/** Decode an exact format-3 manifest without changing the legacy manifest validator or hash domain. */
export function workflowGraphManifest(value: unknown): WorkflowGraphManifest {
  try {
    if (value !== null && typeof value === 'object' && ownedManifests.has(value)) return value as WorkflowGraphManifest;
    const copy = object(jsonValue(value)); fields(copy, ['format', 'id', 'version', 'graph', 'result']);
    if (copy['format'] !== 3 || !Array.isArray(copy['graph']) || copy['graph'].length < 1 || copy['graph'].length > 128) invalid();
    const graph = copy['graph'].map(object); const ids = new Set(graph.map(node => id(node['id'])));
    if (ids.size !== graph.length) invalid();
    for (const node of graph) if (node['kind'] === 'wait') {
      fields(node, ['kind', 'id', 'dependsOn', 'targets']); binding(node['targets'], ids, true);
    } else if (node['kind'] !== 'tool' && node['kind'] !== 'join') invalid();
    const manifest = copy as unknown as WorkflowGraphManifest;
    // The projection validates shared DAG/binding/tool rules only; it is never hashed, stored or executed.
    workflowManifest(commonManifest(manifest));
    const owned = freezeJson(copy) as unknown as WorkflowGraphManifest;
    ownedManifests.add(owned); return owned;
  } catch { return invalid(); }
}

/** Resolve every wait before parent creation. Bounds count edges, including reuse across separate waits. */
export function workflowGraphTargets(definition: WorkflowGraphManifest, input: unknown): Readonly<Record<string, readonly ExecutionRef[]>> {
  try {
    const manifest = workflowGraphManifest(definition); const admitted = jsonValue(input);
    const result: Record<string, readonly ExecutionRef[]> = {}; let count = 0; let policy: string | undefined;
    for (const node of manifest.graph) if (node.kind === 'wait') {
      const values = targets(node.targets.kind === 'literal' ? node.targets.value : resolveWorkflowBinding(node.targets, admitted, {})); count += values.length;
      policy ??= values[0]!.policyHash;
      if (count > 128 || values.some(item => item.policyHash !== policy)) invalid();
      result[node.id] = values;
    }
    return Object.freeze(result);
  } catch { return invalid(); }
}

/** Resource names still apply exclusively to real tool nodes, never waits or joins. */
export function workflowGraphResources(value: unknown, definition: WorkflowGraphManifest): WorkflowResourcePlan {
  try { return workflowResources(value, commonManifest(workflowGraphManifest(definition))); } catch { return invalid(); }
}

function observations(value: JsonValue | undefined, runId?: string): readonly ExecutionCompletion[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) invalid();
  const items = value.map(executionCompletion);
  if (new Set(items.map(item => item.reference.runId)).size !== items.length || items.some(item => item.reference.runId === runId)) invalid();
  return items;
}

/** Fresh mutable state copy; wait effect fields and metadata observations have explicit independent rules. */
export function workflowGraphState(record: Pick<StoredRecord, 'id' | 'state'>): WorkflowGraphFormat3State {
  try {
    const idDescriptor = Object.getOwnPropertyDescriptor(record, 'id'); const stateDescriptor = Object.getOwnPropertyDescriptor(record, 'state');
    if (!idDescriptor || !('value' in idDescriptor) || !stateDescriptor || !('value' in stateDescriptor)) corrupt();
    const runId = hash(idDescriptor.value); const state = object(jsonValue(stateDescriptor.value));
    fields(state, ['format', 'definition', 'policy', 'input', 'status', 'steps', 'maxCostMicros', 'spentMicros', 'reservedMicros', 'output']);
    if (state['format'] !== 3 || !statuses.has(state['status'] as string)) corrupt();
    hash(state['definition']); const policy = hash(state['policy']);
    const maximum = integer(state['maxCostMicros']); const spent = integer(state['spentMicros']); const reservedTotal = integer(state['reservedMicros']);
    const entries = Object.entries(object(state['steps'])); if (entries.length < 1 || entries.length > 128) corrupt();
    let reserved = 0;
    for (const [nodeId, raw] of entries) {
      id(nodeId); const step = object(raw);
      fields(step, ['kind', 'status', 'callId', 'output', 'receipt', 'approval', 'costReserved', 'candidateHash']);
      if (!['tool', 'join', 'wait'].includes(step['kind'] as string) || !stepStatuses.has(step['status'] as string) || step['callId'] !== `step:${nodeId}`) corrupt();
      const amount = integer(step['costReserved']); reserved = integer(reserved + amount);
      if (step['candidateHash'] !== null) hash(step['candidateHash']);
      if (step['approval'] !== null) {
        const approval = object(step['approval']); fields(approval, ['digest', 'expiresAt', 'humanId']); hash(approval['digest']); integer(approval['expiresAt'], 1);
        if (approval['humanId'] !== null && (typeof approval['humanId'] !== 'string' || approval['humanId'].length < 1 || approval['humanId'].length > 256)) corrupt();
      }
      if (step['status'] === 'approved' && (step['approval'] === null || !object(step['approval'])['humanId'])) corrupt();
      if (step['receipt'] !== null) {
        const receipt = mergeWorkflowReceipt(null, step['receipt'] as unknown as ExecutionReceipt); if (receipt.callId !== `${runId}/step:${nodeId}`) corrupt();
      }
      if (step['status'] !== 'succeeded' && step['output'] !== null) corrupt();
      if (step['kind'] !== 'tool' && (step['receipt'] !== null || step['approval'] !== null || step['candidateHash'] !== null || amount !== 0)) corrupt();
      if (step['kind'] === 'wait') {
        if (!waitStatuses.has(step['status'] as string)) corrupt();
        if (['cancelled', 'failed', 'blocked', 'outcome_unknown'].includes(state['status'] as string)
          && ['pending', 'waiting'].includes(step['status'] as string)) corrupt();
      }
      if (step['status'] === 'succeeded') {
        if (amount !== 0) corrupt();
        if (step['kind'] === 'tool' && (step['receipt'] === null || object(step['receipt'])['execution'] !== 'succeeded'
          || object(step['receipt'])['disclosure'] !== 'released' || step['candidateHash'] === null)) corrupt();
        if (step['kind'] === 'wait' && observations(step['output'], runId).some(item => item.reference.policyHash !== policy)) corrupt();
      }
    }
    if (reserved !== reservedTotal || spent > maximum - reservedTotal) corrupt();
    if (state['status'] === 'succeeded' && entries.some(([, raw]) => object(raw)['status'] !== 'succeeded')) corrupt();
    if (state['status'] !== 'succeeded' && state['output'] !== null) corrupt();
    return state as unknown as WorkflowGraphFormat3State;
  } catch { return corrupt(); }
}

/** Definition/target checks supplement structural decoding; SQL separately proves immutable completion facts. */
export function assertWorkflowGraphStateMatchesManifest(state: WorkflowGraphFormat3State, definition: WorkflowGraphManifest): void {
  try {
    const manifest = workflowGraphManifest(definition); const value = object(jsonValue(state));
    if (value['format'] !== 3) corrupt();
    const steps = object(value['steps']); const pinned = workflowGraphTargets(manifest, value['input']);
    if (Object.keys(steps).length !== manifest.graph.length || Object.values(pinned).flat().some(item => item.policyHash !== value['policy'])) corrupt();
    for (const node of manifest.graph) {
      const step = object(steps[node.id]); if (step['kind'] !== node.kind) corrupt();
      const activated = step['status'] === 'succeeded' || (node.kind === 'wait' && ['waiting', 'failed'].includes(step['status'] as string));
      if (activated && node.dependsOn.some(dependency => object(steps[dependency])['status'] !== 'succeeded')) corrupt();
      if (node.kind === 'tool') {
        if (step['receipt'] !== null && object(step['receipt'])['toolId'] !== node.tool) corrupt();
        const amount = integer(step['costReserved']);
        if ((step['approval'] !== null && !node.approval) || amount > node.costMicros
          || (amount !== 0 && amount !== node.costMicros && step['status'] !== 'unknown')) corrupt();
        if (node.approval && step['candidateHash'] !== null && (step['approval'] === null || object(step['approval'])['digest'] !== step['candidateHash'])) corrupt();
      } else if (node.kind === 'wait' && step['status'] === 'succeeded') {
        const output = observations(step['output']);
        if (output.length !== pinned[node.id]!.length || output.some((item, index) => !same(item.reference, pinned[node.id]![index]))) corrupt();
      } else if (node.kind === 'join' && step['status'] === 'succeeded'
        && !same(step['output'], node.dependsOn.map(dependency => object(steps[dependency])['output']))) corrupt();
    }
  } catch { return corrupt(); }
}

/** Create only the new representation; resolved targets still require trusted storage admission. */
export function initialWorkflowGraphState(definition: WorkflowGraphManifest, input: JsonValue, definitionHash: string, policyHash: string, maxCostMicros: number): WorkflowGraphFormat3State {
  try {
    const manifest = workflowGraphManifest(definition); hash(definitionHash); hash(policyHash); integer(maxCostMicros);
    const admitted = jsonValue(input); const pinned = workflowGraphTargets(manifest, admitted);
    if (Object.values(pinned).flat().some(item => item.policyHash !== policyHash)) invalid();
    return jsonValue({ format: 3, definition: definitionHash, policy: policyHash, input: admitted, status: 'running',
      maxCostMicros, spentMicros: 0, reservedMicros: 0, output: null,
      steps: Object.fromEntries(manifest.graph.map(node => [node.id, { kind: node.kind, status: 'pending', callId: `step:${node.id}`,
        output: null, receipt: null, approval: null, costReserved: 0, candidateHash: null }])) }) as unknown as WorkflowGraphFormat3State;
  } catch { return invalid(); }
}

/** Project only released successful effects or validated control-node output, never pending metadata. */
export function workflowGraphOutputs(state: WorkflowGraphFormat3State): Record<string, JsonValue> {
  try {
    const value = object(jsonValue(state)); if (value['format'] !== 3) corrupt();
    const result: Record<string, JsonValue> = {};
    for (const [nodeId, raw] of Object.entries(object(value['steps']))) {
      id(nodeId); const step = object(raw); if (step['status'] !== 'succeeded') continue;
      if (step['kind'] === 'tool') {
        const receipt = mergeWorkflowReceipt(null, step['receipt'] as unknown as ExecutionReceipt); if (receipt.execution !== 'succeeded' || receipt.disclosure !== 'released') corrupt();
      } else if (step['kind'] === 'wait') {
        if (observations(step['output']).some(item => item.reference.policyHash !== value['policy'])) corrupt();
      } else if (step['kind'] !== 'join') corrupt();
      result[nodeId] = jsonValue(step['output']);
    }
    return result;
  } catch { return corrupt(); }
}
