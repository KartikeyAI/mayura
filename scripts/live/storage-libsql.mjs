// Live check of @mayurajs/storage-libsql on Turso (or any remote libSQL server). Run after pnpm build:
//   node --env-file=.env.live scripts/live/storage-libsql.mjs  (needs TURSO_DATABASE_URL and TURSO_AUTH_TOKEN)
import { report, storageChecks } from './storage-checks.mjs';
const { createLibsqlStore } = await import(new URL('../../extensions/storage-libsql/dist/index.js', import.meta.url).href);

const { TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: authToken } = process.env;
if (!url || !authToken) { console.log('TURSO_DATABASE_URL or TURSO_AUTH_TOKEN is not set; nothing run.'); process.exit(2); }
report(await storageChecks(createLibsqlStore({ url, authToken })));
