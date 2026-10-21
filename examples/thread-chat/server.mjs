// Local-only host. Builds the browser app once; all model responses and writes stay on this machine.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { listenAgentServer } from 'mayura/server-node';
import { createSqliteStore } from 'mayura/storage';
import { agentId, createChatServerOptions, demoScope } from './agent.mjs';

const here = dirname(fileURLToPath(import.meta.url)); const workspace = resolve(here, '../..');
export const browserBuild = output => build({ root: here, configFile: false, logLevel: 'warn',
  build: { outDir: output, emptyOutDir: true, sourcemap: false, target: 'es2022' },
  resolve: { dedupe: ['react', 'react-dom'], alias: {
    'mayura/client-react/components': join(workspace, 'packages/client-react/dist/components.js'),
    'mayura/client-react': join(workspace, 'packages/client-react/dist/index.js'),
  } } });

/** Start a single-user loopback example. A supplied database is retained; otherwise data and assets are temporary. */
export async function startThreadChat({ port = 0, database } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('MAYURA_CHAT_PORT must be a port number.');
  const directory = await mkdtemp(join(tmpdir(), 'mayura-thread-chat-')); const output = join(directory, 'ui');
  let api; let store; let ui; let closing; let recoveryTimer; let recoveryWork; let recoveryCursor;
  const recoveryStop = new AbortController();
  const close = () => closing ??= (async () => {
    recoveryStop.abort(); clearTimeout(recoveryTimer);
    if (ui?.listening) await new Promise((done, reject) => { ui.close(error => error ? reject(error) : done()); ui.closeAllConnections(); });
    try { await api?.close(); await recoveryWork; } finally {
      await store?.close();
      // Only the directory created above is eligible for recursive cleanup; never remove the user-supplied database.
      const child = relative(resolve(tmpdir()), resolve(directory));
      if (!child || child.startsWith('..') || isAbsolute(child) || !basename(directory).startsWith('mayura-thread-chat-')) throw new Error('Unsafe temporary cleanup path.');
      await rm(directory, { recursive: true, force: true });
    }
  })();
  try {
    await browserBuild(output);
    store = createSqliteStore({ filename: database ? resolve(database) : join(directory, 'chat.sqlite') });
    await store.initialize(); await store.threads.initialize();
    const secret = randomBytes(32); const token = secret.toString('hex'); const expiresAtMs = Date.now() + 3_600_000;
    const assets = new Map([['/', join(output, 'index.html')], ['/index.html', join(output, 'index.html')]]);
    for (const name of await readdir(join(output, 'assets'))) assets.set(`/assets/${name}`, join(output, 'assets', name));
    let origin;
    ui = createServer(async (request, response) => {
      const send = (status, body, type = 'text/plain; charset=utf-8') => {
        response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'content-security-policy': `default-src 'self'; connect-src 'self' ${api?.origin ?? ''}; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'` });
        response.end(body);
      };
      // Host + Fetch Metadata checks keep the local token/config away from cross-site pages and DNS rebinding.
      if (!origin || request.headers.host !== new URL(origin).host || !['GET', 'HEAD'].includes(request.method)
        || (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site']))) { send(403, 'Forbidden'); return; }
      const path = new URL(request.url ?? '/', origin).pathname;
      if (path === '/config.json') {
        if (!api) { send(503, 'Starting'); return; }
        send(200, request.method === 'HEAD' ? '' : JSON.stringify({ apiOrigin: api.origin, token }), 'application/json'); return;
      }
      const file = assets.get(path); if (!file) { send(404, 'Not found'); return; }
      try { const data = await readFile(file); const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }[extname(file)];
        send(200, request.method === 'HEAD' ? '' : data, type);
      } catch { send(404, 'Not found'); }
    });
    await new Promise((done, reject) => { ui.once('error', reject); ui.listen(port, '127.0.0.1', done); });
    origin = `http://127.0.0.1:${ui.address().port}`;
    api = await listenAgentServer({ ...createChatServerOptions(store, async ({ token: supplied, signal }) => {
      if (signal.aborted || expiresAtMs <= Date.now() || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied, 'hex'), secret)) return null;
      return { scope: demoScope, agentIds: [agentId], capabilities: ['runs:read', 'runs:submit', 'runs:cancel', 'runs:approve', 'threads:read', 'threads:write'], expiresAtMs };
    }), allowedOrigins: [origin] });
    // Request-mode deployments use a trusted job; this local host owns that job and drains it before closing SQLite.
    const recover = async () => {
      try {
        const page = await api.recoverConversations({ limit: 25, ...(recoveryCursor ? { after: recoveryCursor } : {}), signal: recoveryStop.signal });
        recoveryCursor = page.next ?? undefined;
        if (page.outcomes.some(item => item.status === 'retry')) console.error('Chat recovery will retry an interrupted item.');
      } catch { if (!recoveryStop.signal.aborted) console.error('Chat recovery is temporarily unavailable.'); }
      finally { if (!recoveryStop.signal.aborted) recoveryTimer = setTimeout(() => { recoveryWork = recover(); }, 1000); }
    };
    recoveryWork = recover();
    return Object.freeze({ origin, close });
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await startThreadChat({ port: Number(process.env.MAYURA_CHAT_PORT ?? 0), database: process.env.MAYURA_CHAT_DATABASE });
  console.log(`Mayura thread chat: ${server.origin} (Ctrl+C to stop)`);
  const stop = () => { void server.close().then(() => { process.exitCode = 0; }, () => { console.error('Chat shutdown failed.'); process.exitCode = 1; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
