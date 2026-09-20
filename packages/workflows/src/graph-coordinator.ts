import { freezeJson, jsonValue, MayuraError, type ErrorCode, type JsonObject } from '@mayura/core';
import { StorageError, workflowGraphDiscoveryCommand, workflowGraphResources, workflowPolicy,
  type ExecutionRef, type WorkflowGraphDiscoveryAggregateStore, type WorkflowGraphDiscoveryCursor,
  type WorkflowGraphDiscoveryPage, type WorkflowGraphDiscoveryScan, type WorkflowResourcePlan } from '@mayura/storage-contracts';
import { digest } from './definition.js';
import { assertWorkflowGraph, graphManifest, type AnyWorkflowGraph } from './graph-definition.js';
import { createWorkflowGraphDiscovery } from './graph-discovery.js';
import { createScheduledDriver } from './scheduled.js';
import type { WorkflowGraphRuntimeOptions, WorkflowGraphSnapshot } from './graphs.js';

export interface WorkflowGraphCatalogEntry {
  readonly definition: AnyWorkflowGraph;
  /** Exactly one immutable plan per definition digest; omission means empty resources. */
  readonly resources?: WorkflowResourcePlan;
}
export interface WorkflowGraphCoordinatorOptions extends Omit<WorkflowGraphRuntimeOptions,
  'store' | 'resources' | 'verifyHuman' | 'maxConcurrentRuns'> {
  readonly store: WorkflowGraphDiscoveryAggregateStore;
  readonly definitions: readonly WorkflowGraphCatalogEntry[];
}
export type WorkflowGraphCandidateOutcome =
  | { readonly kind: 'observed'; readonly reference: ExecutionRef; readonly version: number; readonly status: WorkflowGraphSnapshot['status'] }
  | { readonly kind: 'skipped'; readonly reference: ExecutionRef; readonly reason: 'unregistered_definition' }
  | { readonly kind: 'failed'; readonly reference: ExecutionRef; readonly code: ErrorCode }
  | { readonly kind: 'not_attempted'; readonly reference: ExecutionRef };
export type WorkflowGraphPageReport =
  | { readonly status: 'completed'; readonly examined: number; readonly nextCursor: WorkflowGraphDiscoveryCursor | null; readonly outcomes: readonly WorkflowGraphCandidateOutcome[] }
  | { readonly status: 'interrupted'; readonly examined: number; readonly retryCursor: WorkflowGraphDiscoveryCursor | null; readonly code: ErrorCode; readonly outcomes: readonly WorkflowGraphCandidateOutcome[] };
export interface WorkflowGraphCoordinator {
  /** Process one explicit discovery page; completion does not imply every run succeeded. */
  runPage(command?: { readonly cursor?: WorkflowGraphDiscoveryCursor | null; readonly limit?: number }): Promise<WorkflowGraphPageReport>;
  /** Stop local admission/waits, preserving durable runs, shared storage and late evidence. */
  close(): Promise<void>;
}

const errorCodes = new Set<ErrorCode>(['INVALID_CONFIG', 'INVALID_INPUT', 'INVALID_OUTPUT', 'INVALID_JSON', 'PERMISSION_DENIED',
  'BUDGET_EXCEEDED', 'LIMIT_EXCEEDED', 'CANCELLED', 'TIMEOUT', 'TOOL_FAILED', 'MODEL_FAILED', 'GUARD_BLOCKED', 'GUARD_UNAVAILABLE',
  'OUTCOME_UNKNOWN', 'UNSUPPORTED_PROFILE', 'NOT_FOUND', 'CONFLICT', 'STORAGE_UNAVAILABLE']);
const statuses = new Set<WorkflowGraphSnapshot['status']>(['running', 'waiting', 'succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown']);
const graphMethods = ['initialize', 'submit', 'inspect', 'requestApproval', 'approve', 'prepare', 'claim', 'renew', 'start',
  'recordReceipt', 'complete', 'abandon', 'failNode', 'advance', 'finalize', 'cancel', 'recover'] as const;
const invalidConfig = (): MayuraError => new MayuraError('INVALID_CONFIG', 'Graph coordination requires a bounded genuine catalog, exact resource plans and explicit worker policy.');
const invalidInput = (): MayuraError => new MayuraError('INVALID_INPUT', 'Graph coordination requires exact bounded page fields matching its configured scope and policy.');
const cancelled = (): MayuraError => new MayuraError('CANCELLED', 'The graph coordinator is closed.');

