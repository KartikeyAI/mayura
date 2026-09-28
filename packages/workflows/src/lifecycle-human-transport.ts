import { freezeJson, jsonValue, MayuraError, type JsonValue, type Scope } from '@mayura/core';
import { digest } from './definition.js';
import { assertWorkflowLifecycle, type AnyWorkflowLifecycle } from './lifecycle-definition.js';
import type { WorkflowLifecycleFleetCandidate, WorkflowLifecycleFleetRuntime } from './lifecycle-fleet.js';
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

/** A definition whose human requests a durable transport serves, and the agent whose callers may see and answer them. */
export interface WorkflowLifecycleHumanRoute {
  readonly agentId: string;
  readonly definition: AnyWorkflowLifecycle;
}

export interface WorkflowLifecycleHumanTransportController {
  /** Exact three-callback object accepted by @mayura/server. */
  readonly transport: WorkflowLifecycleHumanTransport;
  /** Registration mode only: serve one run's human requests. A durable transport finds them itself and refuses this. */
  register(input: WorkflowLifecycleHumanRegistration): readonly string[];
  unregister(runId: string): void;
}

export interface WorkflowLifecycleHumanTransportOptions {
  readonly scope: Scope;
  /**
   * Durable discovery: the fleet runtime (or host runtime) whose index lists the active runs of `scope`. Pending
   * requests are then found in storage: nothing is registered, and a restart loses nothing. Requires `definitions`.
   */
  readonly runtime?: WorkflowLifecycleFleetRuntime;
  /** With `runtime`: every definition version whose requests this transport serves (at most 128), each with its agent. */
  readonly definitions?: readonly WorkflowLifecycleHumanRoute[];
  /** Registration mode: the most registered requests (default 512). */
  readonly maxEntries?: number;
  /** The most requests one page reads (default 256). */
  readonly maxExaminedPerPage?: number;
}

interface Entry { readonly id: string; readonly agentId: string; readonly definition: AnyWorkflowLifecycle; readonly runtime: WorkflowLifecycleRuntime;
  readonly runId: string; readonly nodeId: string }
const identifier = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const hashPattern = /^[a-f0-9]{64}$/;

function active(signal: AbortSignal): void {
  if (signal.aborted) throw new MayuraError('CANCELLED', 'Human transport request was cancelled.');
}

/**
 * A request's opaque route id. It starts with its run's two-hex index shard, so a durable transport finds a request
 * by reading one shard, and pages in id order shard by shard.
 */
function routeId(agentId: string, definitionHash: string, runId: string, nodeId: string): string {
  return runId.slice(0, 2) + digest('mayura:workflow-lifecycle-human-route:v2', { agentId, definitionHash, runId, nodeId }).slice(2);
}

