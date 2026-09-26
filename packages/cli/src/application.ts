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
  /** Apply explicit storage schema migrations before new code serves traffic; returns a JSON-serializable report. */
  readonly migrate?: () => Promise<unknown>;
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
  if (keys.length < 1 || keys.some(key => !['server', 'worker', 'migrate', 'shutdown'].includes(key))
    || keys.some(key => typeof (application as unknown as Record<string, unknown>)[key] !== 'function')) {
    throw new MayuraError('INVALID_CONFIG', 'A Mayura application exports only server, worker, migrate and shutdown functions.');
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
  readonly listenProbe?: (options: { readonly hostname: string; readonly port: number; readonly isLive: () => boolean; readonly isReady: () => boolean })
    => Promise<{ readonly port: number; close(): Promise<void> }>;
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
  let stopping = false; let probe: { readonly port: number; close(): Promise<void> } | undefined; let address: { hostname: string; port: number } | null = null;
  if (options.probe) {
    // The CLI opens no listener itself: the probe factory comes from the application's installed @mayura/server-node.
    if (typeof options.listenProbe !== 'function') throw new MayuraError('INVALID_CONFIG', 'Worker probes require a probe server factory.');
    probe = await options.listenProbe({ hostname: options.probe.hostname, port: options.probe.port, isLive: () => !stopping, isReady: () => !stopping && worker.isReady() });
    address = { hostname: options.probe.hostname, port: probe.port };
  }
  worker.start(); log({ event: 'worker-started', probe: address });
  let report = { drained: false, interrupted: 0 };
  try { await aborted(signal); stopping = true; log({ event: 'stopping' }); report = await worker.drain({ timeoutMs }); }
  finally {
    stopping = true;
    if (probe) await probe.close();
    await settle(application.shutdown);
  }
  log({ event: 'stopped', drained: report.drained, interrupted: report.interrupted });
  return { status: 'stopped', drained: report.drained, interrupted: report.interrupted };
}

/** Run the application's explicit migration once, then its shutdown. Nothing else is started. */
export async function migrateApplication(application: MayuraApplication): Promise<{ readonly status: 'migrated'; readonly report: unknown }> {
  if (!application.migrate) throw new MayuraError('INVALID_CONFIG', 'The application does not define migrate.');
  try { return { status: 'migrated', report: await application.migrate() }; }
  finally { await settle(application.shutdown); }
}
