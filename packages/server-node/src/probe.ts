import { createServer, type ServerResponse } from 'node:http';

export interface ProbeServerOptions {
  readonly hostname: string;
  readonly port: number;
  readonly isLive: () => boolean;
  readonly isReady: () => boolean;
}
export interface ProbeServer { readonly port: number; close(): Promise<void> }

/** Content-free `/livez` and `/readyz` for processes without an HTTP surface of their own, such as workers. */
export async function listenProbe(options: ProbeServerOptions): Promise<ProbeServer> {
  if (!options || typeof options.hostname !== 'string' || !/^[A-Za-z0-9.:[\]-]{1,255}$/.test(options.hostname) || !Number.isInteger(options.port)
    || options.port < 0 || options.port > 65_535 || typeof options.isLive !== 'function' || typeof options.isReady !== 'function') {
    throw new Error('Invalid probe server configuration.');
  }
  const reply = (response: ServerResponse, status: number, body: string): void => {
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(body);
  };
  const server = createServer({ headersTimeout: 5_000, requestTimeout: 5_000 }, (request, response) => {
    const path = (request.url ?? '').split('?')[0];
    const check = (probe: () => boolean): boolean => { try { return probe() === true; } catch { return false; } };
    if (request.method !== 'GET') reply(response, 405, '{"error":{"code":"METHOD_NOT_ALLOWED"}}');
    else if (path === '/livez') reply(response, check(options.isLive) ? 200 : 503, check(options.isLive) ? '{"status":"ok"}' : '{"status":"stopping"}');
    else if (path === '/readyz') { const ready = check(options.isReady); reply(response, ready ? 200 : 503, ready ? '{"status":"ready"}' : '{"status":"unavailable"}'); }
    else reply(response, 404, '{"error":{"code":"NOT_FOUND"}}');
  });
  server.maxConnections = 64;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(options.port, options.hostname, () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('The probe server did not bind.'); }
  return Object.freeze({ port: address.port,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) });
}
