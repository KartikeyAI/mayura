import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { createAgentServer, type AgentServer, type AgentServerOptions } from '@mayura/server';

export interface LocalServerOptions extends Omit<AgentServerOptions, 'publicOrigin'> {
  readonly hostname?: '127.0.0.1' | '::1';
  readonly port?: number;
  readonly shutdownGraceMs?: number;
}
export interface LocalAgentServer {
  readonly origin: string;
  /** Stop listeners and request cancellation, retaining truthful unknown-effect semantics. */
  close(): Promise<void>;
}
const unavailable = (): Response => new Response('{"error":{"code":"HOST_UNAVAILABLE"}}', {
  status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});

/** Explicit local host. Never binds a wildcard/public interface or changes global Web API objects. */
export async function listenAgentServer(options: LocalServerOptions): Promise<LocalAgentServer> {
  const hostname = options.hostname ?? '127.0.0.1'; const port = options.port ?? 0; const grace = options.shutdownGraceMs ?? 5_000;
  if (!['127.0.0.1', '::1'].includes(hostname) || !Number.isInteger(port) || port < 0 || port > 65535
    || !Number.isSafeInteger(grace) || grace < 1 || grace > 30_000) throw new Error('Invalid bounded loopback server configuration.');
  // Snapshot/validate all trusted configuration before opening a socket; retain no mutable option references.
  const settings = { agents: Object.freeze(options.agents.map(config => Object.freeze({ agent: config.agent,
    permissions: Object.freeze({ allow: Object.freeze([...config.permissions.allow]) }),
    ...(config.limits === undefined ? {} : { limits: Object.freeze({ ...config.limits }) }),
  }))), authenticate: options.authenticate,
  ...(options.publicLiveness === undefined ? {} : { publicLiveness: options.publicLiveness }),
  ...(options.healthChecks === undefined ? {} : { healthChecks: Object.freeze(options.healthChecks.map(check => Object.freeze({ id: check.id, check: check.check }))) }),
  ...(options.humanRequests === undefined ? {} : { humanRequests: options.humanRequests }),
  ...(options.workflowViews === undefined ? {} : { workflowViews: options.workflowViews }),
  ...(options.workflowIndex === undefined ? {} : { workflowIndex: options.workflowIndex }),
  ...(options.workflowControls === undefined ? {} : { workflowControls: options.workflowControls }),
  ...(options.workflowSignals === undefined ? {} : { workflowSignals: options.workflowSignals }),
  ...(options.workflowResumes === undefined ? {} : { workflowResumes: options.workflowResumes }),
  ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: Object.freeze([...options.allowedOrigins]) }),
  ...(options.limits === undefined ? {} : { limits: Object.freeze({ ...options.limits }) }),
  };
  const validation = createAgentServer({ ...settings, publicOrigin: 'http://127.0.0.1' });
  await validation.close();
  let protocol: AgentServer | undefined;
  let closing = false;
  const app = new Hono();
  app.onError(() => unavailable());
  app.all('*', context => closing || !protocol ? unavailable() : protocol.fetch(context.req.raw));
  const listener = getRequestListener(app.fetch, { overrideGlobalObjects: false, autoCleanupIncoming: true, errorHandler: () => unavailable() });
  const server = createServer({ maxHeaderSize: 16_384, headersTimeout: 5_000, requestTimeout: 15_000,
    keepAliveTimeout: 5_000, connectionsCheckingInterval: 1_000,
  }, listener);
  server.maxConnections = 128;
  const sockets = new Set<Socket>();
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => { sockets.delete(socket); }); });
  server.maxRequestsPerSocket = 100;
  server.setTimeout(35_000, socket => socket.destroy());
  server.on('upgrade', (_request, socket) => { socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  server.on('connect', (_request, socket) => { socket.destroy(); });
  server.on('clientError', (error, socket) => {
    const status = (error as NodeJS.ErrnoException).code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large' : '400 Bad Request';
    if (socket.writable) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    else socket.destroy();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (): void => { server.removeListener('listening', ready); reject(new Error('The local server could not bind its configured loopback address.')); };
      const ready = (): void => { server.removeListener('error', failed); resolve(); };
      server.once('error', failed); server.once('listening', ready); server.listen(port, hostname);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('The local server did not establish a network address.');
    const origin = `http://${hostname === '::1' ? '[::1]' : hostname}:${address.port}`;
    protocol = createAgentServer({ ...settings, publicOrigin: origin });
    let closingPromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (closingPromise) return closingPromise;
      closing = true;
      closingPromise = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          server.closeAllConnections();
          // Node excludes upgraded sockets from closeAllConnections, including rejected half-open peers.
          for (const socket of sockets) socket.destroy();
        }, grace);
        // Stop accepting first, then close observers/runs. The grace timer bounds stale HTTP sockets.
        const stopped = new Promise<void>(done => { server.close(() => done()); });
        server.closeIdleConnections();
        void Promise.all([stopped, protocol!.close()]).then(() => { clearTimeout(timer); resolve(); }, () => {
          clearTimeout(timer); for (const socket of sockets) socket.destroy();
          reject(new Error('The local server could not confirm runtime shutdown.'));
        });
      });
      return closingPromise;
    };
    server.on('error', () => { void close().catch(() => {}); });
    return Object.freeze({ origin, close });
  } catch {
    closing = true; server.close(); server.closeAllConnections(); await protocol?.close();
    throw new Error('The local agent server could not start.');
  }
}
