import type { ThreadAppendInput } from './conversations.js';
import { ClientError, type MayuraClient, type RemoteApproval, type RunApprovalCommand, type RemoteRun, type RemoteThread, type RemoteThreadEntry,
  type RemoteThreadPage, type ThreadEntriesOptions, type ThreadListOptions, type ThreadUpdateInput } from './index.js';
import { approvalCommand, readApproval, readThread, readThreadEntry } from './conversations.js';

type SignalOptions = { readonly signal?: AbortSignal };
type ViewStatus = 'idle' | 'loading' | 'ready' | 'failed' | 'disposed';
export interface HeadlessThreadsState {
  readonly revision: number; readonly status: ViewStatus; readonly page: RemoteThreadPage | null; readonly errorCode: string | null;
}
export interface HeadlessThreadsStoreOptions {
  readonly client: Pick<MayuraClient, 'threads'>; readonly maxSubscribers?: number;
}
export interface HeadlessThreadsStore {
  getSnapshot(): HeadlessThreadsState;
  subscribe(listener: () => void): () => void;
  /** Replace the visible bounded page. Pass the returned cursor unchanged to fetch the next page. */
  refresh(options?: ThreadListOptions): Promise<HeadlessThreadsState>;
  dispose(): void;
}
export interface HeadlessThreadState {
  readonly revision: number; readonly status: ViewStatus | 'deleted'; readonly thread: RemoteThread | null;
  readonly entries: readonly RemoteThreadEntry[]; readonly errorCode: string | null;
}
export interface HeadlessThreadStoreOptions {
  readonly client: Partial<Pick<MayuraClient, 'appendThread'>> & Pick<MayuraClient, 'thread' | 'threadEntries' | 'updateThread' | 'archiveThread' | 'restoreThread' | 'deleteThread' | 'submit'>;
  readonly threadId: string; readonly maxEntries?: number; readonly maxSubscribers?: number;
}
export interface HeadlessThreadStore {
  append(input: ThreadAppendInput, options?: SignalOptions): Promise<readonly RemoteThreadEntry[]>;
  getSnapshot(): HeadlessThreadState;
  subscribe(listener: () => void): () => void;
  /** Replace the visible history page; after/before are exclusive sequence bounds. */
  refresh(options?: ThreadEntriesOptions): Promise<HeadlessThreadState>;
  update(changes: ThreadUpdateInput, options?: SignalOptions): Promise<RemoteThread>;
  archive(options?: SignalOptions): Promise<RemoteThread>;
  restore(options?: SignalOptions): Promise<RemoteThread>;
  delete(options?: SignalOptions): Promise<{ readonly removed: number }>;
  /** Submit a turn with the binding fixed to this store's thread; observe the returned run separately. */
  submit(agentId: string, input: unknown, options: { readonly idempotencyKey: string; readonly signal?: AbortSignal }): Promise<RemoteRun>;
  dispose(): void;
}
export interface RunApprovalCommandState {
  readonly revision: number; readonly status: 'idle' | 'submitting' | 'succeeded' | 'conflict' | 'failed' | 'disposed';
  readonly approval: RemoteApproval; readonly errorCode: string | null;
}
export interface RunApprovalControllerOptions {
  readonly run: Pick<RemoteRun, 'approve'>; readonly approval: RemoteApproval; readonly maxSubscribers?: number;
}
export interface RunApprovalController {
  getSnapshot(): RunApprovalCommandState;
  subscribe(listener: () => void): () => void;
  /** Decide only the captured approval. A different request requires a new controller after inspection. */
  submit(decision: 'approved' | 'rejected', options?: { readonly reason?: string; readonly signal?: AbortSignal }): Promise<void>;
  dispose(): void;
}
function error(value: unknown): ClientError { return value instanceof ClientError ? value : new ClientError('VIEW_FAILED'); }
function limit(value: number | undefined, fallback: number, max: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > max) throw new ClientError('INVALID_VIEW_CONFIG'); return selected;
}
/** One caller-owned operation at a time, bounded listeners, abort propagation and no publication after disposal. */
function owned<S extends { readonly revision: number; readonly status: string; readonly errorCode: string | null }>(initial: S, maximum?: number) {
  const maxSubscribers = limit(maximum, 64, 256); const listeners = new Set<() => void>();
  let state = Object.freeze(initial); let disposed = false; let busy = false; let active: AbortController | null = null;
  const publish = (change: Partial<S>): S => {
    if (disposed && change.status !== 'disposed') return state;
    state = Object.freeze({ ...state, ...change, revision: state.revision + 1 });
    for (const listener of [...listeners]) { try { listener(); } catch { /* A view cannot break command feedback. */ } } return state;
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      if (disposed) throw new ClientError('VIEW_DISPOSED'); if (typeof listener !== 'function') throw new ClientError('INVALID_VIEW_INPUT');
      if (listeners.size >= maxSubscribers) throw new ClientError('VIEW_SUBSCRIBER_LIMIT'); listeners.add(listener); return () => { listeners.delete(listener); };
    },
    publish,
    async perform<T>(signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>, pending: Partial<S>, failed: (code: string) => Partial<S>): Promise<T> {
      if (disposed) throw new ClientError('VIEW_DISPOSED'); if (busy) throw new ClientError('VIEW_BUSY');
      const control = new AbortController(); const abort = (): void => control.abort();
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
      if (control.signal.aborted) { signal?.removeEventListener('abort', abort); throw new ClientError('ABORTED'); }
      active = control; busy = true; publish(pending);
      try { const result = await work(control.signal); if (disposed || control.signal.aborted) throw new ClientError('ABORTED'); return result; }
      catch (cause) { const safe = control.signal.aborted ? new ClientError('ABORTED') : error(cause); publish(failed(safe.code)); throw safe; }
      finally { signal?.removeEventListener('abort', abort); busy = false; active = null; }
    },
    dispose: () => { if (disposed) return; disposed = true; active?.abort(); publish({ status: 'disposed', errorCode: null } as Partial<S>); listeners.clear(); },
  };
}
/** A bounded thread index page. Fetching and page changes are explicit actions. */
export function createHeadlessThreadsStore(options: HeadlessThreadsStoreOptions): HeadlessThreadsStore {
  if (!options || typeof options.client?.threads !== 'function') throw new ClientError('INVALID_VIEW_CONFIG');
  const store = owned<HeadlessThreadsState>({ revision: 0, status: 'idle', page: null, errorCode: null }, options.maxSubscribers);
  return Object.freeze({ getSnapshot: store.getSnapshot, subscribe: store.subscribe, dispose: store.dispose,
    refresh: (settings?: ThreadListOptions) => store.perform(settings?.signal, async signal => {
      const raw = await options.client.threads({ ...settings, signal });
      if (!raw || !Array.isArray(raw.threads) || raw.threads.length > (settings?.limit ?? 50) || (raw.cursor !== null && (typeof raw.cursor !== 'string' || !/^(?:[0-9]{1,16}:[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}|authz1\.[A-Za-z0-9_-]{40,500})$/.test(raw.cursor)))) throw new ClientError('INVALID_VIEW_INPUT');
      const threads = Object.freeze(raw.threads.map(value => readThread(value)));
      if (threads.length > 100 || threads.some(value => !['active', 'archived'].includes(value.status) || (settings?.status !== 'all' && value.status !== (settings?.status ?? 'active')))
        || new Set(threads.map(value => value.id)).size !== threads.length) throw new ClientError('INVALID_VIEW_INPUT');
      if (signal.aborted) throw new ClientError('ABORTED');
      return store.publish({ status: 'ready', page: Object.freeze({ threads, cursor: raw.cursor }), errorCode: null });
    }, { status: 'loading', errorCode: null }, code => ({ status: 'failed', errorCode: code })),
  });
}
/** Conversation page and explicit mutations. Entries are replaced rather than accumulated without a bound. */
export function createHeadlessThreadStore(options: HeadlessThreadStoreOptions): HeadlessThreadStore {
  if (!options || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(options.threadId)
    || ['thread', 'threadEntries', 'updateThread', 'archiveThread', 'restoreThread', 'deleteThread', 'submit'].some(key => typeof options.client?.[key as keyof typeof options.client] !== 'function')) throw new ClientError('INVALID_VIEW_CONFIG');
  const maxEntries = limit(options.maxEntries, 100, 500); const id = options.threadId; const client = options.client;
  const store = owned<HeadlessThreadState>({ revision: 0, status: 'idle', thread: null, entries: Object.freeze([]), errorCode: null }, options.maxSubscribers);
  const perform = <T>(settings: SignalOptions | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> =>
    store.perform(settings?.signal, work, { status: 'loading', errorCode: null }, code => ({ status: 'failed', errorCode: code }));
  const mutation = (work: (signal: AbortSignal) => Promise<RemoteThread>, settings?: SignalOptions): Promise<RemoteThread> => perform(settings, async signal => {
    const thread = readThread(await work(signal), id); if (signal.aborted) throw new ClientError('ABORTED');
    store.publish({ thread, status: 'ready', errorCode: null }); return thread;
  });
  return Object.freeze({ getSnapshot: store.getSnapshot, subscribe: store.subscribe, dispose: store.dispose,
    refresh: (settings?: ThreadEntriesOptions) => perform(settings, async signal => {
      if (settings?.limit !== undefined && settings.limit > maxEntries) throw new ClientError('INVALID_CURSOR');
      const thread = readThread(await client.thread(id, { signal }), id);
      const page = await client.threadEntries(id, { ...settings, limit: settings?.limit ?? maxEntries, signal });
      if (!Array.isArray(page) || page.length > maxEntries) throw new ClientError('INVALID_VIEW_INPUT');
      if (signal.aborted) throw new ClientError('ABORTED');
      const entries = Object.freeze(page.map(readThreadEntry)); let prior = settings?.after ?? 0;
      for (const item of entries) { if (item.sequence <= prior || (settings?.before !== undefined && item.sequence >= settings.before)) throw new ClientError('INVALID_VIEW_INPUT'); prior = item.sequence; }
      return store.publish({ thread, entries, status: 'ready', errorCode: null });
    }),
    append: (input: ThreadAppendInput, settings?: SignalOptions) => perform(settings, async signal => {
      if (typeof client.appendThread !== 'function') throw new ClientError('INVALID_VIEW_CONFIG');
      const entries = await client.appendThread(id, input, { signal });
      if (signal.aborted) throw new ClientError('ABORTED');
      // Do not silently replace or concatenate a paginated snapshot; the caller explicitly refreshes its chosen page.
      store.publish({ status: 'ready', errorCode: null }); return entries;
    }),
    update: (changes: ThreadUpdateInput, settings?: SignalOptions) => mutation(signal => client.updateThread(id, changes, { signal }), settings),
    archive: (settings?: SignalOptions) => mutation(signal => client.archiveThread(id, { signal }), settings),
    restore: (settings?: SignalOptions) => mutation(signal => client.restoreThread(id, { signal }), settings),
    delete: (settings?: SignalOptions) => perform(settings, async signal => {
      const result = await client.deleteThread(id, { signal }); if (signal.aborted) throw new ClientError('ABORTED');
      if (!Number.isSafeInteger(result?.removed) || result.removed < 0) throw new ClientError('INVALID_VIEW_INPUT');
      store.publish({ status: 'deleted', thread: null, entries: Object.freeze([]), errorCode: null }); return Object.freeze({ removed: result.removed });
    }),
    submit: (agentId: string, input: unknown, settings: { readonly idempotencyKey: string; readonly signal?: AbortSignal }) => perform(settings, async signal => {
      const run = await client.submit(agentId, input, { idempotencyKey: settings.idempotencyKey, threadId: id, signal });
      if (signal.aborted) throw new ClientError('ABORTED'); store.publish({ status: 'ready', errorCode: null }); return run;
    }),
  });
}
/** Digest-bound approval feedback. Success/conflict closes the controller; no decision is retried automatically. */
export function createRunApprovalController(options: RunApprovalControllerOptions): RunApprovalController {
  if (!options || typeof options.run?.approve !== 'function') throw new ClientError('INVALID_VIEW_CONFIG');
  let approval: RemoteApproval; try { approval = readApproval(options.approval); } catch { throw new ClientError('INVALID_VIEW_CONFIG'); }
  const store = owned<RunApprovalCommandState>({ revision: 0, status: 'idle', approval, errorCode: null }, options.maxSubscribers);
  return Object.freeze({ getSnapshot: store.getSnapshot, subscribe: store.subscribe, dispose: store.dispose,
    submit: async (decision: 'approved' | 'rejected', settings?: { readonly reason?: string; readonly signal?: AbortSignal }) => {
      if (['succeeded', 'conflict'].includes(store.getSnapshot().status)) throw new ClientError('APPROVAL_CONFLICT');
      const command = approvalCommand({ callId: approval.callId, digest: approval.digest, decision, ...(settings?.reason === undefined ? {} : { reason: settings.reason }) });
      await store.perform(settings?.signal, async signal => {
        if (approval.expiresAtMs <= Date.now()) throw new ClientError('APPROVAL_CONFLICT');
        await options.run.approve(command as unknown as RunApprovalCommand, { signal });
        if (signal.aborted) throw new ClientError('ABORTED'); store.publish({ status: 'succeeded', errorCode: null });
      }, { status: 'submitting', errorCode: null }, code => ({ status: code === 'APPROVAL_CONFLICT' ? 'conflict' : 'failed', errorCode: code }));
    },
  });
}
