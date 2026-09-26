import { createServer } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { createAgentServer, type AgentServer, type AgentServerOptions } from '@mayura/server';
import { hardenServer, listen, serverTimeouts, shutdown, snapshotSettings, unavailable } from './hardening.js';

export { listenProductionServer, type ProductionAgentServer, type ProductionServerOptions } from './production.js';

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

/** Explicit local host. Never binds a wildcard/public interface or changes global Web API objects. */
export async function listenAgentServer(options: LocalServerOptions): Promise<LocalAgentServer> {
  const hostname = options.hostname ?? '127.0.0.1'; const port = options.port ?? 0; const grace = options.shutdownGraceMs ?? 5_000;
  if (!['127.0.0.1', '::1'].includes(hostname) || !Number.isInteger(port) || port < 0 || port > 65535
    || !Number.isSafeInteger(grace) || grace < 1 || grace > 30_000) throw new Error('Invalid bounded loopback server configuration.');
  const settings = snapshotSettings(options);
  const validation = createAgentServer({ ...settings, publicOrigin: 'http://127.0.0.1' });
  await validation.close();
  let protocol: AgentServer | undefined;
  let closing = false;
  const app = new Hono();
  app.onError(() => unavailable());
  app.all('*', context => closing || !protocol ? unavailable() : protocol.fetch(context.req.raw));
  const listener = getRequestListener(app.fetch, { overrideGlobalObjects: false, autoCleanupIncoming: true, errorHandler: () => unavailable() });
  const server = createServer(serverTimeouts, listener);
  const sockets = hardenServer(server, 128);
  try {
    await listen(server, port, hostname, 'The local server could not bind its configured loopback address.');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('The local server did not establish a network address.');
    const origin = `http://${hostname === '::1' ? '[::1]' : hostname}:${address.port}`;
    protocol = createAgentServer({ ...settings, publicOrigin: origin });
    let closingPromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (closingPromise) return closingPromise;
      closing = true;
      closingPromise = shutdown(server, sockets, grace, () => protocol!.close(), 'The local server could not confirm runtime shutdown.');
      return closingPromise;
    };
    server.on('error', () => { void close().catch(() => {}); });
    return Object.freeze({ origin, close });
  } catch {
    closing = true; server.close(); server.closeAllConnections(); await protocol?.close();
    throw new Error('The local agent server could not start.');
  }
}
