import { MayuraError } from '@mayura/core';

interface Account { readonly capacity: number; active: number }
interface Waiter { readonly path: readonly Account[]; start(): void; abort(): void }
interface Ledger { readonly maxQueue: number; readonly queue: Waiter[] }

/** Atomic ancestor admission: a queued child holds no partial parent capacity. */
export class OperationPermits {
  readonly #ledger: Ledger;
  readonly #path: readonly Account[];
  constructor(capacity: number, maxQueue: number, parent?: OperationPermits) {
    this.#ledger = parent ? parent.#ledger : { maxQueue, queue: [] };
    this.#path = [...(parent ? parent.#path : []), { capacity, active: 0 }];
  }
  fork(capacity: number): OperationPermits { return new OperationPermits(capacity, this.#ledger.maxQueue, this); }

  async acquire(signal: AbortSignal): Promise<() => void> {
    await this.#acquire(signal);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const account of this.#path) account.active--;
      // Serve eligible waiters in arrival order; a capped branch cannot starve an unrelated branch.
      for (let index = 0; index < this.#ledger.queue.length;) {
        const waiter = this.#ledger.queue[index]!;
        if (waiter.path.every(account => account.active < account.capacity)) {
          this.#ledger.queue.splice(index, 1); waiter.start();
        } else index++;
      }
    };
  }
  async run<T>(signal: AbortSignal, execute: () => Promise<T>): Promise<T> {
    const release = await this.acquire(signal);
    try { if (signal.aborted) throw signal.reason; return await execute(); }
    finally { release(); }
  }
  #acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.#path.every(account => account.active < account.capacity)) {
      for (const account of this.#path) account.active++;
      return Promise.resolve();
    }
    if (this.#ledger.queue.length >= this.#ledger.maxQueue) return Promise.reject(new MayuraError('LIMIT_EXCEEDED', 'The execution admission queue is full.'));
    return new Promise((resolve, reject) => {
      const entry: Waiter = {
        path: this.#path,
        start: (): void => {
          signal.removeEventListener('abort', entry.abort);
          for (const account of this.#path) account.active++;
          resolve();
        },
        abort: (): void => {
          const index = this.#ledger.queue.indexOf(entry);
          if (index >= 0) this.#ledger.queue.splice(index, 1);
          signal.removeEventListener('abort', entry.abort);
          reject(signal.reason);
        },
      };
      this.#ledger.queue.push(entry);
      signal.addEventListener('abort', entry.abort, { once: true });
      if (signal.aborted) entry.abort();
    });
  }
}
