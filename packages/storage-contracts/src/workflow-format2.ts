import { freezeJson, jsonValue, type ExecutionReceipt, type JsonObject, type JsonValue } from '@mayura/core';
import { StorageError, type StoredRecord } from './contracts.js';
import type { WorkflowBinding, WorkflowManifest, WorkflowPolicyManifest, WorkflowResourcePlan } from './scheduled-workflow-contracts.js';

export type WorkflowFormat2StepStatus = 'pending' | 'waiting' | 'approved' | 'dispatching' | 'succeeded' | 'failed' | 'blocked' | 'unknown' | 'skipped';
export type WorkflowFormat2Status = 'running' | 'waiting' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'outcome_unknown';
export interface WorkflowFormat2Approval { digest: string; expiresAt: number; humanId: string | null }
export interface WorkflowFormat2Step {
  kind: 'tool' | 'join'; status: WorkflowFormat2StepStatus; callId: string; output: JsonValue;
  receipt: ExecutionReceipt | null; approval: WorkflowFormat2Approval | null; costReserved: number; candidateHash: string | null;
}
/** Exact legacy durable representation. Scheduler ownership must live outside this format. */
export interface WorkflowFormat2State {
  format: 2; definition: string; policy: string; input: JsonValue; status: WorkflowFormat2Status;
  steps: Record<string, WorkflowFormat2Step>; maxCostMicros: number; spentMicros: number; reservedMicros: number; output: JsonValue;
}

const nodeId = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const toolId = /^[A-Za-z][A-Za-z0-9._/-]{0,127}$/;
const forbidden = new Set(['constructor', 'prototype', '__proto__']);
const statuses = new Set(['running', 'waiting', 'succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown']);
const stepStatuses = new Set(['pending', 'waiting', 'approved', 'dispatching', 'succeeded', 'failed', 'blocked', 'unknown', 'skipped']);
const encoder = new TextEncoder();
const stateKeys = ['format', 'definition', 'policy', 'input', 'status', 'steps', 'maxCostMicros', 'spentMicros', 'reservedMicros', 'output'];
const stepKeys = ['kind', 'status', 'callId', 'output', 'receipt', 'approval', 'costReserved', 'candidateHash'];

function invalid(): never { throw new StorageError('INVALID_INPUT', 'Invalid bounded workflow metadata.'); }
function corrupt(): never { throw new StorageError('CONFLICT', 'Stored workflow state failed integrity validation.'); }
function object(value: JsonValue | undefined): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value;
}
function fields(value: JsonObject, expected: readonly string[]): void {
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) invalid();
}
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) return invalid();
  return value;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) return invalid();
  return value;
}
function identity(value: unknown, maximum = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || encoder.encode(value).length > maximum || value.includes('\0')) return invalid();
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return invalid();
  return value;
}
function stepIdentity(value: unknown): string {
  if (typeof value !== 'string' || !nodeId.test(value) || forbidden.has(value)) return invalid();
  return value;
}
function toolIdentity(value: unknown): string {
  if (typeof value !== 'string' || !toolId.test(value)) return invalid();
  return value;
}
function list(value: JsonValue | undefined, maximum: number): JsonValue[] {
  if (!Array.isArray(value) || value.length > maximum) return invalid();
  return value;
}
function binding(value: JsonValue | undefined, ids?: ReadonlySet<string>): WorkflowBinding {
  const item = object(value);
  if (item['kind'] === 'literal') fields(item, ['kind', 'value']);
  else if (item['kind'] === 'input' || item['kind'] === 'step') {
    fields(item, item['kind'] === 'input' ? ['kind', 'path'] : ['kind', 'stepId', 'path']);
    for (const segment of list(item['path'], 32)) if (typeof segment !== 'string' || forbidden.has(segment)) invalid();
    if (item['kind'] === 'step') {
      const id = stepIdentity(item['stepId']); if (ids && !ids.has(id)) invalid();
    }
  } else invalid();
  return item as unknown as WorkflowBinding;
}
function receipt(value: unknown): ExecutionReceipt {
  const item = object(jsonValue(value, { maxBytes: 2_048 }));
  fields(item, ['callId', 'toolId', 'execution', 'disclosure']);
  identity(item['callId'], 512); toolIdentity(item['toolId']);
  if (!['not_started', 'succeeded', 'failed', 'unknown'].includes(item['execution'] as string)
    || !['released', 'withheld'].includes(item['disclosure'] as string)
    || (item['disclosure'] === 'released' && item['execution'] !== 'succeeded')) invalid();
  return item as unknown as ExecutionReceipt;
}

