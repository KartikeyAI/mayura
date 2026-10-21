import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createSqliteStore } from 'mayura/storage-sqlite';
import { createPostgresStore } from 'mayura/storage-postgres';
import { createApplication } from './application.mjs';

// One service per process, including development HMR. No service is created during static rendering.
const key = Symbol.for('mayura.hono.application');
export function application() {
  if (!globalThis[key]) globalThis[key] = open().catch(error => { delete globalThis[key]; throw error; });
  return globalThis[key];
}
async function open() {
  // Vite does not put private .env values into process.env. Load the named host file only when no injected directory exists.
  if (!process.env.MAYURA_SESSIONS_JSON) {
    try { process.loadEnvFile('.env'); } catch (error) { if (error?.code !== 'ENOENT') throw new Error('Private environment configuration unavailable.'); }
  }
  const publicOrigin = process.env.MAYURA_PUBLIC_ORIGIN ?? 'http://localhost:3000';
  const projectId = process.env.MAYURA_PROJECT_ID ?? 'notebook';
  const raw = process.env.MAYURA_SESSIONS_JSON;
  if (!raw || raw.length > 16384) throw new Error('Configure a bounded identity directory before serving requests.');
  const sessions = JSON.parse(raw); let store;
  if (process.env.DATABASE_URL) store = createPostgresStore({ connectionString: process.env.DATABASE_URL });
  else { const filename = resolve(process.env.MAYURA_SQLITE_PATH ?? '.data/notebook.sqlite'); await mkdir(dirname(filename), { recursive: true }); store = createSqliteStore({ filename }); }
  try { return await createApplication({ store, publicOrigin, projectId, sessions }); } catch (error) { await store.close(); throw error; }
}
/** Framework catch-all entry: preserve request bytes and the native Mayura response stream. */
export async function handle(request) {
  try { return await (await application()).fetch(request); }
  catch { return Response.json({ error: { code: 'SERVICE_UNAVAILABLE' } }, { status: 503, headers: { 'cache-control': 'no-store' } }); }
}
