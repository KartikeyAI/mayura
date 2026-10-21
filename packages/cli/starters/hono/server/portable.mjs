import { createPostgresStore } from 'mayura/storage-postgres';
import { createApplication } from './application.mjs';
/** Bun/Deno use explicit PostgreSQL; no native SQLite addon is imported into these entry points. */
export async function openPortable(env) {
  if (!env.DATABASE_URL || !env.MAYURA_SESSIONS_JSON || env.MAYURA_SESSIONS_JSON.length > 16384) throw new Error('PostgreSQL and identity configuration required.');
  const store = createPostgresStore({ connectionString: env.DATABASE_URL });
  try { return await createApplication({ store, publicOrigin: env.MAYURA_PUBLIC_ORIGIN, projectId: env.MAYURA_PROJECT_ID ?? 'notebook', sessions: JSON.parse(env.MAYURA_SESSIONS_JSON) }); }
  catch (error) { await store.close(); throw error; }
}
