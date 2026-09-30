import Database from 'better-sqlite3';
import { Pool } from 'pg';
import { createPostgresStore } from '@mayura/storage-postgres';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { SchedulerDatabase, ScheduledWorkflowDatabase, ExecutionWaitDatabase } from '@mayura/storage-sql/host';

// Only this disposable test process has transaction checkpoints. Production has no failpoint.
async function checkpoint() {
  process.stdout.write('ready\n');
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}

try {
  const options = JSON.parse(process.env.MAYURA_EXECUTION_WAIT_FIXTURE);
  const publication = options.phase.startsWith('publication');
  if (options.phase.endsWith('after')) {
    // After-commit cases exercise the actual public worker/pool adapter, then lose its process.
    const store = options.adapter === 'sqlite' ? createSqliteStore({ filename: options.filename })
      : options.adapter === 'libsql' ? (await import('./libsql.mjs')).libsqlStore(options)
      : options.adapter === 'mysql' ? (await import('./mysql.mjs')).mysqlStore(options)
      : createPostgresStore({ connectionString: options.connectionString, schema: options.schema });
    await store.initialize(); await store.workflows.initialize(); await store.executionWaits.initialize();
    if (publication) await store.workflows.cancel(options.cancel);
    else await store.executionWaits.drainReady({ ...options.stream, limit: 32 });
    await checkpoint();
  } else {
    let armed = false;
    const intercept = async (sql, parameters, execute) => {
      const result = await execute();
      if (armed && ((publication && /INSERT INTO .*mayura_execution_completions\b/.test(sql))
        || (!publication && /INSERT INTO .*mayura_execution_wait_events\b/.test(sql) && parameters.includes('wait.resolved')))) {
        // Real SQL has changed uncommitted rows; terminating the process must roll them back.
        await checkpoint();
      }
      return result;
    };
    let backend;
    if (options.adapter === 'sqlite') {
      const database = new Database(options.filename, { timeout: 5_000 });
      database.pragma('journal_mode = WAL'); database.pragma('synchronous = FULL'); database.pragma('foreign_keys = ON');
      const session = { query: async (sql, parameters = []) => intercept(sql, parameters, async () => {
        const statement = database.prepare(sql);
        if (statement.reader) return statement.all(...parameters);
        statement.run(...parameters); return [];
      }) };
      backend = { dialect: 'sqlite', prefix: '', transaction: async body => {
        database.exec('BEGIN IMMEDIATE');
        try { const result = await body(session); database.exec('COMMIT'); return result; }
        catch (error) { database.exec('ROLLBACK'); throw error; }
      } };
    } else if (options.adapter === 'libsql') {
      backend = (await import('./libsql.mjs')).libsqlBackend(options, { intercept });
    } else if (options.adapter === 'mysql') {
      backend = (await import('./mysql.mjs')).mysqlBackend(options, { intercept });
    } else {
      if (!/^mayura_execution_waits_[a-f0-9]{32}$/.test(options.schema)) throw new Error();
      const pool = new Pool({ connectionString: options.connectionString, max: 1, connectionTimeoutMillis: 5_000 });
      backend = { dialect: 'postgres', prefix: `"${options.schema}".`, transaction: async body => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN'); await client.query("SET LOCAL lock_timeout = '5s'");
          const session = { query: async (sql, parameters = []) => intercept(sql, parameters, async () => {
            let ordinal = 0;
            return (await client.query(sql.replace(/\?/g, () => `$${++ordinal}`), [...parameters])).rows;
          }) };
          const result = await body(session); await client.query('COMMIT'); return result;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      } };
    }
    const scheduler = new SchedulerDatabase(backend);
    const workflows = new ScheduledWorkflowDatabase(backend, scheduler);
    const waits = new ExecutionWaitDatabase(backend, workflows);
    await workflows.execute('initialize', {}); await waits.execute('initialize', {}); armed = true;
    if (publication) await workflows.execute('cancel', options.cancel);
    else await waits.execute('drainReady', { ...options.stream, limit: 32 });
    throw new Error(); // A requested precommit checkpoint must actually have intercepted SQL.
  }
} catch {
  process.stderr.write('Execution-wait fixture did not reach its durable boundary.\n');
  process.exit(1);
}
