import { StorageError, storageError } from 'mayura/storage-contracts';
import { createDocumentStore, documentRangeBounds, type DocumentBackend, type DocumentStore, type DocumentWrite, type StoredDocument } from 'mayura/storage-sql/host';

/** The Mayura store on Cloudflare D1. */
export type D1Store = DocumentStore;

/** The parts of a D1 binding (`env.DB`) the store uses. */
export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<{ results?: T[] }[]>;
}
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
}
export interface D1StoreOptions {
  /** The D1 binding from your Worker's environment, for example `env.DB`. */
  readonly database: D1Database;
  /** The table that holds Mayura's documents; `mayura_documents` by default. */
  readonly table?: string;
  /**
   * How long a transaction keeps running again after conflicting with concurrent writers before failing; 30 seconds by
   * default.
   */
  readonly retryForMs?: number;
}

interface Row { partition: string; sort: string; version: number; body: string }
/** SQLite refuses this value, so a guard that selects it fails the batch and rolls every statement back. */
const REFUSE = 'abs(-9223372036854775808)';
const conflictText = /integer overflow/i;
/** D1 accepts at most 100 bound parameters per statement: key lookups go 45 at a time. */
const KEYS_PER_STATEMENT = 45;

function document(row: Row): StoredDocument {
  if (typeof row.partition !== 'string' || typeof row.sort !== 'string' || typeof row.body !== 'string' || !Number.isSafeInteger(Number(row.version))) {
    throw new StorageError('STORAGE_UNAVAILABLE', 'Stored document failed integrity validation.');
  }
  return { partition: row.partition, sort: row.sort, version: Number(row.version), body: row.body };
}

/**
 * The D1 half of Mayura's optimistic document store. D1 has no interactive transactions, so a Mayura transaction reads
 * with plain queries, then commits one `batch()`: first a guard per document it read or holds, which fails the batch if
 * that document's version changed, then its writes. D1 runs a batch as one SQLite transaction, all or nothing.
 */
