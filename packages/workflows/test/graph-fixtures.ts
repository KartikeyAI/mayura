import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type DatabaseType from 'better-sqlite3';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { createPostgresStore } from '@mayura/storage-postgres';

const sqliteRequire = createRequire(import.meta.resolve('@mayura/storage-sqlite'));
const postgresRequire = createRequire(import.meta.resolve('@mayura/storage-postgres'));
const Database = sqliteRequire('better-sqlite3') as typeof DatabaseType;
const { Pool } = postgresRequire('pg') as typeof import('pg');

/** Fault access is confined to the disposable database owned by this one test. */
export interface GraphFixture {
  readonly store: ReturnType<typeof createSqliteStore>;
  readonly dialect: 'sqlite' | 'postgres' | 'mysql' | 'mongodb';
  readonly prefix: string;
  readonly childConfig: { readonly kind: 'sqlite'; readonly filename: string } | { readonly kind: 'mysql'; readonly uri: string }
    | { readonly kind: 'postgres'; readonly connectionString: string; readonly schema: string }
    | { readonly kind: 'mongodb'; readonly uri: string; readonly database: string };
  /** A store without SQL catalogs (MongoDB): create a mismatched discovery index natively, and list the one that exists. */
  readonly discoveryIndex?: {
    create(mismatch: 'wrong columns' | 'partial' | 'descending' | 'wrong collation' | 'unique'): Promise<void>;
    list(): Promise<readonly unknown[]>;
    /** The store's own plan for the discovery scan of one scope and policy. */
    explain(scope: string, policyHash: string): Promise<unknown>;
  };
  reopen(): ReturnType<typeof createSqliteStore>;
  query(sql: string, parameters?: readonly unknown[]): Promise<readonly Record<string, unknown>[]>;
  lockAggregate(scope: string, id: string): Promise<() => Promise<void>>;
  cleanup(): Promise<void>;
}

export async function graphSqliteFixture(): Promise<GraphFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'mayura-graph-workflows-'));
  const filename = join(directory, 'graphs.sqlite');
  const open = () => createSqliteStore({ filename });
  return {
    store: open(), reopen: open, dialect: 'sqlite', prefix: '', childConfig: { kind: 'sqlite', filename },
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
      if (!target.startsWith(`${resolve(tmpdir())}${sep}mayura-graph-workflows-`)) throw new Error('Unexpected graph fixture path.');
      await rm(target, { recursive: true, force: true });
    },
  };
}

export async function graphPostgresFixture(connectionString: string): Promise<GraphFixture> {
  const schema = `mayura_graph_workflow_${randomUUID().replaceAll('-', '')}`;
  const open = () => createPostgresStore({ connectionString, schema });
  const pool = new Pool({ connectionString, max: 3 });
  return {
    store: open(), reopen: open, dialect: 'postgres', prefix: `"${schema}".`, childConfig: { kind: 'postgres', connectionString, schema },
    async query(sql, parameters = []) {
      let index = 0;
      return (await pool.query(sql.replace(/\?/g, () => `$${++index}`), [...parameters])).rows as Record<string, unknown>[];
    },
    async lockAggregate(scope, id) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT id FROM "${schema}".mayura_aggregates WHERE scope = $1 AND id = $2 FOR UPDATE`, [scope, id]);
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); client.release(); throw error; }
      let released = false;
      return async () => {
        if (released) return; released = true;
        try { await client.query('COMMIT'); } finally { client.release(); }
      };
    },
    async cleanup() {
      if (!/^mayura_graph_workflow_[a-f0-9]{32}$/.test(schema)) throw new Error('Unexpected graph fixture schema.');
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await pool.end(); }
    },
  };
}
