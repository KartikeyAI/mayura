import { ClientError, type ClientJson, type MayuraClient } from './index.js';

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
export type WorkflowCommandStatus = 'idle' | 'submitting' | 'succeeded' | 'conflict' | 'failed' | 'disposed';
export type WorkflowCommandAction = 'cancel' | 'approve' | 'signal' | 'resume';
export interface WorkflowCommandState {
  readonly stateRevision: number; readonly status: WorkflowCommandStatus; readonly runId: string;
  readonly workflowRevision: number; readonly workflowStatus: WorkflowViewRunStatus; readonly action: WorkflowCommandAction | null;
  readonly nodeId: string | null; readonly errorCode: string | null;
}
export interface WorkflowApprovalIntent { readonly nodeId: string; readonly approvalDigest: string; readonly childRunId?: string }
export interface WorkflowSignalIntent { readonly signalId: string; readonly signalName: string; readonly value: ClientJson }
export interface WorkflowCommandControllerOptions {
  readonly client: Pick<MayuraClient, 'cancelWorkflow' | 'approveWorkflow'> & Partial<Pick<MayuraClient, 'signalWorkflow' | 'resumeWorkflow'>>;
  readonly workflow: WorkflowViewInput; readonly maxSubscribers?: number;
}
export interface WorkflowCommandController {
  getSnapshot(): WorkflowCommandState;
  subscribe(listener: () => void): () => void;
  cancel(options: { readonly commandId: string; readonly signal?: AbortSignal }): Promise<WorkflowViewInput>;
  approve(command: WorkflowApprovalIntent, options: { readonly commandId: string; readonly signal?: AbortSignal }): Promise<WorkflowViewInput>;
  signal(command: WorkflowSignalIntent, options: { readonly commandId: string; readonly signal?: AbortSignal }): Promise<WorkflowViewInput>;
  resume(options: { readonly commandId: string; readonly signal?: AbortSignal }): Promise<WorkflowViewInput>;
  reset(): WorkflowCommandState;
  dispose(): void;
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

const commandId = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const signalIdentifier = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const encoder = new TextEncoder();
function workflowCommandState(state: WorkflowCommandState): WorkflowCommandState { return Object.freeze({ ...state }); }
function safeWorkflowCommandError(error: unknown): ClientError {
  const allowed = new Set(['ABORTED', 'TRANSPORT_FAILED', 'REDIRECT_DENIED', 'HTTP_ERROR', 'INVALID_RESPONSE', 'INVALID_JSON', 'RESPONSE_LIMIT', 'INVALID_REQUEST']);
  return error instanceof ClientError && allowed.has(error.code) ? error : new ClientError('WORKFLOW_COMMAND_FAILED');
}
function approvalIntent(value: unknown, projection: WorkflowGraphProjection): WorkflowApprovalIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value)))
    throw new ClientError('INVALID_WORKFLOW_COMMAND');
  const fields = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(fields);
  if (keys.some(key => typeof key !== 'string' || !['nodeId', 'approvalDigest', 'childRunId'].includes(key) || !('value' in fields[key]!))
    || !fields['nodeId'] || !fields['approvalDigest']) throw new ClientError('INVALID_WORKFLOW_COMMAND');
  const nodeId = fields['nodeId'].value; const approvalDigest = fields['approvalDigest'].value; const childRunId = fields['childRunId']?.value;
  const node = projection.nodes.find(candidate => candidate.id === nodeId);
  if (typeof nodeId !== 'string' || !identifier.test(nodeId) || typeof approvalDigest !== 'string' || !digest.test(approvalDigest)
    || (childRunId !== undefined && (typeof childRunId !== 'string' || !digest.test(childRunId)))
    || !node || node.status !== 'waiting' || node.childRunId !== (childRunId ?? null)) throw new ClientError('INVALID_WORKFLOW_COMMAND');
  return Object.freeze({ nodeId, approvalDigest, ...(childRunId === undefined ? {} : { childRunId }) });
}
function workflowSignalIntent(value: unknown): WorkflowSignalIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value)))
    throw new ClientError('INVALID_WORKFLOW_COMMAND');
  const fields = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(fields);
  if (keys.length !== 3 || keys.some(key => typeof key !== 'string' || !['signalId', 'signalName', 'value'].includes(key) || !('value' in fields[key]!)))
    throw new ClientError('INVALID_WORKFLOW_COMMAND');
  const signalId = fields['signalId']?.value; const signalName = fields['signalName']?.value;
  if (typeof signalId !== 'string' || !signalIdentifier.test(signalId) || typeof signalName !== 'string' || !signalIdentifier.test(signalName))
    throw new ClientError('INVALID_WORKFLOW_COMMAND');
  let nodes = 0; const seen = new Set<object>();
  const copy = (item: unknown, depth: number): ClientJson => {
    if (++nodes > 1_024 || depth > 16) throw new ClientError('INVALID_WORKFLOW_COMMAND');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item;
    if (typeof item === 'number' && Number.isFinite(item) && (!Number.isInteger(item) || Number.isSafeInteger(item))) return item;
    if (typeof item !== 'object' || seen.has(item) || (!Array.isArray(item) && ![null, Object.prototype].includes(Object.getPrototypeOf(item))))
      throw new ClientError('INVALID_WORKFLOW_COMMAND');
    seen.add(item); const descriptors = Object.getOwnPropertyDescriptors(item); let result: ClientJson;
    if (Array.isArray(item)) {
      if (Reflect.ownKeys(descriptors).length !== item.length + 1 || !descriptors['length']) throw new ClientError('INVALID_WORKFLOW_COMMAND');
      const entries: ClientJson[] = [];
      for (let index = 0; index < item.length; index++) { const descriptor = descriptors[String(index)];
        if (!descriptor || !('value' in descriptor)) throw new ClientError('INVALID_WORKFLOW_COMMAND'); entries.push(copy(descriptor.value, depth + 1)); }
      result = Object.freeze(entries);
    } else {
      const entries: Record<string, ClientJson> = {};
      for (const key of Reflect.ownKeys(descriptors)) { const descriptor = descriptors[key as keyof typeof descriptors];
        if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key) || !descriptor || !('value' in descriptor) || !descriptor.enumerable)
          throw new ClientError('INVALID_WORKFLOW_COMMAND'); entries[key] = copy(descriptor.value, depth + 1); }
      result = Object.freeze(entries);
    }
    seen.delete(item); return result;
  };
  const captured = copy(fields['value']!.value, 0);
  if (encoder.encode(JSON.stringify(captured)).byteLength > 4_096) throw new ClientError('INVALID_WORKFLOW_COMMAND');
  return Object.freeze({ signalId, signalName, value: captured });
}

