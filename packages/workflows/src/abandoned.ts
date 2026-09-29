import type { AggregateStore } from '@mayura/storage-contracts';

/**
 * How long past a tool's own `timeoutMs` a dispatching step may stay unsettled before it counts as abandoned. A live
 * process settles every call within the timeout, because `invokeTool` enforces it; the margin covers slow storage and
 * the difference between replica clocks and the database clock that timestamps events.
 */
export const ABANDONED_STEP_MARGIN_MS = 60_000;

/**
 * When a step's dispatch was recorded, by the storage clock: the `createdAt` of the last `eventType` event for
 * `nodeId`, or `undefined` when there is none. Events are read page by page, so long histories are fine.
 */
export async function dispatchedAt(store: AggregateStore, scope: string, runId: string, eventType: string, nodeId: string): Promise<number | undefined> {
  let after = 0; let found: number | undefined;
  for (let pages = 0; pages < 10_000; pages++) {
    const page = await store.events(scope, runId, after);
    if (page.length === 0) return found;
    for (const event of page) {
      if (event.type === eventType && event.data['nodeId'] === nodeId) {
        const at = Date.parse(event.createdAt); if (Number.isFinite(at)) found = at;
      }
      after = event.sequence;
    }
  }
  return found;
}

/** Whether a step dispatched at `dispatchedAtMs` for a tool with `timeoutMs` is past any live process's reach at `nowMs`. */
export function abandoned(dispatchedAtMs: number | undefined, timeoutMs: number, nowMs: number): boolean {
  return dispatchedAtMs !== undefined && nowMs >= dispatchedAtMs + timeoutMs + ABANDONED_STEP_MARGIN_MS;
}
