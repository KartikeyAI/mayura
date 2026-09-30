import { StorageError } from '../contracts.js';
import { above, after, compareKeys } from './keys.js';

/** A stored document: its key, its version (1 when created, +1 on every write) and its JSON text. */
export interface StoredDocument { readonly partition: string; readonly sort: string; readonly version: number; readonly body: string }
export interface DocumentKey { readonly partition: string; readonly sort: string }
/**
 * Documents in one partition whose sort key starts with `prefix` (an encoded tuple), optionally only those after
 * `after` and those up to and including `through` (whole sort keys), in sort order or reversed, at most `limit`.
 */
export interface DocumentRange { readonly prefix: string; readonly after?: string; readonly through?: string; readonly reverse?: boolean; readonly limit?: number }
/**
 * One change in a commit. Every change names the version it expects: `null` for a document that must not exist.
 * `put` stores `body` at `version`, `bump` only raises the version (a lock), `delete` removes the document,
 * `check` changes nothing but fails the commit unless the document is still at `expected`.
 */
export type DocumentWrite =
  | { readonly kind: 'put'; readonly partition: string; readonly sort: string; readonly expected: number | null; readonly version: number; readonly body: string }
  | { readonly kind: 'bump'; readonly partition: string; readonly sort: string; readonly expected: number; readonly version: number }
  | { readonly kind: 'delete'; readonly partition: string; readonly sort: string; readonly expected: number }
  | { readonly kind: 'check'; readonly partition: string; readonly sort: string; readonly expected: number | null };

/**
 * What a database must offer Mayura's optimistic document store: consistent reads of keys and of one partition's sort
 * range, and one atomic commit that applies every change only if every expected version still holds.
 */
export interface DocumentBackend {
  /** Creates the store's tables or checks they exist. */
  initialize(): Promise<void>;
  /** The database's time in milliseconds, or the host's where the database has no clock. */
  clock(): Promise<number>;
  /** Strongly consistent reads; `undefined` where a key has no document. */
  get(keys: readonly DocumentKey[]): Promise<readonly (StoredDocument | undefined)[]>;
  /** A strongly consistent range read of one partition. */
  query(partition: string, range: DocumentRange): Promise<readonly StoredDocument[]>;
  /** How many documents a range holds. */
  count(partition: string, range: DocumentRange): Promise<number>;
  /** Applies every change atomically, or none; `false` when an expected version no longer holds. */
  commit(writes: readonly DocumentWrite[]): Promise<boolean>;
}

interface Entry {
  readonly partition: string; readonly sort: string;
  /** The version read, `null` when absent, `undefined` when never read (an insert that expects absence). */
  base: number | null | undefined;
  body: string | undefined;
  lock: boolean; write: 'put' | 'delete' | undefined;
}
const id = (partition: string, sort: string) => `${partition}\u0000${sort}`;
function inRange(sort: string, range: DocumentRange): boolean {
  return compareKeys(sort, range.prefix) >= 0 && compareKeys(sort, above(range.prefix)) < 0 && (range.after === undefined || compareKeys(sort, after(range.after)) >= 0)
    && (range.through === undefined || compareKeys(sort, range.through) <= 0);
}

/**
 * One optimistic transaction. Reads come from the database once and then from this session, which also holds every
 * write until commit, so the body always sees its own changes. A locked read, like SQL's FOR UPDATE, raises the
 * document's version at commit: two transactions that lock one document conflict, and the later one runs again.
 * Unlocked reads are read-committed, as in the SQL stores. Every write expects the version the session saw.
 */