/** Deeply snapshot the exact data-only graph material used by legacy definition hashing. */
export function workflowManifest(value: unknown): WorkflowManifest {
  try {
    const manifest = object(jsonValue(value)); fields(manifest, ['id', 'version', 'graph', 'result']);
    // Workflow IDs historically permit these names; only step IDs prohibit prototype keys.
    if (typeof manifest['id'] !== 'string' || !nodeId.test(manifest['id'])) invalid();
    text(manifest['version'], 128);
    const graph = list(manifest['graph'], 128); if (graph.length === 0) invalid();
    const ids = new Set<string>();
    for (const raw of graph) { const id = stepIdentity(object(raw)['id']); if (ids.has(id)) invalid(); ids.add(id); }
    const dependencies = new Map<string, readonly string[]>();
    for (const raw of graph) {
      const node = object(raw); const id = stepIdentity(node['id']);
      const deps = list(node['dependsOn'], 128).map(stepIdentity);
      if (new Set(deps).size !== deps.length || deps.some(dependency => !ids.has(dependency))) invalid();
      dependencies.set(id, deps);
      if (node['kind'] === 'join') fields(node, ['id', 'kind', 'dependsOn']);
      else if (node['kind'] === 'tool') {
        fields(node, ['id', 'kind', 'dependsOn', 'tool', 'toolVersion', 'effects', 'capabilities', 'costMicros', 'approval', 'input']);
        toolIdentity(node['tool']); text(node['toolVersion'], 128);
        if (!['none', 'read', 'write', 'host'].includes(node['effects'] as string) || typeof node['approval'] !== 'boolean') invalid();
        integer(node['costMicros']);
        const capabilities = list(node['capabilities'], 128).map(capability => text(capability, 256));
        if (new Set(capabilities).size !== capabilities.length) invalid();
        const source = binding(node['input'], ids);
        if (source.kind === 'step' && !deps.includes(source.stepId)) invalid();
      } else invalid();
    }
    // Bounded depth-first validation supports forward declarations without permitting cycles.
    const visiting = new Set<string>(); const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) invalid(); if (visited.has(id)) return;
      visiting.add(id); for (const dependency of dependencies.get(id)!) visit(dependency);
      visiting.delete(id); visited.add(id);
    };
    for (const id of ids) visit(id);
    binding(manifest['result'], ids);
    return freezeJson(manifest) as unknown as WorkflowManifest;
  } catch { return invalid(); }
}

/** Scheduled-profile policy snapshot. Sorted permissions intentionally retain legacy duplicates. */
export function workflowPolicy(value: unknown): WorkflowPolicyManifest {
  try {
    const policy = object(jsonValue(value));
    fields(policy, ['scope', 'permissions', 'policyVersion', 'maxCostMicros', 'maxOutputBytes', 'approvalTtlMs']);
    const scope = object(policy['scope']); fields(scope, ['principalId', 'projectId']);
    text(scope['principalId'], 128); text(scope['projectId'], 128); text(policy['policyVersion'], 128);
    policy['permissions'] = list(policy['permissions'], 4_096).map(grant => text(grant, 256)).sort();
    integer(policy['maxCostMicros']); integer(policy['maxOutputBytes'], 1, 65_536); integer(policy['approvalTtlMs'], 1);
    return freezeJson(policy) as unknown as WorkflowPolicyManifest;
  } catch { return invalid(); }
}

/** Canonical per-tool exact resources; omission means [], never an inferred resource identity. */
export function workflowResources(value: unknown, definition: WorkflowManifest): WorkflowResourcePlan {
  try {
    const manifest = workflowManifest(definition); const supplied = object(jsonValue(value));
    const tools = new Set(manifest.graph.filter(node => node.kind === 'tool').map(node => node.id));
    if (Object.keys(supplied).some(id => !tools.has(id))) invalid();
    const result: JsonObject = {};
    for (const id of [...tools].sort()) {
      const requested = Object.hasOwn(supplied, id) ? list(supplied[id], 32) : [];
      result[id] = [...new Set(requested.map(value => identity(value)))].sort();
    }
    return freezeJson(jsonValue(result)) as unknown as WorkflowResourcePlan;
  } catch { return invalid(); }
}

