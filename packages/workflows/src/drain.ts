import { MayuraError } from '@mayura/core';

export interface WorkflowDrainOptions {
  /** Upper bound for letting admitted work settle before the worker closes. Default 30 s, maximum 300 s. */
  readonly timeoutMs?: number;
}
export interface WorkflowDrainReport {
  /** True when every admitted wave, including its external effects and receipts, settled before the deadline. */
  readonly drained: boolean;
  /** Admitted waves still running at the deadline; the subsequent close aborts them and recovery owns their effects. */
  readonly interrupted: number;
}
export interface WorkflowDrainGate {
  readonly draining: boolean;
  /** Admit one unit of work, or return undefined once draining has begun. Admission is synchronous. */
  enter(): (() => void) | undefined;
  /** Stop admission, wait for admitted work within the deadline, then close exactly once. */
  drain(options: WorkflowDrainOptions | undefined, close: () => void | Promise<void>): Promise<WorkflowDrainReport>;
}

export function drainTimeout(options: WorkflowDrainOptions | undefined): number {
  const value = options?.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) throw new MayuraError('INVALID_INPUT', 'Drain timeout must be 1–300000 ms.');
  return value;
}

/** Counts admitted work so a worker can stop taking new work and let started effects settle before closing. */
export function createWorkflowDrainGate(): WorkflowDrainGate {
  let admitted = 0; let draining = false; let result: Promise<WorkflowDrainReport> | undefined;
  const idle = new Set<() => void>();
  return {
    get draining() { return draining; },
    enter() {
      if (draining) return undefined;
      admitted += 1; let released = false;
      return () => {
        if (released) return; released = true; admitted -= 1;
        if (admitted === 0) for (const notify of [...idle]) notify();
      };
    },
    drain(options, close) {
      if (result) return result;
      const timeoutMs = drainTimeout(options); draining = true;
      result = (async () => {
        if (admitted > 0) {
          let timer: ReturnType<typeof setTimeout> | undefined; let notify!: () => void;
          await new Promise<void>(resolve => { notify = resolve; idle.add(notify); timer = setTimeout(resolve, timeoutMs); });
          idle.delete(notify); if (timer) clearTimeout(timer);
        }
        const interrupted = admitted; await close();
        return Object.freeze({ drained: interrupted === 0, interrupted });
      })();
      return result;
    },
  };
}
