import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { application, handle } from './node.mjs';
const app = new Hono(); app.all('/api/mayura/*', context => handle(context.req.raw));
app.get('/assets/*', serveStatic({ root: './dist/client' })); app.get('*', serveStatic({ path: './dist/client/index.html' }));
const port = Number(process.env.PORT ?? 3000); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port.');
const server = serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? '127.0.0.1' });
let closing = false; async function stop() { if (closing) return; closing = true; server.close(); await (await application()).close(); }
process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
