import { Hono } from 'hono';
import { serveStatic } from 'hono/deno';
import { openPortable } from './portable.mjs';
const service = await openPortable(Object.fromEntries(['DATABASE_URL', 'MAYURA_PUBLIC_ORIGIN', 'MAYURA_PROJECT_ID', 'MAYURA_SESSIONS_JSON'].map(name => [name, Deno.env.get(name)]))); const router = new Hono();
router.all('/api/mayura/*', context => service.fetch(context.req.raw));
router.get('/assets/*', serveStatic({ root: './dist/client' })); router.get('*', serveStatic({ path: './dist/client/index.html' }));
const server = Deno.serve({ port: 3000, hostname: '127.0.0.1' }, router.fetch);
let working = false; const timer = setInterval(async () => { if (working) return; working = true; try { await service.runOnce(); } catch { console.error('Background work needs attention.'); } finally { working = false; } }, 1000);
async function stop() { clearInterval(timer); await server.shutdown(); await service.close(); }
Deno.addSignalListener('SIGINT', () => void stop()); if (Deno.build.os !== 'windows') Deno.addSignalListener('SIGTERM', () => void stop());
