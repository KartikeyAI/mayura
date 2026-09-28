import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { isIP } from 'node:net';
import { createServer as createHttpsServer } from 'node:https';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { createAgentServer, type AgentServer, type AgentServerOptions } from '@mayura/server';
import { hardenServer, listen, serverTimeouts, shutdown, snapshotSettings, unavailable } from './hardening.js';

/** The host rebuilds each request's URL from `publicOrigin` itself, so `mounted` does not apply. */
export interface ProductionServerOptions extends Omit<AgentServerOptions, 'publicOrigin' | 'mounted'> {
  /** The canonical external origin clients use. Must be HTTPS; requests for any other host are refused. */
  readonly publicOrigin: string;
  /**
   * IP addresses of reverse proxies that rewrite the `Host` header. A request whose socket peer is one of them is
   * accepted when its `X-Forwarded-Host` (the last value, the one that proxy set) names the public host. Every other
   * request must carry the public host in `Host`. Either way the destination is `publicOrigin`: no header changes it.
   */
  readonly trustedProxies?: readonly string[];
  /** Explicit bind address, for example `0.0.0.0`, `::` or one interface. There is no default. */
  readonly hostname: string;
  readonly port: number;
  /** Terminate TLS in-process, or declare that a trusted proxy terminates TLS in front of this listener. */
  readonly tls: { readonly key: string | Uint8Array; readonly cert: string | Uint8Array } | { readonly terminatedBy: 'proxy' };
  /** Application readiness for `/readyz`, for example storage reachability. Bounded to 2 s; failures report not ready. */
  readonly readiness?: (signal: AbortSignal) => Promise<boolean>;
  readonly shutdownGraceMs?: number;
  readonly maxConnections?: number;
  readonly hstsMaxAgeSeconds?: number;
}
export interface ProductionAgentServer {
  readonly publicOrigin: string;
  /** The bound port, useful when `port` is 0. */
  readonly port: number;
  /** False before startup completes and from the moment shutdown begins, so load balancers stop routing first. */
  isAccepting(): boolean;
  /** Stop accepting, fail readiness, drain in-flight requests within the grace period, then close runs and streams. */
  close(): Promise<void>;
}

const json = (status: number, body: string): Response => new Response(body, {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});
const misdirected = JSON.stringify({ error: { code: 'MISDIRECTED_REQUEST', message: 'This server answers only for its public origin. Send the public host in the Host header; behind a proxy that rewrites Host, list the proxy in trustedProxies and have it set X-Forwarded-Host.' } });
/** IPv4 peers can appear as IPv4-mapped IPv6 addresses; compare them in one form. */
const peerAddress = (value: string): string => value.toLowerCase().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
const bytes = (value: unknown): boolean => (typeof value === 'string' && value.length > 0) || (value instanceof Uint8Array && value.byteLength > 0);

const material = (value: unknown): string | Buffer => typeof value === 'string' ? value
  : Buffer.from((value as Uint8Array).buffer, (value as Uint8Array).byteOffset, (value as Uint8Array).byteLength);

