import { createClient, type Client, type InArgs, type Transaction } from '@libsql/client';
import { StorageError, storageError, type CreateRecord, type DurableBudgetAggregateStore, type MemoryIndexAggregateStore, type MigrateRecord, type StoredEvent, type StoredRecord,
  type UpdateRecord, type WorkflowGraphDiscoveryAggregateStore, type WorkflowTreeDiscoveryAggregateStore } from 'mayura/storage-contracts';
import {
  createCommand, cursor, durableBudgetFacade, DurableBudgetDatabase, EVENT_PAGE_SIZE, executionWaitFacade, ExecutionWaitDatabase, identifier, initializeOwnership, memoryIndexFacade,
  MemoryIndexDatabase, migrateCommand, nextCounter, ownedRun, ScheduledWorkflowDatabase, scheduledFacade, SchedulerDatabase, schedulerFacade, storedObject, submissionDigest,
  updateCommand, workflowGraphDiscoveryFacade, workflowGraphFacade, WorkflowTreeDatabase, workflowTreeDiscoveryFacade, workflowTreeFacade, writerRequired,
  type SchedulerBackend, type SchedulerSession,
} from 'mayura/storage-sql/host';

export type LibsqlStore = WorkflowGraphDiscoveryAggregateStore & DurableBudgetAggregateStore & WorkflowTreeDiscoveryAggregateStore & MemoryIndexAggregateStore;

export interface LibsqlStoreOptions {
  /**
   * The database: `file:` for a local file (with its directory), `libsql://`, `https://` or `wss://` for a remote
   * libSQL server such as Turso or sqld. Plain `http://` and `ws://` are only for loopback addresses.
   */
  readonly url?: string;
  /** The remote database's auth token. Never read from the environment. */
  readonly authToken?: string;
  /**
   * A libSQL client you create and own instead of `url`, for example from `@libsql/client/web` on an edge runtime.
   * Mayura never closes it.
   */
  readonly client?: Client;
}

interface Row {
  scope: string; id: string; idempotency_key: string; definition_hash: string;
  submission_digest: string; version: number | bigint; event_sequence: number | bigint; state: string;
}
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function integer(value: unknown): number {
  const result = typeof value === 'bigint' ? Number(value) : value;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 0) throw new StorageError('STORAGE_UNAVAILABLE', 'Stored counter failed integrity validation.');
  return result;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new StorageError('STORAGE_UNAVAILABLE', 'A stored value failed integrity validation.');
  return value;
}
function record(row: Row): StoredRecord {
  return {
    scope: text(row.scope), id: text(row.id), idempotencyKey: text(row.idempotency_key),
    definitionHash: text(row.definition_hash), version: integer(row.version), state: storedObject(JSON.parse(text(row.state))),
  };
}
/** Another writer holds the database's write lock. */
const busy = (error: unknown): boolean => {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || code.startsWith('SQLITE_BUSY_');
};
/** A libSQL failure as a storage error, without the driver's text. SQLite's constraint violations are conflicts. */
function safeFailure(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
  if (code.startsWith('SQLITE_CONSTRAINT')) return new StorageError('CONFLICT', 'A record with this ID or idempotency key already exists in this scope with different content; use a new ID or key.');
  if (busy(error)) return new StorageError('STORAGE_UNAVAILABLE', 'The database stayed locked by another writer; retry with bounded backoff.');
  return storageError(error);
}
/** Rows as plain objects with named columns, as the SQL layer reads them. */
function rows<T>(result: { columns: string[]; rows: ArrayLike<unknown>[] }): T[] {
  return result.rows.map(row => Object.fromEntries(result.columns.map((column, index) => [column, (row as ArrayLike<unknown>)[index]])) as T);
}
/** Where a remote database lives: https or wss anywhere, http or ws only on a loopback address; local files as given. */
function checkedUrl(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.length > 4_096) throw new StorageError('INVALID_INPUT', 'libSQL url must be a nonempty string.');
  if (value === ':memory:' || value.startsWith('file:')) return value;
  let url: URL;
  try { url = new URL(value); } catch { throw new StorageError('INVALID_INPUT', 'libSQL url must be file:, libsql:, https:, wss:, or http:/ws: on a loopback address.'); }
  const secure = url.protocol === 'libsql:' || url.protocol === 'https:' || url.protocol === 'wss:';
  const local = (url.protocol === 'http:' || url.protocol === 'ws:') && LOOPBACK.has(url.hostname);
  if (!(secure || local) || url.username || url.password || url.hash) throw new StorageError('INVALID_INPUT', 'libSQL url must be file:, libsql:, https:, wss:, or http:/ws: on a loopback address, without credentials.');
  // A token in the query string would end up in logs; it goes in authToken.
  if ([...url.searchParams.keys()].some(key => key.toLowerCase().includes('token'))) throw new StorageError('INVALID_INPUT', 'Give the libSQL auth token as authToken, not in the url.');
  return value;
}