export class DocumentSession {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly backend: DocumentBackend, private readonly now: () => Promise<number>) {}
  clock(): Promise<number> { return this.now(); }

  private remember(partition: string, sort: string, document: StoredDocument | undefined): Entry {
    const entry: Entry = { partition, sort, base: document?.version ?? null, body: document?.body, lock: false, write: undefined };
    this.entries.set(id(partition, sort), entry); return entry;
  }
  private async entry(partition: string, sort: string): Promise<Entry> {
    const known = this.entries.get(id(partition, sort)); if (known) return known;
    const [document] = await this.backend.get([{ partition, sort }]);
    return this.entries.get(id(partition, sort)) ?? this.remember(partition, sort, document);
  }
  /** The document's JSON text as this transaction sees it; `lock` holds it until commit. */
  async get(partition: string, sort: string, lock = false): Promise<string | undefined> {
    const entry = await this.entry(partition, sort); if (lock) entry.lock = true; return entry.body;
  }
  /** Several documents in one database read. */
  async getMany(keys: readonly DocumentKey[], lock = false): Promise<(string | undefined)[]> {
    const missing = keys.filter(item => !this.entries.has(id(item.partition, item.sort)));
    const unique = [...new Map(missing.map(item => [id(item.partition, item.sort), item])).values()];
    if (unique.length) {
      const found = await this.backend.get(unique);
      unique.forEach((item, index) => { if (!this.entries.has(id(item.partition, item.sort))) this.remember(item.partition, item.sort, found[index]); });
    }
    return keys.map(item => { const entry = this.entries.get(id(item.partition, item.sort))!; if (lock) entry.lock = true; return entry.body; });
  }
  /** A partition range as this transaction sees it: stored documents with this session's writes applied. */
  async query(partition: string, range: DocumentRange, lock = false): Promise<{ sort: string; body: string }[]> {
    const pending = [...this.entries.values()].filter(entry => entry.partition === partition && entry.write !== undefined && inRange(entry.sort, range));
    // Ask for enough to fill the limit even if this session deleted or moved some of the stored ones.
    const stored = await this.backend.query(partition, range.limit === undefined ? range : { ...range, limit: range.limit + pending.length });
    const seen = new Map<string, { sort: string; body: string }>();
    for (const document of stored) {
      const entry = this.entries.get(id(partition, document.sort)) ?? this.remember(partition, document.sort, document);
      if (lock) entry.lock = true;
      if (entry.body !== undefined) seen.set(document.sort, { sort: document.sort, body: entry.body });
    }
    for (const entry of pending) {
      if (entry.body === undefined) seen.delete(entry.sort); else seen.set(entry.sort, { sort: entry.sort, body: entry.body });
      if (lock) entry.lock = true;
    }
    const rows = [...seen.values()].sort((a, b) => compareKeys(a.sort, b.sort) * (range.reverse ? -1 : 1));
    return range.limit === undefined ? rows : rows.slice(0, range.limit);
  }
  /** How many documents a range holds as this transaction sees it. */
  async count(partition: string, range: DocumentRange): Promise<number> {
    let delta = 0;
    for (const entry of this.entries.values()) {
      if (entry.partition !== partition || entry.write === undefined || !inRange(entry.sort, range)) continue;
      const existed = entry.base !== null && entry.base !== undefined; const exists = entry.body !== undefined;
      if (existed !== exists) delta += exists ? 1 : -1;
    }
    return await this.backend.count(partition, range) + delta;
  }
  async put(partition: string, sort: string, body: string): Promise<void> {
    const entry = await this.entry(partition, sort); entry.body = body; entry.write = 'put';
  }
  /** Stores a document that must not exist yet, without reading it first; if it does, the commit conflicts. */
  insert(partition: string, sort: string, body: string): void {
    const known = this.entries.get(id(partition, sort));
    if (known) { known.body = body; known.write = 'put'; return; }
    this.entries.set(id(partition, sort), { partition, sort, base: undefined, body, lock: false, write: 'put' });
  }
  async delete(partition: string, sort: string): Promise<void> {
    const entry = await this.entry(partition, sort); entry.body = undefined; entry.write = 'delete';
  }
  /** Holds a document (created empty if absent) so that concurrent holders conflict, like a named lock. */
  async hold(partition: string, sort: string): Promise<void> {
    const entry = await this.entry(partition, sort); entry.lock = true;
    if (entry.body === undefined) { entry.body = '{}'; entry.write = 'put'; }
  }

  /**
   * Checks that everything this transaction read still holds, without changing anything. An error raised over reads
   * of two different moments may be an artifact of neither: when these checks fail, the transaction runs again.
   */
  readChecks(): DocumentWrite[] {
    const checks: DocumentWrite[] = [];
    for (const entry of this.entries.values()) if (entry.base !== undefined) checks.push({ kind: 'check', partition: entry.partition, sort: entry.sort, expected: entry.base });
    return checks;
  }
  /** The changes to commit. */
  changes(): DocumentWrite[] {
    const writes: DocumentWrite[] = [];
    for (const entry of this.entries.values()) {
      const expected = entry.base === undefined ? null : entry.base;
      if (entry.write === 'put') writes.push({ kind: 'put', partition: entry.partition, sort: entry.sort, expected, version: (expected ?? 0) + 1, body: entry.body! });
      else if (entry.write === 'delete') { if (expected !== null) writes.push({ kind: 'delete', partition: entry.partition, sort: entry.sort, expected }); else if (entry.lock) writes.push({ kind: 'check', partition: entry.partition, sort: entry.sort, expected: null }); }
      else if (entry.lock) writes.push(expected === null
        ? { kind: 'check', partition: entry.partition, sort: entry.sort, expected: null }
        : { kind: 'bump', partition: entry.partition, sort: entry.sort, expected, version: expected + 1 });
    }
    return writes;
  }
}

