import { createHash } from 'node:crypto';
import { assertPositiveInteger, freezeJson, jsonValue, MayuraError, type JsonObject, type JsonValue, type Scope } from '@mayura/core';
import type { MemoryEntry, MemoryRecord, MemoryStore, MemoryTombstone } from '@mayura/memory';

const metadataFormat = 'mayura.remote-memory.v1';
const hostedMem0 = 'https://api.mem0.ai';
const hostedSupermemory = 'https://api.supermemory.ai';

export interface RemoteMemoryReference {
  readonly provider: string;
  readonly kind: 'entry' | 'operation';
  readonly id: string;
}
export interface RemotePublishReceipt {
  readonly status: 'applied' | 'accepted';
  readonly reference: RemoteMemoryReference;
}
export interface RemoteMemoryCandidate {
  readonly namespace: string;
  readonly canonicalId: string;
  readonly canonicalVersion: number;
  readonly contentSha256: string;
  readonly score: number;
  readonly reference: RemoteMemoryReference;
}
export interface RemoteMemoryAdapter {
  readonly id: string;
  publish(record: MemoryRecord, namespace: string, previous: RemoteMemoryReference | undefined, signal: AbortSignal): Promise<RemotePublishReceipt>;
  remove(tombstone: MemoryTombstone, namespace: string, reference: RemoteMemoryReference, signal: AbortSignal): Promise<void>;
  search(query: string, namespace: string, limit: number, signal: AbortSignal): Promise<readonly RemoteMemoryCandidate[]>;
}
export interface RemoteMemorySearchHit {
  readonly record: MemoryRecord;
  readonly score: number;
  readonly reference: RemoteMemoryReference;
}
export interface RemoteMemorySearchResult {
  readonly mode: 'semantic-index';
  readonly provider: string;
  readonly hits: readonly RemoteMemorySearchHit[];
  readonly excluded: Readonly<{ wrongScope: number; stale: number; deleted: number; duplicate: number }>;
}
export interface RemoteMemoryBridge {
  readonly namespace: string;
  readonly provider: string;
  publish(record: MemoryRecord, options?: { readonly previous?: RemoteMemoryReference; readonly signal?: AbortSignal }): Promise<RemotePublishReceipt>;
  remove(tombstone: MemoryTombstone, reference: RemoteMemoryReference, options?: { readonly signal?: AbortSignal }): Promise<void>;
  search(query: string, options?: { readonly limit?: number; readonly signal?: AbortSignal }): Promise<RemoteMemorySearchResult>;
}

interface HttpOptions {
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly fetch?: typeof globalThis.fetch;
}
export interface Mem0MemoryOptions extends HttpOptions { readonly apiKey: string }
export interface SupermemoryOptions extends HttpOptions { readonly apiKey: string }
export interface OpenVikingOptions extends HttpOptions {
  readonly endpoint: string;
  readonly auth?: Readonly<{ scheme: 'x-api-key' | 'bearer'; apiKey: string }>;
}

