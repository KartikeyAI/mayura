import { assertPositiveInteger, MayuraError, type RunEvent, type RunHandle } from '@mayura/core';
import type { ExactCount, Observation, ObservationReason, Observer, ObserverMetrics, ObserverOptions, ObserverSnapshot, ObserveOptions, ObservedCounters, ObservedGap, ObservedRun, ObservedStatus, ReportedCost } from './contracts.js';
import { eventSnapshot, integer, stableId } from './validation.js';

const counterNames = ['events', 'duplicates', 'rejected', 'missing', 'sourceGaps', 'implicitGaps', 'recentEvicted', 'modelStarted', 'modelCompleted', 'toolStarted', 'toolCompleted', 'unknownToolOutcomes', 'unreportedToolReceipts'] as const;
const metricNames = [...counterNames, 'subscriptionsStarted', 'sourceFailures', 'sinkDelivered', 'sinkDropped', 'sinkFailures', 'sinkTimeouts'] as const;
type Metric = typeof metricNames[number];
type Counters = Record<typeof counterNames[number], bigint>;
type Metrics = Record<Metric, bigint>;
interface Run {
  readonly runId: string;
  cursor: number;
  status: ObservedStatus;
  active: boolean;
  sourcePending: number;
  terminal: boolean;
  sawStart: boolean;
  tainted: boolean;
  lastObservation?: ObservationReason;
  rootId?: string;
  parentId?: string;
  agentId?: string;
  cost?: ReportedCost;
  readonly counters: Counters;
  readonly recent: RunEvent[];
  readonly gaps: ObservedGap[];
}
const stopped = Symbol('observer-stopped');
const defaults = Object.freeze({ maxRuns: 128, maxRecentEventsPerRun: 64, maxObservationMs: 60_000, maxSinkQueue: 256, sinkBatchSize: 16, sinkTimeoutMs: 5_000 });
function exact(value: bigint): ExactCount { return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString(); }
function counters(): Counters { return Object.fromEntries(counterNames.map(key => [key, 0n])) as Counters; }
function snapshotCounters<T extends Record<string, bigint>>(value: T): { readonly [K in keyof T]: ExactCount } {
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, amount]) => [key, exact(amount)]))) as { readonly [K in keyof T]: ExactCount };
}
/** Keep callback ownership until actual settlement, independently of observation cancellation. */
function sourceCall<T>(run: Run, action: () => T | PromiseLike<T>): Promise<T> {
  run.sourcePending++;
  let result: T | PromiseLike<T>;
  try { result = action(); }
  catch (error) { run.sourcePending--; return Promise.reject(error); }
  return Promise.resolve(result).then(value => { run.sourcePending--; return value; }, (error: unknown) => {
    run.sourcePending--; throw error;
  });
}
/** Bound awaited callbacks without ever passing cancellation authority to the observed run. */
async function interruptible<T>(action: () => T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw stopped;
  return await new Promise<T>((resolve, reject) => {
    const cleanup = (): void => { signal.removeEventListener('abort', abort); };
    const abort = (): void => { cleanup(); reject(stopped); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { if (signal.aborted) throw stopped; return action(); })
      .then(value => { cleanup(); resolve(value); }, (error: unknown) => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

/** Explicit metadata-only observation, bounded native memory and isolated optional delivery. */
export function createObserver(options: ObserverOptions = {}): Observer {
  let config: typeof defaults; let sink: ObserverOptions['sink'];
  try {
    config = Object.freeze(Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, options[key as keyof typeof defaults] ?? fallback]))) as typeof defaults;
    for (const [key, value] of Object.entries(config)) assertPositiveInteger(value, key);
    if (config.maxRuns > 1_024 || config.maxRecentEventsPerRun > 1_024 || config.maxSinkQueue > 16_384 || config.sinkBatchSize > 256
      || config.sinkBatchSize > config.maxSinkQueue || config.maxObservationMs > 2_147_483_647 || config.sinkTimeoutMs > 2_147_483_647) throw new Error();
    sink = options.sink; if (sink !== undefined && typeof sink !== 'function') throw new Error();
  } catch { throw new MayuraError('INVALID_CONFIG', 'Observer configuration must contain supported finite bounds and an optional callable sink.'); }
  const destination = sink;
  const runs = new Map<string, Run>();
  const active = new Map<string, { readonly observation: Observation; readonly stop: (reason: ObservationReason) => void }>();
  const metrics = Object.fromEntries(metricNames.map(key => [key, 0n])) as Metrics;
  const queue: RunEvent[] = [];
  let closed = false; let sinkDisabled = false; let inFlight = false; let draining = false;
  let deliveryController: AbortController | undefined; let delivery: Promise<void> | undefined; let closing: Promise<ObserverSnapshot> | undefined;
  const count = (key: Metric, run?: Run, amount = 1n): void => {
    metrics[key] += amount;
    if (run && Object.hasOwn(run.counters, key)) run.counters[key as keyof Counters] += amount;
  };
  const dropQueue = (): void => { count('sinkDropped', undefined, BigInt(queue.length)); queue.length = 0; };

  const drain = async (): Promise<void> => {
    try {
      while (queue.length > 0 && !closed && !sinkDisabled && destination) {
        const batch = Object.freeze(queue.splice(0, config.sinkBatchSize));
        const controller = new AbortController(); deliveryController = controller; inFlight = true;
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.sinkTimeoutMs);
        try {
          await interruptible(() => destination(batch, Object.freeze({ signal: controller.signal })), controller.signal);
          count('sinkDelivered', undefined, BigInt(batch.length));
        } catch {
          count('sinkDropped', undefined, BigInt(batch.length));
          if (timedOut) { count('sinkTimeouts'); sinkDisabled = true; }
          else if (!closed) count('sinkFailures');
        } finally { clearTimeout(timer); deliveryController = undefined; inFlight = false; }
        if (sinkDisabled) dropQueue();
      }
    } finally { draining = false; }
  };
  const enqueue = (event: RunEvent): void => {
    if (!destination) return;
    if (closed || sinkDisabled || queue.length >= config.maxSinkQueue) { count('sinkDropped'); return; }
    queue.push(event);
    if (!draining) {
      draining = true;
      delivery = Promise.resolve().then(drain).catch(() => { sinkDisabled = true; count('sinkFailures'); dropQueue(); draining = false; });
    }
  };

  const gap = (run: Run, from: number, to: number, kind: ObservedGap['kind']): void => {
    if (from > to) return;
    count('missing', run, BigInt(to) - BigInt(from) + 1n);
    count(kind === 'source' ? 'sourceGaps' : 'implicitGaps', run);
    run.gaps.push(Object.freeze({ from, to, kind }));
    if (run.gaps.length > config.maxRecentEventsPerRun) run.gaps.shift();
  };
  const admit = (run: Run, raw: unknown): void => {
    const event = eventSnapshot(raw, run.runId);
    if (event.sequence <= run.cursor) { count('duplicates', run); return; }
    if (run.terminal || (event.type === 'run.started' && run.sawStart)) throw new MayuraError('INVALID_INPUT', 'Metadata event conflicts with the observed lifecycle.');
    if (event.type === 'events.gap') {
      const from = event.metadata['from'] as number;
      gap(run, run.cursor + 1, from - 1, 'discontinuity');
      gap(run, Math.max(from, run.cursor + 1), event.sequence, 'source');
    } else if (event.sequence > run.cursor + 1) gap(run, run.cursor + 1, event.sequence - 1, 'discontinuity');
    run.cursor = event.sequence;
    count('events', run);
    switch (event.type) {
      case 'run.started':
        run.sawStart = true; run.status = 'running';
        if (typeof event.metadata['rootId'] === 'string') run.rootId = event.metadata['rootId'];
        if (typeof event.metadata['parentId'] === 'string') run.parentId = event.metadata['parentId'];
        if (typeof event.metadata['agentId'] === 'string') run.agentId = event.metadata['agentId'];
        break;
      case 'model.started': count('modelStarted', run); break;
      case 'model.completed': count('modelCompleted', run); break;
      case 'tool.started': count('toolStarted', run); break;
      case 'tool.completed':
        count('toolCompleted', run);
        if (event.metadata['execution'] === 'unknown' || event.metadata['status'] === 'outcome_unknown') count('unknownToolOutcomes', run);
        if (event.metadata['execution'] === undefined) count('unreportedToolReceipts', run);
        break;
      case 'run.completed':
        run.terminal = true; run.status = event.metadata['status'] as ObservedStatus;
        run.cost = Object.freeze({ spentMicros: event.metadata['spentMicros'] as ExactCount, reservedMicros: event.metadata['reservedMicros'] as number,
          calls: event.metadata['calls'] as number, atSequence: event.sequence,
        });
        break;
    }
    run.recent.push(event);
    if (run.recent.length > config.maxRecentEventsPerRun) { run.recent.shift(); count('recentEvicted', run); }
    enqueue(event);
  };
  const runSnapshot = (run: Run): ObservedRun => Object.freeze({
    runId: run.runId, cursor: run.cursor, status: run.status, active: run.active, sourcePending: run.sourcePending > 0, terminal: run.terminal,
    coverage: run.counters.events === 0n ? 'unknown' : run.terminal && run.sawStart && run.counters.missing === 0n && !run.tainted ? 'complete' : 'partial',
    ...(run.lastObservation ? { lastObservation: run.lastObservation } : {}), ...(run.rootId ? { rootId: run.rootId } : {}),
    ...(run.parentId ? { parentId: run.parentId } : {}), ...(run.agentId ? { agentId: run.agentId } : {}), ...(run.cost ? { cost: run.cost } : {}),
    counters: snapshotCounters(run.counters) as ObservedCounters, recent: Object.freeze([...run.recent]), gaps: Object.freeze([...run.gaps]),
  });
  function inspect(): ObserverSnapshot;
  function inspect(runId: string): ObservedRun | undefined;
  function inspect(runId?: string): ObserverSnapshot | ObservedRun | undefined {
    if (runId !== undefined) { const run = runs.get(stableId(runId)); return run ? runSnapshot(run) : undefined; }
    return Object.freeze({ closed, runs: Object.freeze([...runs.values()].map(runSnapshot)), metrics: snapshotCounters(metrics) as ObserverMetrics,
      sink: Object.freeze({ state: !destination ? 'absent' : closed ? 'closed' : sinkDisabled ? 'disabled' : 'active', pending: queue.length, inFlight }),
    });
  }

  const observe = <T>(handle: RunHandle<T>, options: ObserveOptions = {}): Observation => {
    if (closed) throw new MayuraError('CONFLICT', 'The observer is closed.');
    let runId: string; let sourceObserve: RunHandle<T>['observe']; let after: number | undefined; let external: AbortSignal | undefined; let durationMs: number;
    try {
      // Deliberately do not read result/cancel, even to validate the handle's broader shape.
      runId = stableId(handle.id); const callback = handle.observe;
      if (handle.profile !== 'ephemeral' || typeof callback !== 'function') throw new Error(); sourceObserve = callback.bind(handle);
      after = options.after; if (after !== undefined) integer(after);
      external = options.signal; if (external !== undefined && !(external instanceof AbortSignal)) throw new Error();
      durationMs = options.durationMs ?? config.maxObservationMs; assertPositiveInteger(durationMs, 'durationMs'); if (durationMs > config.maxObservationMs) throw new Error();
    } catch { throw new MayuraError('INVALID_INPUT', 'Observation requires a valid handle, cursor, signal and bounded lifetime.'); }
    let run = runs.get(runId);
    if (run && (run.active || run.sourcePending > 0)) throw new MayuraError('CONFLICT', 'This run has an active observation or an unsettled source callback.');
    if (!run) {
      if (runs.size >= config.maxRuns) throw new MayuraError('LIMIT_EXCEEDED', 'The observer run-table limit was reached.');
      run = { runId, cursor: 0, status: 'unknown', active: false, sourcePending: 0, terminal: false, sawStart: false, tainted: false, counters: counters(), recent: [], gaps: [] };
      runs.set(runId, run);
    }
    const tracked = run; tracked.active = true; count('subscriptionsStarted');
    const controller = new AbortController(); let finished = false; let stopReason: ObservationReason = 'disconnected';
    const stop = (reason: ObservationReason): void => { if (!finished && !controller.signal.aborted) { stopReason = reason; controller.abort(); } };
    const relay = (): void => { stop('disconnected'); };
    external?.addEventListener('abort', relay, { once: true }); if (external?.aborted) relay();
    const timer = setTimeout(() => { stop('timeout'); }, durationMs);
    const consume = async (): Promise<{ readonly runId: string; readonly reason: ObservationReason }> => {
      let cleanup: (() => unknown) | undefined; let reason: ObservationReason = 'source_ended'; let exhausted = false;
      try {
        if (controller.signal.aborted) throw stopped;
        const source = sourceObserve(Object.freeze({ after: after ?? tracked.cursor, signal: controller.signal }));
        const iterator = source[Symbol.asyncIterator](); const next = iterator.next.bind(iterator);
        const returnCallback = iterator.return;
        if (typeof returnCallback === 'function') cleanup = returnCallback.bind(iterator);
        let reads = 0;
        for (;;) {
          const item = await interruptible(async () => {
            const entry = await sourceCall(tracked, next);
            // A timed-out read may settle later. Its candidate must never be inspected or admitted.
            if (controller.signal.aborted) throw stopped;
            const done = entry.done;
            if (done !== undefined && typeof done !== 'boolean') throw new Error();
            return { done: done === true, value: done ? undefined : entry.value };
          }, controller.signal);
          if (controller.signal.aborted) throw stopped;
          if (item.done) { exhausted = true; break; }
          try { admit(tracked, item.value); }
          catch { count('rejected', tracked); tracked.tainted = true; reason = 'invalid_event'; break; }
          if (tracked.terminal) { reason = 'terminal'; break; }
          // Cooperate with timers even when an application-provided iterator resolves immediately.
          if (++reads % 32 === 0) await interruptible(() => new Promise<void>(resolve => { setTimeout(resolve, 0); }), controller.signal);
        }
      } catch (error) {
        if (error === stopped || controller.signal.aborted) reason = stopReason;
        else { reason = 'source_failed'; tracked.tainted = true; count('sourceFailures'); }
      } finally {
        finished = true; clearTimeout(timer); external?.removeEventListener('abort', relay); controller.abort();
        tracked.active = false; tracked.lastObservation = reason; active.delete(runId);
        // At most one read and one cleanup remain owned by this run. Neither holds done/close
        // open, but a replacement source cannot start until both have actually settled.
        if (!exhausted && cleanup) void sourceCall(tracked, cleanup).catch(() => {});
      }
      return Object.freeze({ runId, reason });
    };
    const completion = Promise.resolve().then(consume);
    const observation = Object.freeze({ runId, done: () => completion, disconnect: () => { stop('disconnected'); } });
    active.set(runId, { observation, stop });
    return observation;
  };
  const close = (): Promise<ObserverSnapshot> => {
    if (closing) return closing;
    closed = true;
    const subscriptions = [...active.values()]; for (const entry of subscriptions) entry.stop('observer_closed');
    dropQueue(); deliveryController?.abort();
    closing = Promise.all([Promise.all(subscriptions.map(entry => entry.observation.done())), delivery]).then(() => inspect());
    return closing;
  };
  return Object.freeze({ observe, inspect, close });
}
