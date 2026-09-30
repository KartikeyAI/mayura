import { createPool, type Pool } from 'mysql2/promise';
import { StorageError, storageError, type CreateRecord, type DurableBudgetAggregateStore, type MemoryIndexAggregateStore, type MigrateRecord, type StoredEvent, type StoredRecord,
  type UpdateRecord, type WorkflowGraphDiscoveryAggregateStore, type WorkflowTreeDiscoveryAggregateStore } from 'mayura/storage-contracts';
import {
  createCommand, cursor, durableBudgetFacade, DurableBudgetDatabase, EVENT_PAGE_SIZE, executionWaitFacade, ExecutionWaitDatabase, identifier, initializeOwnership, memoryIndexFacade,
  MemoryIndexDatabase, migrateCommand, nextCounter, ownedRun, ScheduledWorkflowDatabase, scheduledFacade, SchedulerDatabase, schedulerFacade, storedObject, submissionDigest,
  updateCommand, workflowGraphDiscoveryFacade, workflowGraphFacade, WorkflowTreeDatabase, workflowTreeDiscoveryFacade, workflowTreeFacade, writerRequired,
  type SchedulerBackend, type SchedulerSession,
} from 'mayura/storage-sql/host';
import { KEY_TYPE, TABLE_OPTIONS, translate } from './translate.js';

export type MysqlStore = WorkflowGraphDiscoveryAggregateStore & DurableBudgetAggregateStore & WorkflowTreeDiscoveryAggregateStore & MemoryIndexAggregateStore;

/** A connection from a mysql2/promise pool. */
export interface MysqlDriverConnection {
  query(sql: string, values?: unknown[]): Promise<[unknown, unknown]>;
  release(): void;
}
/** A mysql2/promise pool you create and own. */
export interface MysqlDriverPool { getConnection(): Promise<MysqlDriverConnection> }

export interface MysqlStoreOptions {
  /**
   * A `mysql://` URL with the user, password, host, port and database; the database holds Mayura's tables. Keep it in your secret
   * configuration. Give this or `driver`.
   */
  readonly uri?: string;
  /** Verify the server's certificate over TLS (required by most hosted MySQL), optionally against your CA. */
  readonly tls?: boolean | { readonly ca: string };
  /** The connection pool for a `uri`: up to `max` connections (1 to 100, default 8). */
  readonly pool?: { readonly max?: number; readonly connectionTimeoutMs?: number; readonly idleTimeoutMs?: number };
  /**
   * A mysql2/promise pool you create and own, instead of `uri`. It must not set the CLIENT_FOUND_ROWS flag (mysql2
   * sets it by default: create the pool with `flags: ['-FOUND_ROWS']`); `initialize()` checks. Mayura never ends it.
   */
  readonly driver?: MysqlDriverPool;
}

/** Session settings for every transaction: strict data, ANSI identifiers and `||`, read committed, 5 s lock waits, UTC. */
const SQL_MODE = 'ANSI_QUOTES,PIPES_AS_CONCAT,STRICT_ALL_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ZERO_DATE,NO_ZERO_IN_DATE,NO_ENGINE_SUBSTITUTION';
const SETTINGS = "SET SESSION sql_mode = ?, SESSION transaction_isolation = 'READ-COMMITTED', SESSION innodb_lock_wait_timeout = 5, SESSION time_zone = '+00:00'";

interface Row { scope: string; id: string; idempotency_key: string; definition_hash: string; submission_digest: string; version: number | string; event_sequence: number | string; state: string }

function integer(value: unknown): number {
  const result = typeof value === 'string' ? Number(value) : value;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 0) throw new StorageError('STORAGE_UNAVAILABLE', 'Stored counter failed integrity validation.');
  return result;
}
function record(row: Row): StoredRecord {
  return { scope: row.scope, id: row.id, idempotencyKey: row.idempotency_key, definitionHash: row.definition_hash, version: integer(row.version), state: storedObject(JSON.parse(row.state)) };
}
/** Key columns are VARBINARY: their values come back as bytes, which are UTF-8 text. */
function rowsOf<T>(result: unknown): T[] {
  if (!Array.isArray(result)) return [];
  return result.map(row => Object.fromEntries(Object.entries(row as Record<string, unknown>)
    .map(([column, value]) => [column, value instanceof Uint8Array ? new TextDecoder('utf-8', { fatal: true }).decode(value) : value])) as T);
}
const errno = (error: unknown): number | undefined => typeof error === 'object' && error !== null && 'errno' in error && typeof error.errno === 'number' ? error.errno : undefined;
function safeFailure(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  if (errno(error) === 1062) return new StorageError('CONFLICT', 'A record with this ID or idempotency key already exists in this scope with different content; use a new ID or key.');
  if (errno(error) === 1205 || errno(error) === 1213) return new StorageError('CONFLICT', 'Another writer holds these rows; retry with bounded backoff.');
  return storageError(error);
}
function bounded(value: unknown, name: string, minimum: number, maximum: number, fallback: number): number {
  const result = value ?? fallback;
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < minimum || result > maximum) throw new StorageError('INVALID_INPUT', `MySQL pool ${name} must be an integer from ${minimum} to ${maximum}.`);
  return result;
}

