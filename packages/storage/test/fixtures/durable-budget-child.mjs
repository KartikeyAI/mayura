import Database from 'better-sqlite3';
import { Pool } from 'pg';
import { createPostgresStore } from '@mayura/storage-postgres';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { DurableBudgetDatabase } from '@mayura/storage-sql/host';

// Only this owned fixture can pause a real database transaction. Production has no injected failpoint.
const notify = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
const checkpoint = async () => { await notify({ kind: 'checkpoint' }); setInterval(() => {}, 1_000); await new Promise(() => {}); };
let stage = 'configuration';
try {
  const options = JSON.parse(process.argv[2] ?? 'null');
  if (!process.send || !options || !['reserve-before', 'reserve-after', 'start-before', 'start-after', 'settle-before', 'settle-after'].includes(options.phase)) throw new Error();
  if (options.adapter === 'sqlite' && !options.filename.includes('mayura-durable-budgets-')) throw new Error();
  if (options.adapter === 'postgres' && !/^mayura_durable_budget_[a-f0-9]{32}$/.test(options.schema)) throw new Error();
  if (!['sqlite', 'postgres', 'libsql'].includes(options.adapter) || !['reserveBundle', 'start', 'settle'].includes(options.method)) throw new Error();
  if (options.phase.endsWith('after')) {
    const store = options.adapter === 'sqlite' ? createSqliteStore({ filename: options.filename })
      : options.adapter === 'libsql' ? (await import('./libsql.mjs')).libsqlStore(options)
      : createPostgresStore({ connectionString: options.connectionString, schema: options.schema });
    stage = 'initialize'; await store.initialize(); await store.durableBudgets.initialize();
    stage = 'public-command'; await store.durableBudgets[options.method](options.command); await checkpoint();
  } else {
    let armed = false; let backend;
    if (options.adapter === 'sqlite') {
      const database = new Database(options.filename, { timeout: 5_000 });
      database.pragma('journal_mode = WAL'); database.pragma('synchronous = FULL'); database.pragma('foreign_keys = ON');
      backend = { dialect: 'sqlite', prefix: '', transaction: async body => {
        let changed = false; const session = { query: async (sql, parameters = []) => {
          const statement = database.prepare(sql); const rows = statement.reader ? statement.all(...parameters) : (statement.run(...parameters), []);
          changed ||= /(?:UPDATE|INSERT INTO).*mayura_durable_budgets\b/.test(sql); return rows;
        } };
        database.exec('BEGIN IMMEDIATE');
        try { const result = await body(session); if (armed && changed) await checkpoint(); database.exec('COMMIT'); return result; }
        catch (error) { database.exec('ROLLBACK'); throw error; }
      } };
    } else if (options.adapter === 'libsql') {
      let changed = false;
      const base = (await import('./libsql.mjs')).libsqlBackend(options, {
        intercept: async (sql, _parameters, run) => { const rows = await run(); changed ||= /(?:UPDATE|INSERT INTO).*mayura_durable_budgets\b/.test(sql); return rows; },
        beforeCommit: async () => { if (armed && changed) await checkpoint(); } });
      backend = { ...base, transaction: body => { changed = false; return base.transaction(body); } };
    } else {
      const pool = new Pool({ connectionString: options.connectionString, max: 1, connectionTimeoutMillis: 5_000 });
      backend = { dialect: 'postgres', prefix: `"${options.schema}".`, transaction: async body => {
        const client = await pool.connect(); let changed = false;
        try {
          await client.query('BEGIN'); await client.query("SET LOCAL lock_timeout = '5s'");
          const session = { query: async (sql, parameters = []) => {
            let ordinal = 0; const rows = (await client.query(sql.replace(/\?/g, () => `$${++ordinal}`), [...parameters])).rows;
            changed ||= /(?:UPDATE|INSERT INTO).*mayura_durable_budgets\b/.test(sql); return rows;
          } };
          const result = await body(session); if (armed && changed) await checkpoint(); await client.query('COMMIT'); return result;
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      } };
    }
    const ledger = new DurableBudgetDatabase(backend); stage = 'initialize'; await ledger.execute('initialize', {}); armed = true;
    stage = 'transaction-command'; await ledger.execute(options.method, options.command); throw new Error();
  }
} catch {
  await notify({ kind: 'fixture-error', stage }).catch(() => {}); process.exit(1);
}
