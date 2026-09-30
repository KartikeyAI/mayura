// The conformance suites' fixtures for a document store, shared by every document backend's tests.
import type { JsonObject } from '@mayura/core';
import { createDocumentStore } from '../src/document/store.js';
import type { DocumentBackend, DocumentWrite } from '../src/document/session.js';
import { key } from '../src/document/keys.js';
import { documentSql, type RawDocuments } from './document-sql-view.js';

/** One disposable database: its backend, raw access to its documents, and its removal. */
export interface DocumentDatabase {
  readonly backend: DocumentBackend;
  readonly raw: RawDocuments;
  /** How a crash-test child process opens the same database (undefined where a child cannot). */
  readonly child?: JsonObject;
  cleanup(): Promise<void>;
}

/**
 * Stores over one database, whose commits can be held back: while a document is held, every commit that touches it
 * conflicts, so its transaction runs again until release. That is how a row lock looks to an optimistic store.
 */
function holdable(database: DocumentDatabase) {
  const held = new Set<string>();
  const id = (partition: string, sort: string) => `${partition}\u0000${sort}`;
  const backend: DocumentBackend = { ...database.backend,
    commit: async (writes: readonly DocumentWrite[]) => writes.some(write => held.has(id(write.partition, write.sort))) ? false : database.backend.commit(writes) };
  return {
    open: () => createDocumentStore(backend, { retryForMs: 60_000 }),
    hold: async (partition: string, sort: string) => {
      const name = id(partition, sort); held.add(name);
      return async () => { held.delete(name); };
    },
  };
}

export function documentFixtures(database: () => Promise<DocumentDatabase>) {
  const simple = async () => { const db = await database(); const { open } = holdable(db); return { store: open(), reopen: open, cleanup: db.cleanup }; };
  const workflow = async () => {
    const db = await database(); const { open, hold } = holdable(db);
    return { store: open(), reopen: open, dialect: 'document' as const, prefix: '', childConfig: db.child ? { kind: db.child['adapter'], ...db.child } : {}, query: documentSql(db.raw),
      lockAggregate: (scope: string, id: string) => hold(key('run', scope, id), key('r')), cleanup: db.cleanup };
  };
  const scheduler = async () => {
    const db = await database(); const { open, hold } = holdable(db);
    const jobs = key('runjobs', 'scheduler-a', 'run-a');
    return { store: open(), reopen: open, cleanup: db.cleanup, childOptions: db.child ?? {},
      holdJob: async () => ({ release: await hold(jobs, key('j', 'job-a')) }),
      corruptJob: async (mutate: (data: JsonObject) => void) => {
        const document = (await db.raw.scan()).find(item => item.partition === jobs && item.sort === key('j', 'job-a'));
        if (!document) throw new Error('Missing scheduler fixture job.');
        const row = JSON.parse(document.body) as Record<string, unknown>; const data = JSON.parse(String(row['data'])) as JsonObject; mutate(data); const job = data['job'] as JsonObject;
        await db.raw.write([{ partition: document.partition, sort: document.sort, body: JSON.stringify({ ...row, data: JSON.stringify(data), state: job['state'], lease_until: job['leaseUntilMs'] }) }]);
      } };
  };
  const waits = async () => { const db = await database(); const { open } = holdable(db); return { store: open(), reopen: open, prefix: '', childOptions: db.child ?? {}, query: documentSql(db.raw), cleanup: db.cleanup }; };
  const budgets = async () => {
    const db = await database(); const { open, hold } = holdable(db);
    return { store: open(), reopen: open, prefix: '', childOptions: db.child ?? {}, query: documentSql(db.raw),
      lockRoot: (scope: string, id: string) => hold(key('budget', 'durable_budget', scope, id), key('r')), cleanup: db.cleanup };
  };
  const trees = async () => { const db = await database(); const { open } = holdable(db); return { open, cleanup: db.cleanup }; };
  return { simple, workflow, scheduler, waits, budgets, trees };
}
