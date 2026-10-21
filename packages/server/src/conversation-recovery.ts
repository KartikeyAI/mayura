import { MayuraError, type Permissions, type Scope } from '@mayura/core';
import { runCheckpointCommand, runCheckpointResult, type RunCheckpointCursor } from '@mayura/storage-contracts';

export interface ConversationRecoveryOptions {
  /** Explicit service grant, separate from browser token capabilities: conversations:recover. */
  readonly permissions: Permissions;
  /** Trusted service policy, checked for each scope/agent before mutation. Only true authorizes work. */
  readonly authorize: (work: { readonly scope: Scope; readonly agentId: string; readonly kind: 'approval' | 'recording' | 'frontend'; readonly signal: AbortSignal }) => Promise<boolean>;
  /** Optional process scheduler (100 ms to one day). Omit for a trusted cron/job invoking recoverConversations. */
  readonly intervalMs?: number;
  /** Most candidates per scheduler cycle (default 25, at most 100). */
  readonly pageSize?: number;
}
export interface ConversationRecoveryRequest {
  readonly after?: RunCheckpointCursor; readonly limit?: number; readonly signal?: AbortSignal;
}
export interface ConversationRecoveryOutcome {
  readonly id: string; readonly status: 'resumed' | 'cancelled' | 'recovered' | 'skipped' | 'retry'; readonly code?: string;
}
export interface ConversationRecoveryReport {
  readonly outcomes: readonly ConversationRecoveryOutcome[]; readonly next: RunCheckpointCursor | null;
}
/** Internal scheduler/controller: bounded pages, no overlapping local jobs, abortable waits and safe error reports. */
export function createRecoveryController(options: ConversationRecoveryOptions | undefined, hooks: {
  readonly scan: (after: RunCheckpointCursor | undefined, limit: number) => Promise<readonly RunCheckpointCursor[]>;
  readonly process: (id: string, signal: AbortSignal, authorize: ConversationRecoveryOptions['authorize']) => Promise<ConversationRecoveryOutcome>;
  readonly timeoutMs: number;
}) {
  if (options !== undefined && (!options || !Array.isArray(options.permissions?.allow) || !options.permissions.allow.includes('conversations:recover')
    || options.permissions.allow.some(value => value !== 'conversations:recover') || typeof options.authorize !== 'function'
    || (options.intervalMs !== undefined && (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 100 || options.intervalMs > 86_400_000))
    || (options.pageSize !== undefined && (!Number.isSafeInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100))))
    throw new MayuraError('INVALID_CONFIG', 'Conversation recovery requires its explicit service grant, authorization callback and bounded scheduler settings.');
  const authorize = options?.authorize; const interval = options?.intervalMs; const pageSize = options?.pageSize ?? 25;
  const stop = new AbortController(); let active: Promise<ConversationRecoveryReport> | undefined; let timer: ReturnType<typeof setTimeout> | undefined;
  const check = (signal: AbortSignal): void => { if (signal.aborted || stop.signal.aborted) throw new MayuraError('CANCELLED', 'Conversation recovery stopped.'); };
  const recover = async (settings: ConversationRecoveryRequest = {}): Promise<ConversationRecoveryReport> => {
    if (!authorize) throw new MayuraError('PERMISSION_DENIED', 'Conversation recovery is not enabled.');
    if (settings.signal?.aborted || stop.signal.aborted) throw new MayuraError('CANCELLED', 'Conversation recovery stopped.');
    if (active) throw new MayuraError('CONFLICT', 'A conversation recovery page is already running.');
    let command; try { command = runCheckpointCommand('scan', { limit: settings.limit ?? pageSize, ...(settings.after === undefined ? {} : { after: settings.after }) }); }
    catch { throw new MayuraError('INVALID_INPUT', 'Invalid conversation recovery cursor or page size.'); }
    const control = new AbortController(); const abort = (): void => control.abort();
    settings.signal?.addEventListener('abort', abort, { once: true }); stop.signal.addEventListener('abort', abort, { once: true });
    if (settings.signal?.aborted || stop.signal.aborted) abort(); check(control.signal);
    const work = async (): Promise<ConversationRecoveryReport> => {
      check(control.signal);
      const raw = await hooks.scan(command['after'] as unknown as RunCheckpointCursor | undefined, command['limit'] as number);
      const page = runCheckpointResult('scan', raw, command) as unknown as readonly RunCheckpointCursor[];
      const outcomes: ConversationRecoveryOutcome[] = [];
      for (const cursor of page) {
        check(control.signal);
        try { outcomes.push(Object.freeze(await hooks.process(cursor.runId, control.signal, authorize))); }
        catch (error) { check(control.signal); outcomes.push(Object.freeze({ id: cursor.runId, status: 'retry', code: error instanceof MayuraError ? error.code : 'STORAGE_UNAVAILABLE' })); }
      }
      check(control.signal);
      return Object.freeze({ outcomes: Object.freeze(outcomes), next: page.length === command['limit'] ? Object.freeze({ ...page[page.length - 1]! }) : null });
    };
    // Keep the slot until the underlying adapter settles, even if the caller aborts or times out.
    const task = Promise.resolve().then(work); active = task;
    const cleanup = (): void => { if (active === task) active = undefined; settings.signal?.removeEventListener('abort', abort); stop.signal.removeEventListener('abort', abort); };
    void task.then(cleanup, cleanup);
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<ConversationRecoveryReport>((resolve, reject) => {
        const stopped = (): void => reject(new MayuraError('CANCELLED', 'Conversation recovery stopped.'));
        control.signal.addEventListener('abort', stopped, { once: true });
        waitTimer = setTimeout(() => { control.abort(); }, hooks.timeoutMs);
        void task.then(resolve, () => reject(new MayuraError('STORAGE_UNAVAILABLE', 'Conversation recovery storage is unavailable.')))
          .finally(() => control.signal.removeEventListener('abort', stopped));
      });
    } finally { clearTimeout(waitTimer); }
  };
  let cursor: RunCheckpointCursor | undefined;
  const schedule = (): void => {
    if (interval === undefined || stop.signal.aborted) return;
    timer = setTimeout(() => {
      void recover({ ...(cursor ? { after: cursor } : {}) }).then(report => { cursor = report.next ?? undefined; }, () => {})
        .finally(schedule);
    }, interval);
    (timer as { unref?: () => void }).unref?.();
  };
  schedule();
  return Object.freeze({ recover, settled: async (): Promise<void> => { await active?.then(() => undefined, () => undefined); }, stop: () => { stop.abort(); clearTimeout(timer); } });
}
