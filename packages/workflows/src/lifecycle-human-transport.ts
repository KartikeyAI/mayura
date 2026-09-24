import { freezeJson, jsonValue, MayuraError, type JsonValue, type Scope } from '@mayura/core';
import { digest } from './definition.js';
import { assertWorkflowLifecycle, type AnyWorkflowLifecycle } from './lifecycle-definition.js';
import type { WorkflowLifecycleHumanRequest, WorkflowLifecycleRuntime } from './lifecycle-runtime.js';

export interface WorkflowLifecycleHumanTransportRecord {
  readonly id: string;
  readonly agentId: string;
  readonly kind: 'information' | 'correction' | 'plan_selection';
  readonly schemaId: string;
  readonly schemaDigest: string;
  readonly prompt: string;
  readonly digest: string;
  readonly status: 'waiting' | 'answered' | 'timed_out';
  readonly context?: JsonValue;
  readonly subjectDigest?: string;
  readonly deadlineAtMs?: number;
}

export interface WorkflowLifecycleHumanTransport {
  readonly list: (input: { readonly scope: Scope; readonly agentIds: readonly string[]; readonly after: string | null;
    readonly limit: number; readonly signal: AbortSignal }) => Promise<{ readonly items: readonly WorkflowLifecycleHumanTransportRecord[]; readonly next: string | null }>;
  readonly inspect: (input: { readonly scope: Scope; readonly agentIds: readonly string[]; readonly id: string;
    readonly signal: AbortSignal }) => Promise<WorkflowLifecycleHumanTransportRecord | null>;
  readonly respond: (input: { readonly scope: Scope; readonly agentIds: readonly string[]; readonly actorId: string;
    readonly id: string; readonly requestDigest: string; readonly commandId: string; readonly value: JsonValue;
    readonly signal: AbortSignal }) => Promise<WorkflowLifecycleHumanTransportRecord>;
}

export interface WorkflowLifecycleHumanRegistration {
  readonly agentId: string;
  readonly definition: AnyWorkflowLifecycle;
  readonly runtime: WorkflowLifecycleRuntime;
  readonly runId: string;
}

export interface WorkflowLifecycleHumanTransportController {
  /** Exact three-callback object accepted by @mayura/server. */
  readonly transport: WorkflowLifecycleHumanTransport;
  register(input: WorkflowLifecycleHumanRegistration): readonly string[];
  unregister(runId: string): void;
}

export interface WorkflowLifecycleHumanTransportOptions {
  readonly scope: Scope;
  readonly maxEntries?: number;
  readonly maxExaminedPerPage?: number;
}

interface Entry extends WorkflowLifecycleHumanRegistration { readonly id: string; readonly nodeId: string }
const identifier = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const hashPattern = /^[a-f0-9]{64}$/;

function active(signal: AbortSignal): void {
  if (signal.aborted) throw new MayuraError('CANCELLED', 'Human transport request was cancelled.');
}

/**
 * Bridges registered format-5 runs to the authenticated server transport shape.
 * Registration is intentionally explicit until durable lifecycle fleet discovery exists.
 */