/**
 * Mayura storage on MySQL 8.0.19 or later (InnoDB), through `mysql2`: the same store as `mayura/storage-sqlite` and
 * `mayura/storage-postgres`, with the same SQL layer. Every operation is one transaction; rows are locked with
 * `FOR UPDATE`, and work that has no row to lock yet takes a named lock (`GET_LOCK`) released when it ends.
 *
 * ```ts
 * const store = createMysqlStore({ uri: process.env.DATABASE_URL! });
 * await store.initialize();
 * ```
 */
export function createMysqlStore(options: MysqlStoreOptions): MysqlStore {
  if (options === null || typeof options !== 'object' || Object.keys(options).some(key => !['uri', 'tls', 'pool', 'driver'].includes(key))) {
    throw new StorageError('INVALID_INPUT', 'MySQL store options are uri, tls, pool and driver.');
  }
  if ((options.uri === undefined) === (options.driver === undefined)) throw new StorageError('INVALID_INPUT', 'MySQL store needs either a uri or a driver.');
  let pool: MysqlDriverPool; let owned: Pool | undefined;
  if (options.driver !== undefined) {
    if (options.tls !== undefined || options.pool !== undefined) throw new StorageError('INVALID_INPUT', 'Give TLS and pool settings to the MySQL pool you create.');
    const driver = options.driver as Partial<MysqlDriverPool> | null;
    if (driver === null || typeof driver !== 'object' || typeof driver.getConnection !== 'function') throw new StorageError('INVALID_INPUT', 'MySQL driver must be a mysql2/promise pool.');
    pool = options.driver;
  } else {
    let url: URL;
    try { url = new URL(typeof options.uri === 'string' ? options.uri : ''); } catch { throw new StorageError('INVALID_INPUT', 'MySQL uri must be a mysql:// URL.'); }
    if (url.protocol !== 'mysql:' || !url.hostname || !/^\/[A-Za-z0-9_$]{1,64}$/.test(url.pathname)) throw new StorageError('INVALID_INPUT', 'MySQL uri must be a mysql:// URL naming a host and a database.');
    const tls = options.tls;
    if (tls !== undefined && typeof tls !== 'boolean' && !(tls && typeof tls === 'object' && typeof tls.ca === 'string')) throw new StorageError('INVALID_INPUT', 'MySQL tls is true, false or { ca }.');
    const settings = options.pool ?? {};
    if (settings === null || typeof settings !== 'object' || Object.keys(settings).some(key => !['max', 'connectionTimeoutMs', 'idleTimeoutMs'].includes(key))) {
      throw new StorageError('INVALID_INPUT', 'MySQL pool options are max, connectionTimeoutMs and idleTimeoutMs.');
    }
    owned = createPool({
      uri: options.uri!, connectionLimit: bounded(settings.max, 'max', 1, 100, 8), connectTimeout: bounded(settings.connectionTimeoutMs, 'connectionTimeoutMs', 100, 120_000, 5_000),
      idleTimeout: bounded(settings.idleTimeoutMs, 'idleTimeoutMs', 100, 3_600_000, 10_000), waitForConnections: true, queueLimit: 256,
      // Report a duplicate left unchanged as no affected row; one statement per query; integers beyond 2^53 as text.
      flags: ['-FOUND_ROWS'], multipleStatements: false, supportBigNumbers: true, bigNumberStrings: false, dateStrings: true,
      ...(tls === undefined || tls === false ? {} : { ssl: { rejectUnauthorized: true, ...(typeof tls === 'object' ? { ca: tls.ca } : {}) } }),
    });
    pool = owned as unknown as MysqlDriverPool;
  }

  let initialized = false; let closed = false;
  let initializePromise: Promise<void> | undefined; let closePromise: Promise<void> | undefined;
  const available = (requireInitialization = true): void => {
    if (closed) throw new StorageError('STORE_CLOSED', 'Storage has been closed; open a new store to continue.');
    if (requireInitialization && !initialized) throw new StorageError('STORE_NOT_INITIALIZED', 'Storage is not initialized: call `await store.initialize()` before using it.');
  };
  const run = async (connection: MysqlDriverConnection, sql: string, values: readonly unknown[] = []): Promise<unknown> => (await connection.query(sql, [...values]))[0];
  const session = (connection: MysqlDriverConnection): SchedulerSession => ({
    query: async <T>(sql: string, parameters: readonly unknown[] = []) => {
      const statement = translate(sql);
      if (statement.kind === 'index') {
        const found = rowsOf(await run(connection, 'SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1', [statement.table, statement.name]));
        if (found.length === 0) await run(connection, statement.sql);
        return [];
      }
      // Only positional ? placeholders reach mysql2, which sends escaped values; no application text is interpolated.
      return rowsOf<T>(await run(connection, statement.sql, parameters));
    },
  });
  /** One transaction on one connection. A deadlock or lock timeout rolls it back and reports a retryable conflict. */
  const transaction = async <T>(body: (connection: MysqlDriverConnection) => Promise<T>): Promise<T> => {
    let connection: MysqlDriverConnection | undefined; let began = false;
    try {
      connection = await pool.getConnection();
      await run(connection, SETTINGS, [SQL_MODE]);
      await run(connection, 'START TRANSACTION'); began = true;
      const result = await body(connection);
      await run(connection, 'COMMIT');
      return result;
    } catch (error) {
      if (connection && began) { try { await run(connection, 'ROLLBACK'); } catch { /* The original failure remains authoritative. */ } }
      throw safeFailure(error);
    } finally {
      // Named locks belong to the connection, not the transaction.
      if (connection) { try { await run(connection, 'DO RELEASE_ALL_LOCKS()'); } catch { /* A broken connection holds nothing. */ } connection.release(); }
    }
  };
  const read = async <T>(sql: string, values: readonly unknown[]): Promise<T[]> => {
    let connection: MysqlDriverConnection | undefined;
    try { connection = await pool.getConnection(); await run(connection, SETTINGS, [SQL_MODE]); return rowsOf<T>(await run(connection, sql, values)); }
    catch (error) { throw safeFailure(error); } finally { connection?.release(); }
  };
  const clock = async (connection: MysqlDriverConnection): Promise<string> => {
    const [row] = rowsOf<{ now_ms: number | string }>(await run(connection, 'SELECT CAST(FLOOR(UNIX_TIMESTAMP(SYSDATE(3)) * 1000) AS SIGNED) AS now_ms'));
    return new Date(integer(row?.now_ms)).toISOString();
  };
  const one = async (connection: MysqlDriverConnection, sql: string, values: readonly unknown[]): Promise<Row | undefined> => rowsOf<Row>(await run(connection, sql, values))[0];
  const append = async (connection: MysqlDriverConnection, scope: string, id: string, sequence: number, events: CreateRecord['events']): Promise<void> => {
    if (events.length === 0) return;
    const createdAt = await clock(connection);
    for (const [index, event] of events.entries()) {
      await run(connection, 'INSERT INTO mayura_events (scope, aggregate_id, sequence, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [scope, id, nextCounter(sequence, index + 1), event.type, JSON.stringify(event.data), createdAt]);
    }
  };

  const backend: SchedulerBackend = { dialect: 'mysql', prefix: '', transaction: body => transaction(connection => body(session(connection))) };
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
        initializePromise = transaction(async connection => {
          const version = rowsOf<{ version: string }>(await run(connection, 'SELECT VERSION() AS version'))[0]?.version ?? '';
          const [major = 0, minor = 0, patch = 0] = version.split(/[.-]/).map(Number);
          if (major < 8 || (major === 8 && minor === 0 && patch < 19)) throw new StorageError('STORAGE_UNAVAILABLE', 'Mayura needs MySQL 8.0.19 or later.');
          // A duplicate left unchanged must count as no affected row, or the SQL layer would take it for an insert.
          await run(connection, 'CREATE TEMPORARY TABLE mayura_found_rows_probe (id INTEGER PRIMARY KEY)');
          try {
            await run(connection, 'INSERT INTO mayura_found_rows_probe (id) VALUES (1)');
            await run(connection, 'INSERT INTO mayura_found_rows_probe (id) VALUES (1) ON DUPLICATE KEY UPDATE id = id');
            const [changed] = rowsOf<{ changed: number | string }>(await run(connection, 'SELECT ROW_COUNT() AS changed'));
            if (Number(changed?.changed) !== 0) throw new StorageError('INVALID_INPUT', "The MySQL pool reports found rows (CLIENT_FOUND_ROWS); create it with flags: ['-FOUND_ROWS'].");
          } finally { await run(connection, 'DROP TEMPORARY TABLE mayura_found_rows_probe'); }
          await run(connection, 'SELECT GET_LOCK(?, 10)', ['mayura:storage-schema']);
          await run(connection, `CREATE TABLE IF NOT EXISTS mayura_storage_meta (version INTEGER PRIMARY KEY CHECK(version = 1)) ${TABLE_OPTIONS}`);
          await run(connection, 'INSERT INTO mayura_storage_meta (version) VALUES (1) ON DUPLICATE KEY UPDATE version = version');
          const versions = rowsOf<{ version: number }>(await run(connection, 'SELECT version FROM mayura_storage_meta'));
          if (versions.length !== 1 || Number(versions[0]?.version) !== 1) throw new StorageError('STORAGE_UNAVAILABLE', 'Unsupported storage schema version.');
          await run(connection, `CREATE TABLE IF NOT EXISTS mayura_aggregates (
            scope ${KEY_TYPE} NOT NULL, id ${KEY_TYPE} NOT NULL, idempotency_key ${KEY_TYPE} NOT NULL,
            definition_hash ${KEY_TYPE} NOT NULL, submission_digest ${KEY_TYPE} NOT NULL,
            version BIGINT NOT NULL CHECK(version > 0), event_sequence BIGINT NOT NULL CHECK(event_sequence >= 0),
            state LONGTEXT NOT NULL, PRIMARY KEY(scope, id), UNIQUE(scope, idempotency_key)) ${TABLE_OPTIONS}`);
          await run(connection, `CREATE TABLE IF NOT EXISTS mayura_events (
            scope ${KEY_TYPE} NOT NULL, aggregate_id ${KEY_TYPE} NOT NULL, sequence BIGINT NOT NULL CHECK(sequence > 0),
            type ${KEY_TYPE} NOT NULL, data LONGTEXT NOT NULL, created_at ${KEY_TYPE} NOT NULL,
            PRIMARY KEY(scope, aggregate_id, sequence),
            FOREIGN KEY(scope, aggregate_id) REFERENCES mayura_aggregates(scope, id)) ${TABLE_OPTIONS}`);
          await initializeOwnership(session(connection), backend);
        }).then(() => { initialized = true; }).catch((error: unknown) => { initializePromise = undefined; throw error; });
      }
      await initializePromise;
    },
    create: async (raw: CreateRecord) => {
      available();
      const input = createCommand(raw);
      const digest = submissionDigest(input);
      return transaction(async connection => {
        // A concurrent identical submission waits on the unique key, then changes nothing.
        await run(connection, `INSERT INTO mayura_aggregates (scope, id, idempotency_key, definition_hash, submission_digest, version, event_sequence, state)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?) ON DUPLICATE KEY UPDATE idempotency_key = idempotency_key`,
        [input.scope, input.id, input.idempotencyKey, input.definitionHash, digest, input.events.length, JSON.stringify(input.state)]);
        const [changed] = rowsOf<{ changed: number | string }>(await run(connection, 'SELECT ROW_COUNT() AS changed'));
        if (Number(changed?.changed) === 1) {
          await append(connection, input.scope, input.id, 0, input.events);
          const inserted = await one(connection, 'SELECT * FROM mayura_aggregates WHERE scope = ? AND id = ?', [input.scope, input.id]);
          if (!inserted) throw new StorageError('STORAGE_UNAVAILABLE', 'Created record is unavailable.');
          return { record: record(inserted), created: true };
        }
        const existing = await one(connection, 'SELECT * FROM mayura_aggregates WHERE scope = ? AND idempotency_key = ? FOR UPDATE', [input.scope, input.idempotencyKey]);
        if (!existing) throw new StorageError('CONFLICT', 'A record with this ID already exists in this scope under another idempotency key; use a different ID.');
        if (existing.submission_digest !== digest) throw new StorageError('CONFLICT', 'This idempotency key was already used for a different submission (other input, definition or settings); resubmit exactly the same request, or use a new key.');
        return { record: record(existing), created: false };
      });
    },
    read: async (scope, id) => {
      available(); identifier(scope, 'Scope'); identifier(id, 'Record ID');
      const [found] = await read<Row>('SELECT * FROM mayura_aggregates WHERE scope = ? AND id = ?', [scope, id]);
      return found ? record(found) : undefined;
    },
    update: async (raw: UpdateRecord) => {
      available();
      const input = updateCommand(raw);
      return transaction(async connection => {
        const current = await one(connection, 'SELECT * FROM mayura_aggregates WHERE scope = ? AND id = ? FOR UPDATE', [input.scope, input.id]);
        if (!current) throw new StorageError('NOT_FOUND', 'Record was not found in this scope.');
        if (await ownedRun(session(connection), backend, input.scope, input.id)) writerRequired();
        const version = integer(current.version); const sequence = integer(current.event_sequence);
        if (version !== input.expectedVersion) throw new StorageError('CONFLICT', 'The record changed after it was read (another writer updated it); read it again and retry.');
        await run(connection, 'UPDATE mayura_aggregates SET state = ?, version = ?, event_sequence = ? WHERE scope = ? AND id = ?',
          [JSON.stringify(input.state), nextCounter(version, 1), nextCounter(sequence, input.events.length), input.scope, input.id]);
        await append(connection, input.scope, input.id, sequence, input.events);
        const updated = await one(connection, 'SELECT * FROM mayura_aggregates WHERE scope = ? AND id = ?', [input.scope, input.id]);
        if (!updated) throw new StorageError('STORAGE_UNAVAILABLE', 'Updated record is unavailable.');
        return record(updated);
      });
    },
    migrate: async (raw: MigrateRecord) => {
      available();
      const input = migrateCommand(raw);
      return transaction(async connection => {
        const current = await one(connection, 'SELECT * FROM mayura_aggregates WHERE scope = ? AND id = ? FOR UPDATE', [input.scope, input.id]);
        if (!current) throw new StorageError('NOT_FOUND', 'Record was not found in this scope.');
        if (await ownedRun(session(connection), backend, input.scope, input.id)) writerRequired();
        const version = integer(current.version); const sequence = integer(current.event_sequence);
        if (version !== input.expectedVersion || current.definition_hash !== input.expectedDefinitionHash) throw new StorageError('CONFLICT', 'The record or its pinned definition changed after it was read; read it again and retry.');
        await run(connection, 'UPDATE mayura_aggregates SET state = ?, definition_hash = ?, version = ?, event_sequence = ? WHERE scope = ? AND id = ?',
          [JSON.stringify(input.state), input.definitionHash, nextCounter(version, 1), nextCounter(sequence, input.events.length), input.scope, input.id]);
        await append(connection, input.scope, input.id, sequence, input.events);
        const updated = await one(connection, 'SELECT * FROM mayura_aggregates WHERE scope = ? AND id = ?', [input.scope, input.id]);
        if (!updated) throw new StorageError('STORAGE_UNAVAILABLE', 'Migrated record is unavailable.');
        return record(updated);
      });
    },
    events: async (scope, id, after = 0) => {
      available(); identifier(scope, 'Scope'); identifier(id, 'Record ID'); cursor(after);
      const found = await read<{ sequence: number | string; type: string; data: string; created_at: string }>(
        'SELECT sequence, type, data, created_at FROM mayura_events WHERE scope = ? AND aggregate_id = ? AND sequence > ? ORDER BY sequence LIMIT ?', [scope, id, after, EVENT_PAGE_SIZE]);
      return found.map((row): StoredEvent => ({ sequence: integer(row.sequence), type: row.type, data: storedObject(JSON.parse(row.data)), createdAt: row.created_at }));
    },
    close: () => {
      if (!closePromise) { closed = true; closePromise = (owned ? owned.end() : Promise.resolve()).catch((error: unknown) => { throw safeFailure(error); }); }
      return closePromise;
    },
  };
}
