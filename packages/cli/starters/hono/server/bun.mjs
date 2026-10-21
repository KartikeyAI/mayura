import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { openPortable } from './portable.mjs';
const service = await openPortable(Bun.env); const router = new Hono();
router.all('/api/mayura/*', context => service.fetch(context.req.raw));
router.get('/assets/*', serveStatic({ root: './dist/client' })); router.get('*', serveStatic({ path: './dist/client/index.html' }));
const server = Bun.serve({ fetch: router.fetch, port: 3000, hostname: '127.0.0.1' });
let working = false; const timer = setInterval(async () => { if (working) return; working = true; try { await service.runOnce(); } catch { console.error('Background work needs attention.'); } finally { working = false; } }, 1000);
async function stop() { clearInterval(timer); server.stop(true); await service.close(); }
process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