/**
 * Serves format-5 human requests to the agent server's `humanRequests` transport (list, inspect, respond).
 *
 * With `runtime` and `definitions` it is durable: requests are discovered from the lifecycle fleet index, so they are
 * listed, read and answered after a restart without registering anything. Without them, each run is registered with
 * `register` and forgotten on restart. Either way, a caller sees a request only in the transport's exact scope and
 * only when its identity lists the request's agent, and an answer is recorded as the verified caller's.
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
  const durable = options.runtime !== undefined || options.definitions !== undefined;
  const routes = new Map<string, WorkflowLifecycleHumanRoute>();
  if (durable) {
    const runtime = options.runtime;
    if (!runtime || runtime.profile !== 'lifecycle-v1' || typeof runtime.scan !== 'function' || !Array.isArray(options.definitions)
      || options.definitions.length < 1 || options.definitions.length > 128) {
      throw new MayuraError('INVALID_CONFIG', 'A durable human transport needs the lifecycle fleet runtime and 1–128 definitions, each with its agentId.');
    }
    for (const route of options.definitions) {
      assertWorkflowLifecycle(route?.definition);
      if (typeof route.agentId !== 'string' || !identifier.test(route.agentId)) throw new MayuraError('INVALID_CONFIG', 'Each human transport definition needs a valid agentId.');
      if (routes.has(route.definition.digest)) throw new MayuraError('INVALID_CONFIG', 'Human transport definitions must be unique.');
      routes.set(route.definition.digest, Object.freeze({ agentId: route.agentId, definition: route.definition }));
    }
  }
  const scopeKey = digest('mayura:scope:v1', scope);
  const registered = new Map<string, Entry>();
  const exactScope = (candidate: Scope): void => {
    if (candidate?.principalId !== scope.principalId || candidate?.projectId !== scope.projectId) {
      throw new MayuraError('PERMISSION_DENIED', 'Lifecycle human transport scope does not match.');
    }
  };
  const checkedAgents = (agentIds: readonly string[]): void => {
    if (!Array.isArray(agentIds) || agentIds.length > 256 || agentIds.some(id => !identifier.test(id))
      || new Set(agentIds).size !== agentIds.length) throw new MayuraError('INVALID_INPUT', 'Lifecycle human transport agent visibility is invalid.');
  };
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
  /** The human requests of the active runs in one index shard, in route id order. */
  const shardEntries = async (shard: number): Promise<Entry[]> => {
    const runtime = options.runtime!; const candidates: WorkflowLifecycleFleetCandidate[] = []; let afterId = '';
    for (let reads = 0; reads < 8; reads++) {
      let page;
      try { page = await runtime.scan({ cursor: { format: 1, scope: scopeKey, shard, afterId }, limit: 128, maxShardReads: 1 }); }
      catch (error) {
        // The fleet runtime refuses a cursor for another scope: the transport and runtime serve different scopes.
        if (error instanceof MayuraError && error.code === 'INVALID_INPUT') throw new MayuraError('INVALID_CONFIG', 'The human transport and its lifecycle runtime serve different scopes.');
        throw error;
      }
      candidates.push(...page.candidates);
      if (!page.nextCursor || page.nextCursor.shard !== shard) break;
      afterId = page.nextCursor.afterId;
    }
    return candidates.flatMap(candidate => {
      const route = routes.get(candidate.definitionHash); if (!route) return [];
      return route.definition.nodes.filter(node => node.kind === 'human').map(node => Object.freeze({
        id: routeId(route.agentId, candidate.definitionHash, candidate.runId, node.id), agentId: route.agentId, definition: route.definition,
        runtime, runId: candidate.runId, nodeId: node.id }));
    }).sort((left, right) => left.id.localeCompare(right.id));
  };
  const find = async (id: string): Promise<Entry | undefined> => durable
    ? (await shardEntries(Number.parseInt(id.slice(0, 2), 16))).find(entry => entry.id === id)
    : registered.get(id);
  const page = async (agentIds: readonly string[], after: string | null, limit: number, signal: AbortSignal): Promise<{ items: WorkflowLifecycleHumanTransportRecord[]; next: string | null }> => {
    const items: WorkflowLifecycleHumanTransportRecord[] = []; let examined = 0; let cursor: string | null = null;
    const visible = (entry: Entry): boolean => agentIds.includes(entry.agentId) && (after === null || entry.id > after);
    if (!durable) {
      const ordered = [...registered.values()].filter(visible).sort((left, right) => left.id.localeCompare(right.id));
      for (const entry of ordered) {
        if (items.length >= limit || examined >= maxExaminedPerPage) break;
        active(signal); examined += 1; cursor = entry.id;
        const item = await requestFor(entry); if (item) items.push(item);
      }
      return { items, next: cursor !== null && ordered.some(entry => entry.id > cursor!) ? cursor : null };
    }
    // Route ids start with their shard, so walking shards in order walks ids in order.
    for (let shard = after === null ? 0 : Number.parseInt(after.slice(0, 2), 16); shard < 256; shard++) {
      active(signal);
      for (const entry of (await shardEntries(shard)).filter(visible)) {
        if (items.length >= limit || examined >= maxExaminedPerPage) return { items, next: cursor };
        active(signal); examined += 1; cursor = entry.id;
        const item = await requestFor(entry); if (item) items.push(item);
      }
    }
    return { items, next: null };
  };
  const transport = Object.freeze<WorkflowLifecycleHumanTransport>({
    list: async input => {
      exactScope(input.scope); active(input.signal);
      checkedAgents(input.agentIds);
      if ((input.after !== null && !hashPattern.test(input.after)) || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
        throw new MayuraError('INVALID_INPUT', 'Lifecycle human request page is invalid.');
      }
      const result = await page(input.agentIds, input.after, input.limit, input.signal);
      active(input.signal); return freezeJson(jsonValue(result)) as unknown as { readonly items: readonly WorkflowLifecycleHumanTransportRecord[]; readonly next: string | null };
    },
    inspect: async input => {
      exactScope(input.scope); active(input.signal);
      checkedAgents(input.agentIds);
      if (!hashPattern.test(input.id)) throw new MayuraError('INVALID_INPUT', 'Lifecycle human request identity is invalid.');
      const entry = await find(input.id); if (!entry || !input.agentIds.includes(entry.agentId)) return null;
      const item = await requestFor(entry); active(input.signal); return item;
    },
    respond: async input => {
      exactScope(input.scope); active(input.signal);
      checkedAgents(input.agentIds);
      if (!hashPattern.test(input.id) || !hashPattern.test(input.requestDigest) || !identifier.test(input.commandId)
        || !identifier.test(input.actorId)) {
        throw new MayuraError('INVALID_INPUT', 'Lifecycle human response identity is invalid.');
      }
      const entry = await find(input.id);
      if (!entry || !input.agentIds.includes(entry.agentId)) throw new MayuraError('NOT_FOUND', 'Lifecycle human request was not found.');
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
      if (durable) throw new MayuraError('INVALID_CONFIG', 'This human transport finds requests in storage; runs need no registration.');
      assertWorkflowLifecycle(input.definition);
      if (!identifier.test(input.agentId) || !hashPattern.test(input.runId) || input.runtime?.profile !== 'lifecycle-v1') {
        throw new MayuraError('INVALID_INPUT', 'Lifecycle human registration is invalid.');
      }
      const nodes = input.definition.nodes.filter(node => node.kind === 'human');
      const ids = nodes.map(node => routeId(input.agentId, input.definition.digest, input.runId, node.id));
      const additions = ids.filter(id => !registered.has(id)).length;
      if (registered.size + additions > maxEntries) throw new MayuraError('LIMIT_EXCEEDED', 'Lifecycle human transport registry is full.');
      for (const [index, node] of nodes.entries()) {
        const id = ids[index]!; const previous = registered.get(id);
        if (previous && (previous.agentId !== input.agentId || previous.definition !== input.definition
          || previous.runtime !== input.runtime || previous.runId !== input.runId || previous.nodeId !== node.id)) {
          throw new MayuraError('CONFLICT', 'Lifecycle human route ID collision.');
        }
        registered.set(id, Object.freeze({ ...input, id, nodeId: node.id }));
      }
      return Object.freeze(ids);
    },
    unregister: runId => {
      if (!hashPattern.test(runId)) throw new MayuraError('INVALID_INPUT', 'Lifecycle run ID is invalid.');
      for (const [id, entry] of registered) if (entry.runId === runId) registered.delete(id);
    },
  });
}
