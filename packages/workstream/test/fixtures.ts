import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createPostgresStore, createSqliteStore, type AggregateStore } from '@mayura/storage';

export interface WorkStreamFixture {
  readonly store: AggregateStore;
  reopen(): AggregateStore;
  cleanup(): Promise<void>;
}

export async function sqliteFixture(): Promise<WorkStreamFixture> {
  const root = await realpath(tmpdir());
  const directory = await mkdtemp(join(root, 'mayura-workstream-'));
  const filename = join(directory, 'stream.sqlite');
  const open = () => createSqliteStore({ filename });
  return {
    store: open(), reopen: open,
    cleanup: async () => {
      const target = await realpath(directory);
      if (dirname(target) !== root || !basename(target).startsWith('mayura-workstream-')) throw new Error('Unexpected workstream fixture directory.');
      await rm(target, { recursive: true, force: true });
    },
  };
}

export async function postgresFixture(connectionString: string): Promise<WorkStreamFixture> {
  const schema = `mayura_stream_test_${randomUUID().replaceAll('-', '')}`;
  const open = () => createPostgresStore({ connectionString, schema });
  return {
    store: open(), reopen: open,
    cleanup: async () => {
      if (!/^mayura_stream_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unexpected workstream fixture schema.');
      const { Pool } = await import('pg');
      const pool = new Pool({ connectionString });
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await pool.end(); }
    },
  };
}
