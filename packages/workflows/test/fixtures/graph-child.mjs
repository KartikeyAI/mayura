import { createRequire } from 'node:module';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { createPostgresStore } from '@mayura/storage-postgres';

// Disposable owned process only. Production reducers have no failpoint or injected clock.
const notify = message => new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
const checkpoint = async () => {
  await notify({ kind: 'checkpoint' });
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
};

let stage = 'host-import';
try {
  // This repository-owned failure fixture deliberately instruments the trusted shared reducer.
  // Consumer runtime imports are independently qualified by the packed installation gates.
  const { SchedulerDatabase, ScheduledWorkflowDatabase } = await import(new URL('../../../storage-sql/dist/host.js', import.meta.url).href);
  stage = 'configuration';
  const config = JSON.parse(process.argv[2] ?? 'null');
  if (!process.send || !config || !['registration-before', 'registration-after', 'resolution-before', 'resolution-after'].includes(config.phase)) throw new Error();
  const options = config.backend;
  if (options.kind === 'sqlite' && !options.filename.includes('mayura-graph-workflows-')) throw new Error();
  if (options.kind === 'postgres' && !/^mayura_graph_workflow_[a-f0-9]{32}$/.test(options.schema)) throw new Error();
  if (!['sqlite', 'postgres'].includes(options.kind)) throw new Error();
  const registering = config.phase.startsWith('registration');
  if (config.phase.endsWith('after')) {
    stage = 'public-initialize';
    const store = options.kind === 'sqlite' ? createSqliteStore({ filename: options.filename })
      : createPostgresStore({ connectionString: options.connectionString, schema: options.schema });
    await store.initialize(); await store.workflowGraphs.initialize();
    stage = 'public-command';
    if (registering) await store.workflowGraphs.submit(config.enrollment);
    else await store.workflowGraphs.advance(config.command);
    await checkpoint();
  } else {
    stage = 'backend-create';
    let armed = false;
    const relevant = (sql, parameters) => armed && (registering
      ? /INSERT INTO .*mayura_workflow_wait_targets\b/.test(sql)
      : /UPDATE .*mayura_aggregates\b/.test(sql) && parameters.includes(config.command.id));
    let backend;
    if (options.kind === 'sqlite') {
      const require = createRequire(import.meta.resolve('@mayura/storage-sqlite'));
      const Database = require('better-sqlite3');
      const database = new Database(options.filename, { timeout: 10_000 });
      database.pragma('journal_mode = WAL'); database.pragma('synchronous = FULL'); database.pragma('foreign_keys = ON');
      backend = { dialect: 'sqlite', prefix: '', transaction: async body => {
        let changedParent = false;
        const session = { query: async (sql, parameters = []) => {
          const statement = database.prepare(sql); let rows = [];
          if (statement.reader) rows = statement.all(...parameters); else statement.run(...parameters);
          changedParent ||= relevant(sql, parameters); return rows;
        } };
        database.exec('BEGIN IMMEDIATE');
        try {
          const result = await body(session);
          // Full parent/index/events reducer ran; all SQL remains uncommitted at this barrier.
          if (changedParent) await checkpoint();
          database.exec('COMMIT'); return result;
        } catch (error) { database.exec('ROLLBACK'); throw error; }
      } };
    } else {
      const require = createRequire(import.meta.resolve('@mayura/storage-postgres'));
      const { Pool } = require('pg'); const pool = new Pool({ connectionString: options.connectionString, max: 1 });
      backend = { dialect: 'postgres', prefix: `"${options.schema}".`, transaction: async body => {
        const client = await pool.connect(); let changedParent = false;
        try {
          await client.query('BEGIN'); await client.query("SET LOCAL lock_timeout = '10s'");
          const session = { query: async (sql, parameters = []) => {
            let ordinal = 0;
            const result = await client.query(sql.replace(/\?/g, () => `$${++ordinal}`), [...parameters]);
            changedParent ||= relevant(sql, parameters); return result.rows;
          } };
          const result = await body(session); if (changedParent) await checkpoint();
          await client.query('COMMIT'); return result;
        } catch (error) { await client.query('ROLLBACK'); throw error; }
        finally { client.release(); }
      } };
    }
    const scheduler = new SchedulerDatabase(backend); const workflows = new ScheduledWorkflowDatabase(backend, scheduler);
    stage = 'reducer-initialize';
    await workflows.execute('initialize', {}, 2); armed = true;
    stage = 'reducer-command';
    if (registering) await workflows.execute('submit', config.enrollment, 2);
    else await workflows.execute('advance', config.command, 2);
    throw new Error(); // The before-commit fixture must prove it actually intercepted parent SQL.
  }
} catch {
  await notify({ kind: 'fixture-error', stage }).catch(() => {});
  process.exit(1);
}
