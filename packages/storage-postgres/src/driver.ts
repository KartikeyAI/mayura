import { StorageError } from '@mayura/storage-contracts';
import { postgresSchema, postgresStore, type PostgresDriverPool, type PostgresStore } from './store.js';

export type { PostgresDriverClient, PostgresDriverPool, PostgresStore } from './store.js';

export interface PostgresDriverStoreOptions {
  /**
   * A pg-compatible pool you create and own, such as the WebSocket Pool of `@neondatabase/serverless` on runtimes
   * without TCP sockets (Vercel Edge Functions). Mayura never ends it: end it when you are done, for example in the
   * platform's `waitUntil` after a request.
   */
  readonly driver: PostgresDriverPool;
  readonly schema?: string;
}

/**
 * The PostgreSQL store on a pg-compatible pool you own, without the `pg` package: a `pg` Pool you share with the
 * rest of your application, or on runtimes without TCP sockets, such as Vercel Edge Functions, the WebSocket Pool of
 * `@neondatabase/serverless`. A schema is isolated storage, not an authorization boundary.
 */
export function createPostgresStore(options: PostgresDriverStoreOptions): PostgresStore {
  if (options === null || typeof options !== 'object' || !('driver' in options)) {
    throw new StorageError('INVALID_INPUT', 'PostgreSQL driver is required: a pg-compatible pool. For a connection string, import from mayura/storage-postgres.');
  }
  const extra = Object.keys(options).filter(key => key !== 'driver' && key !== 'schema');
  if (extra.length > 0) {
    throw new StorageError('INVALID_INPUT', 'PostgreSQL driver options are driver and schema; for a connection string and pool settings, import from mayura/storage-postgres.');
  }
  const driver = options.driver as Partial<PostgresDriverPool> | null;
  if (driver === null || typeof driver !== 'object' || typeof driver.connect !== 'function' || typeof driver.query !== 'function') {
    throw new StorageError('INVALID_INPUT', 'PostgreSQL driver must be a pg-compatible pool with connect() and query().');
  }
  return postgresStore(options.driver, postgresSchema(options.schema));
}