/** Never execute exception getters, serializers or arbitrary public-error methods. */
function safeCode(error: unknown): ErrorCode {
  try {
    if (error instanceof MayuraError || error instanceof StorageError) {
      const field = Object.getOwnPropertyDescriptor(error, 'code'); const code: unknown = field && 'value' in field ? field.value : undefined;
      if (code === 'QUEUE_FULL') return 'LIMIT_EXCEEDED';
      if (typeof code === 'string' && errorCodes.has(code as ErrorCode)) return code as ErrorCode;
    }
  } catch { /* Trusted-code proxy failures never become public diagnostics. */ }
  return 'STORAGE_UNAVAILABLE';
}
function fields(value: unknown, allowed: readonly string[], required: readonly string[] = []): PropertyDescriptorMap {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalidConfig();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !allowed.includes(key))
    || Object.values(descriptors).some(field => !field.enumerable || !('value' in field))
    || required.some(key => !Object.hasOwn(descriptors, key))) throw invalidConfig();
  return descriptors;
}
function positive(value: unknown, fallback: number, maximum: number, minimum = 1): number {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < minimum || result > maximum) throw invalidConfig();
  return result;
}
function member(value: object, name: string): unknown {
  let current: object | null = value;
  for (let depth = 0; current && depth < 16; depth++, current = Object.getPrototypeOf(current) as object | null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) { if (!('value' in descriptor)) throw invalidConfig(); return descriptor.value; }
  }
  throw invalidConfig();
}
function methods(source: unknown, names: readonly string[]): Readonly<Record<string, (...args: unknown[]) => unknown>> {
  if (!source || typeof source !== 'object') throw invalidConfig();
  return Object.freeze(Object.fromEntries(names.map(name => {
    const method = member(source, name); if (typeof method !== 'function') throw invalidConfig();
    return [name, (...args: unknown[]) => Reflect.apply(method, source, args)];
  })));
}
/** Both private facades see one captured backend; no getter can swap it between construction steps. */
function captureStore(value: unknown): WorkflowGraphDiscoveryAggregateStore {
  try {
    if (!value || typeof value !== 'object') throw invalidConfig();
    return Object.freeze({ ...methods(value, ['read', 'events']),
      workflowGraphs: methods(member(value, 'workflowGraphs'), graphMethods),
      workflowGraphDiscovery: methods(member(value, 'workflowGraphDiscovery'), ['initialize', 'scan']),
    }) as unknown as WorkflowGraphDiscoveryAggregateStore;
  } catch { throw new MayuraError('UNSUPPORTED_PROFILE', 'The adapter must provide both graph execution and graph discovery capabilities.'); }
}

/** Capture the finite executable catalog without trying to JSON-serialize application handlers. */
function catalog(value: unknown): readonly { readonly definition: AnyWorkflowGraph; readonly resources: WorkflowResourcePlan }[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw invalidConfig();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== value.length + 1 || Object.getOwnPropertySymbols(value).length) throw invalidConfig();
  const seen = new Set<string>(); let bytes = 0; const encoder = new TextEncoder();
  return Object.freeze(Array.from({ length: value.length }, (_, index) => {
    const item = descriptors[String(index)]; if (!item || !item.enumerable || !('value' in item)) throw invalidConfig();
    const entry = fields(item.value, ['definition', 'resources'], ['definition']);
    const definition = entry['definition']!.value as AnyWorkflowGraph;
    assertWorkflowGraph(definition);
    if (seen.has(definition.digest)) throw invalidConfig(); seen.add(definition.digest);
    const manifest = graphManifest(definition);
    if (digest('mayura:workflow:v2', manifest) !== definition.digest) throw invalidConfig();
    const resources = workflowGraphResources(entry['resources']?.value === undefined ? {} : entry['resources'].value, manifest);
    // Canonical ordering changes no JSON byte lengths. Count each already-owned
    // manifest/plan separately, without a combined unrelated JSON node-count cap.
    bytes += encoder.encode(JSON.stringify(manifest)).length + encoder.encode(JSON.stringify(resources)).length;
    if (bytes > 4_194_304) throw invalidConfig();
    return Object.freeze({ definition, resources });
  }));
}
function frozenReport(value: WorkflowGraphPageReport): WorkflowGraphPageReport {
  return freezeJson(jsonValue(value, { maxBytes: 65_536, maxNodes: 4_096, maxDepth: 12 })) as unknown as WorkflowGraphPageReport;
}

