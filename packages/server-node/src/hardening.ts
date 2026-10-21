import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import type { AgentServerOptions } from '@mayura/server';

export const unavailable = (): Response => new Response(JSON.stringify({ error: { code: 'HOST_UNAVAILABLE', retryAfterMs: 1_000,
  message: 'The server is starting, stopping or could not handle the request. Retry shortly, against another replica if possible.' } }), {
  status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Retry-After': '1' },
});

/**
 * Hono exposes a stream even for a zero-byte HTTP POST/DELETE. Restore Fetch's absent-body representation only
 * when Node's HTTP framing guarantees no bytes (no transfer encoding and absent/zero Content-Length).
 * This adapter is for requests already parsed by the Node host, not untrusted synthetic Fetch requests.
 */
export function normalizeNodeRequest(request: Request): Request {
  if (request.body === null || request.headers.has('transfer-encoding')
    || (request.headers.has('content-length') && request.headers.get('content-length') !== '0')) return request;
  return new Request(request.url, { method: request.method, headers: request.headers, signal: request.signal });
}

/** Snapshot and freeze every trusted option before a socket opens; no mutable caller reference is retained. */
export function snapshotSettings(options: Omit<AgentServerOptions, 'publicOrigin' | 'mounted'>): Omit<AgentServerOptions, 'publicOrigin' | 'mounted'> {
  return {
    agents: Object.freeze(options.agents.map(config => Object.freeze({ agent: config.agent,
      permissions: Object.freeze({ allow: Object.freeze([...config.permissions.allow]) }),
      ...(config.limits === undefined ? {} : { limits: Object.freeze({ ...config.limits }) }),
    }))), authenticate: options.authenticate,
    ...(options.authorization === undefined ? {} : { authorization: Object.freeze({
      ...(options.authorization.cursorKey === undefined ? {} : { cursorKey: new Uint8Array(options.authorization.cursorKey) }),
      ...(options.authorization.audit === undefined ? {} : { audit: Object.freeze({ ...options.authorization.audit }) }),
      policy: Object.freeze({ version: options.authorization.policy.version, authorize: options.authorization.policy.authorize.bind(options.authorization.policy) }),
      ...(options.authorization.permissions === undefined ? {} : { permissions: Object.freeze({ allow: Object.freeze([...options.authorization.permissions.allow]) }) }),
      ...(options.authorization.limits === undefined ? {} : { limits: Object.freeze({ ...options.authorization.limits }) }),
    }) }),
    ...(options.publicLiveness === undefined ? {} : { publicLiveness: options.publicLiveness }),
    ...(options.inspector === undefined ? {} : { inspector: options.inspector }),
    ...(options.healthChecks === undefined ? {} : { healthChecks: Object.freeze(options.healthChecks.map(check => Object.freeze({ id: check.id, check: check.check }))) }),
    ...(options.humanRequests === undefined ? {} : { humanRequests: options.humanRequests }),
    ...(options.workflowViews === undefined ? {} : { workflowViews: options.workflowViews }),
    ...(options.workflowIndex === undefined ? {} : { workflowIndex: options.workflowIndex }),
    ...(options.workflowControls === undefined ? {} : { workflowControls: options.workflowControls }),
    ...(options.workflowSignals === undefined ? {} : { workflowSignals: options.workflowSignals }),
    ...(options.workflowResumes === undefined ? {} : { workflowResumes: options.workflowResumes }),
    ...(options.workflowPauses === undefined ? {} : { workflowPauses: options.workflowPauses }),
    ...(options.workflowFleet === undefined ? {} : { workflowFleet: options.workflowFleet }),
    ...(options.workflowMigrations === undefined ? {} : { workflowMigrations: options.workflowMigrations }),
    ...(options.submissionJournal === undefined ? {} : { submissionJournal: options.submissionJournal }),
    ...(options.conversationRecovery === undefined ? {} : { conversationRecovery: Object.freeze({ ...options.conversationRecovery, permissions: Object.freeze({ allow: Object.freeze([...options.conversationRecovery.permissions.allow]) }) }) }),
    ...(options.approvalReconciliation === undefined ? {} : { approvalReconciliation: Object.freeze({ ...options.approvalReconciliation, permissions: Object.freeze({ allow: Object.freeze([...options.approvalReconciliation.permissions.allow]) }) }) }),
    ...(options.runRecords === undefined ? {} : { runRecords: options.runRecords }),
    ...(options.threadCompaction === undefined ? {} : { threadCompaction: Object.freeze({ ...options.threadCompaction,
      agentIds: Object.freeze([...options.threadCompaction.agentIds]),
      permissions: Object.freeze({ allow: Object.freeze([...options.threadCompaction.permissions.allow]) }) }) }),
    ...(options.threads === undefined ? {} : { threads: Object.freeze({ store: options.threads.store }) }),
    ...(options.runExecution === undefined ? {} : { runExecution: options.runExecution }),
    ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: Object.freeze([...options.allowedOrigins]) }),
    ...(options.limits === undefined ? {} : { limits: Object.freeze({ ...options.limits }) }),
  };
}

/** Apply the shared socket, header and timeout bounds and track sockets for a bounded shutdown. */
export function hardenServer(server: Server, maxConnections: number): Set<Socket> {
  server.maxConnections = maxConnections;
  const sockets = new Set<Socket>();
  // TLS servers report the encrypted socket through 'secureConnection'; plain servers through 'connection'.
  const track = (socket: Socket): void => { sockets.add(socket); socket.once('close', () => { sockets.delete(socket); }); };
  server.on('connection', track); server.on('secureConnection', track);
  server.maxRequestsPerSocket = 100;
  server.setTimeout(35_000, socket => socket.destroy());
  server.on('upgrade', (_request, socket) => { socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  server.on('connect', (_request, socket) => { socket.destroy(); });
  server.on('clientError', (error, socket) => {
    const status = (error as NodeJS.ErrnoException).code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large' : '400 Bad Request';
    if (socket.writable) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    else socket.destroy();
  });
  return sockets;
}

export const serverTimeouts = { maxHeaderSize: 16_384, headersTimeout: 5_000, requestTimeout: 15_000,
  keepAliveTimeout: 5_000, connectionsCheckingInterval: 1_000 } as const;

export function listen(server: Server, port: number, hostname: string, failure: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const failed = (): void => { server.removeListener('listening', ready); reject(new Error(failure)); };
    const ready = (): void => { server.removeListener('error', failed); resolve(); };
    server.once('error', failed); server.once('listening', ready); server.listen(port, hostname);
  });
}

/** Stop accepting, then close the protocol; the grace timer bounds stale and half-open sockets. */
export function shutdown(server: Server, sockets: Set<Socket>, grace: number, closeProtocol: () => Promise<void>, failure: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.closeAllConnections();
      // Node excludes upgraded sockets from closeAllConnections, including rejected half-open peers.
      for (const socket of sockets) socket.destroy();
    }, grace);
    const stopped = new Promise<void>(done => { server.close(() => done()); });
    server.closeIdleConnections();
    void Promise.all([stopped, closeProtocol()]).then(() => { clearTimeout(timer); resolve(); }, () => {
      clearTimeout(timer); for (const socket of sockets) socket.destroy();
      reject(new Error(failure));
    });
  });
}