export function d1Backend(database: D1Database, table = 'mayura_documents'): DocumentBackend {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/u.test(table)) throw new StorageError('INVALID_INPUT', 'D1 table must be a name of letters, digits and _, starting with a letter or _.');
  const TABLE = table;
  const rows = async (statement: D1PreparedStatement) => ((await statement.all<Row>()).results ?? []).map(document);
  return {
    initialize: async () => {
      await database.batch([
        database.prepare(`CREATE TABLE IF NOT EXISTS ${TABLE} (partition TEXT NOT NULL, sort TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (partition, sort)) WITHOUT ROWID`),
      ]);
    },
    clock: async () => {
      const [row] = (await database.prepare("SELECT CAST(strftime('%s','now') AS INTEGER) * 1000 + CAST(substr(strftime('%f','now'),4,3) AS INTEGER) AS now_ms").all<{ now_ms: number }>()).results ?? [];
      const value = Number(row?.now_ms); if (!Number.isSafeInteger(value)) throw new StorageError('STORAGE_UNAVAILABLE', 'Storage time is unavailable.');
      return value;
    },
    get: async keys => {
      if (keys.length === 0) return [];
      const statements: D1PreparedStatement[] = [];
      for (let offset = 0; offset < keys.length; offset += KEYS_PER_STATEMENT) {
        const chunk = keys.slice(offset, offset + KEYS_PER_STATEMENT);
        statements.push(database.prepare(`SELECT partition, sort, version, body FROM ${TABLE} WHERE ${chunk.map(() => '(partition = ? AND sort = ?)').join(' OR ')}`)
          .bind(...chunk.flatMap(item => [item.partition, item.sort])));
      }
      // One batch is one snapshot: every key is read at the same moment.
      const found = new Map<string, StoredDocument>();
      for (const result of await database.batch<Row>(statements)) for (const row of result.results ?? []) { const item = document(row); found.set(`${item.partition}\u0000${item.sort}`, item); }
      return keys.map(item => found.get(`${item.partition}\u0000${item.sort}`));
    },
    query: async (partition, range) => {
      const { lower, upper, through } = documentRangeBounds(range);
      return rows(database.prepare(`SELECT partition, sort, version, body FROM ${TABLE} WHERE partition = ? AND sort >= ? AND sort < ?${through === undefined ? '' : ' AND sort <= ?'} ORDER BY sort ${range.reverse ? 'DESC' : 'ASC'}${range.limit === undefined ? '' : ' LIMIT ?'}`)
        .bind(partition, lower, upper, ...(through === undefined ? [] : [through]), ...(range.limit === undefined ? [] : [range.limit])));
    },
    count: async (partition, range) => {
      const { lower, upper, through } = documentRangeBounds(range);
      const [row] = (await database.prepare(`SELECT COUNT(*) AS count FROM ${TABLE} WHERE partition = ? AND sort >= ? AND sort < ?${through === undefined ? '' : ' AND sort <= ?'}`)
        .bind(partition, lower, upper, ...(through === undefined ? [] : [through])).all<{ count: number }>()).results ?? [];
      return Number(row?.count ?? 0);
    },
    commit: async (writes: readonly DocumentWrite[]) => {
      const guards = writes.map(write => database.prepare(`SELECT CASE WHEN (SELECT version FROM ${TABLE} WHERE partition = ? AND sort = ?) IS ? THEN 1 ELSE ${REFUSE} END AS ok`)
        .bind(write.partition, write.sort, write.expected));
      const changes = writes.flatMap(write => {
        if (write.kind === 'put') return [database.prepare(`INSERT INTO ${TABLE} (partition, sort, version, body) VALUES (?, ?, ?, ?) ON CONFLICT (partition, sort) DO UPDATE SET version = excluded.version, body = excluded.body`)
          .bind(write.partition, write.sort, write.version, write.body)];
        if (write.kind === 'bump') return [database.prepare(`UPDATE ${TABLE} SET version = ? WHERE partition = ? AND sort = ?`).bind(write.version, write.partition, write.sort)];
        if (write.kind === 'delete') return [database.prepare(`DELETE FROM ${TABLE} WHERE partition = ? AND sort = ?`).bind(write.partition, write.sort)];
        return [];
      });
      try { await database.batch([...guards, ...changes]); return true; }
      catch (error) { if (error instanceof Error && conflictText.test(error.message)) return false; throw error; }
    },
  };
}

/**
 * The Mayura store on Cloudflare D1, from a Worker's D1 binding. Everything the SQL stores keep, as optimistic
 * transactions: see the storage guide for how they behave under contention.
 *
 * ```ts
 * const store = createD1Store({ database: env.DB });
 * await store.initialize();
 * ```
 */
export function createD1Store(options: D1StoreOptions): D1Store {
  if (options === null || typeof options !== 'object' || Object.keys(options).some(key => !['database', 'table', 'retryForMs'].includes(key))) {
    throw new StorageError('INVALID_INPUT', 'D1 store options are database, table and retryForMs.');
  }
  const database = options.database as Partial<D1Database> | undefined;
  if (!database || typeof database.prepare !== 'function' || typeof database.batch !== 'function') throw new StorageError('INVALID_INPUT', 'D1 store needs a D1 database binding.');
  if (options.retryForMs !== undefined && (!Number.isSafeInteger(options.retryForMs) || options.retryForMs < 0 || options.retryForMs > 600_000)) {
    throw new StorageError('INVALID_INPUT', 'D1 retryForMs must be an integer from 0 to 600000.');
  }
  return createDocumentStore(d1Backend(options.database, options.table), { ...(options.retryForMs === undefined ? {} : { retryForMs: options.retryForMs }),
    failure: error => error instanceof StorageError ? error : storageError(error) });
}
