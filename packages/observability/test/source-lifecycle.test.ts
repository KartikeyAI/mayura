import { afterEach, describe, expect, it, vi } from 'vitest';
import { MayuraError, type RunEvent, type RunHandle } from '@mayura/core';
import { createObserver, type Observer, type ObserverOptions } from '../src/index.js';

const observers: Observer[] = [];
function observer(options: ObserverOptions = {}) { const result = createObserver(options); observers.push(result); return result; }
const settle = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}
const end: IteratorReturnResult<undefined> = { done: true, value: undefined };
function event(sequence = 1, runId = 'run'): RunEvent {
  return { runId, sequence, timestamp: '2026-09-20T00:00:00.000Z', type: 'run.completed',
    metadata: { status: 'succeeded', spentMicros: 0, reservedMicros: 0, calls: 0 } };
}
function source(iterator: AsyncIterator<RunEvent>, id = 'run') {
  const observe = vi.fn(() => ({ [Symbol.asyncIterator]: () => iterator }));
  const handle: RunHandle<unknown> = { id, profile: 'ephemeral', observe,
    get result(): RunHandle<unknown>['result'] { throw new Error('PRIVATE: execution result was accessed'); },
    get cancel(): RunHandle<unknown>['cancel'] { throw new Error('PRIVATE: execution cancellation was accessed'); },
  };
  return { handle, observe };
}
afterEach(async () => {
  await Promise.all(observers.splice(0).map(value => value.close())); vi.useRealTimers(); vi.restoreAllMocks();
});

