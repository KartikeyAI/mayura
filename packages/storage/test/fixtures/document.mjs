// Document stores (D1 on a SQLite file, DynamoDB) for the crash-test subprocesses: the public store, or one whose backend calls
// `beforeCommit(writes)` before each commit that changes something, so a fixture can stop a process with a transaction
// computed but not committed. Test-only: the stores themselves have no failpoint.
import { createDocumentStore } from '@mayura/storage-sql/host';

/** A document key: components escaped and terminated, as the store encodes them. */
export const documentKey = (...parts) => parts.map(part => String(part).replaceAll('\u0001', '\u0001\u0003') + '\u0001\u0001').join('');

/**
 * A D1 database on a local SQLite file, through better-sqlite3: D1 is SQLite, so the adapter's SQL runs on the same
 * engine, and a batch is one immediate transaction, all or nothing, as in D1. For the conformance suites, whose
 * one-second leases need faster calls than a local D1 emulator gives.
 */
export async function sqliteD1(filename) {
  const { createRequire } = await import('node:module');
  const Database = createRequire(import.meta.resolve('@mayura/storage-sqlite'))('better-sqlite3');
  const database = new Database(filename, { timeout: 10_000 });
  database.pragma('journal_mode = WAL'); database.pragma('synchronous = FULL');
  const run = (sql, params) => { const statement = database.prepare(sql); return statement.reader ? statement.all(...params) : (statement.run(...params), []); };
  const statement = (sql, params = []) => ({ sql, params, bind: (...values) => statement(sql, values), all: async () => ({ results: run(sql, params) }) });
  const batch = database.transaction(statements => statements.map(item => ({ results: run(item.sql, item.params) })));
  return { prepare: sql => statement(sql), batch: async statements => batch.immediate(statements), close: () => database.close() };
}

async function backend(options) {
  if (options?.adapter === 'd1-sqlite') {
    if (typeof options.filename !== 'string' || !options.filename.includes('mayura-d1-')) throw new Error('Unexpected D1 fixture.');
    const { d1Backend } = await import('@mayurajs/storage-d1');
    return d1Backend(await sqliteD1(options.filename));
  }
  if (options?.adapter === 'dynamodb') {
    if (typeof options.endpoint !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(options.endpoint) || !/^mayura_test_[a-f0-9]{32}$/.test(options.table)) throw new Error('Unexpected DynamoDB fixture.');
    const { dynamoBackend, dynamoClient } = await import('@mayurajs/storage-dynamodb');
    return dynamoBackend(dynamoClient({ region: 'us-east-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' }, endpoint: options.endpoint }), options.table);
  }
  throw new Error('Unexpected document fixture.');
}

export async function documentStore(options) { return createDocumentStore(await backend(options)); }

export async function documentStoreBeforeCommit(options, beforeCommit) {
  const inner = await backend(options);
  return createDocumentStore({ ...inner, commit: async writes => {
    if (writes.some(write => write.kind !== 'check')) await beforeCommit(writes);
    return inner.commit(writes);
  } });
}
