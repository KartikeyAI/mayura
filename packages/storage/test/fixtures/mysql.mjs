// MySQL for the crash-test subprocesses: the public store, or a raw MySQL-dialect backend over one transaction that a
// fixture can pause before commit. mysql2 and the statement translator are the extension's own (test-only access).
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMysqlStore } from '@mayurajs/storage-mysql';

const entry = fileURLToPath(import.meta.resolve('@mayurajs/storage-mysql'));
const { createPool } = await import(pathToFileURL(createRequire(entry).resolve('mysql2/promise')).href);
const { translate } = await import(pathToFileURL(join(dirname(entry), 'translate.js')).href);

/** Only disposable test databases on a loopback server. */
export function mysqlUri(options) {
  const uri = options?.uri;
  if (typeof uri !== 'string' || !/^mysql:\/\/[^@/]+@(?:127\.0\.0\.1|localhost):\d+\/mayura_test_[a-f0-9]{32}$/.test(uri)) throw new Error('Unexpected MySQL fixture uri.');
  return uri;
}

export const mysqlStore = options => createMysqlStore({ uri: mysqlUri(options) });

const SQL_MODE = 'ANSI_QUOTES,PIPES_AS_CONCAT,STRICT_ALL_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ZERO_DATE,NO_ZERO_IN_DATE,NO_ENGINE_SUBSTITUTION';
const decode = rows => (Array.isArray(rows) ? rows : []).map(row => Object.fromEntries(Object.entries(row)
  .map(([column, value]) => [column, value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : value])));

/** `intercept(sql, parameters, run)` wraps each statement; `beforeCommit()` runs after the body, before COMMIT. */
export function mysqlBackend(options, { intercept = (_sql, _parameters, run) => run(), beforeCommit = async () => {} } = {}) {
  const pool = createPool({ uri: mysqlUri(options), connectionLimit: 1, flags: ['-FOUND_ROWS'], supportBigNumbers: true, bigNumberStrings: false });
  return { dialect: 'mysql', prefix: '', transaction: async body => {
    const connection = await pool.getConnection();
    try {
      await connection.query("SET SESSION sql_mode = ?, SESSION transaction_isolation = 'READ-COMMITTED', SESSION innodb_lock_wait_timeout = 5, SESSION time_zone = '+00:00'", [SQL_MODE]);
      await connection.query('START TRANSACTION');
      const session = { query: async (sql, parameters = []) => intercept(sql, parameters, async () => {
        const statement = translate(sql);
        if (statement.kind === 'index') {
          const [found] = await connection.query('SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1', [statement.table, statement.name]);
          if (found.length === 0) await connection.query(statement.sql);
          return [];
        }
        return decode((await connection.query(statement.sql, [...parameters]))[0]);
      }) };
      const result = await body(session); await beforeCommit(); await connection.query('COMMIT'); return result;
    } catch (error) { await connection.query('ROLLBACK').catch(() => {}); throw error; }
    finally { await connection.query('DO RELEASE_ALL_LOCKS()').catch(() => {}); connection.release(); }
  } };
}