/** Caller-owned, inert single-flight command state for one exact durable workflow revision. */
export function createWorkflowCommandController(options: WorkflowCommandControllerOptions): WorkflowCommandController {
  if (!options || !options.client || typeof options.client.cancelWorkflow !== 'function' || typeof options.client.approveWorkflow !== 'function')
    throw new ClientError('INVALID_WORKFLOW_CONTROLLER');
  let projection: WorkflowGraphProjection;
  try { projection = createWorkflowGraphProjection(options.workflow); } catch { throw new ClientError('INVALID_WORKFLOW_CONTROLLER'); }
  const maxSubscribers = options.maxSubscribers ?? 64;
  if (!Number.isSafeInteger(maxSubscribers) || maxSubscribers < 1 || maxSubscribers > 256) throw new ClientError('INVALID_WORKFLOW_CONTROLLER');
  const client = options.client; const workflow = options.workflow; const listeners = new Set<() => void>(); let active: AbortController | null = null; let disposed = false;
  let state = workflowCommandState({ stateRevision: 0, status: 'idle', runId: workflow.runId, workflowRevision: workflow.revision,
    workflowStatus: workflow.status, action: null, nodeId: null, errorCode: null });
  const publish = (change: Omit<Partial<WorkflowCommandState>, 'stateRevision' | 'runId'>): WorkflowCommandState => {
    state = workflowCommandState({ ...state, ...change, stateRevision: state.stateRevision + 1 });
    for (const listener of [...listeners]) { try { listener(); } catch { /* Presentation listeners cannot alter command state. */ } }
    return state;
  };
  const execute = async (action: WorkflowCommandAction, nodeId: string | null, settings: { readonly commandId: string; readonly signal?: AbortSignal },
    invoke: (signal: AbortSignal) => Promise<WorkflowViewInput>): Promise<WorkflowViewInput> => {
    if (disposed) throw new ClientError('WORKFLOW_CONTROLLER_DISPOSED');
    if (active) throw new ClientError('WORKFLOW_CONTROLLER_BUSY');
    if (state.status === 'succeeded') throw new ClientError('WORKFLOW_CONTROLLER_STALE');
    if (state.status !== 'idle') throw new ClientError('WORKFLOW_CONTROLLER_NOT_READY');
    if (!settings || typeof settings.commandId !== 'string' || !commandId.test(settings.commandId)) throw new ClientError('INVALID_WORKFLOW_COMMAND');
    const controller = new AbortController(); const abort = (): void => controller.abort(); active = controller;
    settings.signal?.addEventListener('abort', abort, { once: true }); if (settings.signal?.aborted) abort();
    publish({ status: 'submitting', action, nodeId, errorCode: null });
    try {
      if (controller.signal.aborted) throw new ClientError('ABORTED');
      const result = await invoke(controller.signal);
      if (disposed || controller.signal.aborted) throw new ClientError('ABORTED');
      let next: WorkflowGraphProjection;
      try { next = createWorkflowGraphProjection(result); } catch { throw new ClientError('INVALID_RESPONSE'); }
      if (next.runId !== projection.runId || next.definitionId !== projection.definitionId || next.definitionVersion !== projection.definitionVersion
        || next.revision < projection.revision) throw new ClientError('INVALID_RESPONSE');
      publish({ status: 'succeeded', workflowRevision: next.revision, workflowStatus: next.status, errorCode: null }); return result;
    } catch (error) {
      const safe = safeWorkflowCommandError(error);
      if (!disposed) {
        const conflict = safe.code === 'HTTP_ERROR' && (safe.status === 409 || safe.status === 412);
        publish({ status: conflict ? 'conflict' : 'failed', errorCode: conflict ? 'WORKFLOW_COMMAND_CONFLICT' : safe.code });
      }
      throw safe;
    } finally { settings.signal?.removeEventListener('abort', abort); if (active === controller) active = null; }
  };
  return Object.freeze<WorkflowCommandController>({
    getSnapshot: () => state,
    subscribe: listener => {
      if (disposed) throw new ClientError('WORKFLOW_CONTROLLER_DISPOSED');
      if (typeof listener !== 'function') throw new ClientError('INVALID_WORKFLOW_CONTROLLER');
      if (listeners.size >= maxSubscribers) throw new ClientError('WORKFLOW_SUBSCRIBER_LIMIT');
      listeners.add(listener); let subscribed = true; return () => { if (subscribed) { subscribed = false; listeners.delete(listener); } };
    },
    cancel: settings => {
      if (['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(workflow.status)) return Promise.reject(new ClientError('INVALID_WORKFLOW_COMMAND'));
      return execute('cancel', null, settings, signal => client.cancelWorkflow(workflow.runId, workflow.revision, { commandId: settings.commandId, signal }));
    },
    approve: async (command, settings) => {
      const captured = approvalIntent(command, projection);
      return await execute('approve', captured.nodeId, settings, signal => client.approveWorkflow(workflow.runId, { revision: workflow.revision, ...captured },
        { commandId: settings.commandId, signal }));
    },
    signal: async (command, settings) => {
      if (typeof client.signalWorkflow !== 'function') throw new ClientError('INVALID_WORKFLOW_CONTROLLER');
      if (['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(workflow.status)) throw new ClientError('INVALID_WORKFLOW_COMMAND');
      const captured = workflowSignalIntent(command);
      return await execute('signal', null, settings, signal => client.signalWorkflow!(workflow.runId,
        { revision: workflow.revision, ...captured }, { commandId: settings.commandId, signal }));
    },
    resume: settings => {
      if (typeof client.resumeWorkflow !== 'function') return Promise.reject(new ClientError('INVALID_WORKFLOW_CONTROLLER'));
      if (!['running', 'waiting'].includes(workflow.status)) return Promise.reject(new ClientError('INVALID_WORKFLOW_COMMAND'));
      return execute('resume', null, settings, signal => client.resumeWorkflow!(workflow.runId, workflow.revision,
        { commandId: settings.commandId, signal }));
    },
    reset: () => {
      if (disposed) throw new ClientError('WORKFLOW_CONTROLLER_DISPOSED'); if (active) throw new ClientError('WORKFLOW_CONTROLLER_BUSY');
      if (state.status === 'succeeded') throw new ClientError('WORKFLOW_CONTROLLER_STALE');
      return publish({ status: 'idle', action: null, nodeId: null, errorCode: null });
    },
    dispose: () => {
      if (disposed) return; disposed = true; active?.abort(); publish({ status: 'disposed', action: null, nodeId: null, errorCode: null }); listeners.clear();
    },
  });
}
