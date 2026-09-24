import { freezeJson, jsonValue, MayuraError, type JsonValue } from '@mayura/core';

export interface OperationalClientOptions {
  readonly baseUrl: string;
  /** Resolve a short-lived credential for each request. The CLI reads this from piped stdin. */
  readonly token: () => string | Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly requestTimeoutMs?: number;
  readonly maxResponseBytes?: number;
}
export interface OperationalHealthCheck { readonly id: string; readonly status: 'ready' | 'unavailable' }
export interface OperationalHealth {
  readonly status: 'ready' | 'degraded'; readonly checks: readonly OperationalHealthCheck[];
}
export interface OperationalTool {
  readonly agentId: string; readonly agentVersion: string; readonly id: string; readonly version: string;
  readonly effects: 'none' | 'read' | 'write' | 'host'; readonly capabilities: readonly string[];
  readonly timeoutMs: number; readonly costMicros: number;
}
export interface OperationalToolPage { readonly tools: readonly OperationalTool[]; readonly next: number | null }
export interface OperationalHumanRequest {
  readonly id: string; readonly agentId: string; readonly kind: 'information' | 'correction' | 'plan_selection';
  readonly schemaId: string; readonly schemaDigest: string; readonly prompt: string; readonly digest: string;
  readonly status: 'waiting' | 'answered' | 'cancelled' | 'timed_out'; readonly context?: JsonValue;
  readonly subjectDigest?: string; readonly deadlineAtMs?: number;
}
export interface OperationalHumanRequestPage { readonly items: readonly OperationalHumanRequest[]; readonly next: string | null }
export interface OperationalRunReceipt {
  readonly runId: string; readonly receipt: { readonly callId: string; readonly toolId: string;
    readonly execution: 'not_started' | 'succeeded' | 'failed' | 'unknown'; readonly disclosure: 'released' | 'withheld' };
}
export interface OperationalRun {
  readonly id: string; readonly status: 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'outcome_unknown';
  readonly budget: { readonly spentMicros: number | string; readonly reservedMicros: number; readonly calls: number };
  readonly evidence: readonly OperationalRunReceipt[];
}
export type OperationalWorkflowFormat = 2 | 3 | 4 | 5;
export type OperationalWorkflowNodeKind = 'tool' | 'join' | 'wait' | 'child' | 'human' | 'timer';
export type OperationalWorkflowStatus = 'running' | 'waiting' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'outcome_unknown';
export type OperationalWorkflowStepStatus = 'pending' | 'waiting' | 'approved' | 'dispatching' | 'succeeded' | 'failed' | 'blocked' | 'unknown' | 'skipped' | 'timed_out';
export interface OperationalWorkflowNode { readonly id: string; readonly kind: OperationalWorkflowNodeKind; readonly dependsOn: readonly string[] }
export interface OperationalWorkflowStep { readonly id: string; readonly kind: OperationalWorkflowNodeKind; readonly status: OperationalWorkflowStepStatus; readonly childRunId?: string }
export interface OperationalWorkflow {
  readonly format: OperationalWorkflowFormat; readonly definitionId: string; readonly definitionVersion: string;
  readonly runId: string; readonly revision: number; readonly status: OperationalWorkflowStatus;
  readonly nodes: readonly OperationalWorkflowNode[]; readonly steps: readonly OperationalWorkflowStep[];
}
export interface OperationalWorkflowIndexEntry {
  readonly format: OperationalWorkflowFormat; readonly definitionId: string; readonly definitionVersion: string; readonly runId: string;
  readonly revision: number; readonly status: OperationalWorkflowStatus;
}
export interface OperationalWorkflowIndexPage { readonly items: readonly OperationalWorkflowIndexEntry[]; readonly next: string | null }

