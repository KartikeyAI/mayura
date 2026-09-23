import { Pool, type PoolClient } from 'pg';
import { StorageError, storageError, type CreateRecord, type StoredRecord, type StoredEvent, type UpdateRecord, type WorkflowGraphDiscoveryAggregateStore, type DurableBudgetAggregateStore, type WorkflowTreeAggregateStore } from '@mayura/storage-contracts';
import {
  createCommand, updateCommand, submissionDigest, nextCounter, identifier, cursor, storedObject, EVENT_PAGE_SIZE,
  SchedulerDatabase, type SchedulerBackend, type SchedulerSession, schedulerFacade,
  ScheduledWorkflowDatabase, scheduledFacade, workflowGraphFacade, initializeOwnership, ownedRun, writerRequired,
  ExecutionWaitDatabase, executionWaitFacade,
  workflowGraphDiscoveryFacade,
  DurableBudgetDatabase, durableBudgetFacade,
  WorkflowTreeDatabase, workflowTreeFacade,
} from '@mayura/storage-sql/host';

export interface PostgresStoreOptions { readonly connectionString: string; readonly schema?: string }
interface Row {
  scope: string; id: string; idempotency_key: string; definition_hash: string;
  submission_digest: string; version: string; event_sequence: string; state: string;
}

function integer(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new StorageError('STORAGE_UNAVAILABLE', 'Stored counter failed integrity validation.');
  return result;
}

function record(row: Row): StoredRecord {
  return {
    scope: row.scope, id: row.id, idempotencyKey: row.idempotency_key,
    definitionHash: row.definition_hash, version: integer(row.version), state: storedObject(JSON.parse(row.state)),
  };
}

function safeFailure(error: unknown): StorageError {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
    return new StorageError('CONFLICT', 'A scoped record or idempotency key already exists.');
  }
  return storageError(error);
}

