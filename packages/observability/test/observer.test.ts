import { describe, expect, it, vi } from 'vitest';
import { MayuraError, type RunEvent, type RunHandle } from '@mayura/core';
import { createObserver, type ObserverOptions } from '../src/index.js';

const timestamp = '2026-09-20T00:00:00.000Z';
function event(sequence: number, type: RunEvent['type'], metadata: RunEvent['metadata'], runId = 'run-1'): RunEvent {
  return { runId, sequence, type, timestamp, metadata };
}
function start(runId = 'run-1'): RunEvent { return event(1, 'run.started', { profile: 'ephemeral' }, runId); }
function complete(sequence = 2, runId = 'run-1'): RunEvent {
  return event(sequence, 'run.completed', { status: 'succeeded', spentMicros: 5, reservedMicros: 0, calls: 1 }, runId);
}
function handle(values: readonly unknown[], runId = 'run-1', callback?: (options: Parameters<RunHandle<unknown>['observe']>[0]) => void): RunHandle<unknown> {
  return {
    id: runId, profile: 'ephemeral',
    get result(): RunHandle<unknown>['result'] { throw new Error('SECRET: result must not be read'); },
    get cancel(): RunHandle<unknown>['cancel'] { throw new Error('SECRET: cancel must not be read'); },
    async *observe(options) { callback?.(options); for (const value of values) yield value as RunEvent; },
  };
}
function pending(runId = 'run-1', cleanup = vi.fn(() => new Promise<IteratorResult<RunEvent>>(() => {}))): RunHandle<unknown> {
  return {
    id: runId, profile: 'ephemeral',
    observe: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<RunEvent>>(() => {}), return: cleanup }) }),
    get result(): RunHandle<unknown>['result'] { throw new Error('SECRET: result'); },
    get cancel(): RunHandle<unknown>['cancel'] { throw new Error('SECRET: cancel'); },
  };
}
const settle = async (): Promise<void> => { for (let index = 0; index < 20; index++) await Promise.resolve(); };

