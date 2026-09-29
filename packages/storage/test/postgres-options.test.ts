import { describe, expect, it } from 'vitest';
import { createPostgresStore } from '@mayura/storage-postgres';
import { createPostgresStore as createDriverStore } from '@mayura/storage-postgres/driver';

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

describe('PostgreSQL driver pools', () => {
  const pool = () => {
    const calls: string[] = [];
    const client = { query: async (text: string) => { calls.push(text); return { rows: [] }; }, release: () => { calls.push('release'); } };
    return { calls, connect: async () => client, query: async (text: string) => { calls.push(text); return { rows: [] }; }, end: async () => { calls.push('end'); } };
  };

  it('uses a pg-compatible pool you own and never ends it', async () => {
    const driver = pool();
    const store = createDriverStore({ driver, schema: 'edge_app' });
    await store.close(); await store.close();
    expect(driver.calls).not.toContain('end');
    await expect(store.read('scope', 'id')).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE', message: expect.stringMatching(/closed/) });
  });

  it('refuses a driver that is not a pool, mixed options, and a driver on the connection-string entry point', () => {
    for (const driver of [null, {}, { connect: async () => ({}) }, { query: async () => ({ rows: [] }) }, 'postgres://x']) {
      expect(() => createDriverStore({ driver: driver as never })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    }
    expect(() => createPostgresStore({ driver: pool() } as never)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT', message: expect.stringMatching(/connection string/) }));
    for (const mixed of [{ connectionString }, { pool: { max: 1 } }]) {
      expect(() => createDriverStore({ driver: pool(), ...mixed } as never)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT', message: expect.stringMatching(/mayura\/storage-postgres/) }));
    }
    expect(() => createDriverStore({ driver: pool(), schema: 'Bad-Schema' })).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => createDriverStore({ connectionString } as never)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT', message: expect.stringMatching(/mayura\/storage-postgres/) }));
  });

  it('fails closed, releasing the connection, when the driver fails', async () => {
    const released: string[] = [];
    const failing = { connect: async () => ({ query: async (text: string) => { if (text === 'BEGIN') return { rows: [] }; throw Object.assign(new Error('socket hang up: secret detail'), { code: 'ECONNRESET' }); }, release: () => { released.push('release'); } }),
      query: async () => { throw new Error('socket hang up'); } };
    const store = createDriverStore({ driver: failing });
    const error = await store.initialize().then(() => undefined, (caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(String((error as Error).message)).not.toMatch(/secret detail/);
    expect(released).toEqual(['release']);
    const unreachable = createDriverStore({ driver: { connect: async () => { throw new Error('refused'); }, query: async () => ({ rows: [] }) } });
    await expect(unreachable.initialize()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });
});
