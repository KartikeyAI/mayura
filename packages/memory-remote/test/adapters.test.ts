import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Scope } from '@mayura/core';
import type { MemoryRecord, MemoryStore, MemoryTombstone } from '@mayura/memory';
import { createRemoteMemoryBridge, mem0Memory, openViking, supermemory, type RemoteMemoryAdapter, type RemoteMemoryCandidate } from '../src/index.js';

const scope: Scope = { principalId: 'owner-private', projectId: 'project-private' };
const record = (overrides: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id: 'decision-1', version: 1, status: 'active', scope, category: 'decision', content: 'Use strict TypeScript.', contentSha256: 'a'.repeat(64),
  metadata: {}, sensitivity: 'internal', createdAt: '2026-09-24T00:00:00.000Z', updatedAt: '2026-09-24T00:00:00.000Z',
  provenance: { sourceId: 'source', reference: 'source://one', revision: 'r1', sha256: 'b'.repeat(64), author: 'owner',
    observedAt: '2026-09-24T00:00:00.000Z', origin: 'observed', confidence: 1 },
  validity: { from: '2026-09-24T00:00:00.000Z', until: null }, ...overrides,
});
const tombstone = (overrides: Partial<MemoryTombstone> = {}): MemoryTombstone => ({
  id: 'decision-1', version: 2, status: 'deleted', scope, sensitivity: 'internal', createdAt: '2026-09-24T00:00:00.000Z',
  updatedAt: '2026-09-24T01:00:00.000Z', deletedAt: '2026-09-24T01:00:00.000Z', ...overrides,
});
function canonical(entries: readonly (MemoryRecord | MemoryTombstone)[]): MemoryStore {
  const values = new Map(entries.map(entry => [entry.id, entry]));
  return { get: async id => values.get(id), add: async () => { throw new Error('unused'); }, correct: async () => { throw new Error('unused'); },
    forget: async () => { throw new Error('unused'); }, list: async () => ({ records: [], revision: 0 }),
    search: async () => ({ mode: 'lexical', revision: 0, hits: [] }),
    exportSnapshot: async () => ({ format: 'mayura.memory.export.v1', scope, revision: 0, exportedAt: '2026-09-24T00:00:00.000Z', records: [] }) };
}
const candidate = (namespace: string, overrides: Partial<RemoteMemoryCandidate> = {}): RemoteMemoryCandidate => ({
  namespace, canonicalId: 'decision-1', canonicalVersion: 1, contentSha256: 'a'.repeat(64), score: 0.9,
  reference: { provider: 'fixture', kind: 'entry', id: 'remote-1' }, ...overrides,
});
const response = (value: unknown, status = 200): Response => new Response(status === 204 ? null : JSON.stringify(value), { status });

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('canonical remote-memory bridge', () => {
  it('publishes only the current canonical scope/version and never sends raw scope identifiers', async () => {
    const publish = vi.fn<RemoteMemoryAdapter['publish']>().mockResolvedValue({ status: 'applied', reference: { provider: 'fixture', kind: 'entry', id: 'remote-1' } });
    const adapter: RemoteMemoryAdapter = { id: 'fixture', publish, remove: vi.fn(), search: vi.fn().mockResolvedValue([]) };
    const bridge = createRemoteMemoryBridge({ canonical: canonical([record()]), adapter, scope });
    await expect(bridge.publish(record())).resolves.toMatchObject({ status: 'applied' });
    expect(bridge.namespace).toMatch(/^m_[a-f0-9]{64}$/u); expect(bridge.namespace).not.toContain('owner-private');
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ id: 'decision-1' }), bridge.namespace, undefined, expect.any(AbortSignal));
    await expect(bridge.publish(record({ version: 2 }))).rejects.toMatchObject({ code: 'CONFLICT' }); expect(publish).toHaveBeenCalledTimes(1);
    await expect(bridge.publish(record({ scope: { principalId: 'other', projectId: scope.projectId } }))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('rehydrates current canonical content and excludes wrong-scope, stale, deleted and duplicate hits', async () => {
    const active = record(); const deleted = tombstone({ id: 'deleted-1' });
    const search = vi.fn<RemoteMemoryAdapter['search']>();
    const adapter: RemoteMemoryAdapter = { id: 'fixture', publish: vi.fn(), remove: vi.fn(), search };
    const bridge = createRemoteMemoryBridge({ canonical: canonical([active, deleted]), adapter, scope });
    search.mockResolvedValue([
      candidate(bridge.namespace), candidate('m_wrong'), candidate(bridge.namespace, { canonicalId: 'missing' }),
      candidate(bridge.namespace, { canonicalId: 'deleted-1', canonicalVersion: 2 }), candidate(bridge.namespace),
    ]);
    const result = await bridge.search('typescript', { limit: 5 });
    expect(result.hits).toEqual([{ record: active, score: 0.9, reference: { provider: 'fixture', kind: 'entry', id: 'remote-1' } }]);
    expect(result.excluded).toEqual({ wrongScope: 1, stale: 1, deleted: 1, duplicate: 1 });
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.hits[0]!.record)).toBe(true);
  });

  it('requires the exact current tombstone before external deletion', async () => {
    const remove = vi.fn<RemoteMemoryAdapter['remove']>().mockResolvedValue();
    const adapter: RemoteMemoryAdapter = { id: 'fixture', publish: vi.fn(), remove, search: vi.fn().mockResolvedValue([]) };
    const current = tombstone(); const bridge = createRemoteMemoryBridge({ canonical: canonical([current]), adapter, scope });
    await bridge.remove(current, { provider: 'fixture', kind: 'entry', id: 'remote-1' }); expect(remove).toHaveBeenCalledOnce();
    await expect(bridge.remove(tombstone({ version: 3 }), { provider: 'fixture', kind: 'entry', id: 'remote-1' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('Mem0 adapter', () => {
  it('uses fixed endpoints, explicit token auth and continuity metadata', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response({ status: 'PENDING', event_id: 'event-1' }))
      .mockResolvedValueOnce(response({ results: [{ id: 'memory-1', memory: 'ignored', score: 0.8, metadata: {
        mayura_format: 'mayura.remote-memory.v1', mayura_namespace: 'm_scope', mayura_id: 'decision-1', mayura_version: 1, mayura_sha256: 'a'.repeat(64),
      } }] }))
      .mockResolvedValueOnce(response(undefined, 204));
    const adapter = mem0Memory({ apiKey: 'explicit', fetch }); const signal = new AbortController().signal;
    await expect(adapter.publish(record(), 'm_scope', undefined, signal)).resolves.toEqual({ status: 'accepted', reference: { provider: 'mem0', kind: 'operation', id: 'event-1' } });
    await expect(adapter.search('typescript', 'm_scope', 5, signal)).resolves.toHaveLength(1);
    await adapter.remove(tombstone(), 'm_scope', { provider: 'mem0', kind: 'entry', id: 'memory-1' }, signal);
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['https://api.mem0.ai/v3/memories/add/', 'https://api.mem0.ai/v3/memories/search/', 'https://api.mem0.ai/v1/memories/memory-1/']);
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: 'Token explicit' });
    const body = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string); expect(body.user_id).toBe('m_scope'); expect(body.metadata.mayura_version).toBe(1);
    expect(JSON.stringify(body)).not.toContain('owner-private');
  });

  it('refuses deletion by an unresolved asynchronous operation reference', async () => {
    const adapter = mem0Memory({ apiKey: 'explicit', fetch: vi.fn() });
    await expect(adapter.remove(tombstone(), 'm_scope', { provider: 'mem0', kind: 'operation', id: 'event-1' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('enforces timeout and response bounds even when a custom transport ignores cancellation', async () => {
    const hanging = mem0Memory({ apiKey: 'explicit', timeoutMs: 5, fetch: vi.fn(() => new Promise<Response>(() => undefined)) });
    await expect(hanging.search('query', 'm_scope', 1, new AbortController().signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    const oversized = mem0Memory({ apiKey: 'explicit', maxResponseBytes: 8,
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ results: [] }))) });
    await expect(oversized.search('query', 'm_scope', 1, new AbortController().signal)).rejects.toMatchObject({ code: 'TOOL_FAILED' });
  });
});

describe('Supermemory adapter', () => {
  it('replaces an explicit prior document, publishes a deterministic custom ID and scopes search', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(undefined, 204)).mockResolvedValueOnce(response({ id: 'doc-new', status: 'queued' }))
      .mockResolvedValueOnce(response({ results: [{ docId: 'doc-new', score: 0.7, metadata: {
        mayura_format: 'mayura.remote-memory.v1', mayura_namespace: 'm_scope', mayura_id: 'decision-1', mayura_version: 1, mayura_sha256: 'a'.repeat(64),
      } }] }));
    const adapter = supermemory({ apiKey: 'explicit', fetch }); const signal = new AbortController().signal;
    const receipt = await adapter.publish(record(), 'm_scope', { provider: 'supermemory', kind: 'entry', id: 'doc-old' }, signal);
    expect(receipt).toEqual({ status: 'accepted', reference: { provider: 'supermemory', kind: 'entry', id: 'doc-new' } });
    await adapter.search('typescript', 'm_scope', 4, signal);
    expect(fetch.mock.calls.map(call => call[0])).toEqual(['https://api.supermemory.ai/v3/documents/doc-old', 'https://api.supermemory.ai/v3/documents', 'https://api.supermemory.ai/v4/search']);
    const publishBody = JSON.parse(fetch.mock.calls[1]?.[1]?.body as string); expect(publishBody.containerTag).toBe('m_scope');
    expect(publishBody.customId).toMatch(/^mayura_[a-f0-9]{64}$/u);
    expect(JSON.parse(fetch.mock.calls[2]?.[1]?.body as string)).toMatchObject({ containerTags: ['m_scope'], searchMode: 'hybrid', limit: 4 });
  });
});

