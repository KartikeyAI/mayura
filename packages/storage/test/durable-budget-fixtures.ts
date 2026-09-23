import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { Pool } from 'pg';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { createPostgresStore } from '@mayura/storage-postgres';

/** Real disposable databases; raw access is restricted to fault and lock instrumentation. */
export interface DurableBudgetFixture {
  readonly store: ReturnType<typeof createSqliteStore>;
  readonly prefix: string;
  readonly childOptions: { readonly adapter: 'sqlite'; readonly filename: string }
    | { readonly adapter: 'postgres'; readonly connectionString: string; readonly schema: string };
  reopen(): ReturnType<typeof createSqliteStore>;
  query(sql: string, parameters?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
  lockRoot(scope: string, id: string): Promise<() => Promise<void>>;
  cleanup(): Promise<void>;
}

export async function durableBudgetSqliteFixture(): Promise<DurableBudgetFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'mayura-durable-budgets-'));
  const filename = join(directory, 'budgets.sqlite'); const open = () => createSqliteStore({ filename });
  return { store: open(), reopen: open, prefix: '', childOptions: { adapter: 'sqlite', filename },
    async query(sql, parameters = []) {
      const database = new Database(filename); database.pragma('foreign_keys = ON');
      try { const statement = database.prepare(sql); if (statement.reader) return statement.all(...parameters) as Record<string, unknown>[];
        statement.run(...parameters); return []; } finally { database.close(); }
    },
    async lockRoot() {
      const database = new Database(filename); database.exec('BEGIN IMMEDIATE'); let released = false;
      return async () => { if (released) return; released = true; try { database.exec('COMMIT'); } finally { database.close(); } };
    },
    async cleanup() {
      const target = resolve(directory);
      if (!target.startsWith(`${resolve(tmpdir())}${sep}mayura-durable-budgets-`)) throw new Error('Unexpected durable-budget fixture path.');
      await rm(target, { recursive: true, force: true });
    },
  };
}

export async function durableBudgetPostgresFixture(connectionString: string): Promise<DurableBudgetFixture> {
  const schema = `mayura_durable_budget_${randomUUID().replaceAll('-', '')}`;
  const open = () => createPostgresStore({ connectionString, schema }); const pool = new Pool({ connectionString, max: 3 });
  return { store: open(), reopen: open, prefix: `"${schema}".`, childOptions: { adapter: 'postgres', connectionString, schema },
    async query(sql, parameters = []) { let index = 0; return (await pool.query(sql.replace(/\?/g, () => `$${++index}`), [...parameters])).rows as Record<string, unknown>[]; },
    async lockRoot(scope, id) {
      const client = await pool.connect();
      try { await client.query('BEGIN'); await client.query(`SELECT id FROM "${schema}".mayura_durable_budgets WHERE scope = $1 AND id = $2 FOR UPDATE`, [scope, id]); }
      catch (error) { await client.query('ROLLBACK').catch(() => {}); client.release(); throw error; }
      let released = false; return async () => { if (released) return; released = true;
        try { await client.query('COMMIT'); } finally { client.release(); } };
    },
    async cleanup() {
      if (!/^mayura_durable_budget_[a-f0-9]{32}$/.test(schema)) throw new Error('Unexpected durable-budget fixture schema.');
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); }
    },
  };
}
