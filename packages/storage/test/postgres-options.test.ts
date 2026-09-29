import { describe, expect, it } from 'vitest';
import { createPostgresStore } from '@mayura/storage-postgres';

// Options are checked before any connection is opened, so these tests need no database.
const connectionString = 'postgres://unused@127.0.0.1:1/unused';

describe('PostgreSQL pool options', () => {
  it('accepts a small pool for serverless functions, and the defaults', async () => {
    for (const pool of [undefined, { max: 1 }, { max: 2, connectionTimeoutMs: 10_000, idleTimeoutMs: 1_000 }, { max: 100, connectionTimeoutMs: 120_000, idleTimeoutMs: 3_600_000 }]) {
      const store = createPostgresStore({ connectionString, ...(pool ? { pool } : {}) });
      await store.close();
    }
  });

  it('refuses pool settings outside their bounds, and unknown ones', () => {
    for (const pool of [{ max: 0 }, { max: 101 }, { max: 1.5 }, { connectionTimeoutMs: 99 }, { connectionTimeoutMs: 120_001 },
      { idleTimeoutMs: 0 }, { idleTimeoutMs: 3_600_001 }, { maxConnections: 2 }, null]) {
      expect(() => createPostgresStore({ connectionString, pool: pool as never })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    }
  });
});
