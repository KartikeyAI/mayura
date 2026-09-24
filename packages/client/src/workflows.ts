import { ClientError } from './index.js';

export type WorkflowViewFormat = 2 | 3 | 4 | 5;
export type WorkflowViewNodeKind = 'tool' | 'join' | 'wait' | 'child' | 'human' | 'timer';
export type WorkflowViewRunStatus = 'running' | 'waiting' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'outcome_unknown';
export type WorkflowViewStepStatus = 'pending' | 'waiting' | 'approved' | 'dispatching' | 'succeeded' | 'failed' | 'blocked' | 'unknown' | 'skipped' | 'timed_out';
export interface WorkflowViewNode { readonly id: string; readonly kind: WorkflowViewNodeKind; readonly dependsOn: readonly string[] }
export interface WorkflowViewStep { readonly id: string; readonly kind: WorkflowViewNodeKind; readonly status: WorkflowViewStepStatus; readonly childRunId?: string }
export interface WorkflowViewInput {
  readonly format: WorkflowViewFormat; readonly definitionId: string; readonly definitionVersion: string;
  readonly runId: string; readonly revision: number; readonly status: WorkflowViewRunStatus;
  readonly nodes: readonly WorkflowViewNode[]; readonly steps: readonly WorkflowViewStep[];
}
export interface WorkflowGraphNode {
  readonly id: string; readonly kind: WorkflowViewNodeKind; readonly status: WorkflowViewStepStatus; readonly depth: number;
  readonly ready: boolean; readonly childRunId: string | null;
}
export interface WorkflowGraphEdge { readonly from: string; readonly to: string }
export interface WorkflowGraphProjection {
  readonly format: WorkflowViewFormat; readonly definitionId: string; readonly definitionVersion: string;
  readonly runId: string; readonly revision: number; readonly status: WorkflowViewRunStatus;
  readonly nodes: readonly WorkflowGraphNode[]; readonly edges: readonly WorkflowGraphEdge[];
  readonly progress: { readonly total: number; readonly terminal: number; readonly succeeded: number; readonly active: number; readonly waiting: number; readonly failed: number };
}

const identifier = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const version = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const digest = /^[a-f0-9]{64}$/;
const runStatuses = new Set<WorkflowViewRunStatus>(['running', 'waiting', 'succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown']);
const stepStatuses = new Set<WorkflowViewStepStatus>(['pending', 'waiting', 'approved', 'dispatching', 'succeeded', 'failed', 'blocked', 'unknown', 'skipped', 'timed_out']);
const humanStatuses = new Set<WorkflowViewStepStatus>(['pending', 'waiting', 'succeeded', 'timed_out', 'skipped']);
const timerStatuses = new Set<WorkflowViewStepStatus>(['pending', 'waiting', 'succeeded', 'skipped']);
const terminal = new Set<WorkflowViewStepStatus>(['succeeded', 'failed', 'blocked', 'unknown', 'skipped', 'timed_out']);
const failed = new Set<WorkflowViewStepStatus>(['failed', 'blocked', 'unknown', 'timed_out']);
const kinds: Readonly<Record<WorkflowViewFormat, ReadonlySet<WorkflowViewNodeKind>>> = Object.freeze({
  2: new Set<WorkflowViewNodeKind>(['tool', 'join']), 3: new Set<WorkflowViewNodeKind>(['tool', 'join', 'wait']),
  4: new Set<WorkflowViewNodeKind>(['tool', 'join', 'child']), 5: new Set<WorkflowViewNodeKind>(['tool', 'join', 'human', 'timer']),
});
function invalid(): never { throw new ClientError('INVALID_WORKFLOW_VIEW'); }
function fields(value: object, names: readonly string[]): Record<string, PropertyDescriptor> {
  const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== names.length || keys.some(key => typeof key !== 'string' || !names.includes(key) || !('value' in descriptors[key]!))) return invalid();
  return descriptors;
}
function frozenArray(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || !Object.isFrozen(value) || value.length < 1 || value.length > maximum) return invalid();
  return value;
}