/** Legacy canonical JSON v1 material, including its exact domain/newline separator. No hashing or I/O. */
export function workflowHashMaterial(domain: string, value: unknown): string {
  try {
    if (typeof domain !== 'string' || !/^[A-Za-z0-9:._/-]{1,128}$/.test(domain)) invalid();
    const canonical = (item: JsonValue): string => {
      if (item === null || typeof item !== 'object') return JSON.stringify(item);
      if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
      return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical(item[key]!)}`).join(',')}}`;
    };
    return `${domain}\n${canonical(jsonValue(value))}`;
  } catch { return invalid(); }
}

/** Decode a fresh mutable format-2 copy; input records and nested objects are never mutated. */
export function workflowState(record: Pick<StoredRecord, 'id' | 'state'>): WorkflowFormat2State {
  try {
    // Read own data descriptors so external storage accessors cannot execute at this boundary.
    const idDescriptor = Object.getOwnPropertyDescriptor(record, 'id'); const stateDescriptor = Object.getOwnPropertyDescriptor(record, 'state');
    if (!idDescriptor || !('value' in idDescriptor) || !stateDescriptor || !('value' in stateDescriptor)) corrupt();
    const runId = identity(idDescriptor.value); const state = object(jsonValue(stateDescriptor.value)); fields(state, stateKeys);
    if (state['format'] !== 2 || !statuses.has(state['status'] as string)) corrupt();
    hash(state['definition']); hash(state['policy']);
    const maxCost = integer(state['maxCostMicros']); const spent = integer(state['spentMicros']); const totalReserved = integer(state['reservedMicros']);
    const steps = object(state['steps']); const entries = Object.entries(steps); if (entries.length === 0 || entries.length > 128) corrupt();
    let reserved = 0;
    for (const [id, raw] of entries) {
      stepIdentity(id); const step = object(raw); fields(step, stepKeys);
      if (!['tool', 'join'].includes(step['kind'] as string) || !stepStatuses.has(step['status'] as string) || step['callId'] !== `step:${id}`) corrupt();
      const amount = integer(step['costReserved']); reserved += amount; integer(reserved);
      if (step['candidateHash'] !== null) hash(step['candidateHash']);
      if (step['approval'] !== null) {
        const approval = object(step['approval']); fields(approval, ['digest', 'expiresAt', 'humanId']);
        hash(approval['digest']); integer(approval['expiresAt'], 1);
        if (approval['humanId'] !== null) text(approval['humanId'], 256);
      }
      if (step['status'] === 'approved' && (step['approval'] === null || !object(step['approval'])['humanId'])) corrupt();
      if (step['receipt'] !== null) {
        const evidence = receipt(step['receipt']); if (evidence.callId !== `${runId}/step:${id}`) corrupt();
      }
      if (step['status'] !== 'succeeded' && step['output'] !== null) corrupt();
      if (step['kind'] === 'join' && (step['receipt'] !== null || step['approval'] !== null || step['candidateHash'] !== null || amount !== 0)) corrupt();
      if (step['status'] === 'succeeded') {
        if (amount !== 0) corrupt();
        if (step['kind'] === 'tool' && (step['receipt'] === null || object(step['receipt'])['execution'] !== 'succeeded'
          || object(step['receipt'])['disclosure'] !== 'released' || step['candidateHash'] === null)) corrupt();
      }
    }
    if (reserved !== totalReserved || spent > maxCost - totalReserved) corrupt();
    if (state['status'] === 'succeeded' && entries.some(([, raw]) => object(raw)['status'] !== 'succeeded')) corrupt();
    if (state['status'] !== 'succeeded' && state['output'] !== null) corrupt();
    return state as unknown as WorkflowFormat2State;
  } catch { return corrupt(); }
}

