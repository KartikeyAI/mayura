import { MayuraError, type Scope } from '@mayura/core';
import { evaluateLifecycleControl, snapshotHookOptions } from '@mayura/core/host';
import { admissionKey, assembleContext } from './assemble.js';
import type { AssembleContextOptions, ContextAssembly, ContextHooks } from './contracts.js';

export interface ContextCacheOptions {
  /** Default 256, maximum 10,000 entries; least recently used entries are evicted. */
  readonly maxEntries?: number;
  /** Default 5 minutes, maximum 24 hours. */
  readonly ttlMs?: number;
  /** Granularity used for `asOf` when a caller omits it (default 1000 ms), so repeated calls can share an entry. */
  readonly asOfResolutionMs?: number;
  /** Background prefetch concurrency (default 2, maximum 8). */
  readonly maxPrefetch?: number;
  readonly now?: () => number;
}
/** Any source of content-free change events, such as native memory's `changes`. */
export interface ContextChangeFeed { changes(options: { readonly after?: number; readonly limit?: number }): Promise<readonly { readonly sequence: number; readonly id: string }[]> }
export interface ContextCacheStats { readonly entries: number; readonly hits: number; readonly misses: number; readonly invalidated: number; readonly prefetched: number }
export interface ContextCache {
  /** Same contract as `assembleContext`; a hit returns the stored assembly after re-running any hooks. */
  assemble(options: AssembleContextOptions): Promise<ContextAssembly>;
  /** Start a bounded background assembly; it is used only by a later `assemble` with an identical admission key. */
  prefetch(options: AssembleContextOptions): void;
  /** Drop entries for a scope and/or entries that include any of the given sources. Returns the number removed. */
  invalidate(filter: { readonly scope?: Scope; readonly sourceIds?: readonly string[] }): number;
  /** Consume a change feed from the last cursor and invalidate entries that include a changed source. */
  follow(feed: ContextChangeFeed, options?: { readonly sourceIdFor?: (id: string) => string }): Promise<number>;
  clear(): void;
  stats(): ContextCacheStats;
}

interface Entry { readonly assembly: ContextAssembly; readonly sources: ReadonlySet<string>; readonly scope: string; readonly expiresAt: number }

function bounded(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < minimum || result > maximum) throw new MayuraError('INVALID_CONFIG', `${label} must be an integer from ${minimum} to ${maximum}.`);
  return result;
}
const scopeText = (scope: Scope): string => JSON.stringify([scope.principalId, scope.projectId]);

/**
 * A cache of assemblies, never of generated answers or approvals. Keys cover every admission input, so any changed
 * source revision misses; `invalidate` and `follow` handle deletion, revocation and permission changes.
 */
