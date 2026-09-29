import { Pool } from 'pg';
import { StorageError } from '@mayura/storage-contracts';
import type { WorkflowGraphDiscoveryAggregateStore, DurableBudgetAggregateStore, WorkflowTreeDiscoveryAggregateStore, MemoryIndexAggregateStore } from '@mayura/storage-contracts';
import { postgresSchema, postgresStore } from './store.js';

export interface PostgresStoreOptions {
  readonly connectionString: string;
  readonly schema?: string;
  /**
   * The connection pool. The defaults suit a long-running server: up to 8 connections, 5 s to connect, idle connections
   * closed after 10 s. On serverless functions, where every instance has its own pool, use `max: 1` or `2` and connect
   * through your provider's pooler. Mayura keeps no session state between transactions (each operation is one
   * transaction, with `SET LOCAL` settings and transaction-scoped locks), which is what transaction-mode poolers need.
   */
  readonly pool?: PostgresPoolOptions;
}
export interface PostgresPoolOptions {
  /** Most connections open at once, 1 to 100. Default 8. */
  readonly max?: number;
  /** How long to wait for a connection, 100 to 120,000 ms. Default 5,000. */
  readonly connectionTimeoutMs?: number;
  /** How long an idle connection stays open, 100 to 3,600,000 ms. Default 10,000. */
  readonly idleTimeoutMs?: number;
}

/**
 * Optional PostgreSQL adapter. A schema is isolated storage, not an authorization boundary. Mayura opens a `pg` pool
 * and ends it on `close()`. To use a pool you own, or on runtimes without TCP sockets, use `mayura/storage-postgres/driver`.
 */
export function createPostgresStore(options: PostgresStoreOptions): WorkflowGraphDiscoveryAggregateStore & DurableBudgetAggregateStore & WorkflowTreeDiscoveryAggregateStore & MemoryIndexAggregateStore {
  if (typeof options.connectionString !== 'string' || options.connectionString.length === 0) {
    throw new StorageError('INVALID_INPUT', 'PostgreSQL connection string is required.');
  }
  const schema = postgresSchema(options.schema);
  const settings = options.pool === undefined ? {} : options.pool;
  if (settings === null || typeof settings !== 'object' || Object.keys(settings).some(key => !['max', 'connectionTimeoutMs', 'idleTimeoutMs'].includes(key))) {
    throw new StorageError('INVALID_INPUT', 'PostgreSQL pool options are max, connectionTimeoutMs and idleTimeoutMs.');
  }
  const max = settings.max ?? 8; const connectionTimeoutMs = settings.connectionTimeoutMs ?? 5_000; const idleTimeoutMs = settings.idleTimeoutMs ?? 10_000;
  for (const [name, value, minimum, maximum] of [['max', max, 1, 100], ['connectionTimeoutMs', connectionTimeoutMs, 100, 120_000], ['idleTimeoutMs', idleTimeoutMs, 100, 3_600_000]] as const) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new StorageError('INVALID_INPUT', `PostgreSQL pool ${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  const pool = new Pool({ connectionString: options.connectionString, max, connectionTimeoutMillis: connectionTimeoutMs, idleTimeoutMillis: idleTimeoutMs });
  // Idle-client errors must not become unhandled EventEmitter exceptions. Commands still fail closed.
  pool.on('error', () => { /* Driver detail is intentionally not exposed through the public adapter. */ });
  return postgresStore(pool, schema, () => pool.end());
}
