// Live check of @mayurajs/storage-d1 on a real D1 database, from outside a Worker: the binding the store takes is
// played by D1's HTTP API (one query, or a batch as one transaction), so the SQL runs on real D1. First it checks that
// a failing batch rolls back over HTTP, as it does through the binding. Run after pnpm build:
//   node --env-file=.env.live scripts/live/storage-d1.mjs
// Needs CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID and CLOUDFLARE_API_TOKEN (D1 edit). Writes to the table mayura_live_documents.
import { report, storageChecks } from './storage-checks.mjs';
const { createD1Store } = await import(new URL('../../extensions/storage-d1/dist/index.js', import.meta.url).href);

const { CLOUDFLARE_ACCOUNT_ID: account, D1_DATABASE_ID: databaseId, CLOUDFLARE_API_TOKEN: token } = process.env;
if (!account || !databaseId || !token) { console.log('CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID or CLOUDFLARE_API_TOKEN is not set; nothing run.'); process.exit(2); }

const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${databaseId}/query`;
async function query(body) {
  const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const reply = await response.json().catch(() => ({}));
  // The binding throws D1's error text; so does this, which is how the store recognizes a failed guard.
  if (!response.ok || !reply.success) throw new Error(reply.errors?.map(error => error.message).join('; ') || `D1 HTTP ${response.status}`);
  return reply.result;
}
/** A D1 binding over the HTTP API: the parts the store uses (prepare, bind, all, batch). */
const database = {
  prepare(sql) {
    const statement = (params) => ({ sql, params, bind: (...values) => statement(values), all: async () => ({ results: (await query({ sql, params }))[0]?.results ?? [] }) });
    return statement([]);
  },
  async batch(statements) { return (await query({ batch: statements.map(({ sql, params }) => ({ sql, params })) })).map(result => ({ results: result.results ?? [] })); },
};

const results = [];
try {
  await query({ sql: 'CREATE TABLE IF NOT EXISTS mayura_live_rollback (id INTEGER)' });
  const failed = await database.batch([database.prepare('INSERT INTO mayura_live_rollback (id) VALUES (?1)').bind(1), database.prepare('SELECT abs(-9223372036854775808)')]).then(() => false, () => true);
  const [{ n }] = (await query({ sql: 'SELECT count(*) AS n FROM mayura_live_rollback' }))[0].results;
  await query({ sql: 'DROP TABLE mayura_live_rollback' });
  results.push(['a failing batch rolls back over HTTP', failed && n === 0 ? 'passed' : `FAILED: batch failed ${failed}, ${n} rows kept`]);
} catch (error) { results.push(['a failing batch rolls back over HTTP', `FAILED: ${String(error.message).slice(0, 200)}`]); }
results.push(...await storageChecks(createD1Store({ database, table: 'mayura_live_documents' })));
report(results);
