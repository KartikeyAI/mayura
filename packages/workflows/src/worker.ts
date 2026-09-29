import { freezeJson, jsonValue, MayuraError, type ErrorCode } from '@mayura/core';
import { drainTimeout, type WorkflowDrainOptions, type WorkflowDrainReport } from './drain.js';
import type { WorkflowLeadership } from './leadership.js';

/** Anything a worker supervises: lifecycle and composite hosts qualify directly; coordinators via `coordinatorUnit`. */
export interface WorkflowWorkerUnit {
  start(): void;
  stop(): Promise<void>;
  drain(options?: WorkflowDrainOptions): Promise<WorkflowDrainReport>;
  /**
   * One bounded pass over due work, then return; what `WorkflowWorker.runOnce` calls. `completedSweep` is true once the
   * pass reached the end of the unit's work, and `held` while a fleet hold stops it from driving anything. Hosts and
   * `coordinatorUnit` have it.
   */
  runOnce?(): Promise<{ readonly completedSweep: boolean; readonly held?: boolean }>;
}
export interface WorkflowWorkerStatus {
  readonly running: boolean; readonly leader: boolean; readonly fence: number; readonly unitsActive: boolean;
  readonly lastError: ErrorCode | null; readonly lastConfirmedAtMs: number | null;
}
export interface WorkflowWorker {
  /** Begin the leadership loop; units run only while this replica holds the lease (or always, without leadership). */
  start(): void;
  status(): WorkflowWorkerStatus;
  /** Ready while started, not draining, and leadership storage was confirmed within three renewal intervals. */
  isReady(): boolean;
  /** Stop renewing, drain every unit within one deadline, then release the lease so a standby takes over at once. */
  drain(options?: WorkflowDrainOptions): Promise<WorkflowDrainReport>;
  /**
   * Advance everything that is due once, then return: for a scheduled job or function instead of a process that keeps
   * running. Takes the lease once (a standby returns at once, having done nothing), runs each unit's passes until every
   * unit has completed a sweep or the budget runs out, renewing the lease between passes, then releases it. A pass that
   * has started finishes, so leave room in the budget for your longest tool. Not while the worker is started.
   */
  runOnce(options?: WorkflowWorkerOnceOptions): Promise<WorkflowWorkerOnceReport>;
}
export interface WorkflowWorkerOnceOptions {
  /** Stop starting passes after this long. Default 60,000 ms; 1,000 to 3,600,000. */
  readonly budgetMs?: number;
}
export interface WorkflowWorkerOnceReport {
  /** False when another replica holds the lease: this call advanced nothing. */
  readonly leader: boolean;
  /** Every unit completed a sweep within the budget. When false, run it more often or give it a larger budget. */
  readonly completedSweep: boolean;
  /** A fleet hold stopped a unit from driving runs. */
  readonly held: boolean;
  readonly passes: number;
  /** The error code of each pass that failed. */
  readonly failures: readonly ErrorCode[];
}
export interface WorkflowWorkerOptions {
  readonly units: readonly WorkflowWorkerUnit[];
  readonly leadership?: WorkflowLeadership;
  /** How often to renew or contest the lease. Keep it under a third of the lease duration. Default 4 s. */
  readonly renewIntervalMs?: number;
  readonly now?: () => number;
}