const identifier = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const capabilityIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const runIdentifier = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const workflowRunIdentifier = /^[a-f0-9]{64}$/u;
const workflowNodeIdentifier = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;
const workflowVersion = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
function fail(): never { throw new MayuraError('INVALID_OUTPUT', 'The operational server returned an invalid response.'); }
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) return fail();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail();
}
function id(value: unknown): string { if (typeof value !== 'string' || !identifier.test(value)) return fail(); return value; }
function capability(value: unknown): string { if (typeof value !== 'string' || !capabilityIdentifier.test(value)) return fail(); return value; }
function natural(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) return fail(); return value as number; }
function runId(value: unknown): string { if (typeof value !== 'string' || !runIdentifier.test(value)) return fail(); return value; }
async function bounded<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void Promise.resolve(work).catch(() => {}); throw new MayuraError('TIMEOUT', 'Operational inspection was cancelled or timed out.'); }
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void => { cleanup(); reject(new MayuraError('TIMEOUT', 'Operational inspection was cancelled or timed out.')); };
    const cleanup = (): void => { signal.removeEventListener('abort', abort); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(work).then(value => { cleanup(); resolve(value); }, () => { cleanup(); reject(new MayuraError('TOOL_FAILED', 'The operational callback failed.')); });
    if (signal.aborted) abort();
  });
}