/** Validate one matched durable manifest/snapshot view and derive a bounded, content-free DAG projection. */
export function createWorkflowGraphProjection(input: WorkflowViewInput): WorkflowGraphProjection {
  if (!input || typeof input !== 'object' || !Object.isFrozen(input)) return invalid();
  const root = fields(input, ['format', 'definitionId', 'definitionVersion', 'runId', 'revision', 'status', 'nodes', 'steps']);
  const format = root['format']!.value as WorkflowViewFormat; const definitionId = root['definitionId']!.value as string;
  const definitionVersion = root['definitionVersion']!.value as string; const runId = root['runId']!.value as string;
  const revision = root['revision']!.value as number; const status = root['status']!.value as WorkflowViewRunStatus;
  if (![2, 3, 4, 5].includes(format) || typeof definitionId !== 'string' || !identifier.test(definitionId)
    || typeof definitionVersion !== 'string' || !version.test(definitionVersion) || typeof runId !== 'string' || !digest.test(runId)
    || !Number.isSafeInteger(revision) || revision < 1 || typeof status !== 'string' || !runStatuses.has(status)) return invalid();
  const rawNodes = frozenArray(root['nodes']!.value, 128); const rawSteps = frozenArray(root['steps']!.value, 128);
  if (rawNodes.length !== rawSteps.length) return invalid();
  const nodes = new Map<string, { id: string; kind: WorkflowViewNodeKind; dependsOn: readonly string[]; index: number }>(); let edgeCount = 0;
  for (const [index, raw] of rawNodes.entries()) {
    if (!raw || typeof raw !== 'object' || !Object.isFrozen(raw)) return invalid(); const item = fields(raw, ['id', 'kind', 'dependsOn']);
    const id = item['id']!.value as string; const kind = item['kind']!.value as WorkflowViewNodeKind; const dependencies = item['dependsOn']!.value;
    if (typeof id !== 'string' || !identifier.test(id) || nodes.has(id) || typeof kind !== 'string' || !kinds[format].has(kind)) return invalid();
    const list = frozenArrayAllowEmpty(dependencies, 127); if (new Set(list).size !== list.length || list.some(value => typeof value !== 'string' || !identifier.test(value))) return invalid();
    edgeCount += list.length; if (edgeCount > 512) return invalid(); nodes.set(id, { id, kind, dependsOn: list as readonly string[], index });
  }
  for (const node of nodes.values()) if (node.dependsOn.some(dependency => dependency === node.id || !nodes.has(dependency))) return invalid();
  const steps = new Map<string, { id: string; kind: WorkflowViewNodeKind; status: WorkflowViewStepStatus; childRunId: string | null }>();
  for (const raw of rawSteps) {
    if (!raw || typeof raw !== 'object' || !Object.isFrozen(raw)) return invalid(); const descriptors = Object.getOwnPropertyDescriptors(raw);
    const names = Reflect.ownKeys(descriptors); const allowed = ['id', 'kind', 'status', 'childRunId'];
    if (names.some(key => typeof key !== 'string' || !allowed.includes(key) || !('value' in descriptors[key]!)) || !['id', 'kind', 'status'].every(key => descriptors[key])) return invalid();
    const id = descriptors['id']!.value as string; const kind = descriptors['kind']!.value as WorkflowViewNodeKind; const stepStatus = descriptors['status']!.value as WorkflowViewStepStatus;
    const hasChildRunId = descriptors['childRunId'] !== undefined; const childRunId = descriptors['childRunId']?.value as string | undefined; const node = nodes.get(id);
    if (!node || steps.has(id) || kind !== node.kind || typeof stepStatus !== 'string' || !stepStatuses.has(stepStatus)
      || (kind === 'human' && !humanStatuses.has(stepStatus)) || (kind === 'timer' && !timerStatuses.has(stepStatus))
      || (stepStatus === 'timed_out' && kind !== 'human')
      || (hasChildRunId && (kind !== 'child' || typeof childRunId !== 'string' || !digest.test(childRunId)))) return invalid();
    steps.set(id, { id, kind, status: stepStatus, childRunId: childRunId ?? null });
  }
  if (steps.size !== nodes.size) return invalid();
  const remaining = new Map([...nodes].map(([id, node]) => [id, node.dependsOn.length])); const depths = new Map<string, number>();
  const dependents = new Map<string, string[]>(); for (const node of nodes.values()) for (const dependency of node.dependsOn) {
    const list = dependents.get(dependency) ?? []; list.push(node.id); dependents.set(dependency, list);
  }
  const queue = [...nodes.values()].filter(node => node.dependsOn.length === 0).sort((a, b) => a.index - b.index).map(node => node.id);
  for (let cursor = 0; cursor < queue.length; cursor++) { const id = queue[cursor]!; const node = nodes.get(id)!;
    depths.set(id, node.dependsOn.length === 0 ? 0 : Math.max(...node.dependsOn.map(dependency => depths.get(dependency)!)) + 1);
    for (const dependent of dependents.get(id) ?? []) { const count = remaining.get(dependent)! - 1; remaining.set(dependent, count); if (count === 0) queue.push(dependent); }
  }
  if (depths.size !== nodes.size) return invalid();
  const projected = [...nodes.values()].sort((a, b) => a.index - b.index).map(node => { const step = steps.get(node.id)!;
    return Object.freeze({ id: node.id, kind: node.kind, status: step.status, depth: depths.get(node.id)!,
      ready: step.status === 'pending' && node.dependsOn.every(dependency => steps.get(dependency)!.status === 'succeeded'), childRunId: step.childRunId }); });
  const edges = [...nodes.values()].flatMap(node => node.dependsOn.map(from => Object.freeze({ from, to: node.id })));
  const statuses = [...steps.values()].map(step => step.status); const progress = Object.freeze({ total: statuses.length,
    terminal: statuses.filter(value => terminal.has(value)).length, succeeded: statuses.filter(value => value === 'succeeded').length,
    active: statuses.filter(value => ['approved', 'dispatching'].includes(value)).length, waiting: statuses.filter(value => value === 'waiting').length,
    failed: statuses.filter(value => failed.has(value)).length });
  return Object.freeze({ format, definitionId, definitionVersion, runId, revision, status,
    nodes: Object.freeze(projected), edges: Object.freeze(edges), progress });
}

function frozenArrayAllowEmpty(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || !Object.isFrozen(value) || value.length > maximum) return invalid();
  return value;
}
