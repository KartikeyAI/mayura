import { MayuraError, type RunEvent } from '@mayura/core';

/** Bounded process-local replay buffer. Observers share retained events, not private unbounded queues. */
export class EventBuffer {
  private events: RunEvent[] = [];
  private sequence = 0;
  private terminal = false;
  private readonly waiters = new Set<() => void>();

  constructor(private readonly runId: string, private readonly capacity: number) {}

  emit(type: RunEvent['type'], metadata: RunEvent['metadata'] = {}): void {
    if (this.terminal) return;
    this.events.push(Object.freeze({ runId: this.runId, sequence: ++this.sequence, timestamp: new Date().toISOString(), type, metadata: Object.freeze({ ...metadata }) }));
    if (this.events.length > this.capacity) this.events.shift();
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  finish(): void {
    this.terminal = true;
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  async *observe(options: { readonly after?: number; readonly signal?: AbortSignal } = {}): AsyncIterable<RunEvent> {
    let cursor = options.after ?? 0;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.sequence) {
      throw new MayuraError('INVALID_INPUT', 'Event cursor must refer to this process-local run history.');
    }
    while (!options.signal?.aborted) {
      const oldest = this.events[0]?.sequence ?? this.sequence + 1;
      if (cursor < oldest - 1) {
        // Synthetic gap metadata is explicitly distinguished from retained execution evidence.
        const previous = cursor;
        cursor = oldest - 1;
        yield Object.freeze({ runId: this.runId, sequence: cursor, timestamp: new Date().toISOString(), type: 'events.gap', metadata: Object.freeze({ from: previous + 1, to: cursor }) });
        continue;
      }
      const next = this.events.find((event) => event.sequence > cursor);
      if (next) { cursor = next.sequence; yield next; continue; }
      if (this.terminal) return;
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          this.waiters.delete(wake);
          options.signal?.removeEventListener('abort', wake);
          resolve();
        };
        this.waiters.add(wake);
        options.signal?.addEventListener('abort', wake, { once: true });
        if (options.signal?.aborted) wake();
      });
    }
  }
}