const sleep = (milliseconds: number, signal: AbortSignal): Promise<void> => new Promise(resolve => {
  if (signal.aborted) { resolve(); return; }
  const timer = setTimeout(done, milliseconds); function done(): void { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
  signal.addEventListener('abort', done, { once: true });
});

/** Supervises hosts under an optional durable leadership lease with fail-safe stop on lost or unconfirmable leadership. */
export function createWorkflowWorker(options: WorkflowWorkerOptions): WorkflowWorker {
  const units = [...(options.units ?? [])]; const interval = options.renewIntervalMs ?? 4_000; const leadership = options.leadership;
  if (units.length < 1 || units.length > 32 || units.some(unit => !unit || ['start', 'stop', 'drain'].some(name => typeof (unit as unknown as Record<string, unknown>)[name] !== 'function'))
    || !Number.isSafeInteger(interval) || interval < 100 || interval > 200_000
    || (leadership !== undefined && ['acquire', 'release', 'isLeader'].some(name => typeof (leadership as unknown as Record<string, unknown>)[name] !== 'function'))) {
    throw new MayuraError('INVALID_CONFIG', 'A worker requires 1–32 units with start/stop/drain, an optional leadership lease and a bounded renewal interval.');
  }
  const now = options.now ?? Date.now;
  let running = false; let draining = false; let unitsActive = false; let leader = false; let fence = 0;
  let lastError: ErrorCode | null = null; let lastConfirmedAtMs: number | null = null;
  let controller: AbortController | undefined; let loop: Promise<void> | undefined; let drained: Promise<WorkflowDrainReport> | undefined;
  const activate = (): void => { if (!unitsActive && !draining) { for (const unit of units) unit.start(); unitsActive = true; } };
  const deactivate = async (): Promise<void> => { if (unitsActive) { unitsActive = false; await Promise.allSettled(units.map(unit => unit.stop())); } };
  const tick = async (): Promise<void> => {
    if (!leadership) { leader = true; lastConfirmedAtMs = now(); lastError = null; activate(); return; }
    try {
      const state = await leadership.acquire(); leader = state.leader; fence = state.fence; lastConfirmedAtMs = now(); lastError = null;
      if (state.leader) activate(); else await deactivate();
    } catch (error) {
      // Fail safe: if the lease cannot be confirmed, stop driving rather than risk two active leaders.
      leader = false; lastError = error instanceof MayuraError ? error.code : 'STORAGE_UNAVAILABLE'; await deactivate();
    }
  };
  let once = false;
  const runOnce = async (onceOptions: WorkflowWorkerOnceOptions = {}): Promise<WorkflowWorkerOnceReport> => {
    const budgetMs = onceOptions.budgetMs ?? 60_000;
    if (!Number.isSafeInteger(budgetMs) || budgetMs < 1_000 || budgetMs > 3_600_000) throw new MayuraError('INVALID_CONFIG', 'budgetMs must be 1000–3600000.');
    if (units.some(unit => typeof unit.runOnce !== 'function')) throw new MayuraError('INVALID_CONFIG', 'A one-shot worker needs units with runOnce: hosts, or coordinators through coordinatorUnit.');
    if (running || draining || once) throw new MayuraError('CONFLICT', 'The worker is already running.');
    once = true; const deadline = now() + budgetMs; const failures: ErrorCode[] = []; let passes = 0; let held = false; let completed = false;
    const report = (isLeader: boolean): WorkflowWorkerOnceReport =>
      freezeJson(jsonValue({ leader: isLeader, completedSweep: completed, held, passes, failures })) as unknown as WorkflowWorkerOnceReport;
    try {
      if (leadership) {
        const state = await leadership.acquire(); leader = state.leader; fence = state.fence; lastConfirmedAtMs = now();
        if (!state.leader) return report(false);
      }
      const pending = new Set(units); let renewedAtMs = now();
      while (pending.size > 0 && now() < deadline) {
        for (const unit of [...pending]) {
          if (now() >= deadline) break;
          try {
            const cycle = await unit.runOnce!(); passes += 1;
            if (cycle.held) { held = true; pending.delete(unit); } else if (cycle.completedSweep) pending.delete(unit);
          } catch (error) { passes += 1; failures.push(error instanceof MayuraError ? error.code : 'STORAGE_UNAVAILABLE'); pending.delete(unit); }
        }
        // Keep the lease between passes; stop at once if it was lost, rather than risk two leaders.
        if (leadership && pending.size > 0 && now() - renewedAtMs >= interval) {
          const state = await leadership.acquire(); renewedAtMs = now(); lastConfirmedAtMs = renewedAtMs; fence = state.fence;
          if (!state.leader) { leader = false; break; }
        }
      }
      completed = pending.size === 0 && !held && failures.length === 0;
      return report(true);
    } finally {
      if (leadership && leader) { try { await leadership.release(); } catch { /* The lease expires on its own. */ } }
      leader = false; once = false;
    }
  };
  return Object.freeze<WorkflowWorker>({
    runOnce,
    start() {
      if (draining) throw new MayuraError('CANCELLED', 'The worker is draining.'); if (once) throw new MayuraError('CONFLICT', 'The worker is running once.'); if (running) return;
      running = true; controller = new AbortController(); const signal = controller.signal;
      loop = (async () => { while (!signal.aborted) { await tick(); await sleep(interval, signal); } })();
    },
    status: () => freezeJson(jsonValue({ running, leader, fence, unitsActive, lastError, lastConfirmedAtMs })) as unknown as WorkflowWorkerStatus,
    isReady: () => running && !draining && lastError === null && lastConfirmedAtMs !== null && now() - lastConfirmedAtMs <= interval * 3,
    drain(drainOptions) {
      if (drained) return drained;
      const timeoutMs = drainTimeout(drainOptions); draining = true;
      drained = (async () => {
        controller?.abort(); await loop; running = false;
        const reports = await Promise.all(units.map(unit => unit.drain({ timeoutMs }).catch(() => ({ drained: false, interrupted: 1 }))));
        unitsActive = false;
        try { await leadership?.release(); } catch { /* The lease expires on its own; release only shortens failover. */ }
        leader = false;
        return Object.freeze({ drained: reports.every(report => report.drained), interrupted: reports.reduce((total, report) => total + report.interrupted, 0) });
      })();
      return drained;
    },
  });
}

/** Adapt a pull-based graph or tree coordinator into a worker unit that pages continuously while running. */
export function coordinatorUnit(coordinator: {
  runPage(command?: { readonly cursor?: never; readonly limit?: number }): Promise<{ readonly status: string; readonly nextCursor?: unknown; readonly retryCursor?: unknown }>;
  drain(options?: WorkflowDrainOptions): Promise<WorkflowDrainReport>;
}, settings: { readonly intervalMs?: number; readonly limit?: number } = {}): WorkflowWorkerUnit {
  const interval = settings.intervalMs ?? 1_000; const limit = settings.limit ?? 32;
  if (!coordinator || typeof coordinator.runPage !== 'function' || typeof coordinator.drain !== 'function'
    || !Number.isSafeInteger(interval) || interval < 10 || interval > 3_600_000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 128) {
    throw new MayuraError('INVALID_CONFIG', 'A coordinator unit requires runPage/drain and bounded paging.');
  }
  let controller: AbortController | undefined; let loop: Promise<void> | undefined; let cursor: unknown = null;
  const stop = async (): Promise<void> => { controller?.abort(); await loop; controller = undefined; loop = undefined; };
  return Object.freeze<WorkflowWorkerUnit>({
    start() {
      if (loop) return; controller = new AbortController(); const signal = controller.signal;
      loop = (async () => {
        while (!signal.aborted) {
          try {
            const report = await coordinator.runPage({ cursor: cursor as never, limit });
            cursor = report.status === 'completed' ? report.nextCursor ?? null : report.retryCursor ?? null;
          } catch { cursor = null; }
          // Continue immediately through a sweep; pause between complete sweeps and after interruptions.
          if (cursor === null) await sleep(interval, signal);
        }
      })();
    },
    stop,
    async drain(options) { await stop(); return coordinator.drain(options); },
    async runOnce() {
      if (loop) throw new MayuraError('CONFLICT', 'The coordinator unit is running.');
      // Page through one sweep, up to 256 pages; a failed page ends the pass and the next pass starts over.
      let pages = 0;
      do {
        try {
          const report = await coordinator.runPage({ cursor: cursor as never, limit });
          cursor = report.status === 'completed' ? report.nextCursor ?? null : report.retryCursor ?? null;
        } catch (error) { cursor = null; throw error; }
        pages += 1;
      } while (cursor !== null && pages < 256);
      return { completedSweep: cursor === null };
    },
  });
}
