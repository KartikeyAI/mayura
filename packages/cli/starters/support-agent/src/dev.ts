import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, request as forward, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MayuraError } from '@mayura/core';
import { createNativeMemory } from '@mayura/memory';
import { customerPrincipal, devSecrets, tokenDigest } from './auth.js';
import { loadConfig } from './config.js';
import { demoCustomers } from './orders.js';
import { startServer } from './server.js';
import { openServices } from './services.js';
import { mintSessionToken } from './session.js';
import { createFollowUpWorker } from './worker.js';

// Local development in one process: the Mayura server and worker on SQLite, plus a small front server for the chat UI.
// The front server serves the built web UI (web/dist), forwards /v1/* to the Mayura server so the browser talks to one
// origin, and offers POST /dev/session, which signs a session for a demo customer. That endpoint is the stand-in for
// your application's backend and exists only here: `mayura serve` has nothing like it.
// Production runs `npm run serve` and `npm run worker` as separate processes instead (see README).

const webPort = Number(process.env['DEV_WEB_PORT'] ?? 5173);
if (!Number.isInteger(webPort) || webPort < 1 || webPort > 65_535) throw new Error('DEV_WEB_PORT must be a TCP port.');
const webOrigin = `http://127.0.0.1:${webPort}`;
const webRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url));
if (!existsSync(resolve(webRoot, 'index.html'))) throw new Error('The chat UI is not built. `npm run dev` builds it; or run `npx vite build web`.');

const { operatorToken } = await devSecrets(['operatorToken']);
const config = await loadConfig({ ...process.env, MAYURA_ENV: 'development', MAYURA_OPERATOR_TOKEN_SHA256: tokenDigest(operatorToken),
  // The browser's requests arrive through the front server with the chat's origin; the API must accept it.
  MAYURA_ALLOWED_ORIGINS: [process.env['MAYURA_ALLOWED_ORIGINS'], webOrigin].filter(Boolean).join(',') });
const services = await openServices(config);
const server = await startServer(config, services);
const { worker } = createFollowUpWorker(config, services); worker.start();

// Demo data: one remembered preference for Grace, so the memory panel is not empty. Idempotent across restarts.
{
  const content = 'Prefers deliveries to the office on weekdays.'; const observedAt = new Date().toISOString();
  const memory = createNativeMemory({ store: services.store, scope: { principalId: customerPrincipal('cus-grace'), projectId: config.projectId },
    permissions: { allow: ['memory:write'] } });
  try {
    await memory.add({ id: 'note-demo-delivery', content, category: 'preference', sensitivity: 'internal', provenance: { sourceId: 'dev-seed',
      reference: 'src/dev.ts', revision: '1', sha256: createHash('sha256').update(content).digest('hex'), author: 'dev-seed', observedAt, origin: 'observed', confidence: 1 } });
  } catch (error) { if (!(error instanceof MayuraError && error.code === 'CONFLICT')) throw error; }
}

const types: Readonly<Record<string, string>> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const security = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" };

async function serveFile(pathname: string, response: ServerResponse): Promise<void> {
  // Resolve inside web/dist only; anything unknown falls back to the single page.
  const candidate = resolve(webRoot, `.${decodeURIComponent(pathname)}`);
  const file = candidate.startsWith(webRoot.endsWith(sep) ? webRoot : webRoot + sep) && extname(candidate) && existsSync(candidate)
    ? candidate : resolve(webRoot, 'index.html');
  response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', ...security });
  response.end(await readFile(file));
}

/** Forward one API request (including the streamed run events) to the Mayura server, unchanged but for the host. */
function proxy(request: IncomingMessage, response: ServerResponse): void {
  const headers = { ...request.headers }; delete headers.host; delete headers.connection;
  const upstream = forward(new URL(request.url ?? '/', server.origin), { method: request.method, headers }, reply => {
    response.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(response);
  });
  upstream.on('error', () => { if (!response.headersSent) response.writeHead(502).end(); else response.destroy(); });
  response.on('close', () => upstream.destroy());
  request.pipe(upstream);
}

async function session(request: IncomingMessage, response: ServerResponse): Promise<void> {
  let body = '';
  for await (const chunk of request) { body += chunk; if (body.length > 1_024) { response.writeHead(413).end(); return; } }
  let customerId: unknown;
  try { customerId = (JSON.parse(body) as { customerId?: unknown }).customerId; } catch { /* handled below */ }
  const customer = demoCustomers.find(entry => entry.customerId === customerId);
  if (!customer) { response.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":{"code":"UNKNOWN_CUSTOMER"}}'); return; }
  const ttlMs = 60 * 60_000;
  const token = mintSessionToken(config.sessionSecret, customer.customerId, ttlMs);
  response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...security })
    .end(JSON.stringify({ token, customerId: customer.customerId, name: customer.name, expiresAtMs: Date.now() + ttlMs }));
}

const web = createServer((request, response) => {
  const { pathname } = new URL(request.url ?? '/', webOrigin);
  const handle = async (): Promise<void> => {
    if (pathname.startsWith('/v1/')) return proxy(request, response);
    if (pathname === '/dev/customers' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...security }).end(JSON.stringify({ customers: demoCustomers })); return;
    }
    if (pathname === '/dev/session' && request.method === 'POST') return session(request, response);
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
    return serveFile(pathname, response);
  };
  handle().catch(() => { if (!response.headersSent) response.writeHead(500).end(); else response.destroy(); });
});
await new Promise<void>((resolveListen, reject) => { web.once('error', reject); web.listen(webPort, '127.0.0.1', () => resolveListen()); });

console.log(JSON.stringify({
  chat: webOrigin,
  console: `${server.origin}/inspector`,
  operatorToken,
  customers: demoCustomers.map(customer => customer.customerId),
  next: 'Open the chat, pick a customer and ask "Where is my order?" or "I want to return my mug set". Paste the operator token into the console to see return follow-ups.',
}, null, 2));

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) process.exit(1); stopping = true;
  web.closeAllConnections(); web.close();
  await worker.drain({ timeoutMs: 10_000 }); await server.close(); await services.close();
};
process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