export function createContextCache(options: ContextCacheOptions = {}): ContextCache {
  const maxEntries = bounded(options.maxEntries, 256, 1, 10_000, 'maxEntries');
  const ttlMs = bounded(options.ttlMs, 300_000, 1, 86_400_000, 'ttlMs');
  const resolution = bounded(options.asOfResolutionMs, 1_000, 1, 3_600_000, 'asOfResolutionMs');
  const maxPrefetch = bounded(options.maxPrefetch, 2, 1, 8, 'maxPrefetch');
  const now = (): number => { const value = (options.now ?? Date.now)(); if (!Number.isSafeInteger(value) || value < 0) throw new MayuraError('INVALID_CONFIG', 'Cache clock returned an invalid time.'); return value; };
  const entries = new Map<string, Entry>(); const pending = new Map<string, Promise<ContextAssembly>>();
  let hits = 0; let misses = 0; let invalidated = 0; let prefetched = 0; let cursor = 0; let generation = 0;

  const prepare = async (input: AssembleContextOptions): Promise<{ key: string; request: AssembleContextOptions }> => {
    const asOf = input.asOf ?? new Date(Math.floor(now() / resolution) * resolution).toISOString();
    const request = { ...input, asOf };
    return { key: await admissionKey(request, asOf), request };
  };
  const store = (key: string, assembly: ContextAssembly, request: AssembleContextOptions, admittedGeneration: number): void => {
    // An invalidation that raced this assembly wins: the result is returned but not cached.
    if (admittedGeneration !== generation) return;
    const sources = new Set([...assembly.selected.map(item => item.source.id), ...request.sources.map(source => source.id)]);
    entries.delete(key); entries.set(key, { assembly, sources, scope: scopeText(assembly.scope), expiresAt: now() + ttlMs });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
  };
  const compute = (key: string, request: AssembleContextOptions, started: number): Promise<ContextAssembly> => {
    const existing = pending.get(key); if (existing) return existing;
    // Hooks run on the returned path, not inside the shared computation.
    const { hooks: _hooks, signal: _signal, ...plain } = request; void _hooks; void _signal;
    const promise = assembleContext(plain).then(assembly => { store(key, assembly, request, started); return assembly; })
      .finally(() => pending.delete(key));
    pending.set(key, promise); return promise;
  };
  /** Cached assemblies are re-admitted: hooks see the same views an uncached assembly would produce. */
  const admit = async (assembly: ContextAssembly, request: AssembleContextOptions): Promise<ContextAssembly> => {
    const { handlers, timeoutMs } = snapshotHookOptions(request.hooks, ['beforeContextBuild', 'afterContextBuild'] as const,
      'Context hooks require callable beforeContextBuild/afterContextBuild handlers and a bounded timeout.');
    const signal = request.signal;
    const budget = { reservedBytes: 0, reservedTokens: 0, ...request.budget };
    if (handlers.beforeContextBuild) await evaluateLifecycleControl({ stage: 'beforeContextBuild', handler: handlers.beforeContextBuild as NonNullable<ContextHooks['beforeContextBuild']>, timeoutMs, ...(signal ? { signal } : {}),
      event: { scope: { ...assembly.scope }, policyVersion: assembly.policyVersion, asOf: assembly.asOf, candidateCount: request.candidates.length, sourceCount: request.sources.length,
        budget: { maxBytes: budget.maxBytes, maxEstimatedTokens: budget.maxEstimatedTokens, reservedBytes: budget.reservedBytes, reservedTokens: budget.reservedTokens } } });
    if (handlers.afterContextBuild) await evaluateLifecycleControl({ stage: 'afterContextBuild', handler: handlers.afterContextBuild as NonNullable<ContextHooks['afterContextBuild']>, timeoutMs, ...(signal ? { signal } : {}),
      event: { scope: { ...assembly.scope }, policyVersion: assembly.policyVersion, asOf: assembly.asOf, fingerprint: assembly.fingerprint,
        selected: assembly.selected.map(item => ({ id: item.id, sourceId: item.source.id, revision: item.source.revision, contentDigest: item.contentDigest })),
        excluded: assembly.excluded.map(entry => ({ ...entry })), usage: { ...assembly.usage } } });
    return assembly;
  };
  const drop = (predicate: (entry: Entry) => boolean): number => {
    let removed = 0; generation++;
    for (const [key, entry] of entries) if (predicate(entry)) { entries.delete(key); removed++; }
    invalidated += removed; return removed;
  };
  let running = 0; const queue: AssembleContextOptions[] = [];
  const pump = (): void => {
    while (running < maxPrefetch && queue.length > 0) {
      const next = queue.shift()!; running++; const started = generation;
      void prepare(next).then(({ key, request }) => entries.has(key) ? undefined : compute(key, request, started).then(() => { prefetched++; }))
        .catch(() => { /* A failed prefetch is simply not cached; the foreground call reports its own error. */ })
        .finally(() => { running--; pump(); });
    }
  };

  return Object.freeze<ContextCache>({
    async assemble(input) {
      // Captured before any await: an invalidation at any point during this call prevents caching its result.
      const started = generation;
      const { key, request } = await prepare(input);
      const entry = entries.get(key);
      if (entry && entry.expiresAt > now()) {
        hits++; entries.delete(key); entries.set(key, entry);
        return admit(entry.assembly, request);
      }
      if (entry) entries.delete(key);
      misses++;
      return admit(await compute(key, request, started), request);
    },
    prefetch(input) {
      if (queue.length >= 64) return;
      queue.push(input); pump();
    },
    invalidate(filter) {
      if (!filter || typeof filter !== 'object') throw new MayuraError('INVALID_INPUT', 'An invalidation filter is required.');
      const scope = filter.scope ? scopeText(filter.scope) : undefined; const sources = filter.sourceIds ? new Set(filter.sourceIds) : undefined;
      if (scope === undefined && sources === undefined) throw new MayuraError('INVALID_INPUT', 'Invalidate by scope and/or source ids; use clear() to drop everything.');
      return drop(entry => (scope === undefined || entry.scope === scope) && (sources === undefined || [...entry.sources].some(id => sources.has(id))));
    },
    async follow(feed, followOptions = {}) {
      const map = followOptions.sourceIdFor ?? ((id: string) => id); let removed = 0;
      for (;;) {
        const page = await feed.changes({ after: cursor, limit: 1_000 });
        if (page.length === 0) return removed;
        const changed = new Set(page.map(change => map(change.id)));
        removed += drop(entry => [...entry.sources].some(id => changed.has(id)));
        cursor = page.at(-1)!.sequence;
        if (page.length < 1_000) return removed;
      }
    },
    clear() { drop(() => true); },
    stats: () => Object.freeze({ entries: entries.size, hits, misses, invalidated, prefetched }),
  });
}