class RemoteFailure extends MayuraError {
  constructor(message = 'The remote memory service returned an unavailable or invalid response.') { super('TOOL_FAILED', message); }
}
const fail = (message?: string): never => { throw new RemoteFailure(message); };
const hash = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const immutable = <T>(value: T): T => freezeJson(jsonValue(value)) as unknown as T;
function bounded(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > maxBytes) throw new MayuraError('INVALID_CONFIG', `${label} must be a bounded nonempty string.`);
  return value;
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value)) return fail();
  return value;
}
function remoteId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || /[\r\n]/u.test(value) || Buffer.byteLength(value) > 1_024) return fail();
  return value;
}
function object(value: JsonValue | undefined): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value;
}
function number(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) return fail();
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return fail();
  return value;
}
function metadata(record: MemoryRecord, namespace: string): JsonObject {
  return { mayura_format: metadataFormat, mayura_namespace: namespace, mayura_id: record.id,
    mayura_version: record.version, mayura_sha256: record.contentSha256 };
}
function candidate(provider: string, rawMetadata: JsonValue | undefined, scoreValue: unknown, referenceId: unknown): RemoteMemoryCandidate {
  const item = object(rawMetadata);
  if (item['mayura_format'] !== metadataFormat || typeof item['mayura_namespace'] !== 'string'
    || typeof item['mayura_sha256'] !== 'string' || !/^[a-f0-9]{64}$/u.test(item['mayura_sha256'])) return fail();
  return immutable<RemoteMemoryCandidate>({ namespace: item['mayura_namespace'], canonicalId: identifier(item['mayura_id']),
    canonicalVersion: integer(item['mayura_version']), contentSha256: item['mayura_sha256'], score: number(scoreValue, 0, 1),
    reference: { provider, kind: 'entry', id: remoteId(referenceId) } });
}
function validatedCandidate(value: unknown): RemoteMemoryCandidate {
  const item = object(jsonValue(value, { maxBytes: 4_096 })); const reference = object(item['reference']);
  if (typeof item['namespace'] !== 'string' || typeof item['contentSha256'] !== 'string' || !/^[a-f0-9]{64}$/u.test(item['contentSha256'])
    || typeof reference['provider'] !== 'string' || reference['kind'] !== 'entry') return fail();
  return immutable({ namespace: item['namespace'], canonicalId: identifier(item['canonicalId']), canonicalVersion: integer(item['canonicalVersion']),
    contentSha256: item['contentSha256'], score: number(item['score'], 0, 1),
    reference: { provider: identifier(reference['provider']), kind: 'entry' as const, id: remoteId(reference['id']) } });
}
function validateReference(reference: RemoteMemoryReference, provider: string, kind?: 'entry' | 'operation'): string {
  if (!reference || reference.provider !== provider || (kind !== undefined && reference.kind !== kind)) throw new MayuraError('INVALID_INPUT', 'Remote memory reference does not belong to this provider operation.');
  return remoteId(reference.id);
}
function scopeNamespace(scope: Scope): string {
  const principalId = bounded(scope?.principalId, 'Principal ID', 128); const projectId = bounded(scope?.projectId, 'Project ID', 128);
  return `m_${hash(`mayura:remote-memory-scope:v1\n${JSON.stringify([principalId, projectId])}`)}`;
}
function equalScope(left: Scope, right: Scope): boolean { return left.principalId === right.principalId && left.projectId === right.projectId; }
function sameEntry(left: MemoryEntry | undefined, right: MemoryEntry): boolean {
  return left?.id === right.id && left.version === right.version && left.status === right.status && equalScope(left.scope, right.scope)
    && (left.status === 'deleted' || (right.status === 'active' && left.contentSha256 === right.contentSha256));
}
function signal(value?: AbortSignal): AbortSignal {
  if (value !== undefined && !(value instanceof AbortSignal)) throw new MayuraError('INVALID_INPUT', 'A valid cancellation signal is required.');
  return value ?? new AbortController().signal;
}
async function remote<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof RemoteFailure) throw error;
    if (error instanceof MayuraError && error.code === 'CANCELLED') throw new MayuraError('CANCELLED', 'Remote memory request was cancelled or timed out.');
    if (error instanceof MayuraError && error.code === 'INVALID_INPUT') throw new MayuraError('INVALID_INPUT', 'Remote memory operation input is invalid.');
    throw new RemoteFailure();
  }
}

