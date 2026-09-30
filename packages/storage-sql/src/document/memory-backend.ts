import { above, after, compareKeys } from './keys.js';
import type { DocumentBackend, DocumentRange, StoredDocument } from './session.js';

/**
 * A document backend in this process's memory, for tests: every commit is atomic and checks every expected version.
 * `beforeCommit` runs before each commit is applied, so a test can pause or stop a writer there.
 */
export function memoryDocumentBackend(options: { beforeCommit?: () => Promise<void> } = {}): DocumentBackend & { readonly documents: Map<string, StoredDocument> } {
  const documents = new Map<string, StoredDocument>();
  const id = (partition: string, sort: string) => `${partition}\u0000${sort}`;
  const select = (partition: string, range: DocumentRange): StoredDocument[] => {
    const rows = [...documents.values()].filter(document => document.partition === partition && compareKeys(document.sort, range.prefix) >= 0
      && compareKeys(document.sort, above(range.prefix)) < 0 && (range.after === undefined || compareKeys(document.sort, after(range.after)) >= 0)
      && (range.through === undefined || compareKeys(document.sort, range.through) <= 0))
      .sort((a, b) => compareKeys(a.sort, b.sort) * (range.reverse ? -1 : 1));
    return range.limit === undefined ? rows : rows.slice(0, range.limit);
  };
  // Every call yields first, so concurrent transactions interleave as they would over a network. A microtask, not a
  // timer: timers wait a whole tick of the system clock on some platforms.
  const tick = () => new Promise<void>(resolve => queueMicrotask(resolve));
  return {
    documents,
    initialize: async () => {},
    // The host's wall clock, read without Date.now, which tests replace to play a caller with a wrong clock.
    clock: async () => Math.round(performance.timeOrigin + performance.now()),
    get: async keys => { await tick(); return keys.map(item => documents.get(id(item.partition, item.sort))); },
    query: async (partition, range) => { await tick(); return select(partition, range); },
    count: async (partition, range) => { await tick(); return select(partition, { prefix: range.prefix, ...(range.after === undefined ? {} : { after: range.after }), ...(range.through === undefined ? {} : { through: range.through }) }).length; },
    commit: async writes => {
      await tick(); await options.beforeCommit?.();
      if (new Set(writes.map(write => id(write.partition, write.sort))).size !== writes.length) throw new Error('A commit changes each document once.');
      for (const write of writes) if ((documents.get(id(write.partition, write.sort))?.version ?? null) !== write.expected) return false;
      for (const write of writes) {
        const key = id(write.partition, write.sort);
        if (write.kind === 'put') documents.set(key, { partition: write.partition, sort: write.sort, version: write.version, body: write.body });
        else if (write.kind === 'bump') documents.set(key, { ...documents.get(key)!, version: write.version });
        else if (write.kind === 'delete') documents.delete(key);
      }
      return true;
    },
  };
}
