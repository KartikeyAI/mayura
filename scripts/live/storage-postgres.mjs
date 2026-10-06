// Live check of mayura/storage-postgres on a hosted PostgreSQL (Neon, Supabase, RDS…), in its own schema. Run after
// pnpm build:  node --env-file=.env.live scripts/live/storage-postgres.mjs
// (needs POSTGRES_URL; POSTGRES_SCHEMA, default mayura_live). Needs the pg package, which the workspace installs.
import { report, storageChecks } from './storage-checks.mjs';
const { createPostgresStore } = await import(new URL('../../packages/mayura/dist/storage-postgres.js', import.meta.url).href);

const connectionString = process.env.POSTGRES_URL;
if (!connectionString) { console.log('POSTGRES_URL is not set; nothing run.'); process.exit(2); }
report(await storageChecks(createPostgresStore({ connectionString, schema: process.env.POSTGRES_SCHEMA || 'mayura_live', pool: { max: 2 } })));