/** Explicit finite orchestration of independent roots; no child ownership or shared money is implied. */
export function createWorkflowGraphCoordinator(options: WorkflowGraphCoordinatorOptions): WorkflowGraphCoordinator {
  let descriptors: PropertyDescriptorMap; let definitions: ReturnType<typeof catalog>; let policy: ReturnType<typeof workflowPolicy>;
  let workerId: string; let leaseMs: number; let maxConcurrentJobs: number; let storageTimeoutMs: number; let maxPendingStorageOperations: number;
  try {
    descriptors = fields(options, ['store', 'definitions', 'scope', 'permissions', 'policyVersion', 'maxCostMicros', 'maxOutputBytes',
      'approvalTtlMs', 'workerId', 'leaseMs', 'maxConcurrentJobs', 'storageTimeoutMs', 'maxPendingStorageOperations'],
    ['store', 'definitions', 'scope', 'permissions', 'policyVersion', 'maxCostMicros', 'workerId']);
    definitions = catalog(descriptors['definitions']!.value);
    const raw = jsonValue({ scope: descriptors['scope']!.value, permissions: descriptors['permissions']!.value,
      policyVersion: descriptors['policyVersion']!.value, maxCostMicros: descriptors['maxCostMicros']!.value,
      maxOutputBytes: descriptors['maxOutputBytes']?.value === undefined ? 65_536 : descriptors['maxOutputBytes'].value,
      approvalTtlMs: descriptors['approvalTtlMs']?.value === undefined ? 3_600_000 : descriptors['approvalTtlMs'].value }) as JsonObject;
    const permissions = fields(raw['permissions'], ['allow'], ['allow']);
    policy = workflowPolicy({ ...raw, permissions: permissions['allow']!.value });
    const id: unknown = descriptors['workerId']!.value;
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(id)) throw invalidConfig(); workerId = id;
    leaseMs = positive(descriptors['leaseMs']?.value, 3_000, 300_000, 1_000);
    maxConcurrentJobs = positive(descriptors['maxConcurrentJobs']?.value, 4, 32);
    storageTimeoutMs = positive(descriptors['storageTimeoutMs']?.value, 10_000, 30_000);
    maxPendingStorageOperations = positive(descriptors['maxPendingStorageOperations']?.value, 64, 1_024);
  } catch { throw invalidConfig(); }
  const store = captureStore(descriptors['store']!.value);
  const shared = { store, scope: policy.scope, permissions: { allow: policy.permissions }, policyVersion: policy.policyVersion,
    maxCostMicros: policy.maxCostMicros, maxOutputBytes: policy.maxOutputBytes, approvalTtlMs: policy.approvalTtlMs,
    storageTimeoutMs, maxPendingStorageOperations };
  const discovery = createWorkflowGraphDiscovery(shared);
  const driver = createScheduledDriver({ ...shared, workerId, leaseMs, maxConcurrentJobs, maxConcurrentRuns: 1 }, 'scheduled-v2', definitions);
  const registered = new Map(definitions.map(entry => [entry.definition.digest, entry.definition]));
  const scope = digest('mayura:scope:v1', policy.scope); const policyHash = digest('mayura:policy:v1', policy);
  let closed = false; let activePage = false; let closing: Promise<void> | undefined;

  return Object.freeze<WorkflowGraphCoordinator>({
    async runPage(command = {}): Promise<WorkflowGraphPageReport> {
      if (closed) throw cancelled();
      if (activePage) throw new MayuraError('LIMIT_EXCEEDED', 'The coordinator already has one active page.');
      // Reflective proxies can reenter synchronously, even though accessors are
      // forbidden. Reserve admission before inspecting any caller-owned value.
      activePage = true;
      try {
        let admitted: WorkflowGraphDiscoveryScan;
        try {
          const raw = jsonValue(command, { maxBytes: 1_024 }); const values = fields(raw, ['cursor', 'limit']);
          admitted = workflowGraphDiscoveryCommand('scan', { scope, policyHash,
            cursor: values['cursor'] ? values['cursor'].value : null,
            limit: values['limit'] ? values['limit'].value : 16 }) as unknown as WorkflowGraphDiscoveryScan;
        } catch { throw closed ? cancelled() : invalidInput(); }
        if (closed) throw cancelled();
        let page: WorkflowGraphDiscoveryPage;
        try { page = await discovery.scan({ cursor: admitted.cursor, limit: admitted.limit }); }
        catch (error) { throw closed ? cancelled() : new MayuraError(safeCode(error), 'Graph coordination could not discover a valid page.'); }
        const outcomes: WorkflowGraphCandidateOutcome[] = []; let stopped: ErrorCode | undefined;
        for (const candidate of page.candidates) {
          if (closed || stopped) {
            stopped ??= 'CANCELLED'; outcomes.push({ kind: 'not_attempted', reference: candidate.reference }); continue;
          }
          const definition = registered.get(candidate.reference.definitionHash);
          if (!definition) { outcomes.push({ kind: 'skipped', reference: candidate.reference, reason: 'unregistered_definition' }); continue; }
          try {
            const result = await driver.runUntilSettled(definition, candidate.reference.runId);
            if (result.id !== candidate.reference.runId || !Number.isSafeInteger(result.version) || result.version < candidate.version
              || !statuses.has(result.status)) throw new MayuraError('STORAGE_UNAVAILABLE', 'Graph continuation returned inconsistent identity metadata.');
            outcomes.push({ kind: 'observed', reference: candidate.reference, version: result.version, status: result.status });
          } catch (error) {
            stopped = closed ? 'CANCELLED' : safeCode(error); outcomes.push({ kind: 'failed', reference: candidate.reference, code: stopped });
          }
        }
        // This synchronous publication is the completion point. A later close
        // cannot rewrite a result, while close during the last await still stops it.
        if (closed) stopped = 'CANCELLED';
        return stopped
          ? frozenReport({ status: 'interrupted', examined: page.examined, retryCursor: admitted.cursor, code: stopped, outcomes })
          : frozenReport({ status: 'completed', examined: page.examined, nextCursor: page.nextCursor, outcomes });
      } finally { activePage = false; }
    },
    close(): Promise<void> {
      if (!closing) { closed = true; closing = Promise.allSettled([discovery.close(), driver.close()]).then(() => {}); }
      return closing;
    },
  });
}
