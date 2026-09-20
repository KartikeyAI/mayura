import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPostgresStore, createSqliteStore, type AggregateStore } from '@mayura/storage';

export interface WorkflowFixture {
  readonly store: AggregateStore;
  reopen(): AggregateStore;
  cleanup(): Promise<void>;
}

export async function sqliteFixture(): Promise<WorkflowFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'mayura-workflows-'));
  const filename = join(directory, 'workflows.sqlite');
  const open = () => createSqliteStore({ filename });
  return {
    store: open(), reopen: open,
    cleanup: async () => {
      const safeDirectory = resolve(directory);
      const prefix = `${resolve(tmpdir())}${process.platform === 'win32' ? '\\' : '/'}mayura-workflows-`;
      if (!safeDirectory.startsWith(prefix)) throw new Error('Unexpected workflow fixture directory.');
      await rm(safeDirectory, { recursive: true, force: true });
    },
  };
}

export async function postgresFixture(connectionString: string): Promise<WorkflowFixture> {
  const schema = `mayura_workflow_test_${randomUUID().replaceAll('-', '')}`;
  const open = () => createPostgresStore({ connectionString, schema });
  return {
    store: open(), reopen: open,
    cleanup: async () => {
      if (!/^mayura_workflow_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unexpected workflow fixture schema.');
      const { Pool } = await import('pg');
      const pool = new Pool({ connectionString });
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await pool.end(); }
    },
  };
}