/** Canonical-state firewall around an untrusted remote semantic index. */
export function createRemoteMemoryBridge(options: Readonly<{ canonical: MemoryStore; adapter: RemoteMemoryAdapter; scope: Scope }>): RemoteMemoryBridge {
  if (!options?.canonical || typeof options.canonical.get !== 'function' || !options.adapter
    || !['publish', 'remove', 'search'].every(method => typeof (options.adapter as unknown as Record<string, unknown>)[method] === 'function')) {
    throw new MayuraError('INVALID_CONFIG', 'Remote memory requires a canonical store and adapter.');
  }
  const scope = Object.freeze({ principalId: bounded(options.scope?.principalId, 'Principal ID', 128), projectId: bounded(options.scope?.projectId, 'Project ID', 128) });
  const namespace = scopeNamespace(scope); const adapter = options.adapter; const provider = identifier(adapter.id); const canonical = options.canonical;
  const current = async (entry: MemoryEntry): Promise<void> => {
    if (!equalScope(entry.scope, scope)) throw new MayuraError('PERMISSION_DENIED', 'Remote memory entry belongs to another scope.');
    const stored = await canonical.get(entry.id, { includeDeleted: true });
    if (!sameEntry(stored, entry)) throw new MayuraError('CONFLICT', 'Remote memory synchronization requires the current canonical version.');
  };
  return Object.freeze<RemoteMemoryBridge>({
    namespace, provider,
    publish: async (record, publishOptions = {}) => {
      if (record.status !== 'active') throw new MayuraError('INVALID_INPUT', 'Only active canonical records can be published.');
      await current(record); return remote(() => adapter.publish(record, namespace, publishOptions.previous, signal(publishOptions.signal)));
    },
    remove: async (tombstone, reference, removeOptions = {}) => {
      if (tombstone.status !== 'deleted') throw new MayuraError('INVALID_INPUT', 'Remote deletion requires a canonical tombstone.');
      await current(tombstone); await remote(() => adapter.remove(tombstone, namespace, reference, signal(removeOptions.signal)));
    },
    search: async (query, searchOptions = {}) => {
      bounded(query, 'Memory search query', 512); const limit = searchOptions.limit ?? 10;
      assertPositiveInteger(limit, 'limit'); if (limit > 50) throw new MayuraError('INVALID_INPUT', 'Remote memory searches are limited to 50 candidates.');
      const candidates = await remote(() => adapter.search(query, namespace, limit, signal(searchOptions.signal)));
      if (!Array.isArray(candidates) || candidates.length > limit) return fail();
      const hits: RemoteMemorySearchHit[] = []; const seen = new Set<string>();
      const excluded = { wrongScope: 0, stale: 0, deleted: 0, duplicate: 0 };
      for (const item of candidates) {
        const copy = validatedCandidate(item);
        if (copy.reference.provider !== provider) return fail();
        if (copy.namespace !== namespace) { excluded.wrongScope++; continue; }
        if (seen.has(copy.canonicalId)) { excluded.duplicate++; continue; } seen.add(copy.canonicalId);
        const stored = await canonical.get(copy.canonicalId, { includeDeleted: true });
        if (!stored || !equalScope(stored.scope, scope) || stored.version !== copy.canonicalVersion
          || (stored.status === 'active' && stored.contentSha256 !== copy.contentSha256)) { excluded.stale++; continue; }
        if (stored.status === 'deleted') { excluded.deleted++; continue; }
        hits.push({ record: stored, score: number(copy.score, 0, 1), reference: copy.reference });
      }
      return immutable<RemoteMemorySearchResult>({ mode: 'semantic-index', provider, hits, excluded });
    },
  });
}

interface Client {
  request(path: string, method: 'POST' | 'PUT' | 'DELETE', body: JsonObject | undefined, signal: AbortSignal, allowEmpty?: boolean): Promise<JsonObject | undefined>;
}
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => undefined); throw new MayuraError('CANCELLED', 'Remote memory request was cancelled or timed out.'); }
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      abort = () => reject(new MayuraError('CANCELLED', 'Remote memory request was cancelled or timed out.'));
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}
async function readResponse(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) return fail(); const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  const cancelled = (): never => { throw new MayuraError('CANCELLED', 'Remote memory request was cancelled or timed out.'); };
  try {
    while (true) {
      if (signal.aborted) return cancelled();
      const item = await abortable(reader.read(), signal);
      if (item.done) break; size += item.value.byteLength; if (size > limit) return fail(); chunks.push(item.value);
    }
    const result = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
function httpClient(baseUrl: string, options: HttpOptions, headers: Readonly<Record<string, string>>): Client {
  const timeoutMs = options.timeoutMs ?? 30_000; const maxRequestBytes = options.maxRequestBytes ?? 64 * 1_024; const maxResponseBytes = options.maxResponseBytes ?? 256 * 1_024;
  assertPositiveInteger(timeoutMs, 'timeoutMs'); assertPositiveInteger(maxRequestBytes, 'maxRequestBytes'); assertPositiveInteger(maxResponseBytes, 'maxResponseBytes');
  if (timeoutMs > 2_147_483_647) throw new MayuraError('INVALID_CONFIG', 'Remote memory timeout exceeds the supported timer range.');
  const transport = options.fetch ?? globalThis.fetch; if (typeof transport !== 'function') throw new MayuraError('INVALID_CONFIG', 'A fetch-compatible transport is required.');
  return Object.freeze<Client>({ request: async (path, method, value, callerSignal, allowEmpty = false) => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const combined = AbortSignal.any([callerSignal, controller.signal]);
      if (combined.aborted) throw new MayuraError('CANCELLED', 'Remote memory request was cancelled.');
      let body: string | undefined;
      if (value !== undefined) body = JSON.stringify(jsonValue(value, { maxBytes: maxRequestBytes }));
      const response = await abortable(transport(`${baseUrl}${path}`, { method, headers, ...(body === undefined ? {} : { body }), signal: combined, redirect: 'error', credentials: 'omit' }), combined);
      if (!response.ok || response.redirected || (!allowEmpty && !response.body)) { void response.body?.cancel().catch(() => undefined); return fail(); }
      if (allowEmpty && (response.status === 204 || !response.body)) { void response.body?.cancel().catch(() => undefined); return undefined; }
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maxResponseBytes)) { void response.body?.cancel().catch(() => undefined); return fail(); }
      const bytes = await readResponse(response, maxResponseBytes, combined);
      if (allowEmpty && bytes.byteLength === 0) return undefined;
      const parsed = jsonValue(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), { maxBytes: maxResponseBytes });
      return object(parsed);
    } catch (error) {
      if (callerSignal.aborted || controller.signal.aborted) throw new MayuraError('CANCELLED', 'Remote memory request was cancelled or timed out.');
      if (error instanceof RemoteFailure || error instanceof MayuraError && error.code === 'LIMIT_EXCEEDED') throw error;
      return fail();
    } finally { clearTimeout(timer); }
  } });
}
function key(value: string | undefined): string {
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/u.test(value) || value.length > 4_096) throw new MayuraError('INVALID_CONFIG', 'A bounded explicit API key is required.');
  return value;
}
function resultArray(value: JsonValue | undefined): JsonValue[] { if (!Array.isArray(value)) return fail(); return value; }

