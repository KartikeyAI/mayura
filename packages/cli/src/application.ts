import { createServer, type Server } from 'node:http';
import { lstat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MayuraError } from '@mayura/core';

/** A running HTTP host, for example the result of `listenProductionServer`. */
export interface MayuraServerHandle { isAccepting(): boolean; close(): Promise<void> }
/** A running worker, for example the result of `createWorkflowWorker`. */
export interface MayuraWorkerHandle {
  start(): void; isReady(): boolean;
  drain(options?: { readonly timeoutMs?: number }): Promise<{ readonly drained: boolean; readonly interrupted: number }>;
}
/**
 * The explicit contract a `mayura serve` or `mayura worker` module exports. The module wires its own storage,
 * definitions and hosts with its own installed Mayura packages; the CLI only owns process lifecycle.
 */
export interface MayuraApplication {
  readonly server?: () => Promise<MayuraServerHandle>;
  readonly worker?: () => Promise<MayuraWorkerHandle>;
  /** Runs after the server closes or the worker drains, for example to close storage. */
  readonly shutdown?: () => Promise<void>;
}
export type MayuraLifecycleEvent =
  | { readonly event: 'serving' } | { readonly event: 'worker-started'; readonly probe: { readonly hostname: string; readonly port: number } | null }
  | { readonly event: 'stopping' } | { readonly event: 'stopped'; readonly drained?: boolean; readonly interrupted?: number };

/** Validate and freeze an application definition. */
export function defineMayuraApplication(application: MayuraApplication): MayuraApplication {
  if (!application || typeof application !== 'object') throw new MayuraError('INVALID_CONFIG', 'A Mayura application must be an object.');
  const keys = Object.keys(application);
  if (keys.length < 1 || keys.some(key => !['server', 'worker', 'shutdown'].includes(key))
    || keys.some(key => typeof (application as unknown as Record<string, unknown>)[key] !== 'function')) {
    throw new MayuraError('INVALID_CONFIG', 'A Mayura application exports only server, worker and shutdown functions.');
  }
  return Object.freeze({ ...application });
}

/** Import exactly the named module file. Directories, symbolic links and non-JavaScript files are refused. */
export async function loadApplication(path: string): Promise<MayuraApplication> {
  const absolute = resolve(path);
  let details;
  try { details = await lstat(absolute); } catch { throw new MayuraError('INVALID_CONFIG', 'The application module was not found.'); }
  if (!details.isFile() || details.isSymbolicLink() || !['.js', '.mjs'].includes(extname(absolute))) {
    throw new MayuraError('INVALID_CONFIG', 'The application module must be a regular .js or .mjs file.');
  }
  const module = await import(pathToFileURL(absolute).href) as { default?: unknown };
  return defineMayuraApplication(module.default as MayuraApplication);
}

const settle = async (operation: (() => Promise<void>) | undefined): Promise<void> => { if (operation) await operation(); };
const aborted = (signal: AbortSignal): Promise<void> => new Promise(resolve => {
  if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true });
});

/** Start the application's server and keep it until the signal aborts, then close it gracefully. */
export async function serveApplication(options: { readonly application: MayuraApplication; readonly signal: AbortSignal;
  readonly log?: (event: MayuraLifecycleEvent) => void }): Promise<{ readonly status: 'stopped' }> {
  const { application, signal } = options; const log = options.log ?? (() => {});
  if (!application.server) throw new MayuraError('INVALID_CONFIG', 'The application does not define a server.');
  const server = await application.server();
  if (!server || typeof server.close !== 'function' || typeof server.isAccepting !== 'function') throw new MayuraError('INVALID_CONFIG', 'The application server handle is invalid.');
  log({ event: 'serving' });
  try { await aborted(signal); log({ event: 'stopping' }); await server.close(); }
  finally { await settle(application.shutdown); }
  log({ event: 'stopped' }); return { status: 'stopped' };
}

/** Start the application's worker with optional HTTP probes, then drain it when the signal aborts. */
export async function runWorkerApplication(options: { readonly application: MayuraApplication; readonly signal: AbortSignal;
  readonly probe?: { readonly hostname: string; readonly port: number }; readonly drainTimeoutMs?: number;
  readonly log?: (event: MayuraLifecycleEvent) => void }): Promise<{ readonly status: 'stopped'; readonly drained: boolean; readonly interrupted: number }> {
  const { application, signal } = options; const log = options.log ?? (() => {}); const timeoutMs = options.drainTimeoutMs ?? 30_000;
  if (!application.worker) throw new MayuraError('INVALID_CONFIG', 'The application does not define a worker.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new MayuraError('INVALID_CONFIG', 'Drain timeout must be 1–300000 ms.');
  if (options.probe && (typeof options.probe.hostname !== 'string' || !/^[A-Za-z0-9.:[\]-]{1,255}$/.test(options.probe.hostname)
    || !Number.isInteger(options.probe.port) || options.probe.port < 0 || options.probe.port > 65_535)) throw new MayuraError('INVALID_CONFIG', 'Invalid probe address.');
  const worker = await application.worker();
  if (!worker || typeof worker.start !== 'function' || typeof worker.isReady !== 'function' || typeof worker.drain !== 'function') {
    throw new MayuraError('INVALID_CONFIG', 'The application worker handle is invalid.');
  }
  let stopping = false; let probe: Server | undefined; let address: { hostname: string; port: number } | null = null;
  if (options.probe) {
    const reply = (response: import('node:http').ServerResponse, status: number, body: string): void => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(body);
    };
    probe = createServer({ headersTimeout: 5_000, requestTimeout: 5_000 }, (request, response) => {
      const path = (request.url ?? '').split('?')[0];
      if (request.method !== 'GET') reply(response, 405, '{"error":{"code":"METHOD_NOT_ALLOWED"}}');
      else if (path === '/livez') reply(response, stopping ? 503 : 200, stopping ? '{"status":"stopping"}' : '{"status":"ok"}');
      else if (path === '/readyz') { const ready = !stopping && worker.isReady(); reply(response, ready ? 200 : 503, ready ? '{"status":"ready"}' : '{"status":"unavailable"}'); }
      else reply(response, 404, '{"error":{"code":"NOT_FOUND"}}');
    });
    probe.maxConnections = 64;
    await new Promise<void>((done, fail) => { probe!.once('error', fail); probe!.listen(options.probe!.port, options.probe!.hostname, () => { probe!.removeListener('error', fail); done(); }); });
    const bound = probe.address(); if (!bound || typeof bound === 'string') throw new MayuraError('INVALID_CONFIG', 'The probe server did not bind.');
    address = { hostname: options.probe.hostname, port: bound.port };
  }
  worker.start(); log({ event: 'worker-started', probe: address });
  let report = { drained: false, interrupted: 0 };
  try { await aborted(signal); stopping = true; log({ event: 'stopping' }); report = await worker.drain({ timeoutMs }); }
  finally {
    stopping = true;
    if (probe) await new Promise<void>(done => { probe!.close(() => done()); probe!.closeAllConnections(); });
    await settle(application.shutdown);
  }
  log({ event: 'stopped', drained: report.drained, interrupted: report.interrupted });
  return { status: 'stopped', drained: report.drained, interrupted: report.interrupted };
}
