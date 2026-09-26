import { describe, expect, it, vi } from 'vitest';
import type { Scope } from '@mayura/core';
import { createContextCache, type AssembleContextOptions, type ContextCandidate, type SourceState } from '../src/index.js';

const scope: Scope = { principalId: 'alice', projectId: 'project-a' };
const item = (id: string, revision = '1'): ContextCandidate => ({ id, scope, source: { id: `source.${id}`, revision, kind: 'memory' },
  provenance: { reference: `memory://${id}`, observedAt: '2026-09-20T00:00:00.000Z', origin: 'observed', confidence: 1 },
  kind: 'evidence', sensitivity: 'internal', trust: 'reviewed', content: { note: id } });
const options = (items: readonly ContextCandidate[], overrides: Partial<AssembleContextOptions> = {}): AssembleContextOptions => ({
  scope, policyVersion: 'policy-1', asOf: '2026-09-20T12:00:00.000Z', candidates: items,
  sources: items.map((entry): SourceState => ({ scope, id: entry.source.id, revision: entry.source.revision, status: 'active' })),
  allowedSensitivities: ['internal'], budget: { maxBytes: 100_000, maxEstimatedTokens: 100_000 }, ...overrides,
});

describe('context cache', () => {
  it('returns the identical assembly for an identical admission key and misses on any source revision change', async () => {
    const cache = createContextCache();
    const first = await cache.assemble(options([item('a'), item('b')]));
    expect(await cache.assemble(options([item('a'), item('b')]))).toBe(first);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, entries: 1 });
    const revised = await cache.assemble(options([item('a', '2'), item('b')]));
    expect(revised).not.toBe(first); expect(revised.fingerprint).not.toBe(first.fingerprint);
    expect((await cache.assemble(options([item('a')], { policyVersion: 'policy-2' })))).not.toBe(first);
    expect(cache.stats().misses).toBe(3);
  });

  it('invalidates by source, by scope and from a memory change feed', async () => {
    const cache = createContextCache();
    const first = await cache.assemble(options([item('a'), item('b')]));
    const other = await cache.assemble(options([item('c')]));
    expect(cache.invalidate({ sourceIds: ['source.a'] })).toBe(1);
    expect(await cache.assemble(options([item('a'), item('b')]))).not.toBe(first);
    expect(await cache.assemble(options([item('c')]))).toBe(other);
    expect(cache.invalidate({ scope: { principalId: 'someone', projectId: 'else' } })).toBe(0);
    expect(cache.invalidate({ scope })).toBe(2);
    await cache.assemble(options([item('a')])); await cache.assemble(options([item('c')]));
    const feed = { changes: vi.fn(async ({ after = 0 }: { after?: number }) => after === 0 ? [{ sequence: 7, id: 'a' }] : []) };
    expect(await cache.follow(feed, { sourceIdFor: id => `source.${id}` })).toBe(1);
    expect(await cache.follow(feed)).toBe(0); expect(feed.changes).toHaveBeenLastCalledWith({ after: 7, limit: 1_000 });
    expect(cache.stats().entries).toBe(1);
  });

  it('does not cache an assembly that raced an invalidation, and expires entries after the TTL', async () => {
    let clock = 1_000; const cache = createContextCache({ ttlMs: 50, now: () => clock });
    const pending = cache.assemble(options([item('a')]));
    cache.invalidate({ sourceIds: ['source.a'] });
    await pending; expect(cache.stats().entries).toBe(0);
    const stored = await cache.assemble(options([item('a')]));
    clock += 49; expect(await cache.assemble(options([item('a')]))).toBe(stored);
    clock += 2; expect(await cache.assemble(options([item('a')]))).not.toBe(stored);
  });

  it('re-runs hooks on a hit, so a later block still fails closed', async () => {
    const cache = createContextCache(); let block = false;
    const after = vi.fn(() => ({ decision: block ? 'block' as const : 'continue' as const }));
    await cache.assemble(options([item('a')], { hooks: { afterContextBuild: after } }));
    block = true;
    await expect(cache.assemble(options([item('a')], { hooks: { afterContextBuild: after } }))).rejects.toMatchObject({ code: 'GUARD_BLOCKED' });
    expect(after).toHaveBeenCalledTimes(2); expect(cache.stats().hits).toBe(1);
  });

  it('prefetches in the background and serves only identical keys', async () => {
    const cache = createContextCache();
    cache.prefetch(options([item('p')]));
    await vi.waitFor(() => expect(cache.stats().prefetched).toBe(1));
    await cache.assemble(options([item('p')]));
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 0 });
    cache.prefetch(options([item('bad')], { budget: { maxBytes: 1, maxEstimatedTokens: 1, reservedBytes: 2 } }));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(cache.stats().entries).toBe(1);
  });

  it('quantizes an omitted asOf so repeated calls share an entry, and validates configuration', async () => {
    let clock = Date.parse('2026-09-20T12:00:00.100Z'); const cache = createContextCache({ now: () => clock });
    const { asOf: _asOf, ...rest } = options([item('a')]); void _asOf;
    const first = await cache.assemble(rest); clock += 500;
    expect(await cache.assemble(rest)).toBe(first); expect(first.asOf).toBe('2026-09-20T12:00:00.000Z');
    expect(() => createContextCache({ maxEntries: 0 })).toThrow(); expect(() => cache.invalidate({})).toThrow();
  });
});