/** Fixed-destination Mem0 Platform adapter. V3 adds may return an operation reference until search resolves an entry ID. */
export function mem0Memory(options: Mem0MemoryOptions): RemoteMemoryAdapter {
  const provider = 'mem0'; const client = httpClient(hostedMem0, options, { Authorization: `Token ${key(options.apiKey)}`, 'Content-Type': 'application/json' });
  return Object.freeze<RemoteMemoryAdapter>({ id: provider,
    publish: async (record, namespace, previous, requestSignal) => {
      if (previous?.kind === 'entry') {
        const id = validateReference(previous, provider, 'entry');
        await client.request(`/v1/memories/${encodeURIComponent(id)}/`, 'PUT', { text: record.content, metadata: metadata(record, namespace) }, requestSignal);
        return immutable<RemotePublishReceipt>({ status: 'applied', reference: previous });
      }
      if (previous) validateReference(previous, provider, 'operation');
      const response = await client.request('/v3/memories/add/', 'POST', { messages: [{ role: 'user', content: record.content }],
        user_id: namespace, metadata: metadata(record, namespace) }, requestSignal);
      if (response?.['status'] !== 'PENDING') return fail();
      return immutable<RemotePublishReceipt>({ status: 'accepted', reference: { provider, kind: 'operation', id: identifier(response['event_id']) } });
    },
    remove: async (_tombstone, _namespace, reference, requestSignal) => {
      const id = validateReference(reference, provider, 'entry'); await client.request(`/v1/memories/${encodeURIComponent(id)}/`, 'DELETE', undefined, requestSignal, true);
    },
    search: async (query, namespace, limit, requestSignal) => {
      const response = await client.request('/v3/memories/search/', 'POST', { query, filters: { AND: [{ user_id: namespace }] }, top_k: limit }, requestSignal);
      return immutable(resultArray(response?.['results']).map(raw => { const hit = object(raw); return candidate(provider, hit['metadata'], hit['score'], hit['id']); }));
    },
  });
}

/** Fixed-destination Supermemory document adapter with exact container isolation. */
export function supermemory(options: SupermemoryOptions): RemoteMemoryAdapter {
  const provider = 'supermemory'; const client = httpClient(hostedSupermemory, options, { Authorization: `Bearer ${key(options.apiKey)}`, 'Content-Type': 'application/json' });
  return Object.freeze<RemoteMemoryAdapter>({ id: provider,
    publish: async (record, namespace, previous, requestSignal) => {
      if (previous !== undefined) {
        const oldId = validateReference(previous, provider, 'entry');
        await client.request(`/v3/documents/${encodeURIComponent(oldId)}`, 'DELETE', undefined, requestSignal, true);
      }
      const response = await client.request('/v3/documents', 'POST', { content: record.content, containerTag: namespace,
        customId: `mayura_${hash(`${namespace}\n${record.id}`)}`, metadata: metadata(record, namespace) }, requestSignal);
      return immutable<RemotePublishReceipt>({ status: response?.['status'] === 'done' ? 'applied' : 'accepted',
        reference: { provider, kind: 'entry', id: identifier(response?.['id']) } });
    },
    remove: async (_tombstone, _namespace, reference, requestSignal) => {
      const id = validateReference(reference, provider, 'entry'); await client.request(`/v3/documents/${encodeURIComponent(id)}`, 'DELETE', undefined, requestSignal, true);
    },
    search: async (query, namespace, limit, requestSignal) => {
      const response = await client.request('/v4/search', 'POST', { query, containerTags: [namespace], searchMode: 'hybrid', limit }, requestSignal);
      return immutable(resultArray(response?.['results']).map(raw => { const hit = object(raw); return candidate(provider, hit['metadata'], hit['score'], hit['docId']); }));
    },
  });
}

