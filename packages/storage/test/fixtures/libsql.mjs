// libSQL for the crash-test subprocesses: the public store, or a raw SQLite-dialect backend over one libSQL write
// transaction that a fixture can pause before commit. @libsql/client is the extension's own dependency.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLibsqlStore } from '@mayurajs/storage-libsql';

const { createClient } = await import(pathToFileURL(createRequire(fileURLToPath(import.meta.resolve('@mayurajs/storage-libsql'))).resolve('@libsql/client')).href);

/** Only disposable test databases: a temporary file, or a loopback server. */
export function libsqlUrl(options) {
  const url = options?.url;
  if (typeof url !== 'string' || !(/^file:.*mayura-/.test(url) || /^(?:http|ws):\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(url))) throw new Error('Unexpected libSQL fixture url.');
  return url;
}

export const libsqlStore = options => createLibsqlStore({ url: libsqlUrl(options) });

/** `intercept(sql, parameters, run)` wraps each statement; `beforeCommit()` runs after the body, before COMMIT. */
export function libsqlBackend(options, { intercept = (_sql, _parameters, run) => run(), beforeCommit = async () => {} } = {}) {
  const client = createClient({ url: libsqlUrl(options) });
  return { dialect: 'sqlite', prefix: '', transaction: async body => {
    const tx = await client.transaction('write');
    try {
      const session = { query: async (sql, parameters = []) => intercept(sql, parameters, async () => {
        const result = await tx.execute({ sql, args: [...parameters] });
        return result.rows.map(row => Object.fromEntries(result.columns.map((column, index) => [column, row[index]])));
      }) };
      const result = await body(session); await beforeCommit(); await tx.commit(); return result;
    } catch (error) { await tx.rollback().catch(() => {}); throw error; }
    finally { tx.close(); }
  } };
}