export function createWorkflowLifecycleHumanTransport(
  options: WorkflowLifecycleHumanTransportOptions,
): WorkflowLifecycleHumanTransportController {
  const scope = Object.freeze({ principalId: options.scope?.principalId, projectId: options.scope?.projectId });
  if (!identifier.test(scope.principalId) || !identifier.test(scope.projectId)) throw new MayuraError('INVALID_CONFIG', 'Lifecycle human transport scope is invalid.');
  const maxEntries = options.maxEntries ?? 512; const maxExaminedPerPage = options.maxExaminedPerPage ?? 256;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 8_192
    || !Number.isSafeInteger(maxExaminedPerPage) || maxExaminedPerPage < 1 || maxExaminedPerPage > 1_024) {
    throw new MayuraError('INVALID_CONFIG', 'Lifecycle human transport limits are invalid.');
  }
  const entries = new Map<string, Entry>();
  const exactScope = (candidate: Scope): void => {
    if (candidate?.principalId !== scope.principalId || candidate?.projectId !== scope.projectId) {
      throw new MayuraError('PERMISSION_DENIED', 'Lifecycle human transport scope does not match.');
    }
  };
  const checkedAgents = (agentIds: readonly string[]): void => {
    if (!Array.isArray(agentIds) || agentIds.length > 256 || agentIds.some(id => !identifier.test(id))
      || new Set(agentIds).size !== agentIds.length) throw new MayuraError('INVALID_INPUT', 'Lifecycle human transport agent visibility is invalid.');
  };
  const visible = (entry: Entry, agentIds: readonly string[]): boolean => agentIds.includes(entry.agentId);
  const record = (entry: Entry, request: WorkflowLifecycleHumanRequest): WorkflowLifecycleHumanTransportRecord =>
    freezeJson(jsonValue({ id: entry.id, agentId: entry.agentId, kind: request.kind, schemaId: request.schemaId,
      schemaDigest: request.schemaDigest, prompt: request.prompt, digest: request.digest,
      status: request.status === 'succeeded' ? 'answered' : request.status,
      ...(request.context === null ? {} : { context: request.context }),
      ...(request.subjectDigest === null ? {} : { subjectDigest: request.subjectDigest }),
      ...(request.deadlineAtMs === null ? {} : { deadlineAtMs: request.deadlineAtMs }),
    })) as unknown as WorkflowLifecycleHumanTransportRecord;
  const requestFor = async (entry: Entry): Promise<WorkflowLifecycleHumanTransportRecord | null> => {
    try {
      const request = await entry.runtime.humanRequest(entry.definition, entry.runId, entry.nodeId);
      return request ? record(entry, request) : null;
    } catch (error) {
      if (error instanceof MayuraError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  };
  const transport = Object.freeze<WorkflowLifecycleHumanTransport>({
    list: async input => {
      exactScope(input.scope); active(input.signal);
      checkedAgents(input.agentIds);
      if ((input.after !== null && !hashPattern.test(input.after)) || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
        throw new MayuraError('INVALID_INPUT', 'Lifecycle human request page is invalid.');
      }
      const ordered = [...entries.values()].filter(entry => visible(entry, input.agentIds) && (input.after === null || entry.id > input.after))
        .sort((left, right) => left.id.localeCompare(right.id));
      const items: WorkflowLifecycleHumanTransportRecord[] = []; let examined = 0; let cursor: string | null = null;
      for (const entry of ordered) {
        if (items.length >= input.limit || examined >= maxExaminedPerPage) break;
        active(input.signal); examined += 1; cursor = entry.id;
        const item = await requestFor(entry); if (item) items.push(item);
      }
      const hasMore = cursor !== null && ordered.some(entry => entry.id > cursor!);
      active(input.signal); return freezeJson(jsonValue({ items, next: hasMore ? cursor : null })) as unknown as { readonly items: readonly WorkflowLifecycleHumanTransportRecord[]; readonly next: string | null };
    },
    inspect: async input => {
      exactScope(input.scope); active(input.signal);
      checkedAgents(input.agentIds);
      if (!hashPattern.test(input.id)) throw new MayuraError('INVALID_INPUT', 'Lifecycle human request identity is invalid.');
      const entry = entries.get(input.id); if (!entry || !visible(entry, input.agentIds)) return null;
      const item = await requestFor(entry); active(input.signal); return item;
    },
    respond: async input => {
      exactScope(input.scope); active(input.signal);
      checkedAgents(input.agentIds);
      if (!hashPattern.test(input.id) || !hashPattern.test(input.requestDigest) || !identifier.test(input.commandId)
        || !identifier.test(input.actorId)) {
        throw new MayuraError('INVALID_INPUT', 'Lifecycle human response identity is invalid.');
      }
      const entry = entries.get(input.id);
      if (!entry || !visible(entry, input.agentIds)) throw new MayuraError('NOT_FOUND', 'Lifecycle human request was not found.');
      await entry.runtime.respondVerified(entry.definition, { id: entry.runId, nodeId: entry.nodeId,
        requestDigest: input.requestDigest, commandId: input.commandId,
        actor: { id: input.actorId, projectId: scope.projectId }, value: input.value });
      active(input.signal); const updated = await requestFor(entry);
      if (!updated) throw new MayuraError('CONFLICT', 'Lifecycle human request disappeared after response.');
      return updated;
    },
  });
  return Object.freeze<WorkflowLifecycleHumanTransportController>({
    transport,
    register: input => {
      assertWorkflowLifecycle(input.definition);
      if (!identifier.test(input.agentId) || !hashPattern.test(input.runId) || input.runtime?.profile !== 'lifecycle-v1') {
        throw new MayuraError('INVALID_INPUT', 'Lifecycle human registration is invalid.');
      }
      const nodes = input.definition.nodes.filter(node => node.kind === 'human');
      const ids = nodes.map(node => digest('mayura:workflow-lifecycle-human-route:v1', {
        agentId: input.agentId, definitionHash: input.definition.digest, runId: input.runId, nodeId: node.id,
      }));
      const additions = ids.filter(id => !entries.has(id)).length;
      if (entries.size + additions > maxEntries) throw new MayuraError('LIMIT_EXCEEDED', 'Lifecycle human transport registry is full.');
      for (const [index, node] of nodes.entries()) {
        const id = ids[index]!; const previous = entries.get(id);
        if (previous && (previous.agentId !== input.agentId || previous.definition !== input.definition
          || previous.runtime !== input.runtime || previous.runId !== input.runId || previous.nodeId !== node.id)) {
          throw new MayuraError('CONFLICT', 'Lifecycle human route ID collision.');
        }
        entries.set(id, Object.freeze({ ...input, id, nodeId: node.id }));
      }
      return Object.freeze(ids);
    },
    unregister: runId => {
      if (!hashPattern.test(runId)) throw new MayuraError('INVALID_INPUT', 'Lifecycle run ID is invalid.');
      for (const [id, entry] of entries) if (entry.runId === runId) entries.delete(id);
    },
  });
}