/** Cross-check stored graph evidence against its immutable manifest, not just its shape. */
export function assertWorkflowStateMatchesManifest(state: WorkflowFormat2State, definition: WorkflowManifest): void {
  try {
    const manifest = workflowManifest(definition);
    // Callers must decode the state first; this helper additionally snapshots to reject accessors.
    const value = object(jsonValue(state)); const steps = object(value['steps']);
    if (Object.keys(steps).length !== manifest.graph.length) corrupt();
    for (const node of manifest.graph) {
      const step = object(steps[node.id]);
      if (step['kind'] !== node.kind || (node.kind === 'tool' && step['receipt'] !== null && object(step['receipt'])['toolId'] !== node.tool)) corrupt();
      if (step['status'] === 'succeeded' && node.dependsOn.some(id => object(steps[id])['status'] !== 'succeeded')) corrupt();
      if (node.kind === 'tool') {
        const reserved = integer(step['costReserved']);
        if ((step['approval'] !== null && !node.approval) || (reserved !== 0 && reserved !== node.costMicros)) corrupt();
        if (node.approval && step['candidateHash'] !== null
          && (step['approval'] === null || object(step['approval'])['digest'] !== step['candidateHash'])) corrupt();
      }
    }
  } catch { return corrupt(); }
}

/** Construct unchanged legacy initial state; input schema admission remains outside this module. */
export function initialWorkflowState(definition: WorkflowManifest, input: JsonValue, definitionHash: string, policyHash: string, maxCostMicros: number): WorkflowFormat2State {
  try {
    const manifest = workflowManifest(definition); hash(definitionHash); hash(policyHash); integer(maxCostMicros);
    const state: WorkflowFormat2State = { format: 2, definition: definitionHash, policy: policyHash, input: jsonValue(input), status: 'running',
      maxCostMicros, spentMicros: 0, reservedMicros: 0, output: null,
      steps: Object.fromEntries(manifest.graph.map(node => [node.id, { kind: node.kind, status: 'pending', callId: `step:${node.id}`,
        output: null, receipt: null, approval: null, costReserved: 0, candidateHash: null }])) };
    // Input and structural overhead share the same aggregate boundary, not independent allowances.
    return jsonValue(state) as unknown as WorkflowFormat2State;
  } catch { return invalid(); }
}

/** Project only released successful step outputs; callers receive a detached JSON copy. */
export function workflowOutputs(state: WorkflowFormat2State): Record<string, JsonValue> {
  try {
    const steps = object(object(jsonValue(state))['steps']);
    return Object.fromEntries(Object.entries(steps).filter(([, step]) => object(step)['status'] === 'succeeded').map(([id, raw]) => {
      const step = object(raw);
      if (step['kind'] === 'tool') {
        const evidence = receipt(step['receipt']);
        if (evidence.execution !== 'succeeded' || evidence.disclosure !== 'released') corrupt();
      } else if (step['kind'] !== 'join') corrupt();
      if (!Object.hasOwn(step, 'output')) corrupt();
      return [id, step['output']!];
    }));
  } catch { return corrupt(); }
}

/** Known receipt facts never regress to unknown; conflicting known facts require reconciliation. */
export function mergeWorkflowReceipt(previous: ExecutionReceipt | null, incoming: ExecutionReceipt): ExecutionReceipt {
  try {
    const next = receipt(incoming); const before = previous === null ? null : receipt(previous);
    if (before && (before.callId !== next.callId || before.toolId !== next.toolId)) corrupt();
    if (before && before.execution !== 'unknown') {
      if (next.execution === 'unknown') return Object.freeze(before);
      if (before.execution !== next.execution) corrupt();
      if (before.disclosure === 'released') return Object.freeze(before);
    }
    return Object.freeze(next);
  } catch { return corrupt(); }
}

/** Resolve an admitted JSON binding without prototype traversal or executable expressions. */
export function resolveWorkflowBinding(source: WorkflowBinding, input: JsonValue, outputs: Readonly<Record<string, JsonValue>>): JsonValue {
  try {
    const selected = binding(jsonValue(source));
    if (selected.kind === 'literal') return jsonValue(selected.value);
    const values = object(jsonValue(outputs)); let value: JsonValue | undefined = selected.kind === 'input' ? jsonValue(input) : values[selected.stepId];
    for (const segment of selected.path) {
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, segment)) invalid();
      value = (value as JsonObject)[segment];
    }
    return jsonValue(value);
  } catch { throw new StorageError('INVALID_INPUT', 'Workflow binding cannot resolve its path.'); }
}
