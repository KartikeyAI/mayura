import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import type { AgentServerOptions } from '@mayura/server';

export const unavailable = (): Response => new Response('{"error":{"code":"HOST_UNAVAILABLE"}}', {
  status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});

/** Snapshot and freeze every trusted option before a socket opens; no mutable caller reference is retained. */
export function snapshotSettings(options: Omit<AgentServerOptions, 'publicOrigin'>): Omit<AgentServerOptions, 'publicOrigin'> {
  return {
    agents: Object.freeze(options.agents.map(config => Object.freeze({ agent: config.agent,
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
    ...(options.workflowPauses === undefined ? {} : { workflowPauses: options.workflowPauses }),
    ...(options.workflowFleet === undefined ? {} : { workflowFleet: options.workflowFleet }),
    ...(options.submissionJournal === undefined ? {} : { submissionJournal: options.submissionJournal }),
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
