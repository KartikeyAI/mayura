import { ClientError, type MayuraClient, type ThreadCompactionInput, type RemoteThreadCompaction,
  type RemoteThreadCompactionResult, type RemoteThreadCompactionCancellation } from './index.js';
import { threadCompactionCommand, readThreadCompaction, readThreadCompactionResult, readThreadCompactionCancellation } from './conversations.js';

export interface ThreadCompactionState {
  readonly revision: number; readonly status: 'idle' | 'submitting' | 'loading' | 'ready' | 'failed' | 'disposed';
  /** Immutable binding for review before admitting a paid command. */
  readonly threadId: string; readonly command: ThreadCompactionInput;
  readonly commandId: string; readonly compaction: RemoteThreadCompaction | null; readonly result: RemoteThreadCompactionResult | null;
  readonly cancelling: boolean; readonly cancellation: RemoteThreadCompactionCancellation | null; readonly errorCode: string | null;
}
export interface ThreadCompactionControllerOptions {
  readonly client: Pick<MayuraClient, 'compactThread' | 'threadCompaction' | 'cancelThreadCompaction'>;
  readonly threadId: string; readonly command: ThreadCompactionInput; readonly maxSubscribers?: number;
}
export interface ThreadCompactionController {
  getSnapshot(): ThreadCompactionState;
  subscribe(listener: () => void): () => void;
  /** Submit exactly the captured command. No automatic retries or replacement command ids. */
  compact(options?: { readonly signal?: AbortSignal }): Promise<RemoteThreadCompactionResult>;
  /** Read durable state after a lost response; never dispatches a model or publishes staged output. */
  refresh(options?: { readonly signal?: AbortSignal }): Promise<RemoteThreadCompaction>;
  /** May run while compact() is pending. A committed summary is never removed. */
  cancel(options?: { readonly signal?: AbortSignal }): Promise<RemoteThreadCompactionCancellation>;
  /** Stops local requests and publication. Durable cancellation always requires cancel(). */
  dispose(): void;
}
/** A command-bound view with independently cancellable requests, bounded listeners and immutable feedback. */
export function createThreadCompactionController(options: ThreadCompactionControllerOptions): ThreadCompactionController {
  if (!options || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(options.threadId)
    || ['compactThread', 'threadCompaction', 'cancelThreadCompaction'].some(key => typeof options.client?.[key as keyof typeof options.client] !== 'function')) throw new ClientError('INVALID_VIEW_CONFIG');
  const maximum = options.maxSubscribers ?? 64;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 256) throw new ClientError('INVALID_VIEW_CONFIG');
  const command = threadCompactionCommand(options.command); const client = options.client; const threadId = options.threadId;
  const listeners = new Set<() => void>(); const requests = new Set<AbortController>();
  let busy = false; let cancelling = false; let generation = 0;
  let state: ThreadCompactionState = Object.freeze({ revision: 0, status: 'idle', threadId, command, commandId: command.commandId,
    compaction: null, result: null, cancelling: false, cancellation: null, errorCode: null });
  const publish = (change: Partial<ThreadCompactionState>) => {
    if (state.status === 'disposed') return;
    state = Object.freeze({ ...state, ...change, revision: state.revision + 1 });
    for (const listener of [...listeners]) { try { listener(); } catch { /* Feedback is independent of view exceptions. */ } }
  };
  const active = () => { if (state.status === 'disposed') throw new ClientError('VIEW_DISPOSED'); };
  const request = async <T>(signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    active(); const control = new AbortController(); const abort = () => control.abort();
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); requests.add(control);
    try {
      if (control.signal.aborted) throw new ClientError('ABORTED');
      const result = await work(control.signal);
      if (control.signal.aborted || state.status === 'disposed') throw new ClientError('ABORTED'); return result;
    } catch (error) { throw control.signal.aborted ? new ClientError('ABORTED') : error instanceof ClientError ? error : new ClientError('VIEW_FAILED'); }
    finally { requests.delete(control); signal?.removeEventListener('abort', abort); }
  };
  const main = async <T>(kind: 'submitting' | 'loading', signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>,
    update: (result: T) => Partial<ThreadCompactionState>): Promise<T> => {
    active(); if (busy || cancelling) throw new ClientError('VIEW_BUSY'); if (signal?.aborted) throw new ClientError('ABORTED');
    const current = generation; busy = true; publish({ status: kind, errorCode: null });
    try { const result = await request(signal, work); if (generation === current) publish({ ...update(result), status: 'ready', errorCode: null }); return result; }
    catch (error) { if (generation === current) publish({ status: 'failed', errorCode: (error as ClientError).code }); throw error; }
    finally { busy = false; }
  };
  return Object.freeze({
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      active(); if (typeof listener !== 'function') throw new ClientError('INVALID_VIEW_INPUT');
      if (listeners.size >= maximum) throw new ClientError('VIEW_SUBSCRIBER_LIMIT'); listeners.add(listener); return () => { listeners.delete(listener); };
    },
    compact: (settings?: { readonly signal?: AbortSignal }) => main('submitting', settings?.signal,
      async signal => readThreadCompactionResult(await client.compactThread(threadId, command, { signal }), command), result => ({ result, compaction: null, cancellation: null })),
    refresh: (settings?: { readonly signal?: AbortSignal }) => main('loading', settings?.signal,
      async signal => {
        const compaction = readThreadCompaction(await client.threadCompaction(threadId, command.commandId, { signal }), command.commandId);
        if (compaction.through !== command.through) throw new ClientError('INVALID_VIEW_INPUT'); return compaction;
      }, compaction => ({ compaction })),
    async cancel(settings?: { readonly signal?: AbortSignal }) {
      active(); if (cancelling) throw new ClientError('VIEW_BUSY'); if (settings?.signal?.aborted) throw new ClientError('ABORTED');
      cancelling = true; publish({ cancelling: true, errorCode: null });
      try {
        const cancellation = await request(settings?.signal, async signal => readThreadCompactionCancellation(await client.cancelThreadCompaction(threadId, command.commandId, { signal })));
        // Only a durable cancellation fences late submit feedback; a missing command may still be reserved by an in-flight submit.
        if (cancellation.status !== 'missing') generation++;
        publish({ cancellation, cancelling: false, ...(cancellation.status === 'missing' && busy ? {} : { status: 'ready' as const }), errorCode: null }); return cancellation;
      } catch (error) { publish({ cancelling: false, errorCode: (error as ClientError).code, ...(busy ? {} : { status: 'failed' as const }) }); throw error; }
      finally { cancelling = false; }
    },
    dispose() {
      if (state.status === 'disposed') return; generation++;
      for (const control of requests) control.abort(); publish({ status: 'disposed', cancelling: false, errorCode: null }); listeners.clear();
    },
  });
}