/** Explicit production host: public binding, HTTPS-only origin, unauthenticated content-free probes and bounded shutdown. */
export async function listenProductionServer(options: ProductionServerOptions): Promise<ProductionAgentServer> {
  let publicOrigin: URL;
  try { publicOrigin = new URL(options.publicOrigin); } catch { throw new Error('Production servers require an exact HTTPS public origin.'); }
  if (publicOrigin.protocol !== 'https:' || publicOrigin.username || publicOrigin.password || publicOrigin.pathname !== '/'
    || publicOrigin.search || publicOrigin.hash || publicOrigin.origin !== options.publicOrigin.replace(/\/$/, '')) {
    throw new Error('Production servers require an exact HTTPS public origin.');
  }
  const { hostname, port } = options; const grace = options.shutdownGraceMs ?? 30_000;
  const maxConnections = options.maxConnections ?? 1_024; const hsts = options.hstsMaxAgeSeconds ?? 31_536_000;
  if (typeof hostname !== 'string' || !/^[A-Za-z0-9.:[\]-]{1,255}$/.test(hostname) || !Number.isInteger(port) || port < 0 || port > 65_535
    || !Number.isSafeInteger(grace) || grace < 1 || grace > 120_000 || !Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 65_536
    || !Number.isSafeInteger(hsts) || hsts < 0 || hsts > 63_072_000) throw new Error('Invalid bounded production server configuration.');
  const tls = options.tls as Record<string, unknown> | undefined;
  const proxied = tls?.['terminatedBy'] === 'proxy' && Object.keys(tls).length === 1;
  const inProcess = !!tls && Object.keys(tls).length === 2 && bytes(tls['key']) && bytes(tls['cert']);
  if (!proxied && !inProcess) throw new Error('Production servers require in-process TLS material or an explicit TLS-terminating proxy.');
  if (options.readiness !== undefined && typeof options.readiness !== 'function') throw new Error('Readiness must be a function.');
  const trustedProxies = (() => {
    const supplied = options.trustedProxies ?? [];
    if (!Array.isArray(supplied) || supplied.length > 64 || supplied.some(address => typeof address !== 'string' || isIP(address) === 0))
      throw new Error('Trusted proxies must be at most 64 exact IP addresses.');
    return new Set(supplied.map(peerAddress));
  })();
  const settings = snapshotSettings(options); const readiness = options.readiness;
  // Validate the complete protocol configuration before opening a socket.
  await createAgentServer({ ...settings, publicOrigin: publicOrigin.origin }).close();

  let protocol: AgentServer | undefined; let accepting = false; let closing = false;
  const expectedHost = publicOrigin.host.toLowerCase();
  const secure = (response: Response): Response => {
    if (hsts === 0) return response;
    const headers = new Headers(response.headers); headers.set('Strict-Transport-Security', `max-age=${hsts}`);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
  const app = new Hono();
  app.onError(() => unavailable());
  // Probes precede the host check: orchestrators address pods directly, not through the public name.
  app.get('/livez', () => closing ? json(503, '{"status":"stopping"}') : json(200, '{"status":"ok"}'));
  app.get('/readyz', async () => {
    if (!accepting || closing) return json(503, '{"status":"unavailable"}');
    if (!readiness) return json(200, '{"status":"ready"}');
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = await Promise.race([Promise.resolve().then(() => readiness(controller.signal)),
        new Promise<false>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(false); }, 2_000); })]);
      return ready === true && accepting && !closing ? json(200, '{"status":"ready"}') : json(503, '{"status":"unavailable"}');
    } catch { return json(503, '{"status":"unavailable"}'); } finally { if (timer) clearTimeout(timer); }
  });
  app.all('*', async context => {
    if (closing || !protocol) return unavailable();
    const raw = context.req.raw;
    // A trusted proxy may carry the public host in X-Forwarded-Host after rewriting Host; it only decides acceptance.
    const peer = peerAddress((context.env as { incoming?: IncomingMessage } | undefined)?.incoming?.socket.remoteAddress ?? '');
    const forwarded = trustedProxies.has(peer) ? raw.headers.get('x-forwarded-host')?.split(',').at(-1)?.trim().toLowerCase() : undefined;
    if ((forwarded ?? (raw.headers.get('host') ?? '').toLowerCase()) !== expectedHost) return secure(json(421, misdirected));
    // Rebuild the canonical public URL; the listener's own scheme and address are never trusted as the destination.
    const incoming = new URL(raw.url); const canonical = new URL(`${incoming.pathname}${incoming.search}`, publicOrigin.origin);
    const body = raw.method === 'GET' || raw.method === 'HEAD' ? null : raw.body;
    const request = new Request(canonical, { method: raw.method, headers: raw.headers, body, signal: raw.signal, ...(body ? { duplex: 'half' } : {}) } as RequestInit);
    return secure(await protocol.fetch(request));
  });
  const listener = getRequestListener(app.fetch, { overrideGlobalObjects: false, autoCleanupIncoming: true, errorHandler: () => unavailable() });
  const server = (inProcess
    ? createHttpsServer({ ...serverTimeouts, key: material(tls!['key']), cert: material(tls!['cert']), minVersion: 'TLSv1.2' }, listener)
    : createHttpServer(serverTimeouts, listener)) as unknown as Server;
  const sockets = hardenServer(server, maxConnections);
  try {
    await listen(server, port, hostname, 'The production server could not bind its configured address.');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('The production server did not establish a network address.');
    protocol = createAgentServer({ ...settings, publicOrigin: publicOrigin.origin }); accepting = true;
    let closingPromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      if (closingPromise) return closingPromise;
      accepting = false; closing = true;
      closingPromise = shutdown(server, sockets, grace, () => protocol!.close(), 'The production server could not confirm runtime shutdown.');
      return closingPromise;
    };
    server.on('error', () => { void close().catch(() => {}); });
    return Object.freeze({ publicOrigin: publicOrigin.origin, port: address.port, isAccepting: () => accepting && !closing, close });
  } catch {
    closing = true; server.close(); server.closeAllConnections(); await protocol?.close();
    throw new Error('The production agent server could not start.');
  }
}