export interface DocumentTransactionOptions {
  /** How long a transaction keeps running again after conflicts before failing; 30 seconds by default. */
  readonly retryForMs?: number;
}
/**
 * Runs `body` in a fresh session and commits it; on a conflict, runs it again with fresh reads, after a growing random
 * pause. A body must be safe to run more than once: it only reads and writes through its session.
 */
export function documentTransactions(backend: DocumentBackend, options: DocumentTransactionOptions = {}) {
  const retryForMs = options.retryForMs ?? 30_000;
  let offset: { value: number; measuredAt: number } | undefined;
  /** The database's clock, as an offset from this host's, measured again every second. */
  const now = async (): Promise<number> => {
    const local = Date.now();
    if (!offset || local < offset.measuredAt || local - offset.measuredAt >= 1_000) {
      const before = Date.now(); const remote = await backend.clock(); const afterward = Date.now();
      offset = { value: remote - Math.round((before + afterward) / 2), measuredAt: afterward };
    }
    return Date.now() + offset.value;
  };
  const pause = (attempt: number) => new Promise(resolve => setTimeout(resolve, Math.random() * Math.min(200, 5 * 2 ** Math.min(attempt, 6))));
  /** Whether every read still holds; checked in groups small enough for any backend's commit. */
  const readsHold = async (checks: readonly DocumentWrite[]): Promise<boolean> => {
    for (let offset = 0; offset < checks.length; offset += 100) if (!await backend.commit(checks.slice(offset, offset + 100))) return false;
    return true;
  };
  return async <T>(body: (session: DocumentSession) => Promise<T>): Promise<T> => {
    const deadline = Date.now() + retryForMs;
    for (let attempt = 0; ; attempt++) {
      const session = new DocumentSession(backend, now);
      let result: T;
      try { result = await body(session); }
      catch (error) {
        // Reads without locks see whichever version was current when each was made. If any of them has changed since,
        // the error may come from a view no single moment had: run again. Otherwise the error is the answer.
        if (Date.now() >= deadline || await readsHold(session.readChecks())) throw error;
        await pause(attempt); continue;
      }
      const writes = session.changes();
      if (writes.length === 0 || await backend.commit(writes)) return result;
      if (Date.now() >= deadline) throw new StorageError('STORAGE_UNAVAILABLE', 'Storage stayed busy: concurrent writers kept changing the same records.');
      await pause(attempt);
    }
  };
}
export type DocumentTransaction = ReturnType<typeof documentTransactions>;
