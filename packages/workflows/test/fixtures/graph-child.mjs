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
  if (!['sqlite', 'postgres', 'mysql', 'mongodb', 'd1-sqlite', 'dynamodb'].includes(options.kind)) throw new Error();
  const registering = config.phase.startsWith('registration');
  if (config.phase.endsWith('after')) {
    stage = 'public-initialize';
    const store = options.kind === 'sqlite' ? createSqliteStore({ filename: options.filename })
      : options.kind === 'mysql' ? (await import('../../../storage/test/fixtures/mysql.mjs')).mysqlStore({ uri: options.uri })
      : options.kind === 'mongodb' ? (await import('../../../storage/test/fixtures/mongodb.mjs')).mongoStore({ uri: options.uri, database: options.database })
      : ['d1-sqlite', 'dynamodb'].includes(options.kind) ? await (await import('../../../storage/test/fixtures/document.mjs')).documentStore(options)
      : createPostgresStore({ connectionString: options.connectionString, schema: options.schema });
    await store.initialize(); await store.workflowGraphs.initialize();
    stage = 'public-command';
    if (registering) await store.workflowGraphs.submit(config.enrollment);
    else await store.workflowGraphs.advance(config.command);
    await checkpoint();
  } else if (['d1-sqlite', 'dynamodb'].includes(options.kind)) {
    // A document store's transaction commits once: stop just before the commit that writes the wait edges
    // (registration) or the parent's new state (resolution).
    stage = 'backend-create';
    const { documentKey, documentStoreBeforeCommit } = await import('../../../storage/test/fixtures/document.mjs');
    let armed = false;
    const relevant = writes => writes.some(write => write.kind === 'put' && (registering ? write.sort === documentKey('w')
      : write.partition === documentKey('run', config.command.scope, config.command.id) && write.sort === documentKey('r')));
    const store = await documentStoreBeforeCommit(options, async writes => { if (armed && relevant(writes)) await checkpoint(); });
    stage = 'reducer-initialize';
    await store.initialize(); await store.workflowGraphs.initialize(); armed = true;
    stage = 'reducer-command';
    if (registering) await store.workflowGraphs.submit(config.enrollment);
    else await store.workflowGraphs.advance(config.command);
    throw new Error();
  } else if (options.kind === 'mongodb') {
    // MongoDB has no SQL layer to instrument: the public store stops before committing the transaction that wrote the
    // wait edges (registration) or the parent's new state (resolution).
    stage = 'backend-create';
    let armed = false;
    const relevant = (name, command) => registering ? name === 'insert' && command.insert === 'mayura_workflow_wait_targets'
      : name === 'update' && command.update === 'mayura_aggregates'
        && command.updates.some(update => update.q?.id === config.command.id && update.u?.$set?.state !== undefined);
    const store = (await import('../../../storage/test/fixtures/mongodb.mjs')).mongoStoreBeforeCommit({ uri: options.uri, database: options.database },
      async changed => { if (armed && changed) await checkpoint(); }, relevant);
    stage = 'reducer-initialize';
    await store.initialize(); await store.workflowGraphs.initialize(); armed = true;
    stage = 'reducer-command';
    if (registering) await store.workflowGraphs.submit(config.enrollment);
    else await store.workflowGraphs.advance(config.command);
    throw new Error();
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
    } else if (options.kind === 'mysql') {
      let changedParent = false;
      const base = (await import('../../../storage/test/fixtures/mysql.mjs')).mysqlBackend({ uri: options.uri }, {
        intercept: async (sql, parameters, run) => { const rows = await run(); changedParent ||= relevant(sql, parameters); return rows; },
        // Full parent/index/events reducer ran; all SQL remains uncommitted at this barrier.
        beforeCommit: async () => { if (changedParent) await checkpoint(); } });
      backend = { ...base, transaction: body => { changedParent = false; return base.transaction(body); } };
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
