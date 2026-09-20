import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { Pool } from 'pg';
import type { ExecutionWaitAggregateStore } from '@mayura/storage-contracts';
import { createPostgresStore } from '@mayura/storage-postgres';
import { createSqliteStore } from '@mayura/storage-sqlite';

/** Disposable real databases. SQL access is test-only fault instrumentation. */
export interface ExecutionWaitFixture {
  readonly store: ExecutionWaitAggregateStore;
  readonly prefix: string;
  readonly childOptions: { readonly adapter: 'sqlite'; readonly filename: string }
    | { readonly adapter: 'postgres'; readonly connectionString: string; readonly schema: string };
  reopen(): ExecutionWaitAggregateStore;
  query(sql: string, parameters?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
  cleanup(): Promise<void>;
}

export async function executionWaitSqliteFixture(): Promise<ExecutionWaitFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'mayura-execution-waits-'));
  const filename = join(directory, 'waits.sqlite');
  const open = () => createSqliteStore({ filename }) as ExecutionWaitAggregateStore;
  return {
    store: open(), reopen: open, prefix: '', childOptions: { adapter: 'sqlite', filename },
    async query(sql, parameters = []) {
      const database = new Database(filename); database.pragma('foreign_keys = ON');
      try {
        const statement = database.prepare(sql);
        if (statement.reader) return statement.all(...parameters) as Record<string, unknown>[];
        statement.run(...parameters); return [];
      } finally { database.close(); }
    },
    async cleanup() {
      const target = resolve(directory);
      if (!target.startsWith(`${resolve(tmpdir())}${sep}mayura-execution-waits-`)) throw new Error('Unexpected execution-wait fixture path.');
      await rm(target, { recursive: true, force: true });
    },
  };
}

export async function executionWaitPostgresFixture(connectionString: string): Promise<ExecutionWaitFixture> {
  const schema = `mayura_execution_waits_${randomUUID().replaceAll('-', '')}`;
  const open = () => createPostgresStore({ connectionString, schema }) as ExecutionWaitAggregateStore;
  const pool = new Pool({ connectionString, max: 2 });
  return {
    store: open(), reopen: open, prefix: `"${schema}".`, childOptions: { adapter: 'postgres', connectionString, schema },
    async query(sql, parameters = []) {
      let index = 0;
      const result = await pool.query(sql.replace(/\?/g, () => `$${++index}`), [...parameters]);
      return result.rows as Record<string, unknown>[];
    },
    async cleanup() {
      if (!/^mayura_execution_waits_[a-f0-9]{32}$/.test(schema)) throw new Error('Unexpected execution-wait fixture schema.');
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await pool.end(); }
    },
  };
}