describe('native metadata observer', () => {
  it('collects only explicit handles, never reads execution controls, and distinguishes reported cost', async () => {
    const observer = createObserver();
    expect(observer.inspect()).toMatchObject({ runs: [], sink: { state: 'absent' }, metrics: { subscriptionsStarted: 0 } });
    const observation = observer.observe(handle([
      start(), event(2, 'model.started', { step: 0, modelCall: 1 }),
      event(3, 'model.completed', { step: 0, response: 'tool_calls' }),
      event(4, 'tool.started', { callId: 'call-1', toolId: 'lookup' }),
      event(5, 'tool.completed', { callId: 'call-1', toolId: 'lookup', status: 'succeeded', execution: 'succeeded', disclosure: 'released' }),
      complete(6),
    ]));
    expect(observation.runId).toBe('run-1');
    expect(await observation.done()).toEqual({ runId: 'run-1', reason: 'terminal' });
    expect(observer.inspect('run-1')).toMatchObject({
      cursor: 6, status: 'succeeded', terminal: true, active: false, coverage: 'complete',
      cost: { spentMicros: 5, reservedMicros: 0, calls: 1, atSequence: 6 },
      counters: { events: 6, modelStarted: 1, modelCompleted: 1, toolStarted: 1, toolCompleted: 1, missing: 0, unknownToolOutcomes: 0 },
    });
    await observer.close();
  });

  it('never infers success or zero cost from source end', async () => {
    const observer = createObserver();
    expect((await observer.observe(handle([start()])).done()).reason).toBe('source_ended');
    expect(observer.inspect('run-1')).toMatchObject({ status: 'running', terminal: false, coverage: 'partial', lastObservation: 'source_ended' });
    expect(observer.inspect('run-1')?.cost).toBeUndefined();
    expect((await observer.observe(handle([], 'empty')).done()).reason).toBe('source_ended');
    expect(observer.inspect('empty')).toMatchObject({ status: 'unknown', coverage: 'unknown', cursor: 0 });
    await observer.close();
  });

  it('reconnects at the last cursor and does not count or export replayed events twice', async () => {
    const sink = vi.fn(); const observer = createObserver({ sink }); const cursors: (number | undefined)[] = [];
    await observer.observe(handle([start()], 'run-1', options => cursors.push(options?.after))).done();
    await observer.observe(handle([start(), complete()], 'run-1', options => cursors.push(options?.after))).done();
    await vi.waitFor(() => expect(observer.inspect().metrics.sinkDelivered).toBe(2));
    expect(cursors).toEqual([0, 1]);
    expect(observer.inspect('run-1')?.counters).toMatchObject({ events: 2, duplicates: 1 });
    expect(sink.mock.calls.flatMap(call => call[0] as RunEvent[])).toHaveLength(2);
    await observer.close();
  });

  it('permits an explicit replay cursor without changing the stored accepted cursor', async () => {
    const observer = createObserver(); let after: number | undefined;
    await observer.observe(handle([start()])).done();
    await observer.observe(handle([start(), complete()], 'run-1', options => { after = options?.after; }), { after: 0 }).done();
    expect(after).toBe(0); expect(observer.inspect('run-1')?.cursor).toBe(2);
    await observer.close();
  });

  it('retains explicit and discontinuity gap evidence, clipping overlap on reconnect', async () => {
    const observer = createObserver();
    await observer.observe(handle([start(), event(5, 'events.gap', { from: 3, to: 5 })])).done();
    await observer.observe(handle([event(7, 'events.gap', { from: 4, to: 7 }), complete(9)])).done();
    expect(observer.inspect('run-1')).toMatchObject({ coverage: 'partial', counters: { events: 4, missing: 7, sourceGaps: 2, implicitGaps: 2 }, gaps: [
      { from: 2, to: 2, kind: 'discontinuity' }, { from: 3, to: 5, kind: 'source' },
      { from: 6, to: 7, kind: 'source' }, { from: 8, to: 8, kind: 'discontinuity' },
    ] });
    await observer.close();
  });

  it('counts aggregate gaps exactly beyond the safe integer range', async () => {
    const observer = createObserver(); const end = Number.MAX_SAFE_INTEGER;
    for (const id of ['run-1', 'run-2']) await observer.observe(handle([event(end, 'events.gap', { from: 1, to: end }, id)], id)).done();
    expect(observer.inspect().metrics.missing).toBe((2n * BigInt(end)).toString());
    expect(observer.inspect('run-1')?.counters.missing).toBe(end);
    await observer.close();
  });

  it('preserves unknown outcomes, absent receipts, retained reservations and exact reported overruns', async () => {
    const observer = createObserver();
    await observer.observe(handle([
      start(), event(2, 'tool.completed', { callId: 'a', toolId: 'write', status: 'outcome_unknown', execution: 'unknown', disclosure: 'withheld' }),
      event(3, 'tool.completed', { callId: 'b', toolId: 'read', status: 'cancelled' }),
      event(4, 'run.completed', { status: 'outcome_unknown', spentMicros: '9007199254740993', reservedMicros: 7, calls: 2 }),
    ])).done();
    expect(observer.inspect('run-1')).toMatchObject({ status: 'outcome_unknown', counters: { unknownToolOutcomes: 1, unreportedToolReceipts: 1 },
      cost: { spentMicros: '9007199254740993', reservedMicros: 7, calls: 2 } });
    await observer.close();
  });

  it('retains tree correlation without summing overlapping budget snapshots', async () => {
    const observer = createObserver();
    await observer.observe(handle([event(1, 'run.started', { profile: 'ephemeral', rootId: 'root', agentId: 'parent-agent' }, 'root'), complete(2, 'root')], 'root')).done();
    await observer.observe(handle([event(1, 'run.started', { profile: 'ephemeral', rootId: 'root', parentId: 'root', agentId: 'child-agent' }, 'child'), complete(2, 'child')], 'child')).done();
    expect(observer.inspect('child')).toMatchObject({ rootId: 'root', parentId: 'root', agentId: 'child-agent', cost: { spentMicros: 5 } });
    expect(observer.inspect('root')).toMatchObject({ rootId: 'root', agentId: 'parent-agent', cost: { spentMicros: 5 } });
    expect(observer.inspect().metrics).not.toHaveProperty('spentMicros');
    await observer.close();
  });

  it('bounds retained history while preserving counters and immutable snapshots', async () => {
    const raw = { ...start(), metadata: { profile: 'ephemeral' } }; const observer = createObserver({ maxRecentEventsPerRun: 2 });
    await observer.observe(handle([raw])).done(); const before = observer.inspect('run-1');
    raw.metadata.profile = 'SECRET';
    expect(before?.recent[0]?.metadata['profile']).toBe('ephemeral');
    await observer.observe(handle([event(2, 'model.started', { step: 0, modelCall: 1 }), complete(3)])).done();
    const after = observer.inspect('run-1');
    expect(after?.recent).toHaveLength(2); expect(after?.counters).toMatchObject({ events: 3, recentEvicted: 1 });
    expect(before?.cursor).toBe(1); expect(after?.coverage).toBe('complete');
    expect(Object.isFrozen(after)).toBe(true); expect(Object.isFrozen(after?.recent)).toBe(true);
    expect(Object.isFrozen(after?.recent[0]?.metadata)).toBe(true); expect(Object.isFrozen(after?.counters)).toBe(true);
    expect(() => Object.assign(after?.recent[0]?.metadata ?? {}, { secret: 'secret' })).toThrow();
    await observer.close();
  });

  it('caps lifetime runs before touching a new source and rejects duplicate active subscriptions', async () => {
    const observer = createObserver({ maxRuns: 1 }); const first = observer.observe(pending()); const subscribe = vi.fn();
    expect(() => observer.observe(handle([], 'run-1'))).toThrow(MayuraError);
    expect(() => observer.observe(handle([], 'other', subscribe))).toThrow(MayuraError);
    expect(subscribe).not.toHaveBeenCalled();
    first.disconnect(); await first.done();
    expect(() => observer.observe(handle([], 'other', subscribe))).toThrow(MayuraError);
    await observer.close();
  });

  it.each([
    { ...start(), message: 'SECRET' }, { ...start(), runId: 'other' }, { ...start(), sequence: 0 }, { ...start(), sequence: 1.5 },
    { ...start(), timestamp: '2026-09-20' }, { ...start(), timestamp: 'invalid' }, { ...start(), type: 'custom' },
    { ...start(), metadata: { profile: 'ephemeral', input: 'SECRET' } }, { ...start(), metadata: { profile: 'ephemeral', rootId: 'other' } },
    { ...start(), metadata: { profile: 'ephemeral', parentId: 'run-1', rootId: 'root' } },
    event(1, 'model.started', { step: -1, modelCall: 1 }), event(1, 'model.started', { step: 0, modelCall: 0 }),
    event(1, 'tool.started', { callId: 'a', toolId: 'SECRET\nprivate' }),
    event(1, 'tool.completed', { callId: 'a', toolId: 'b', status: 'succeeded', execution: 'succeeded' }),
    event(1, 'tool.completed', { callId: 'a', toolId: 'b', status: 'failed', execution: 'succeeded', disclosure: 'released' }),
    event(1, 'tool.completed', { callId: 'a', toolId: 'b', status: 'succeeded', execution: 'unknown', disclosure: 'withheld' }),
    event(1, 'run.completed', { status: 'success', spentMicros: 0, reservedMicros: 0, calls: 0 }),
    event(1, 'run.completed', { status: 'succeeded', spentMicros: '1', reservedMicros: 0, calls: 0 }),
    event(1, 'run.completed', { status: 'succeeded', spentMicros: Number.MAX_VALUE, reservedMicros: 0, calls: 0 }),
    event(1, 'events.gap', { from: 2, to: 1 }), event(1, 'events.gap', { from: 1, to: 2 }),
    { ...start(), metadata: { profile: 'ephemeral', code: 'SECRET'.repeat(1_000) } },
  ])('rejects malformed metadata without retaining or delivering it (%#)', async raw => {
    const sink = vi.fn(); const observer = createObserver({ sink });
    expect(await observer.observe(handle([raw])).done()).toEqual({ runId: 'run-1', reason: 'invalid_event' });
    const result = observer.inspect();
    expect(result.metrics).toMatchObject({ events: 0, rejected: 1 }); expect(result.runs[0]?.recent).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('SECRET'); expect(sink).not.toHaveBeenCalled(); await observer.close();
  });

  it('does not invoke getters in untrusted event objects', async () => {
    const getter = vi.fn(() => { throw new MayuraError('INVALID_INPUT', 'SECRET'); });
    const raw = Object.defineProperty({ ...start() }, 'metadata', { enumerable: true, get: getter });
    const observer = createObserver(); expect((await observer.observe(handle([raw])).done()).reason).toBe('invalid_event');
    expect(getter).not.toHaveBeenCalled(); expect(JSON.stringify(observer.inspect())).not.toContain('SECRET'); await observer.close();
  });

  it('validates even duplicated raw events and rejects conflicting fresh start events', async () => {
    const observer = createObserver(); await observer.observe(handle([start()])).done();
    expect((await observer.observe(handle([{ ...start(), secret: 'SECRET' }])).done()).reason).toBe('invalid_event');
    expect((await observer.observe(handle([event(2, 'run.started', { profile: 'ephemeral' })])).done()).reason).toBe('invalid_event');
    expect(observer.inspect('run-1')?.counters).toMatchObject({ events: 1, rejected: 2, duplicates: 0 }); await observer.close();
  });

  it('redacts thrown source and iterator errors', async () => {
    const observer = createObserver();
    const source = handle([]); source.observe = () => { throw new MayuraError('INVALID_INPUT', 'SECRET provider token'); };
    expect((await observer.observe(source).done()).reason).toBe('source_failed');
    const second = handle([], 'second'); second.observe = () => ({ [Symbol.asyncIterator]() { throw new Error('SECRET iterator'); } });
    expect((await observer.observe(second).done()).reason).toBe('source_failed');
    expect(observer.inspect().metrics.sourceFailures).toBe(2); expect(JSON.stringify(observer.inspect())).not.toContain('SECRET'); await observer.close();
  });

  it('disconnects a pending read without calling result/cancel or awaiting uncooperative cleanup', async () => {
    const cleanup = vi.fn(() => new Promise<IteratorResult<RunEvent>>(() => {})); const observer = createObserver();
    const observation = observer.observe(pending('run-1', cleanup)); await settle(); observation.disconnect();
    expect(await observation.done()).toEqual({ runId: 'run-1', reason: 'disconnected' });
    expect(cleanup).toHaveBeenCalledOnce(); expect(observer.inspect('run-1')).toMatchObject({ active: false, status: 'unknown' }); await observer.close();
  });

  it('honors pre-aborted and active cancellation signals without subscribing early', async () => {
    const observer = createObserver(); const signal = new AbortController(); signal.abort(); const subscribe = vi.fn();
    expect((await observer.observe(handle([], 'early', subscribe), { signal: signal.signal }).done()).reason).toBe('disconnected');
    expect(subscribe).not.toHaveBeenCalled();
    const active = new AbortController(); const observation = observer.observe(pending(), { signal: active.signal }); await settle(); active.abort();
    expect((await observation.done()).reason).toBe('disconnected'); await observer.close();
  });

  it('times out pending reads and close is idempotent and bounded', async () => {
    vi.useFakeTimers();
    try {
      const observer = createObserver({ maxObservationMs: 50 }); const observation = observer.observe(pending());
      await vi.advanceTimersByTimeAsync(50); expect((await observation.done()).reason).toBe('timeout');
      expect(observer.inspect('run-1')?.sourcePending).toBe(true);
      expect(() => observer.observe(pending())).toThrow(MayuraError);
      const next = observer.observe(pending('run-2')); await settle(); const closing = observer.close();
      expect(observer.close()).toBe(closing); expect((await next.done()).reason).toBe('observer_closed');
      expect((await closing).closed).toBe(true); expect(() => observer.observe(handle([]))).toThrow(MayuraError);
    } finally { vi.useRealTimers(); }
  });

  it('does not allow an immediately resolved endless source to starve deadlines or grow history', async () => {
    const observer = createObserver({ maxObservationMs: 15, maxRecentEventsPerRun: 3 }); const source = handle([]);
    source.observe = async function* () { let sequence = 1; for (;;) yield event(sequence++, 'model.started', { step: 0, modelCall: 1 }); };
    expect((await observer.observe(source).done()).reason).toBe('timeout');
    expect(observer.inspect('run-1')?.recent).toHaveLength(3); await observer.close();
  });

  it('bounds sink pressure independently of native summaries and disables a timed-out sink', async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined; const sink = vi.fn((_batch: readonly RunEvent[], context: { signal: AbortSignal }) => {
        signal = context.signal; return new Promise<void>(() => {});
      });
      const observer = createObserver({ sink, maxSinkQueue: 2, sinkBatchSize: 1, sinkTimeoutMs: 25 });
      const values = [start(), ...Array.from({ length: 9 }, (_, index) => event(index + 2, 'model.started', { step: index, modelCall: index + 1 })), complete(11)];
      await observer.observe(handle(values)).done();
      expect(observer.inspect('run-1')?.counters.events).toBe(11);
      expect(observer.inspect().sink).toMatchObject({ pending: 2, inFlight: true });
      expect(observer.inspect().metrics.sinkDropped).toBe(8);
      await vi.advanceTimersByTimeAsync(25);
      expect(observer.inspect().metrics).toMatchObject({ sinkTimeouts: 1, sinkDelivered: 0, sinkDropped: 11 });
      expect(observer.inspect().sink).toMatchObject({ state: 'disabled', pending: 0, inFlight: false }); expect(signal?.aborted).toBe(true);
      await observer.observe(handle([start('new'), complete(2, 'new')], 'new')).done();
      expect(sink).toHaveBeenCalledOnce(); expect(observer.inspect().metrics.sinkDropped).toBe(13); await observer.close();
    } finally { vi.useRealTimers(); }
  });

  it('isolates rejected sinks, releases immutable batches, and continues without retry', async () => {
    const delivered: (readonly RunEvent[])[] = []; let calls = 0;
    const sink = vi.fn((batch: readonly RunEvent[]) => {
      calls++; expect(Object.isFrozen(batch)).toBe(true); expect(Object.isFrozen(batch[0]?.metadata)).toBe(true);
      if (calls === 1) throw new MayuraError('INVALID_CONFIG', 'SECRET sink token');
      delivered.push(batch);
    });
    const observer = createObserver({ sink, sinkBatchSize: 1 }); await observer.observe(handle([start(), complete()])).done();
    await vi.waitFor(() => expect(observer.inspect().metrics.sinkDelivered).toBe(1));
    expect(observer.inspect().metrics).toMatchObject({ sinkFailures: 1, sinkDropped: 1, events: 2 }); expect(calls).toBe(2);
    expect(delivered[0]?.[0]?.type).toBe('run.completed'); expect(JSON.stringify(observer.inspect())).not.toContain('SECRET'); await observer.close();
  });

  it('does not count late sink success after close as delivered', async () => {
    let release: (() => void) | undefined; const observer = createObserver({ sink: () => new Promise<void>(resolve => { release = resolve; }) });
    await observer.observe(handle([start()])).done(); await settle(); await observer.close();
    expect(observer.inspect().metrics).toMatchObject({ sinkDelivered: 0, sinkDropped: 1 });
    release?.(); await settle(); expect(observer.inspect().metrics).toMatchObject({ sinkDelivered: 0, sinkDropped: 1 });
  });

  it('snapshots configuration and redacts unsafe configuration and handle accessors', async () => {
    const options = { maxRuns: 1 }; const observer = createObserver(options); options.maxRuns = 4;
    await observer.observe(handle([])).done(); expect(() => observer.observe(handle([], 'second'))).toThrow(MayuraError); await observer.close();
    expect(() => createObserver({ get sink(): NonNullable<ObserverOptions['sink']> { throw new Error('SECRET'); } })).toThrow('Observer configuration must contain supported finite bounds');
    const other = createObserver(); const raw = { get id() { throw new MayuraError('INVALID_INPUT', 'SECRET'); } } as unknown as RunHandle<unknown>;
    expect(() => other.observe(raw)).toThrow('Observation requires a valid handle'); await other.close();
  });

  it.each<ObserverOptions>([
    { maxRuns: 0 }, { maxRuns: 1_025 }, { maxRecentEventsPerRun: Infinity }, { maxRecentEventsPerRun: 1_025 },
    { maxObservationMs: 2_147_483_648 }, { maxSinkQueue: 16_385 }, { maxSinkQueue: 1, sinkBatchSize: 2 },
    { sinkBatchSize: 257 }, { sinkTimeoutMs: -1 }, { sinkTimeoutMs: 1.5 },
  ])('requires finite bounded configuration (%#)', options => { expect(() => createObserver(options)).toThrow(MayuraError); });
});
