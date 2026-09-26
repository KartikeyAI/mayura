import { freezeJson, jsonValue, MayuraError, type ErrorCode } from '@mayura/core';
import type { WorkflowDrainOptions, WorkflowDrainReport } from './drain.js';
import { assertWorkflowLifecycle, type AnyWorkflowLifecycle } from './lifecycle-definition.js';
import { createWorkflowLifecycleFleetRuntime, type WorkflowLifecycleFleetCursor,
  type WorkflowLifecycleFleetOutcome, type WorkflowLifecycleFleetRuntime,
  type WorkflowLifecycleFleetRuntimeOptions } from './lifecycle-fleet.js';

export interface WorkflowLifecycleHostOptions extends WorkflowLifecycleFleetRuntimeOptions {
  readonly definitions: readonly AnyWorkflowLifecycle[];
  readonly intervalMs?: number;
  readonly maxPagesPerCycle?: number;
  readonly pageLimit?: number;
  readonly maxShardReads?: number;
  readonly maxBackoffMs?: number;
}
export interface WorkflowLifecycleHostCycle {
  readonly pages: number; readonly examined: number; readonly shardReads: number;
  readonly outcomes: readonly WorkflowLifecycleFleetOutcome[]; readonly completedSweep: boolean;
}
export interface WorkflowLifecycleHostStatus {
  readonly running: boolean; readonly cycles: number; readonly consecutiveFailures: number;
  readonly lastError: ErrorCode | null; readonly lastCycle: WorkflowLifecycleHostCycle | null;
}
export interface WorkflowLifecycleHost {
  readonly runtime: WorkflowLifecycleFleetRuntime;
  start(): void;
  runOnce(): Promise<WorkflowLifecycleHostCycle>;
  status(): WorkflowLifecycleHostStatus;
  stop(): Promise<void>;
  close(): Promise<void>;
  /** Start no further cycle, let admitted effects settle within the deadline, then close the owned runtime. */
  drain(options?: WorkflowDrainOptions): Promise<WorkflowDrainReport>;
}

function code(error: unknown): ErrorCode { return error instanceof MayuraError ? error.code : 'STORAGE_UNAVAILABLE'; }
function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(done, milliseconds);
    function done(): void { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Explicitly started, single-flight lifecycle fleet worker with bounded scans and backoff. */
export function createWorkflowLifecycleHost(options: WorkflowLifecycleHostOptions): WorkflowLifecycleHost {
  if (!Array.isArray(options.definitions) || options.definitions.length < 1 || options.definitions.length > 128) {
    throw new MayuraError('INVALID_CONFIG', 'A lifecycle host requires 1–128 registered definitions.');
  }
  const definitions = Object.freeze([...options.definitions]); const digests = new Set<string>();
  for (const definition of definitions) { assertWorkflowLifecycle(definition);
    if (digests.has(definition.digest)) throw new MayuraError('INVALID_CONFIG', 'Lifecycle host definitions must be unique.'); digests.add(definition.digest); }
  const intervalMs = options.intervalMs ?? 1_000; const maxPages = options.maxPagesPerCycle ?? 16;
  const pageLimit = options.pageLimit ?? 32; const maxShardReads = options.maxShardReads ?? 32;
  const maxBackoffMs = options.maxBackoffMs ?? 30_000;
  for (const [name, value, maximum] of [['intervalMs', intervalMs, 3_600_000], ['maxPagesPerCycle', maxPages, 256],
    ['pageLimit', pageLimit, 128], ['maxShardReads', maxShardReads, 256], ['maxBackoffMs', maxBackoffMs, 3_600_000]] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new MayuraError('INVALID_CONFIG', `${name} is outside its finite host bound.`);
  }
  if (maxBackoffMs < intervalMs) throw new MayuraError('INVALID_CONFIG', 'maxBackoffMs must be at least intervalMs.');
  const runtime = createWorkflowLifecycleFleetRuntime(options); let cursor: WorkflowLifecycleFleetCursor | null = null;
  let cycles = 0; let consecutiveFailures = 0; let lastError: ErrorCode | null = null;
  let lastCycle: WorkflowLifecycleHostCycle | null = null; let controller: AbortController | undefined;
  let loop: Promise<void> | undefined; let inFlight: Promise<WorkflowLifecycleHostCycle> | undefined; let closed = false;
  const runOnce = (): Promise<WorkflowLifecycleHostCycle> => {
    if (closed) return Promise.reject(new MayuraError('CANCELLED', 'Lifecycle host is closed.'));
    if (inFlight) return inFlight;
    const operation = (async () => {
      let pages = 0; let examined = 0; let shardReads = 0; const outcomes: WorkflowLifecycleFleetOutcome[] = [];
      do {
        const report = await runtime.runPage(definitions, { cursor, limit: pageLimit, maxShardReads });
        pages += 1; examined += report.page.examined; shardReads += report.page.shardReads; outcomes.push(...report.outcomes);
        cursor = report.page.nextCursor;
      } while (cursor && pages < maxPages);
      const completedSweep = cursor === null; if (completedSweep) cursor = null;
      const result = freezeJson(jsonValue({ pages, examined, shardReads, outcomes, completedSweep })) as unknown as WorkflowLifecycleHostCycle;
      cycles += 1; consecutiveFailures = 0; lastError = null; lastCycle = result; return result;
    })();
    inFlight = operation; void operation.finally(() => { if (inFlight === operation) inFlight = undefined; }).catch(() => {}); return operation;
  };
  const start = (): void => {
    if (closed) throw new MayuraError('CANCELLED', 'Lifecycle host is closed.'); if (loop) return;
    controller = new AbortController(); const signal = controller.signal;
    loop = (async () => { while (!signal.aborted) {
      try { await runOnce(); } catch (error) { if (signal.aborted) break; consecutiveFailures += 1; lastError = code(error); }
      const backoff = Math.min(maxBackoffMs, intervalMs * (2 ** Math.min(consecutiveFailures, 16)));
      await delay(backoff, signal);
    } })().finally(() => { loop = undefined; });
  };
  const stop = async (): Promise<void> => { controller?.abort(); await loop; if (inFlight) await Promise.allSettled([inFlight]); controller = undefined; };
  return Object.freeze({ runtime, start, runOnce,
    status: () => freezeJson(jsonValue({ running: loop !== undefined, cycles, consecutiveFailures, lastError, lastCycle })) as unknown as WorkflowLifecycleHostStatus,
    stop,
    close: async () => { if (closed) return; await stop(); closed = true; runtime.close(); },
    drain: async (options?: WorkflowDrainOptions) => {
      // Stop the loop first so no new cycle begins; the active cycle's in-flight wave still settles.
      controller?.abort(); const report = await runtime.drain(options);
      await loop; if (inFlight) await Promise.allSettled([inFlight]); controller = undefined; closed = true; return report;
    },
  });
}
