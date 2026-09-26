import { freezeJson, jsonValue, MayuraError, type ErrorCode } from '@mayura/core';
import type { WorkflowDrainOptions, WorkflowDrainReport } from './drain.js';
import { createWorkflowCompositeFleetRuntime, type WorkflowCompositeCursor, type WorkflowCompositeFleetOptions,
  type WorkflowCompositeFleetRuntime, type WorkflowCompositeOutcome } from './composite-fleet.js';
import { assertWorkflowLoop, type AnyWorkflowLoop } from './loop-definition.js';
import { assertWorkflowSaga, type AnyWorkflowSaga } from './saga-definition.js';

export interface WorkflowCompositeHostOptions extends WorkflowCompositeFleetOptions {
  readonly sagaDefinitions?: readonly AnyWorkflowSaga[]; readonly loopDefinitions?: readonly AnyWorkflowLoop[];
  readonly intervalMs?: number; readonly maxBackoffMs?: number; readonly maxPagesPerCycle?: number;
  readonly pageLimit?: number; readonly maxShardReads?: number;
}
export interface WorkflowCompositeHostCycle { readonly pages: number; readonly examined: number; readonly shardReads: number;
  readonly outcomes: readonly WorkflowCompositeOutcome[]; readonly completedSweep: boolean }
export interface WorkflowCompositeHostStatus { readonly running: boolean; readonly cycles: number;
  readonly consecutiveFailures: number; readonly lastError: ErrorCode | null; readonly lastCycle: WorkflowCompositeHostCycle | null }
export interface WorkflowCompositeHost { readonly runtime: WorkflowCompositeFleetRuntime; start(): void;
  runOnce(): Promise<WorkflowCompositeHostCycle>; status(): WorkflowCompositeHostStatus; stop(): Promise<void>; close(): Promise<void>;
  /** Start no further cycle, let admitted effects settle within the deadline, then close the owned runtime. */
  drain(options?: WorkflowDrainOptions): Promise<WorkflowDrainReport> }

function delay(milliseconds: number, signal: AbortSignal): Promise<void> { return new Promise(resolve => {
  if (signal.aborted) { resolve(); return; } const timer = setTimeout(done, milliseconds);
  function done(): void { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
  signal.addEventListener('abort', done, { once: true }); } ); }

/** Explicitly hosted, restart-safe continuation for indexed saga and loop parents. */
export function createWorkflowCompositeHost(options: WorkflowCompositeHostOptions): WorkflowCompositeHost {
  const sagas = Object.freeze([...(options.sagaDefinitions ?? [])]); const loops = Object.freeze([...(options.loopDefinitions ?? [])]);
  if (sagas.length + loops.length < 1 || sagas.length > 128 || loops.length > 128) throw new MayuraError('INVALID_CONFIG', 'A composite host requires a finite definition catalog.');
  const seen = new Set<string>(); for (const value of sagas) { assertWorkflowSaga(value); if (seen.has(value.digest)) throw new MayuraError('INVALID_CONFIG', 'Composite host definitions must be unique.'); seen.add(value.digest); }
  for (const value of loops) { assertWorkflowLoop(value); if (seen.has(value.digest)) throw new MayuraError('INVALID_CONFIG', 'Composite host definitions must be unique.'); seen.add(value.digest); }
  const interval = options.intervalMs ?? 1_000; const backoffMaximum = options.maxBackoffMs ?? 30_000;
  const pageMaximum = options.maxPagesPerCycle ?? 16; const limit = options.pageLimit ?? 32; const reads = options.maxShardReads ?? 32;
  for (const [name, value, maximum] of [['intervalMs', interval, 3_600_000], ['maxBackoffMs', backoffMaximum, 3_600_000],
    ['maxPagesPerCycle', pageMaximum, 256], ['pageLimit', limit, 128], ['maxShardReads', reads, 256]] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new MayuraError('INVALID_CONFIG', `${name} is outside its finite host bound.`); }
  if (backoffMaximum < interval) throw new MayuraError('INVALID_CONFIG', 'maxBackoffMs must be at least intervalMs.');
  const runtime = createWorkflowCompositeFleetRuntime(options); let cursor: WorkflowCompositeCursor | null = null; let closed = false;
  let cycles = 0; let failures = 0; let lastError: ErrorCode | null = null; let lastCycle: WorkflowCompositeHostCycle | null = null;
  let controller: AbortController | undefined; let loop: Promise<void> | undefined; let active: Promise<WorkflowCompositeHostCycle> | undefined;
  const runOnce = (): Promise<WorkflowCompositeHostCycle> => { if (closed) return Promise.reject(new MayuraError('CANCELLED', 'Composite host is closed.')); if (active) return active;
    const operation = (async () => { let pages = 0; let examined = 0; let shardReads = 0; const outcomes: WorkflowCompositeOutcome[] = [];
      do { const report = await runtime.runPage({ sagas, loops }, { cursor, limit, maxShardReads: reads }); pages += 1;
        examined += report.page.examined; shardReads += report.page.shardReads; outcomes.push(...report.outcomes); cursor = report.page.nextCursor; }
      while (cursor && pages < pageMaximum); const completedSweep = cursor === null;
      const result = freezeJson(jsonValue({ pages, examined, shardReads, outcomes, completedSweep })) as unknown as WorkflowCompositeHostCycle;
      cycles += 1; failures = 0; lastError = null; lastCycle = result; return result; })();
    active = operation; void operation.finally(() => { if (active === operation) active = undefined; }).catch(() => {}); return operation; };
  const start = (): void => { if (closed) throw new MayuraError('CANCELLED', 'Composite host is closed.'); if (loop) return;
    controller = new AbortController(); const signal = controller.signal; loop = (async () => { while (!signal.aborted) {
      try { await runOnce(); } catch (error) { if (signal.aborted) break; failures += 1; lastError = error instanceof MayuraError ? error.code : 'STORAGE_UNAVAILABLE'; }
      await delay(Math.min(backoffMaximum, interval * (2 ** Math.min(failures, 16))), signal); } })().finally(() => { loop = undefined; }); };
  const stop = async (): Promise<void> => { controller?.abort(); await loop; if (active) await Promise.allSettled([active]); controller = undefined; };
  return Object.freeze({ runtime, start, runOnce,
    status: () => freezeJson(jsonValue({ running: loop !== undefined, cycles, consecutiveFailures: failures, lastError, lastCycle })) as unknown as WorkflowCompositeHostStatus,
    stop, close: async () => { if (closed) return; await stop(); closed = true; runtime.close(); },
    drain: async (options?: WorkflowDrainOptions) => {
      controller?.abort(); const report = await runtime.drain(options);
      await loop; if (active) await Promise.allSettled([active]); controller = undefined; closed = true; return report;
    } });
}