/** Optional PostgreSQL adapter. A schema is isolated storage, not an authorization boundary. */
export function createPostgresStore(options: PostgresStoreOptions): WorkflowGraphDiscoveryAggregateStore & DurableBudgetAggregateStore & WorkflowTreeAggregateStore {
  if (typeof options.connectionString !== 'string' || options.connectionString.length === 0) {
    throw new StorageError('INVALID_INPUT', 'PostgreSQL connection string is required.');
  }
  const schema = options.schema ?? 'mayura';
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
    throw new StorageError('INVALID_INPUT', 'PostgreSQL schema must be a lowercase identifier of at most 63 characters.');
  }
  // The only interpolated SQL fragment is validated above; all record values are parameters.
  const prefix = `"${schema}"`;
  const aggregates = `${prefix}.mayura_aggregates`;
  const eventsTable = `${prefix}.mayura_events`;
  const pool = new Pool({ connectionString: options.connectionString, max: 8, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 10_000 });
  // Idle-client errors must not become unhandled EventEmitter exceptions. Commands still fail closed.
  pool.on('error', () => { /* Driver detail is intentionally not exposed through the public adapter. */ });
  let initialized = false;
  let closed = false;
  let initializePromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;

  const available = (requireInitialization = true): void => {
    if (closed) throw new StorageError('STORE_CLOSED', 'Storage has been closed.');
    if (requireInitialization && !initialized) throw new StorageError('STORE_NOT_INITIALIZED', 'Initialize storage before accessing records.');
  };

  const transaction = async <T>(body: (client: PoolClient) => Promise<T>): Promise<T> => {
    let client: PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '10s'");
      await client.query("SET LOCAL lock_timeout = '5s'");
      const result = await body(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (client) { try { await client.query('ROLLBACK'); } catch { /* Original safe failure remains authoritative. */ } }
      throw safeFailure(error);
    } finally { client?.release(); }
  };

  const append = async (client: PoolClient, scope: string, id: string, sequence: number, events: CreateRecord['events']): Promise<void> => {
    for (const [index, event] of events.entries()) {
      await client.query(`INSERT INTO ${eventsTable} (scope, aggregate_id, sequence, type, data, created_at)
        VALUES ($1, $2, $3, $4, $5, transaction_timestamp())`,
      [scope, id, nextCounter(sequence, index + 1), event.type, JSON.stringify(event.data)]);
    }
  };

  const session = (client: PoolClient): SchedulerSession => ({
    query: async <T>(sql: string, parameters: readonly unknown[] = []) => {
      let ordinal = 0;
      // Scheduler SQL uses only positional ? placeholders, never interpolated application text.
      const result = await client.query(sql.replace(/\?/g, () => `$${++ordinal}`), [...parameters]);
      return result.rows as T[];
    },
  });
  const backend: SchedulerBackend = { dialect:'postgres',prefix:`${prefix}.`,transaction:body => transaction(client => body(session(client))) };
  const schedulerDatabase = new SchedulerDatabase(backend);
  const workflowsDatabase = new ScheduledWorkflowDatabase(backend,schedulerDatabase);
  const executionWaitDatabase = new ExecutionWaitDatabase(backend,workflowsDatabase);
  const durableBudgetDatabase = new DurableBudgetDatabase(backend);
  const workflowTreeDatabase = new WorkflowTreeDatabase(backend,schedulerDatabase);
  return {
    scheduler: schedulerFacade((method, input) => { available(); return schedulerDatabase.execute(method, input); }),
    workflows: scheduledFacade((method,input) => { available(); return workflowsDatabase.execute(method,input); }),
    workflowGraphs: workflowGraphFacade((method,input) => { available(); return workflowsDatabase.execute(method,input,2); }),
    workflowGraphDiscovery: workflowGraphDiscoveryFacade((method,input) => { available(); return workflowsDatabase.discover(method,input); }),
    executionWaits: executionWaitFacade((method,input) => { available(); return executionWaitDatabase.execute(method,input); }),
    durableBudgets: durableBudgetFacade((method,input) => { available(); return durableBudgetDatabase.execute(method,input); }),
    workflowTrees: workflowTreeFacade((method,input) => { available(); return workflowTreeDatabase.execute(method,input); }),
    initialize: async () => {
      available(false);
      if (!initializePromise) {
        initializePromise = transaction(async (client) => {
          // Serialize schema bootstrap across application instances without holding business locks.
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`mayura:storage-schema:${schema}`]);
          await client.query(`CREATE SCHEMA IF NOT EXISTS ${prefix}`);
          await client.query(`CREATE TABLE IF NOT EXISTS ${prefix}.mayura_storage_meta (version INTEGER PRIMARY KEY CHECK(version = 1))`);
          await client.query(`INSERT INTO ${prefix}.mayura_storage_meta (version) VALUES (1) ON CONFLICT DO NOTHING`);
          const versions = await client.query<{ version: number }>(`SELECT version FROM ${prefix}.mayura_storage_meta`);
          if (versions.rows.length !== 1 || versions.rows[0]?.version !== 1) throw new StorageError('STORAGE_UNAVAILABLE', 'Unsupported storage schema version.');
          await client.query(`CREATE TABLE IF NOT EXISTS ${aggregates} (
            scope TEXT NOT NULL, id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
            definition_hash TEXT NOT NULL, submission_digest TEXT NOT NULL,
            version BIGINT NOT NULL CHECK(version > 0), event_sequence BIGINT NOT NULL CHECK(event_sequence >= 0),
            state TEXT NOT NULL, PRIMARY KEY(scope, id), UNIQUE(scope, idempotency_key)
          )`);
          await client.query(`CREATE TABLE IF NOT EXISTS ${eventsTable} (
            scope TEXT NOT NULL, aggregate_id TEXT NOT NULL, sequence BIGINT NOT NULL CHECK(sequence > 0),
            type TEXT NOT NULL, data TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,
            PRIMARY KEY(scope, aggregate_id, sequence),
            FOREIGN KEY(scope, aggregate_id) REFERENCES ${aggregates}(scope, id)
          )`);
          await initializeOwnership(session(client),backend);
        }).then(() => { initialized = true; }).catch((error: unknown) => { initializePromise = undefined; throw error; });
      }
      await initializePromise;
    },
    create: async (raw: CreateRecord) => {
      available();
      const input = createCommand(raw);
      const digest = submissionDigest(input);
      return transaction(async (client) => {
        const inserted = await client.query<Row>(`INSERT INTO ${aggregates}
          (scope, id, idempotency_key, definition_hash, submission_digest, version, event_sequence, state)
          VALUES ($1, $2, $3, $4, $5, 1, $6, $7)
          ON CONFLICT (scope, idempotency_key) DO NOTHING RETURNING *`,
        [input.scope, input.id, input.idempotencyKey, input.definitionHash, digest, input.events.length, JSON.stringify(input.state)]);
        const row = inserted.rows[0];
        if (row) {
          await append(client, input.scope, input.id, 0, input.events);
          return { record: record(row), created: true };
        }
        const found = await client.query<Row>(`SELECT * FROM ${aggregates} WHERE scope = $1 AND idempotency_key = $2`, [input.scope, input.idempotencyKey]);
        const existing = found.rows[0];
        if (!existing) throw new StorageError('STORAGE_UNAVAILABLE', 'Existing submission is unavailable.');
        if (existing.submission_digest !== digest) throw new StorageError('CONFLICT', 'Idempotency key already belongs to a different submission.');
        return { record: record(existing), created: false };
      });
    },
    read: async (scope, id) => {
      available(); identifier(scope, 'Scope'); identifier(id, 'Record ID');
      try {
        const result = await pool.query<Row>(`SELECT * FROM ${aggregates} WHERE scope = $1 AND id = $2`, [scope, id]);
        return result.rows[0] ? record(result.rows[0]) : undefined;
      } catch (error) { throw safeFailure(error); }
    },
    update: async (raw: UpdateRecord) => {
      available();
      const input = updateCommand(raw);
      return transaction(async (client) => {
        const selected = await client.query<Row>(`SELECT * FROM ${aggregates} WHERE scope = $1 AND id = $2 FOR UPDATE`, [input.scope, input.id]);
        const current = selected.rows[0];
        if (!current) throw new StorageError('NOT_FOUND', 'Record was not found in this scope.');
        if (await ownedRun(session(client),backend,input.scope,input.id)) writerRequired();
        const version = integer(current.version);
        const sequence = integer(current.event_sequence);
        if (version !== input.expectedVersion) throw new StorageError('CONFLICT', 'Record version has changed.');
        const updated = await client.query<Row>(`UPDATE ${aggregates} SET state = $1, version = $2, event_sequence = $3 WHERE scope = $4 AND id = $5 RETURNING *`,
          [JSON.stringify(input.state), nextCounter(version, 1), nextCounter(sequence, input.events.length), input.scope, input.id]);
        await append(client, input.scope, input.id, sequence, input.events);
        const row = updated.rows[0];
        if (!row) throw new StorageError('STORAGE_UNAVAILABLE', 'Updated record is unavailable.');
        return record(row);
      });
    },
    events: async (scope, id, after = 0) => {
      available(); identifier(scope, 'Scope'); identifier(id, 'Record ID'); cursor(after);
      try {
        const result = await pool.query<{ sequence: string; type: string; data: string; created_at: Date }>(
          `SELECT sequence, type, data, created_at FROM ${eventsTable} WHERE scope = $1 AND aggregate_id = $2 AND sequence > $3 ORDER BY sequence LIMIT $4`,
          [scope, id, after, EVENT_PAGE_SIZE]);
        return result.rows.map((row): StoredEvent => ({ sequence: integer(row.sequence), type: row.type, data: storedObject(JSON.parse(row.data)), createdAt: row.created_at.toISOString() }));
      } catch (error) { throw safeFailure(error); }
    },
    close: () => {
      if (!closePromise) { closed = true; closePromise = pool.end().catch((error: unknown) => { throw safeFailure(error); }); }
      return closePromise;
    },
  };
}
