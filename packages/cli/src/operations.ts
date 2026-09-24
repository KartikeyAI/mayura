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

const identifier = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const capabilityIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
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
    if (!accepted.includes(response.status)) { void response.body?.cancel().catch(() => {}); throw new MayuraError(response.status === 401 || response.status === 403 ? 'PERMISSION_DENIED' : 'TOOL_FAILED', 'Operational request was rejected.'); }
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
