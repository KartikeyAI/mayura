import { Worker } from 'node:worker_threads';
import { StorageError, type CreateRecord, type UpdateRecord, type StoredRecord, type StoredEvent, type StorageErrorCode } from './contracts.js';
import { createCommand, updateCommand, identifier, cursor } from './validation.js';
import { schedulerFacade } from './scheduler-validation.js';
import type { SchedulerAggregateStore } from './scheduler-contracts.js';

export interface SqliteStoreOptions { readonly filename: string }
interface Pending { resolve(value: unknown): void; reject(error: Error): void }
interface Response { id: number; result?: unknown; error?: { code: StorageErrorCode; message: string } }

/** Creates an optional SQLite adapter with one database-owning worker and a bounded IPC queue. */
export function createSqliteStore(options: SqliteStoreOptions): SchedulerAggregateStore {
  if (typeof options.filename !== 'string' || options.filename.length === 0 || options.filename.includes('\0')) {
    throw new StorageError('INVALID_INPUT', 'SQLite filename must be nonempty and contain no null characters.');
  }
  const worker = new Worker(new URL('./sqlite-worker.js', import.meta.url), { workerData: { filename: options.filename } });
  const pending = new Map<number, Pending>();
  let nextId = 0;
  let closed = false;
  let fatal = false;
  let closePromise: Promise<void> | undefined;

  const rejectAll = (): void => {
    fatal = true;
    for (const waiter of pending.values()) waiter.reject(new StorageError('STORAGE_UNAVAILABLE', 'SQLite storage worker stopped. Reopen storage and reconcile uncertain writes.'));
    pending.clear();
  };
  worker.on('message', (response: Response) => {
    const waiter = pending.get(response.id);
    if (!waiter) return;
    pending.delete(response.id);
    if (response.error) waiter.reject(new StorageError(response.error.code, response.error.message));
    else waiter.resolve(response.result);
  });
  worker.on('error', rejectAll);
  worker.on('exit', () => { if (!closed || pending.size > 0) rejectAll(); });

  const request = <T>(method: string, args: unknown[]): Promise<T> => {
    if (fatal) return Promise.reject(new StorageError('STORAGE_UNAVAILABLE', 'SQLite storage worker is unavailable.'));
    if (closed && method !== 'close') return Promise.reject(new StorageError('STORE_CLOSED', 'Storage has been closed.'));
    if (pending.size >= 256 && method !== 'close') return Promise.reject(new StorageError('QUEUE_FULL', 'Storage queue is full; retry with bounded backoff.'));
    const id = ++nextId;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: (value) => resolve(value as T), reject });
      try { worker.postMessage({ id, method, args }); }
      catch { pending.delete(id); reject(new StorageError('STORAGE_UNAVAILABLE', 'Could not send the storage request.')); }
    });
  };

  return {
    scheduler: schedulerFacade((method, input) => request('scheduler', [method, input])),
    initialize: () => request<void>('initialize', []),
    create: async (command: CreateRecord) => request<{ record: StoredRecord; created: boolean }>('create', [createCommand(command)]),
    read: async (scope, id) => request<StoredRecord | undefined>('read', [identifier(scope, 'Scope'), identifier(id, 'Record ID')]),
    update: async (command: UpdateRecord) => request<StoredRecord>('update', [updateCommand(command)]),
    events: async (scope, id, after = 0) => request<StoredEvent[]>('events', [identifier(scope, 'Scope'), identifier(id, 'Record ID'), cursor(after)]),
    close: () => {
      if (!closePromise) {
        closed = true;
        closePromise = request<void>('close', []).finally(async () => { await worker.terminate(); });
      }
      return closePromise;
    },
  };
}