describe('bounded observer source ownership', () => {
  it('quarantines timed-out read and cleanup callbacks against repeated same-run reconnects', async () => {
    vi.useFakeTimers();
    const next = vi.fn(() => new Promise<IteratorResult<RunEvent>>(() => {}));
    const cleanup = vi.fn(() => new Promise<IteratorResult<RunEvent>>(() => {}));
    const fixture = source({ next, return: cleanup }); const value = observer({ maxRuns: 1, maxObservationMs: 25 });
    const subscription = value.observe(fixture.handle); await vi.advanceTimersByTimeAsync(25);
    expect(await subscription.done()).toEqual({ runId: 'run', reason: 'timeout' });
    expect(value.inspect('run')).toMatchObject({ active: false, sourcePending: true, status: 'unknown' });
    const replacement = source({ next: async () => end });
    for (let index = 0; index < 100; index++) expect(() => value.observe(replacement.handle)).toThrow(MayuraError);
    expect(replacement.observe).not.toHaveBeenCalled(); expect(fixture.observe).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce(); expect(cleanup).toHaveBeenCalledOnce();
    expect(value.inspect().metrics.subscriptionsStarted).toBe(1);
    const closed = await value.close(); expect(closed.closed).toBe(true); expect(closed.runs[0]?.sourcePending).toBe(true);
  });

  it('retains a disconnected read without a return callback and discards its late candidate before inspecting it', async () => {
    const read = deferred<IteratorResult<RunEvent>>(); const sink = vi.fn(); const value = observer({ sink });
    const fixture = source({ next: () => read.promise }); const subscription = value.observe(fixture.handle); await settle(); subscription.disconnect();
    expect((await subscription.done()).reason).toBe('disconnected'); const before = value.inspect('run');
    expect(before).toMatchObject({ active: false, sourcePending: true, counters: { events: 0 } });
    expect(() => value.observe(source({ next: async () => end }).handle)).toThrow(MayuraError);
    const getter = vi.fn(() => { throw new Error('PRIVATE late candidate'); });
    read.resolve(Object.defineProperty({ value: event() }, 'done', { get: getter }) as IteratorResult<RunEvent>);
    await settle(); expect(getter).not.toHaveBeenCalled(); expect(sink).not.toHaveBeenCalled();
    expect(value.inspect('run')).toMatchObject({ active: false, sourcePending: false, status: 'unknown', counters: { events: 0 } });
    expect(before?.sourcePending).toBe(true); expect((await subscription.done()).reason).toBe('disconnected');
    expect((await value.observe(source({ next: async () => end }).handle).done()).reason).toBe('source_ended');
    expect(JSON.stringify(value.inspect())).not.toContain('PRIVATE');
  });

  it('keeps a terminal observation quarantined until its cleanup settles, including a late rejection', async () => {
    const cleanup = deferred<IteratorResult<RunEvent>>(); const value = observer();
    const fixture = source({ next: async () => ({ done: false, value: event() }), return: () => cleanup.promise });
    const subscription = value.observe(fixture.handle); const result = await subscription.done();
    expect(result).toEqual({ runId: 'run', reason: 'terminal' });
    expect(value.inspect('run')).toMatchObject({ terminal: true, status: 'succeeded', active: false, sourcePending: true });
    expect(() => value.observe(source({ next: async () => end }).handle)).toThrow(MayuraError);
    cleanup.reject(new MayuraError('INVALID_INPUT', 'PRIVATE cleanup failure')); await settle();
    expect(value.inspect('run')).toMatchObject({ sourcePending: false, status: 'succeeded', lastObservation: 'terminal' });
    expect(await subscription.done()).toBe(result); expect(JSON.stringify(value.inspect())).not.toContain('PRIVATE');
    expect((await value.observe(source({ next: async () => end }).handle).done()).reason).toBe('source_ended');
  });

  it.each(['read', 'cleanup'] as const)('waits for both actual callback settlements when %s settles first', async first => {
    const read = deferred<IteratorResult<RunEvent>>(); const cleanup = deferred<IteratorResult<RunEvent>>(); const value = observer();
    const subscription = value.observe(source({ next: () => read.promise, return: () => cleanup.promise }).handle);
    await settle(); subscription.disconnect(); await subscription.done();
    (first === 'read' ? read : cleanup).resolve(end); await settle();
    expect(value.inspect('run')?.sourcePending).toBe(true);
    expect(() => value.observe(source({ next: async () => end }).handle)).toThrow(MayuraError);
    (first === 'read' ? cleanup : read).resolve(end); await settle();
    expect(value.inspect('run')?.sourcePending).toBe(false);
    expect((await value.observe(source({ next: async () => end }).handle).done()).reason).toBe('source_ended');
  });

  it('does not invoke redundant cleanup after natural exhaustion and permits immediate reconnect', async () => {
    const cleanup = vi.fn(() => new Promise<IteratorResult<RunEvent>>(() => {}));
    const fixture = source({ next: async () => end, return: cleanup }); const value = observer();
    expect((await value.observe(fixture.handle).done()).reason).toBe('source_ended');
    expect(value.inspect('run')).toMatchObject({ active: false, sourcePending: false }); expect(cleanup).not.toHaveBeenCalled();
    expect((await value.observe(fixture.handle).done()).reason).toBe('source_ended'); expect(fixture.observe).toHaveBeenCalledTimes(2);
  });

  it('releases ownership after synchronous read and cleanup exceptions without leaking them', async () => {
    const value = observer(); const cleanup = vi.fn(() => { throw new Error('PRIVATE cleanup'); });
    const fixture = source({ next: () => { throw new MayuraError('INVALID_INPUT', 'PRIVATE read'); }, return: cleanup });
    expect((await value.observe(fixture.handle).done()).reason).toBe('source_failed');
    expect(cleanup).toHaveBeenCalledOnce(); expect(value.inspect('run')).toMatchObject({ sourcePending: false, status: 'unknown' });
    expect(JSON.stringify(value.inspect())).not.toContain('PRIVATE');
    expect((await value.observe(source({ next: async () => end }).handle).done()).reason).toBe('source_ended');
  });

  it('keeps close and completed snapshots bounded while pending callback state can settle later', async () => {
    const value = observer({ maxRuns: 3 }); const callbacks: ReturnType<typeof deferred<IteratorResult<RunEvent>>>[] = [];
    const subscriptions = Array.from({ length: 3 }, (_, index) => {
      const read = deferred<IteratorResult<RunEvent>>(); const cleanup = deferred<IteratorResult<RunEvent>>(); callbacks.push(read, cleanup);
      return value.observe(source({ next: () => read.promise, return: () => cleanup.promise }, `run-${index}`).handle);
    });
    await settle(); const closing = value.close(); expect(value.close()).toBe(closing); const closed = await closing;
    expect(closed.runs.every(run => !run.active && run.sourcePending)).toBe(true);
    for (const subscription of subscriptions) expect((await subscription.done()).reason).toBe('observer_closed');
    for (const callback of callbacks) callback.resolve(end); await settle();
    expect(value.inspect().runs.every(run => !run.sourcePending)).toBe(true);
    expect(closed.runs.every(run => run.sourcePending)).toBe(true); expect(Object.isFrozen(closed.runs)).toBe(true);
    expect(() => value.observe(source({ next: async () => end }).handle)).toThrow(MayuraError);
  });

  it('never dispatches or quarantines source callbacks for a pre-aborted observation', async () => {
    const controller = new AbortController(); controller.abort(); const value = observer();
    const fixture = source({ next: async () => end });
    expect((await value.observe(fixture.handle, { signal: controller.signal }).done()).reason).toBe('disconnected');
    expect(fixture.observe).not.toHaveBeenCalled(); expect(value.inspect('run')?.sourcePending).toBe(false);
    expect((await value.observe(fixture.handle).done()).reason).toBe('source_ended');
  });

  it('quarantines cleanup after invalid metadata without retaining or exporting rejected content', async () => {
    const cleanup = deferred<IteratorResult<RunEvent>>(); const sink = vi.fn(); const value = observer({ sink });
    const invalid = { ...event(), secret: 'PRIVATE raw source' };
    const fixture = source({ next: async () => ({ done: false, value: invalid }), return: () => cleanup.promise });
    expect((await value.observe(fixture.handle).done()).reason).toBe('invalid_event');
    expect(value.inspect('run')).toMatchObject({ sourcePending: true, counters: { rejected: 1, events: 0 }, recent: [] });
    expect(sink).not.toHaveBeenCalled(); expect(JSON.stringify(value.inspect())).not.toContain('PRIVATE');
    expect(() => value.observe(source({ next: async () => end }).handle)).toThrow(MayuraError);
    cleanup.resolve(end); await settle(); expect(value.inspect('run')?.sourcePending).toBe(false);
  });

  it('establishes cleanup ownership before invoking a reentrant application callback', async () => {
    const value = observer(); const replacement = source({ next: async () => end });
    const cleanup = vi.fn(async () => {
      expect(value.inspect('run')).toMatchObject({ active: false, sourcePending: true });
      expect(() => value.observe(replacement.handle)).toThrow(MayuraError); return end;
    });
    const fixture = source({ next: async () => ({ done: false, value: event() }), return: cleanup });
    expect((await value.observe(fixture.handle).done()).reason).toBe('terminal');
    await settle(); expect(cleanup).toHaveBeenCalledOnce(); expect(replacement.observe).not.toHaveBeenCalled();
    expect(value.inspect().metrics.subscriptionsStarted).toBe(1); expect(value.inspect('run')?.sourcePending).toBe(false);
  });
});