async function transport(options: OperationalClientOptions, path: string, accepted: readonly number[], method: 'GET' | 'POST' = 'GET', body?: JsonValue): Promise<Record<string, unknown>> {
  let base: URL;
  try {
    base = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash
      || (base.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) throw new Error();
  } catch { throw new MayuraError('INVALID_CONFIG', 'Operational inspection requires an HTTPS or loopback HTTP origin.'); }
  if (typeof options.token !== 'function' || (options.fetch !== undefined && typeof options.fetch !== 'function')) throw new MayuraError('INVALID_CONFIG', 'Operational inspection requires explicit credential and transport callbacks.');
  const timeout = options.requestTimeoutMs ?? 10_000; const maximum = options.maxResponseBytes ?? 262_144;
  if (![timeout, maximum].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 4_194_304)) throw new MayuraError('INVALID_CONFIG', 'Operational transport limits are invalid.');
  const controller = new AbortController(); const abort = (): void => { controller.abort(); };
  options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
  const timer = setTimeout(abort, timeout);
  try {
    let credential: string;
    try { credential = await bounded(Promise.resolve().then(options.token), controller.signal); }
    catch (error) {
      if (error instanceof MayuraError && error.code === 'TIMEOUT') throw error;
      throw new MayuraError('PERMISSION_DENIED', 'Operational credential resolution failed.');
    }
    if (controller.signal.aborted) throw new MayuraError('TIMEOUT', 'Operational inspection was cancelled or timed out.');
    if (typeof credential !== 'string' || !/^[\x21-\x7e]{1,8192}$/u.test(credential)) throw new MayuraError('INVALID_CONFIG', 'Operational credential format is invalid.');
    let response: Response;
    try {
      response = await bounded(Promise.resolve().then(() => (options.fetch ?? globalThis.fetch.bind(globalThis))(new URL(path, base), {
        method, headers: { Authorization: `Bearer ${credential}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, signal: controller.signal,
        redirect: 'error', credentials: 'omit', cache: 'no-store',
        ...(body === undefined ? {} : { body: JSON.stringify(jsonValue(body, { maxBytes: maximum })) }),
      })), controller.signal);
    } catch (error) {
      if (error instanceof MayuraError && error.code === 'TIMEOUT') throw error;
      throw new MayuraError('TOOL_FAILED', 'The operational server could not be reached.');
    }
    if (response.redirected || (response.url && new URL(response.url).origin !== base.origin)) { void response.body?.cancel().catch(() => {}); throw new MayuraError('PERMISSION_DENIED', 'Operational redirects are denied.'); }
    if (!accepted.includes(response.status)) { void response.body?.cancel().catch(() => {});
      const code = response.status === 401 || response.status === 403 ? 'PERMISSION_DENIED' : response.status === 404 ? 'NOT_FOUND'
        : response.status === 409 || response.status === 412 ? 'CONFLICT' : 'TOOL_FAILED';
      throw new MayuraError(code, 'Operational request was rejected.'); }
    if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) { void response.body?.cancel().catch(() => {}); return fail(); }
    const reader = response.body?.getReader(); if (!reader) return fail();
    const chunks: Uint8Array[] = []; let size = 0; let complete = false;
    try {
      while (true) {
        const next = await bounded(reader.read(), controller.signal); if (next.done) { complete = true; break; }
        size += next.value.byteLength; if (size > maximum) throw new MayuraError('LIMIT_EXCEEDED', 'Operational response exceeded its configured limit.');
        chunks.push(next.value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      try { return record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); } catch { return fail(); }
    } finally { if (!complete) void reader.cancel().catch(() => {}); reader.releaseLock(); }
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); controller.abort(); }
}

function human(value: unknown): OperationalHumanRequest {
  const item = record(value); const allowed = ['id', 'agentId', 'kind', 'schemaId', 'schemaDigest', 'prompt', 'digest', 'status', 'context', 'subjectDigest', 'deadlineAtMs'];
  if (Object.keys(item).some(key => !allowed.includes(key)) || !['id', 'agentId', 'kind', 'schemaId', 'schemaDigest', 'prompt', 'digest', 'status'].every(key => Object.hasOwn(item, key))) return fail();
  const requestId = typeof item['id'] === 'string' ? item['id'] : ''; const agentId = id(item['agentId']); const schemaId = id(item['schemaId']);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(requestId) || !['information', 'correction', 'plan_selection'].includes(String(item['kind']))
    || !/^[a-f0-9]{64}$/u.test(String(item['schemaDigest'])) || !/^[a-f0-9]{64}$/u.test(String(item['digest']))
    || typeof item['prompt'] !== 'string' || new TextEncoder().encode(item['prompt']).byteLength < 1 || new TextEncoder().encode(item['prompt']).byteLength > 1_024
    || !['waiting', 'answered', 'cancelled', 'timed_out'].includes(String(item['status']))
    || (item['subjectDigest'] !== undefined && !/^[a-f0-9]{64}$/u.test(String(item['subjectDigest'])))
    || ((item['kind'] === 'correction') !== (item['subjectDigest'] !== undefined))
    || (item['deadlineAtMs'] !== undefined && (!Number.isSafeInteger(item['deadlineAtMs']) || (item['deadlineAtMs'] as number) < 0))) return fail();
  return Object.freeze({ id: requestId, agentId, kind: item['kind'] as OperationalHumanRequest['kind'], schemaId,
    schemaDigest: item['schemaDigest'] as string, prompt: item['prompt'], digest: item['digest'] as string, status: item['status'] as OperationalHumanRequest['status'],
    ...(item['context'] === undefined ? {} : { context: freezeJson(jsonValue(item['context'], { maxBytes: 65_536 })) }),
    ...(item['subjectDigest'] === undefined ? {} : { subjectDigest: item['subjectDigest'] as string }),
    ...(item['deadlineAtMs'] === undefined ? {} : { deadlineAtMs: item['deadlineAtMs'] as number }) });
}

function run(value: unknown, expectedId: string): OperationalRun {
  const item = record(value); const allowed = ['id', 'status', 'budget', 'evidence', 'outcome'];
  if (Object.keys(item).some(key => !allowed.includes(key)) || !['id', 'status', 'budget', 'evidence'].every(key => Object.hasOwn(item, key))
    || runId(item['id']) !== expectedId || !['running', 'succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown'].includes(String(item['status']))) return fail();
  const budget = record(item['budget']); exact(budget, ['spentMicros', 'reservedMicros', 'calls']); const spent = budget['spentMicros'];
  if (typeof spent === 'string' ? !/^\d{1,64}$/u.test(spent) : !Number.isSafeInteger(spent) || (spent as number) < 0) return fail();
  if (!Array.isArray(item['evidence']) || item['evidence'].length > 4_096) return fail();
  const evidence = item['evidence'].map(raw => { const entry = record(raw); exact(entry, ['runId', 'receipt']); const receipt = record(entry['receipt']);
    exact(receipt, ['callId', 'toolId', 'execution', 'disclosure']);
    if (!['not_started', 'succeeded', 'failed', 'unknown'].includes(String(receipt['execution'])) || !['released', 'withheld'].includes(String(receipt['disclosure']))) return fail();
    return Object.freeze({ runId: runId(entry['runId']), receipt: Object.freeze({ callId: id(receipt['callId']), toolId: id(receipt['toolId']),
      execution: receipt['execution'] as OperationalRunReceipt['receipt']['execution'], disclosure: receipt['disclosure'] as OperationalRunReceipt['receipt']['disclosure'] }) });
  });
  return Object.freeze({ id: expectedId, status: item['status'] as OperationalRun['status'], budget: Object.freeze({ spentMicros: spent as number | string,
    reservedMicros: natural(budget['reservedMicros']), calls: natural(budget['calls']) }), evidence: Object.freeze(evidence) });
}

function workflow(value: unknown, expectedId: string): OperationalWorkflow {
  const item = record(value); exact(item, ['format', 'definitionId', 'definitionVersion', 'runId', 'revision', 'status', 'nodes', 'steps']);
  const format = item['format'] as OperationalWorkflowFormat; const definitionId = item['definitionId']; const definitionVersion = item['definitionVersion'];
  if (![2, 3, 4, 5].includes(format) || typeof definitionId !== 'string' || !workflowNodeIdentifier.test(definitionId)
    || typeof definitionVersion !== 'string' || !workflowVersion.test(definitionVersion) || item['runId'] !== expectedId
    || !Number.isSafeInteger(item['revision']) || (item['revision'] as number) < 1
    || !['running', 'waiting', 'succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown'].includes(String(item['status']))
    || !Array.isArray(item['nodes']) || item['nodes'].length < 1 || item['nodes'].length > 128
    || !Array.isArray(item['steps']) || item['steps'].length !== item['nodes'].length) return fail();
  const allowedKinds: Readonly<Record<OperationalWorkflowFormat, ReadonlySet<OperationalWorkflowNodeKind>>> = {
    2: new Set(['tool', 'join']), 3: new Set(['tool', 'join', 'wait']), 4: new Set(['tool', 'join', 'child']), 5: new Set(['tool', 'join', 'human', 'timer']),
  };
  const nodes = new Map<string, OperationalWorkflowNode>(); let edges = 0;
  for (const raw of item['nodes']) {
    const source = record(raw); exact(source, ['id', 'kind', 'dependsOn']); const nodeId = source['id']; const kind = source['kind'] as OperationalWorkflowNodeKind;
    if (typeof nodeId !== 'string' || !workflowNodeIdentifier.test(nodeId) || nodes.has(nodeId) || !allowedKinds[format].has(kind)
      || !Array.isArray(source['dependsOn']) || source['dependsOn'].length > 127) return fail();
    const dependsOn = source['dependsOn'].map(value => { if (typeof value !== 'string' || !workflowNodeIdentifier.test(value)) return fail(); return value; });
    if (new Set(dependsOn).size !== dependsOn.length || (edges += dependsOn.length) > 512) return fail();
    nodes.set(nodeId, Object.freeze({ id: nodeId, kind, dependsOn: Object.freeze(dependsOn) }));
  }
  for (const node of nodes.values()) if (node.dependsOn.some(parent => parent === node.id || !nodes.has(parent))) return fail();
  const indegree = new Map([...nodes].map(([nodeId, node]) => [nodeId, node.dependsOn.length])); const children = new Map<string, string[]>();
  for (const node of nodes.values()) for (const parent of node.dependsOn) { const list = children.get(parent) ?? []; list.push(node.id); children.set(parent, list); }
  const ready = [...indegree].filter(([, count]) => count === 0).map(([nodeId]) => nodeId); let visited = 0;
  for (let cursor = 0; cursor < ready.length; cursor++) { const nodeId = ready[cursor]!; visited += 1;
    for (const child of children.get(nodeId) ?? []) { const count = indegree.get(child)! - 1; indegree.set(child, count); if (count === 0) ready.push(child); }
  }
  if (visited !== nodes.size) return fail();
  const statuses = new Set<OperationalWorkflowStepStatus>(['pending', 'waiting', 'approved', 'dispatching', 'succeeded', 'failed', 'blocked', 'unknown', 'skipped', 'timed_out']);
  const steps = new Map<string, OperationalWorkflowStep>();
  for (const raw of item['steps']) {
    const source = record(raw); const keys = Object.keys(source); if (keys.some(key => !['id', 'kind', 'status', 'childRunId'].includes(key))
      || !['id', 'kind', 'status'].every(key => Object.hasOwn(source, key))) return fail();
    const stepId = source['id']; const kind = source['kind'] as OperationalWorkflowNodeKind; const status = source['status'] as OperationalWorkflowStepStatus;
    const node = typeof stepId === 'string' ? nodes.get(stepId) : undefined; const childRunId = source['childRunId'];
    if (!node || steps.has(stepId as string) || kind !== node.kind || !statuses.has(status)
      || (kind === 'human' && !['pending', 'waiting', 'succeeded', 'timed_out', 'skipped'].includes(status))
      || (kind === 'timer' && !['pending', 'waiting', 'succeeded', 'skipped'].includes(status)) || (status === 'timed_out' && kind !== 'human')
      || (childRunId !== undefined && (kind !== 'child' || typeof childRunId !== 'string' || !workflowRunIdentifier.test(childRunId)))) return fail();
    steps.set(stepId as string, Object.freeze({ id: stepId as string, kind, status, ...(childRunId === undefined ? {} : { childRunId: childRunId as string }) }));
  }
  return Object.freeze({ format, definitionId, definitionVersion, runId: expectedId, revision: item['revision'] as number,
    status: item['status'] as OperationalWorkflowStatus, nodes: Object.freeze([...nodes.values()]), steps: Object.freeze([...steps.values()]) });
}

function workflowIndexEntry(value: unknown): OperationalWorkflowIndexEntry {
  const item = record(value); exact(item, ['format', 'definitionId', 'definitionVersion', 'runId', 'revision', 'status']);
  if (![2, 3, 4, 5].includes(item['format'] as number) || typeof item['definitionId'] !== 'string' || !workflowNodeIdentifier.test(item['definitionId'])
    || typeof item['definitionVersion'] !== 'string' || !workflowVersion.test(item['definitionVersion']) || typeof item['runId'] !== 'string'
    || !workflowRunIdentifier.test(item['runId']) || !Number.isSafeInteger(item['revision']) || (item['revision'] as number) < 1
    || !['running', 'waiting', 'succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown'].includes(String(item['status']))) return fail();
  return Object.freeze({ format: item['format'] as OperationalWorkflowFormat, definitionId: item['definitionId'], definitionVersion: item['definitionVersion'],
    runId: item['runId'], revision: item['revision'] as number, status: item['status'] as OperationalWorkflowStatus });
}

/** Read sanitized readiness metadata. HTTP 503 is a valid degraded report, not a transport failure. */
export async function inspectServerHealth(options: OperationalClientOptions): Promise<OperationalHealth> {
  const raw = await transport(options, '/v1/operations/health', [200, 503]); exact(raw, ['status', 'checks']);
  if (!['ready', 'degraded'].includes(String(raw['status'])) || !Array.isArray(raw['checks']) || raw['checks'].length < 1 || raw['checks'].length > 33) return fail();
  const seen = new Set<string>(); const checks = raw['checks'].map(value => {
    const item = record(value); exact(item, ['id', 'status']); const checkId = id(item['id']);
    if (seen.has(checkId) || !['ready', 'unavailable'].includes(String(item['status']))) return fail();
    seen.add(checkId); return Object.freeze({ id: checkId, status: item['status'] as 'ready' | 'unavailable' });
  });
  const status = raw['status'] as 'ready' | 'degraded';
  if (checks[0]?.id !== 'server' || checks[0].status !== 'ready' || (status === 'ready') !== checks.every(check => check.status === 'ready')) return fail();
  return Object.freeze({ status, checks: Object.freeze(checks) });
}

/** Read one metadata-only tool page. Pagination is explicit and never followed automatically. */
export async function inspectServerTools(options: OperationalClientOptions, page: { readonly after?: number; readonly limit?: number } = {}): Promise<OperationalToolPage> {
  const after = page.after ?? 0; const limit = page.limit ?? 50;
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new MayuraError('INVALID_CONFIG', 'Operational catalog pagination is invalid.');
  const raw = await transport(options, `/v1/tools?after=${after}&limit=${limit}`, [200]); exact(raw, ['tools', 'next']);
  if (!Array.isArray(raw['tools']) || raw['tools'].length > limit || (raw['next'] !== null && (!Number.isSafeInteger(raw['next']) || (raw['next'] as number) <= after))) return fail();
  const tools = raw['tools'].map(value => {
    const item = record(value); exact(item, ['agentId', 'agentVersion', 'id', 'version', 'effects', 'capabilities', 'timeoutMs', 'costMicros']);
    if (!['none', 'read', 'write', 'host'].includes(String(item['effects'])) || !Array.isArray(item['capabilities']) || item['capabilities'].length > 256) return fail();
    const capabilities = item['capabilities'].map(capability);
    return Object.freeze({ agentId: id(item['agentId']), agentVersion: id(item['agentVersion']), id: id(item['id']), version: id(item['version']),
      effects: item['effects'] as OperationalTool['effects'], capabilities: Object.freeze(capabilities),
      timeoutMs: natural(item['timeoutMs']), costMicros: natural(item['costMicros']) });
  });
  return Object.freeze({ tools: Object.freeze(tools), next: raw['next'] === null ? null : natural(raw['next']) });
}

/** Read one explicit page of authorized human requests. */
export async function inspectHumanRequests(options: OperationalClientOptions,
  page: { readonly after?: string; readonly limit?: number } = {}): Promise<OperationalHumanRequestPage> {
  const limit = page.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (page.after !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/u.test(page.after))) throw new MayuraError('INVALID_CONFIG', 'Human request pagination is invalid.');
  const query = new URLSearchParams({ limit: String(limit), ...(page.after === undefined ? {} : { after: page.after }) });
  const raw = await transport(options, `/v1/human-requests?${query}`, [200]); exact(raw, ['items', 'next']);
  if (!Array.isArray(raw['items']) || raw['items'].length > limit || (raw['next'] !== null && (typeof raw['next'] !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(raw['next'])))) return fail();
  const items = raw['items'].map(human); if (new Set(items.map(item => item.id)).size !== items.length) return fail();
  return Object.freeze({ items: Object.freeze(items), next: raw['next'] as string | null });
}

/** Inspect one authorized human request. */
export async function inspectHumanRequest(options: OperationalClientOptions, requestId: string): Promise<OperationalHumanRequest> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(requestId)) throw new MayuraError('INVALID_CONFIG', 'Human request ID is invalid.');
  const raw = await transport(options, `/v1/human-requests/${requestId}`, [200]); exact(raw, ['request']);
  const result = human(raw['request']); if (result.id !== requestId) return fail(); return result;
}

/** Submit one response bound to the exact request digest; actor identity comes from server authentication. */
export async function respondHumanRequest(options: OperationalClientOptions, input: {
  readonly id: string; readonly requestDigest: string; readonly commandId: string; readonly value: JsonValue;
}): Promise<OperationalHumanRequest> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(input.id) || !/^[a-f0-9]{64}$/u.test(input.requestDigest) || !identifier.test(input.commandId)) throw new MayuraError('INVALID_CONFIG', 'Human response identity is invalid.');
  const raw = await transport(options, `/v1/human-requests/${input.id}/responses`, [200], 'POST',
    { commandId: input.commandId, requestDigest: input.requestDigest, value: input.value }); exact(raw, ['request']);
  const result = human(raw['request']);
  if (result.id !== input.id || result.digest !== input.requestDigest || result.status === 'waiting') return fail(); return result;
}

/** Inspect metadata and effect evidence for one authorized run. Output/error payloads are intentionally omitted. */
export async function inspectRun(options: OperationalClientOptions, id: string): Promise<OperationalRun> {
  if (!runIdentifier.test(id)) throw new MayuraError('INVALID_CONFIG', 'Run ID is invalid.');
  return run(await transport(options, `/v1/runs/${id}`, [200]), id);
}

/** Submit one cancellation request. It is never retried after an ambiguous acknowledgement. */
export async function cancelRun(options: OperationalClientOptions, id: string): Promise<void> {
  if (!runIdentifier.test(id)) throw new MayuraError('INVALID_CONFIG', 'Run ID is invalid.');
  const raw = await transport(options, `/v1/runs/${id}/cancel`, [202], 'POST'); exact(raw, ['id', 'cancellationRequested']);
  if (raw['id'] !== id || raw['cancellationRequested'] !== true) return fail();
}

/** Inspect one authorized content-free durable workflow view. */
export async function inspectWorkflow(options: OperationalClientOptions, id: string): Promise<OperationalWorkflow> {
  if (!workflowRunIdentifier.test(id)) throw new MayuraError('INVALID_CONFIG', 'Workflow run ID is invalid.');
  const raw = await transport(options, `/v1/workflow-runs/${id}`, [200]); exact(raw, ['workflow']); return workflow(raw['workflow'], id);
}

/** Read one explicit page of authorized content-free durable workflow summaries. */
export async function inspectWorkflows(options: OperationalClientOptions,
  page: { readonly after?: string; readonly limit?: number } = {}): Promise<OperationalWorkflowIndexPage> {
  const limit = page.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (page.after !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/u.test(page.after)))
    throw new MayuraError('INVALID_CONFIG', 'Workflow pagination is invalid.');
  const query = new URLSearchParams({ limit: String(limit), ...(page.after === undefined ? {} : { after: page.after }) });
  const raw = await transport(options, `/v1/workflow-runs?${query}`, [200]); exact(raw, ['items', 'next']);
  if (!Array.isArray(raw['items']) || raw['items'].length > limit || (raw['next'] !== null
    && (typeof raw['next'] !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(raw['next']) || raw['next'] === page.after))) return fail();
  const items = raw['items'].map(workflowIndexEntry); if (new Set(items.map(item => item.runId)).size !== items.length) return fail();
  return Object.freeze({ items: Object.freeze(items), next: raw['next'] as string | null });
}

/** Submit one revision-bound durable cancellation command without automatic retry. */
export async function cancelWorkflow(options: OperationalClientOptions, input: {
  readonly id: string; readonly revision: number; readonly commandId: string;
}): Promise<OperationalWorkflow> {
  if (!workflowRunIdentifier.test(input.id) || !Number.isSafeInteger(input.revision) || input.revision < 1 || !identifier.test(input.commandId))
    throw new MayuraError('INVALID_CONFIG', 'Workflow cancellation identity is invalid.');
  const raw = await transport(options, `/v1/workflow-runs/${input.id}/cancel`, [200], 'POST', { commandId: input.commandId, revision: input.revision });
  exact(raw, ['workflow']); const result = workflow(raw['workflow'], input.id); if (result.revision < input.revision) return fail(); return result;
}

/** Submit one exact digest-bound workflow approval without automatic retry. */
export async function approveWorkflow(options: OperationalClientOptions, input: {
  readonly id: string; readonly revision: number; readonly commandId: string; readonly nodeId: string;
  readonly approvalDigest: string; readonly childRunId?: string;
}): Promise<OperationalWorkflow> {
  if (!workflowRunIdentifier.test(input.id) || !Number.isSafeInteger(input.revision) || input.revision < 1 || !identifier.test(input.commandId)
    || !workflowNodeIdentifier.test(input.nodeId) || !workflowRunIdentifier.test(input.approvalDigest)
    || (input.childRunId !== undefined && !workflowRunIdentifier.test(input.childRunId)))
    throw new MayuraError('INVALID_CONFIG', 'Workflow approval identity is invalid.');
  const raw = await transport(options, `/v1/workflow-runs/${input.id}/approvals`, [200], 'POST', { commandId: input.commandId, revision: input.revision,
    nodeId: input.nodeId, approvalDigest: input.approvalDigest, childRunId: input.childRunId ?? null });
  exact(raw, ['workflow']); const result = workflow(raw['workflow'], input.id); if (result.revision < input.revision) return fail(); return result;
}

/** Deliver one revision-bound durable signal without automatic retry. */
export async function signalWorkflow(options: OperationalClientOptions, input: {
  readonly id: string; readonly revision: number; readonly commandId: string; readonly signalId: string;
  readonly signalName: string; readonly value: JsonValue;
}): Promise<OperationalWorkflow> {
  if (!workflowRunIdentifier.test(input.id) || !Number.isSafeInteger(input.revision) || input.revision < 1 || !identifier.test(input.commandId)
    || !identifier.test(input.signalId) || !identifier.test(input.signalName))
    throw new MayuraError('INVALID_CONFIG', 'Workflow signal identity is invalid.');
  const value = jsonValue(input.value, { maxBytes: 4_096, maxDepth: 16, maxNodes: 1_024 });
  const raw = await transport(options, `/v1/workflow-runs/${input.id}/signals`, [200], 'POST', { commandId: input.commandId,
    revision: input.revision, signalId: input.signalId, signalName: input.signalName, value });
  exact(raw, ['workflow']); const result = workflow(raw['workflow'], input.id); if (result.revision < input.revision) return fail(); return result;
}

/** Request one revision-bound continuation without forcing a waiting gate or retrying automatically. */
export async function resumeWorkflow(options: OperationalClientOptions, input: {
  readonly id: string; readonly revision: number; readonly commandId: string;
}): Promise<OperationalWorkflow> {
  if (!workflowRunIdentifier.test(input.id) || !Number.isSafeInteger(input.revision) || input.revision < 1 || !identifier.test(input.commandId))
    throw new MayuraError('INVALID_CONFIG', 'Workflow resume identity is invalid.');
  const raw = await transport(options, `/v1/workflow-runs/${input.id}/resume`, [200], 'POST', { commandId: input.commandId, revision: input.revision });
  exact(raw, ['workflow']); const result = workflow(raw['workflow'], input.id); if (result.revision < input.revision) return fail(); return result;
}

/** Bounded explicit polling of read-only run state; commands are never issued or retried. */
export async function waitForRun(options: OperationalClientOptions, id: string,
  settings: { readonly pollIntervalMs?: number; readonly maxWaitMs?: number } = {}): Promise<OperationalRun> {
  if (!runIdentifier.test(id)) throw new MayuraError('INVALID_CONFIG', 'Run ID is invalid.');
  const interval = settings.pollIntervalMs ?? 1_000; const maximum = settings.maxWaitMs ?? 60_000;
  if (!Number.isSafeInteger(interval) || interval < 250 || interval > 10_000 || !Number.isSafeInteger(maximum) || maximum < interval || maximum > 300_000) throw new MayuraError('INVALID_CONFIG', 'Run wait limits are invalid.');
  const controller = new AbortController(); const abort = (): void => controller.abort(); options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
  const timer = setTimeout(abort, maximum);
  const pause = () => new Promise<void>((resolve, reject) => { const done = (): void => { clearTimeout(delay); controller.signal.removeEventListener('abort', cancelled); resolve(); };
    const cancelled = (): void => { clearTimeout(delay); controller.signal.removeEventListener('abort', cancelled); reject(new MayuraError('TIMEOUT', 'Run wait was cancelled or timed out.')); };
    const delay = setTimeout(done, interval); controller.signal.addEventListener('abort', cancelled, { once: true }); if (controller.signal.aborted) cancelled(); });
  try {
    while (true) { const current = await inspectRun({ ...options, signal: controller.signal }, id); if (current.status !== 'running') return current; await pause(); }
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); controller.abort(); }
}