describe('OpenViking adapter', () => {
  it.each(['http://remote.example', 'ftp://127.0.0.1:1933', 'https://user:pass@example.com'])('rejects unsafe endpoint %s', endpoint => {
    expect(() => openViking({ endpoint, auth: { scheme: 'bearer', apiKey: 'explicit' } })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it('requires explicit auth remotely but permits explicit local unauthenticated development', () => {
    expect(() => openViking({ endpoint: 'https://openviking.example' })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(openViking({ endpoint: 'http://127.0.0.1:1933', fetch: vi.fn() }).id).toBe('openviking');
  });

  it('writes, retrieves and deletes one exact scoped URI without trusting returned content', async () => {
    let target = '';
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url, init) => {
      if (String(url).endsWith('/api/v1/content/write')) {
        const body = JSON.parse(init?.body as string); target = body.uri;
        return response({ status: 'ok', result: { uri: target, semantic_status: 'completed' } });
      }
      if (String(url).endsWith('/api/v1/search/find')) return response({ status: 'ok', result: { memories: [{ uri: target, score: 0.95,
        content: JSON.stringify({ mayura_format: 'mayura.remote-memory.v1', mayura_namespace: 'm_scope', mayura_id: 'decision-1',
          mayura_version: 1, mayura_sha256: 'a'.repeat(64), content: 'provider copy is not authoritative' }) }] } });
      return response(undefined, 204);
    });
    const adapter = openViking({ endpoint: 'https://openviking.example/base', auth: { scheme: 'x-api-key', apiKey: 'explicit' }, fetch });
    const signal = new AbortController().signal; const receipt = await adapter.publish(record(), 'm_scope', undefined, signal);
    expect(target).toMatch(/^viking:\/\/~\/memories\/mayura\/m_scope\/[a-f0-9]{64}\.json$/u);
    expect(receipt.status).toBe('applied'); await expect(adapter.search('typescript', 'm_scope', 3, signal)).resolves.toHaveLength(1);
    await adapter.remove(tombstone(), 'm_scope', receipt.reference, signal);
    expect(fetch.mock.calls.map(call => call[0])).toEqual([
      'https://openviking.example/base/api/v1/content/write', 'https://openviking.example/base/api/v1/search/find',
      `https://openviking.example/base/api/v1/fs?uri=${encodeURIComponent(target)}&recursive=false`,
    ]);
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ 'X-API-Key': 'explicit' });
    expect(JSON.stringify(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string))).not.toContain('owner-private');
  });

  it('sanitizes arbitrary provider failures', async () => {
    const adapter = openViking({ endpoint: 'http://127.0.0.1:1933', fetch: vi.fn().mockRejectedValue(new Error('PRIVATE transport')) });
    const error: unknown = await adapter.publish(record(), 'm_scope', undefined, new AbortController().signal).catch(value => value);
    expect(error).toMatchObject({ code: 'TOOL_FAILED' }); expect(JSON.stringify(error)).not.toContain('PRIVATE');
  });
});
