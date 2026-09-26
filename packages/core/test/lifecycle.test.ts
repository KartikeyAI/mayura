import { describe, expect, it } from 'vitest';
import { LIFECYCLE_STAGES } from '../src/index.js';
import { evaluateLifecycleControl, evaluateLifecycleObserver, lifecycleHookTimeout, snapshotHookOptions } from '../src/host.js';

describe('shared lifecycle callback evaluation', () => {
  it('names exactly the 25 plan lifecycle points', () => {
    expect(LIFECYCLE_STAGES).toHaveLength(25);
    expect(new Set(LIFECYCLE_STAGES).size).toBe(25);
    expect(Object.isFrozen(LIFECYCLE_STAGES)).toBe(true);
  });

  it('continues only on an exact continue decision and blocks on block', async () => {
    await expect(evaluateLifecycleControl({ stage: 'onRetry', handler: () => ({ decision: 'continue' }), event: {}, timeoutMs: 100 })).resolves.toBeUndefined();
    await expect(evaluateLifecycleControl({ stage: 'onRetry', handler: () => ({ decision: 'block' }), event: {}, timeoutMs: 100 }))
      .rejects.toMatchObject({ code: 'GUARD_BLOCKED' });
  });

  it('fails closed on malformed results, accessors, extra fields and thrown errors without echoing callback text', async () => {
    const malformed: unknown[] = [undefined, null, 'continue', { decision: 'allow' }, { decision: 'continue', extra: true },
      Object.defineProperty({}, 'decision', { get: () => 'continue', enumerable: true }), new (class { decision = 'continue'; })()];
    for (const result of malformed) {
      await expect(evaluateLifecycleControl({ stage: 'beforeContextBuild', handler: (() => result) as never, event: {}, timeoutMs: 100 }))
        .rejects.toMatchObject({ code: 'GUARD_UNAVAILABLE' });
    }
    const failure = evaluateLifecycleControl({ stage: 'beforeContextBuild', handler: () => { throw new Error('secret-detail'); }, event: {}, timeoutMs: 100 });
    await expect(failure).rejects.toMatchObject({ code: 'GUARD_UNAVAILABLE' });
    await expect(failure).rejects.not.toThrow(/secret-detail/);
  });

  it('bounds callbacks by a deadline and aborts the callback signal', async () => {
    let seen: AbortSignal | undefined;
    await expect(evaluateLifecycleObserver({ stage: 'afterMemoryWrite', timeoutMs: 20, event: {},
      handler: (_event, context) => { seen = context.signal; return new Promise<void>(() => {}); } })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(seen?.aborted).toBe(true);
  });

  it('propagates caller cancellation as CANCELLED', async () => {
    const controller = new AbortController();
    const pending = evaluateLifecycleObserver({ stage: 'afterMemoryWrite', timeoutMs: 1_000, event: {}, signal: controller.signal, handler: () => new Promise<void>(() => {}) });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(evaluateLifecycleObserver({ stage: 'afterMemoryWrite', timeoutMs: 1_000, event: {}, signal: controller.signal, handler: () => {} }))
      .rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('requires observers to return nothing and passes a frozen view', async () => {
    await expect(evaluateLifecycleObserver({ stage: 'onFinally', handler: (() => ({ decision: 'continue' })) as never, event: {}, timeoutMs: 100 }))
      .rejects.toMatchObject({ code: 'GUARD_UNAVAILABLE' });
    let frozen = false;
    await evaluateLifecycleObserver({ stage: 'onFinally', timeoutMs: 100, event: { nested: { value: 1 } },
      handler: event => { frozen = Object.isFrozen(event) && Object.isFrozen((event as { nested: object }).nested); } });
    expect(frozen).toBe(true);
  });

  it('validates hook option objects and timeouts', () => {
    expect(snapshotHookOptions(undefined, ['a'], 'x')).toEqual({ handlers: {}, timeoutMs: 5_000 });
    const handler = () => {};
    expect(snapshotHookOptions({ a: handler, timeoutMs: 10 }, ['a'], 'x')).toEqual({ handlers: { a: handler }, timeoutMs: 10 });
    for (const value of [null, { b: handler }, { a: 'no' }, { a: handler, timeoutMs: 0 }, { a: handler, timeoutMs: 30_001 },
      Object.defineProperty({}, 'a', { get: () => handler, enumerable: true }), new (class { a = handler; })()]) {
      expect(() => snapshotHookOptions(value, ['a'], 'bad hooks')).toThrow('bad hooks');
    }
    expect(() => lifecycleHookTimeout(1.5)).toThrow();
  });
});
