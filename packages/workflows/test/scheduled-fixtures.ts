import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import type DatabaseType from 'better-sqlite3';
import { createPostgresStore, createSqliteStore } from '@mayura/storage';
import type { WorkflowFixture } from './fixtures.js';

// Fault instrumentation deliberately reuses the reference adapter's installed drivers.
// The workflows package retains only its existing optional test dependency on storage.
const storageRequire = createRequire(import.meta.resolve('@mayura/storage'));
const Database = storageRequire('better-sqlite3') as typeof DatabaseType;
const { Pool } = storageRequire('pg') as typeof import('pg');

/** Raw SQL is test-only fault instrumentation, scoped to one disposable fixture. */
export interface ScheduledFixture extends WorkflowFixture {
  readonly prefix: string;
  readonly childConfig: { readonly kind: 'sqlite'; readonly filename: string }
    | { readonly kind: 'postgres'; readonly connectionString: string; readonly schema: string };
  query(sql: string, parameters?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
  /** Hold a real database lock while the runtime's independent connection waits. */
  lockAggregate(scope: string, id: string): Promise<() => Promise<void>>;
}

export async function scheduledSqliteFixture(): Promise<ScheduledFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'mayura-scheduled-workflows-'));
  const filename = join(directory, 'scheduled.sqlite');
  const open = () => createSqliteStore({ filename });
  return {
    store: open(), reopen: open, prefix: '', childConfig: { kind: 'sqlite', filename },
    async query(sql, parameters = []) {
      const database = new Database(filename); database.pragma('foreign_keys = ON');
      try {
        const statement = database.prepare(sql);
        if (statement.reader) return statement.all(...parameters) as Record<string, unknown>[];
        statement.run(...parameters); return [];
      } finally { database.close(); }
    },
    async lockAggregate(_scope, _id) {
      const database = new Database(filename);
      try { database.exec('BEGIN IMMEDIATE'); }
      catch (error) { database.close(); throw error; }
      let released = false;
      return async () => {
        if (released) return; released = true;
        try { database.exec('COMMIT'); } finally { database.close(); }
      };
    },
    async cleanup() {
      const target = resolve(directory);
      if (!target.startsWith(`${resolve(tmpdir())}${sep}mayura-scheduled-workflows-`)) throw new Error('Unexpected scheduled fixture path.');
      await rm(target, { recursive: true, force: true });
    },
  };
}

export async function scheduledPostgresFixture(connectionString: string): Promise<ScheduledFixture> {
  const schema = `mayura_scheduled_workflow_${randomUUID().replaceAll('-', '')}`;
  const open = () => createPostgresStore({ connectionString, schema });
  const pool = new Pool({ connectionString, max: 2 });
  return {
    store: open(), reopen: open, prefix: `"${schema}".`, childConfig: { kind: 'postgres', connectionString, schema },
    async query(sql, parameters = []) {
      let index = 0;
      const result = await pool.query(sql.replace(/\?/g, () => `$${++index}`), [...parameters]);
      return result.rows as Record<string, unknown>[];
    },
    async lockAggregate(scope, id) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT id FROM "${schema}".mayura_aggregates WHERE scope = $1 AND id = $2 FOR UPDATE`, [scope, id]);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {}); client.release(); throw error;
      }
      let released = false;
      return async () => {
        if (released) return; released = true;
        try { await client.query('COMMIT'); } finally { client.release(); }
      };
    },
    async cleanup() {
      if (!/^mayura_scheduled_workflow_[a-f0-9]{32}$/.test(schema)) throw new Error('Unexpected scheduled fixture schema.');
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await pool.end(); }
    },
  };
}
