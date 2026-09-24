import { freezeJson, jsonValue, type JsonObject, type JsonValue } from '@mayura/core';
import { StorageError } from './contracts.js';
import type { WorkflowBinding, WorkflowManifestNode } from './scheduled-workflow-contracts.js';
import { workflowManifest } from './workflow-format2.js';

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
}

export interface WorkflowLifecycleTimerNodeManifest {
  readonly kind: 'timer';
  readonly id: string;
  readonly dependsOn: readonly string[];
  readonly fireAtMs: WorkflowBinding;
}

export type WorkflowLifecycleManifestNode = WorkflowManifestNode
  | WorkflowLifecycleHumanNodeManifest
  | WorkflowLifecycleTimerNodeManifest;

/** Immutable data-only definition material for explicit lifecycle suspension nodes. */
export interface WorkflowLifecycleManifest {
  readonly format: 5;
  readonly id: string;
  readonly version: string;
  readonly graph: readonly WorkflowLifecycleManifestNode[];
  readonly result: WorkflowBinding;
}

const forbidden = new Set(['constructor', 'prototype', '__proto__']);
const idPattern = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const schemaIdPattern = /^[A-Za-z][A-Za-z0-9._:/-]{0,127}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const humanKinds = new Set<WorkflowLifecycleHumanKind>(['information', 'correction', 'plan_selection']);

function invalid(): never {
  throw new StorageError('INVALID_INPUT', 'Invalid bounded workflow lifecycle metadata.');
}

function object(value: JsonValue | undefined): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value;
}

function fields(value: JsonObject, names: readonly string[]): void {
  if (Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) invalid();
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
      if (node['kind'] === 'tool' || node['kind'] === 'join') return node;
      if (node['kind'] !== 'human' && node['kind'] !== 'timer') invalid();
      return { kind: 'join', id: node['id'], dependsOn: node['dependsOn'] };
    });
    const common = workflowManifest({ id: manifest['id'], version: manifest['version'], graph: projected, result: manifest['result'] });
    const ids = new Set(common.graph.map(node => node.id));
    let humans = 0; let timers = 0;

    for (const raw of graph) {
      const node = object(raw);
      const id = typeof node['id'] === 'string' && idPattern.test(node['id']) ? node['id'] : invalid();
      const projectedNode = common.graph.find(item => item.id === id)!;
      const dependencies = projectedNode.dependsOn;
      if (node['kind'] === 'tool' || node['kind'] === 'join') continue;
      if (node['kind'] === 'timer') {
        timers += 1;
        fields(node, ['kind', 'id', 'dependsOn', 'fireAtMs']);
        temporalBinding(node['fireAtMs'], ids, dependencies);
        continue;
      }
      humans += 1;
      fields(node, ['kind', 'id', 'dependsOn', 'requestKind', 'schemaId', 'schemaDigest', 'prompt', 'context', 'subjectDigest', 'deadlineAtMs']);
      if (!humanKinds.has(node['requestKind'] as WorkflowLifecycleHumanKind)
        || typeof node['schemaId'] !== 'string' || !schemaIdPattern.test(node['schemaId'])
        || typeof node['schemaDigest'] !== 'string' || !hashPattern.test(node['schemaDigest'])
        || typeof node['prompt'] !== 'string' || node['prompt'].length < 1 || node['prompt'].length > 4_096) invalid();
      if ((node['requestKind'] === 'correction') !== (node['subjectDigest'] !== null)) invalid();
      if (node['context'] !== null) binding(node['context'], ids, dependencies);
      if (node['subjectDigest'] !== null) digestBinding(node['subjectDigest'], ids, dependencies);
      if (node['deadlineAtMs'] !== null) temporalBinding(node['deadlineAtMs'], ids, dependencies);
    }
    if (humans > 32 || timers > 64) invalid();
    return freezeJson(manifest) as unknown as WorkflowLifecycleManifest;
  } catch {
    return invalid();
  }
}