/**
 * Mayura storage on libSQL: a local file, or a remote libSQL server such as Turso or sqld, through the official
 * `@libsql/client`. The SQL is SQLite's, shared with `mayura/storage-sqlite`; every operation is one write
 * transaction, so a record, its events and the scheduler state it touches change together or not at all.
 *
 * ```ts
 * const store = createLibsqlStore({ url: 'libsql://my-db.turso.io', authToken });
 * await store.initialize();
 * ```
 */
export function createLibsqlStore(options: LibsqlStoreOptions): LibsqlStore {
  if (options === null || typeof options !== 'object' || Object.keys(options).some(key => !['url', 'authToken', 'client'].includes(key))) {
    throw new StorageError('INVALID_INPUT', 'libSQL store options are url, authToken and client.');
  }
  if ((options.url === undefined) === (options.client === undefined)) throw new StorageError('INVALID_INPUT', 'libSQL store needs either a url or a client.');
  if (options.client !== undefined && options.authToken !== undefined) throw new StorageError('INVALID_INPUT', 'Give the auth token to the libSQL client you create.');
  if (options.authToken !== undefined && (typeof options.authToken !== 'string' || !options.authToken || /[\r\n]/u.test(options.authToken))) {
    throw new StorageError('INVALID_INPUT', 'libSQL authToken must be a nonempty string.');
  }
  let client: Client;
  let connect: (() => Client) | undefined;
  if (options.client !== undefined) {
    const given = options.client as Partial<Client> | null;
    if (given === null || typeof given !== 'object' || typeof given.transaction !== 'function' || typeof given.execute !== 'function') {
      throw new StorageError('INVALID_INPUT', 'libSQL client must be a client from @libsql/client.');
    }
    client = options.client;
  } else {
    const config = { url: checkedUrl(options.url), ...(options.authToken === undefined ? {} : { authToken: options.authToken }), intMode: 'number' as const };
    // intMode 'number' fails on an integer beyond 2^53 rather than rounding it.
    connect = () => createClient(config);
    client = connect();
  }
  const owned = connect !== undefined;
  const local = client.protocol === 'file';

  let initialized = false; let closed = false;
  let initializePromise: Promise<void> | undefined; let closePromise: Promise<void> | undefined;
  const available = (requireInitialization = true): void => {
    if (closed) throw new StorageError('STORE_CLOSED', 'Storage has been closed; open a new store to continue.');
    if (requireInitialization && !initialized) throw new StorageError('STORE_NOT_INITIALIZED', 'Storage is not initialized: call `await store.initialize()` before using it.');
  };
  const session = (tx: Transaction): SchedulerSession => ({
    // The SQL layer uses only positional ? placeholders, never interpolated application text.
    query: async <T>(sql: string, parameters: readonly unknown[] = []) => rows<T>(await tx.execute({ sql, args: [...parameters] as InArgs })),
  });
  // One write transaction at a time per store. A local file's client waits for a lock inside native code, which
  // blocks the event loop, so a second transaction of this process could never let the first one finish.
  let tail: Promise<unknown> = Promise.resolve(); let queued = 0;
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    if (queued >= 256) return Promise.reject(new StorageError('QUEUE_FULL', 'Storage queue is full; retry with bounded backoff.'));
    queued += 1;
    const run = tail.then(work, work);
    tail = run.then(() => undefined, () => undefined).finally(() => { queued -= 1; });
    return run;
  };
  // Another process (or another client of a remote server) may hold the write lock: retry the start of the
  // transaction for up to 5 s, waiting between attempts without blocking the event loop.
  const begin = async (): Promise<Transaction> => {
    const deadline = Date.now() + 5_000; let delay = 5;
    for (;;) {
      try { return await client.transaction('write'); } catch (error) {
        if (!busy(error) || Date.now() + delay > deadline) throw error;
        if (local) {
          // The local driver leaves a BEGIN that found the database locked unfinished on its pooled connection, and
          // that connection can never commit again. The store's own client is replaced (no other operation is using
          // it: writes are serialized and local reads finish synchronously); a client you gave cannot be.
          if (!connect) throw error;
          client.close(); client = connect();
        }
        await new Promise(resolve => setTimeout(resolve, delay)); delay = Math.min(delay * 2, 100);
      }
    }
  };
  const transaction = <T>(body: (tx: Transaction) => Promise<T>): Promise<T> => serialized(async () => {
    let tx: Transaction | undefined;
    try {
      tx = await begin();
      const result = await body(tx);
      await tx.commit();
      return result;
    } catch (error) {
      if (tx) { try { await tx.rollback(); } catch { /* The original failure remains authoritative. */ } }
      throw safeFailure(error);
    } finally { tx?.close(); }
  });
  const one = async (tx: Transaction, sql: string, args: unknown[]): Promise<Row | undefined> => rows<Row>(await tx.execute({ sql, args: args as InArgs }))[0];
  const append = async (tx: Transaction, scope: string, id: string, sequence: number, events: CreateRecord['events']): Promise<void> => {
    const createdAt = new Date().toISOString();
    for (const [index, event] of events.entries()) {
      await tx.execute({ sql: 'INSERT INTO mayura_events (scope, aggregate_id, sequence, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        args: [scope, id, nextCounter(sequence, index + 1), event.type, JSON.stringify(event.data), createdAt] });
    }
  };

  const backend: SchedulerBackend = { dialect: 'sqlite', prefix: '', transaction: body => transaction(tx => body(session(tx))) };
  const schedulerDatabase = new SchedulerDatabase(backend);
  const workflowsDatabase = new ScheduledWorkflowDatabase(backend, schedulerDatabase);
  const executionWaitDatabase = new ExecutionWaitDatabase(backend, workflowsDatabase);
  const durableBudgetDatabase = new DurableBudgetDatabase(backend);
  const workflowTreeDatabase = new WorkflowTreeDatabase(backend, schedulerDatabase);
  const memoryDatabase = new MemoryIndexDatabase(backend);

  return {
    scheduler: schedulerFacade((method, input) => { available(); return schedulerDatabase.execute(method, input); }),
    workflows: scheduledFacade((method, input) => { available(); return workflowsDatabase.execute(method, input); }),
    workflowGraphs: workflowGraphFacade((method, input) => { available(); return workflowsDatabase.execute(method, input, 2); }),
    workflowGraphDiscovery: workflowGraphDiscoveryFacade((method, input) => { available(); return workflowsDatabase.discover(method, input); }),
    executionWaits: executionWaitFacade((method, input) => { available(); return executionWaitDatabase.execute(method, input); }),
    durableBudgets: durableBudgetFacade((method, input) => { available(); return durableBudgetDatabase.execute(method, input); }),
    workflowTrees: workflowTreeFacade((method, input) => { available(); return workflowTreeDatabase.execute(method, input); }),
    workflowTreeDiscovery: workflowTreeDiscoveryFacade((method, input) => { available(); return workflowTreeDatabase.discover(method, input); }),
    memory: memoryIndexFacade((method, input) => { available(); return memoryDatabase.execute(method, input); }),
    initialize: async () => {
      available(false);
      if (!initializePromise) {
        initializePromise = (async () => {
          // A local file keeps SQLite's durability settings: write-ahead logging and a full sync on every commit.
          if (options.client === undefined && (options.url === ':memory:' || options.url!.startsWith('file:'))) {
            try {
              const journal = rows<{ journal_mode: string }>(await client.execute('PRAGMA journal_mode = WAL'))[0]?.journal_mode;
              await client.execute('PRAGMA synchronous = FULL');
              if (options.url !== ':memory:' && journal !== 'wal') throw new StorageError('STORAGE_UNAVAILABLE', 'libSQL durability settings could not be enabled.');
            } catch (error) { throw safeFailure(error); }
          }
          await transaction(async tx => {
            await tx.execute('CREATE TABLE IF NOT EXISTS mayura_storage_meta (version INTEGER PRIMARY KEY CHECK(version = 1))');
            await tx.execute('INSERT OR IGNORE INTO mayura_storage_meta (version) VALUES (1)');
            await tx.execute(`CREATE TABLE IF NOT EXISTS mayura_aggregates (
              scope TEXT NOT NULL, id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
              definition_hash TEXT NOT NULL, submission_digest TEXT NOT NULL,
              version INTEGER NOT NULL CHECK(version > 0), event_sequence INTEGER NOT NULL CHECK(event_sequence >= 0),
              state TEXT NOT NULL, PRIMARY KEY(scope, id), UNIQUE(scope, idempotency_key))`);
            await tx.execute(`CREATE TABLE IF NOT EXISTS mayura_events (
              scope TEXT NOT NULL, aggregate_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence > 0),
              type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL,
              PRIMARY KEY(scope, aggregate_id, sequence),
              FOREIGN KEY(scope, aggregate_id) REFERENCES mayura_aggregates(scope, id))`);
            const versions = rows<{ version: unknown }>(await tx.execute('SELECT version FROM mayura_storage_meta'));
            if (versions.length !== 1 || integer(versions[0]!.version) !== 1) throw new StorageError('STORAGE_UNAVAILABLE', 'Unsupported storage schema version.');
            await initializeOwnership(session(tx), backend);
          });
        })().then(() => { initialized = true; }).catch((error: unknown) => { initializePromise = undefined; throw error; });
      }
      await initializePromise;
    },
    create: async (raw: CreateRecord) => {
      available();
      const input = createCommand(raw);
      const digest = submissionDigest(input);
      return transaction(async tx => {
        const existing = await one(tx, 'SELECT * FROM mayura_aggregates WHERE scope = ? AND idempotency_key = ?', [input.scope, input.idempotencyKey]);
        if (existing) {
          if (existing.submission_digest !== digest) throw new StorageError('CONFLICT', 'This idempotency key was already used for a different submission (other input, definition or settings); resubmit exactly the same request, or use a new key.');
          return { record: record(existing), created: false };
        }
        if (await one(tx, 'SELECT * FROM mayura_aggregates WHERE scope = ? AND id = ?', [input.scope, input.id])) {
          throw new StorageError('CONFLICT', 'A record with this ID already exists in this scope under another idempotency key; use a different ID.');
        }
        await tx.execute({ sql: `INSERT INTO mayura_aggregates (scope, id, idempotency_key, definition_hash, submission_digest, version, event_sequence, state)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?)`, args: [input.scope, input.id, input.idempotencyKey, input.definitionHash, digest, input.events.length, JSON.stringify(input.state)] });
        await append(tx, input.scope, input.id, 0, input.events);
        const inserted = await one(tx, 'SELECT * FROM mayura_aggregates WHERE scope = ? AND id = ?', [input.scope, input.id]);
        if (!inserted) throw new StorageError('STORAGE_UNAVAILABLE', 'Created record is unavailable.');
        return { record: record(inserted), created: true };
      });
    },
    read: async (scope, id) => {
      available(); identifier(scope, 'Scope'); identifier(id, 'Record ID');
      try {
        const found = rows<Row>(await client.execute({ sql: 'SELECT * FROM mayura_aggregates WHERE scope = ? AND id = ?', args: [scope, id] }))[0];
        return found ? record(found) : undefined;
      } catch (error) { throw safeFailure(error); }
    },
    update: async (raw: UpdateRecord) => {
      available();
      const input = updateCommand(raw);
      return transaction(async tx => {
        const current = await one(tx, 'SELECT * FROM mayura_aggregates WHERE scope = ? AND id = ?', [input.scope, input.id]);
        if (!current) throw new StorageError('NOT_FOUND', 'Record was not found in this scope.');
        if (await ownedRun(session(tx), backend, input.scope, input.id)) writerRequired();
        const version = integer(current.version); const sequence = integer(current.event_sequence);
        if (version !== input.expectedVersion) throw new StorageError('CONFLICT', 'The record changed after it was read (another writer updated it); read it again and retry.');
        await tx.execute({ sql: 'UPDATE mayura_aggregates SET state = ?, version = ?, event_sequence = ? WHERE scope = ? AND id = ?',
          args: [JSON.stringify(input.state), nextCounter(version, 1), nextCounter(sequence, input.events.length), input.scope, input.id] });
        await append(tx, input.scope, input.id, sequence, input.events);
        const updated = await one(tx, 'SELECT * FROM mayura_aggregates WHERE scope = ? AND id = ?', [input.scope, input.id]);
        if (!updated) throw new StorageError('STORAGE_UNAVAILABLE', 'Updated record is unavailable.');
        return record(updated);
      });
    },
    migrate: async (raw: MigrateRecord) => {
      available();
      const input = migrateCommand(raw);
      return transaction(async tx => {
        const current = await one(tx, 'SELECT * FROM mayura_aggregates WHERE scope = ? AND id = ?', [input.scope, input.id]);
        if (!current) throw new StorageError('NOT_FOUND', 'Record was not found in this scope.');
        if (await ownedRun(session(tx), backend, input.scope, input.id)) writerRequired();
        const version = integer(current.version); const sequence = integer(current.event_sequence);
        if (version !== input.expectedVersion || current.definition_hash !== input.expectedDefinitionHash) throw new StorageError('CONFLICT', 'The record or its pinned definition changed after it was read; read it again and retry.');
        await tx.execute({ sql: 'UPDATE mayura_aggregates SET state = ?, definition_hash = ?, version = ?, event_sequence = ? WHERE scope = ? AND id = ?',
          args: [JSON.stringify(input.state), input.definitionHash, nextCounter(version, 1), nextCounter(sequence, input.events.length), input.scope, input.id] });
        await append(tx, input.scope, input.id, sequence, input.events);
        const updated = await one(tx, 'SELECT * FROM mayura_aggregates WHERE scope = ? AND id = ?', [input.scope, input.id]);
        if (!updated) throw new StorageError('STORAGE_UNAVAILABLE', 'Migrated record is unavailable.');
        return record(updated);
      });
    },
    events: async (scope, id, after = 0) => {
      available(); identifier(scope, 'Scope'); identifier(id, 'Record ID'); cursor(after);
      try {
        const found = rows<{ sequence: unknown; type: string; data: string; created_at: string }>(await client.execute({
          sql: 'SELECT sequence, type, data, created_at FROM mayura_events WHERE scope = ? AND aggregate_id = ? AND sequence > ? ORDER BY sequence LIMIT ?', args: [scope, id, after, EVENT_PAGE_SIZE] }));
        return found.map((row): StoredEvent => ({ sequence: integer(row.sequence), type: text(row.type), data: storedObject(JSON.parse(text(row.data))), createdAt: text(row.created_at) }));
      } catch (error) { throw safeFailure(error); }
    },
    close: () => {
      if (!closePromise) {
        closed = true;
        closePromise = Promise.resolve().then(() => { if (owned) client.close(); }).catch((error: unknown) => { throw safeFailure(error); });
      }
      return closePromise;
    },
  };
}