function openVikingEndpoint(endpointValue: string): string {
  let endpoint: URL; try { endpoint = new URL(endpointValue); } catch { throw new MayuraError('INVALID_CONFIG', 'A valid OpenViking endpoint is required.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if ((endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new MayuraError('INVALID_CONFIG', 'OpenViking requires HTTPS or an HTTP loopback endpoint without embedded credentials.');
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/u, ''); return endpoint.href.replace(/\/$/u, '');
}
function openVikingEnvelope(record: MemoryRecord, namespace: string): string {
  return JSON.stringify({ ...metadata(record, namespace), content: record.content });
}

/** Explicit OpenViking HTTP adapter for hosted or loopback deployments. */
export function openViking(options: OpenVikingOptions): RemoteMemoryAdapter {
  const provider = 'openviking'; const base = openVikingEndpoint(options.endpoint); const remote = !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/iu.test(base);
  if (remote && !options.auth) throw new MayuraError('INVALID_CONFIG', 'Remote OpenViking endpoints require explicit authentication.');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.auth) headers[options.auth.scheme === 'bearer' ? 'Authorization' : 'X-API-Key'] = options.auth.scheme === 'bearer' ? `Bearer ${key(options.auth.apiKey)}` : key(options.auth.apiKey);
  const client = httpClient(base, options, headers);
  const uri = (namespace: string, recordId: string): string => `viking://~/memories/mayura/${namespace}/${hash(recordId)}.json`;
  return Object.freeze<RemoteMemoryAdapter>({ id: provider,
    publish: async (record, namespace, previous, requestSignal) => {
      const target = uri(namespace, record.id);
      if (previous !== undefined && validateReference(previous, provider, 'entry') !== target) throw new MayuraError('INVALID_INPUT', 'OpenViking reference does not match the canonical record path.');
      const response = await client.request('/api/v1/content/write', 'POST', { uri: target, content: openVikingEnvelope(record, namespace),
        mode: 'replace', create_parents: true, wait: true, timeout: Math.min(120, Math.max(1, Math.ceil((options.timeoutMs ?? 30_000) / 1_000))) }, requestSignal);
      const result = response?.['result'] === undefined ? response : object(response['result']);
      if (result?.['uri'] !== target) return fail();
      return immutable<RemotePublishReceipt>({ status: result['semantic_status'] === 'done' || result['semantic_status'] === 'completed' ? 'applied' : 'accepted',
        reference: { provider, kind: 'entry', id: target } });
    },
    remove: async (tombstone, namespace, reference, requestSignal) => {
      const target = uri(namespace, tombstone.id); if (validateReference(reference, provider, 'entry') !== target) throw new MayuraError('INVALID_INPUT', 'OpenViking reference does not match the canonical tombstone path.');
      await client.request(`/api/v1/fs?uri=${encodeURIComponent(target)}&recursive=false`, 'DELETE', undefined, requestSignal, true);
    },
    search: async (query, namespace, limit, requestSignal) => {
      const response = await client.request('/api/v1/search/find', 'POST', { query, target_uri: `viking://~/memories/mayura/${namespace}/`,
        context_type: ['memory'], limit, read_content: true }, requestSignal);
      const result = object(response?.['result']); const memories = resultArray(result['memories']);
      return immutable(memories.map(raw => {
        const hit = object(raw); if (typeof hit['content'] !== 'string') return fail();
        const envelope = object(jsonValue(JSON.parse(hit['content']), { maxBytes: 16_384 }));
        return candidate(provider, envelope, hit['score'], hit['uri']);
      }));
    },
  });
}
