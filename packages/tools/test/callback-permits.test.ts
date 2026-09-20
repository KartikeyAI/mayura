import { setImmediate as nextTurn } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { Budget, MayuraError, type Guard, type Schema } from '@mayura/core';
import { defineTool, invokeTool, type InvokeToolContext } from '../src/index.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
function schema(validate: Schema<string>['~standard']['validate'] = value => ({ value: value as string })): Schema<string> {
  return { '~standard': { version: 1, vendor: 'callback-permit-test', validate } };
}
/** A real one-slot queue in the fixture, including cancelled wait removal and actual lifetime. */
function limiter() {
  let active = 0;
  const queue: { signal: AbortSignal; resolve: (release: () => void) => void; reject: (error: unknown) => void; abort: () => void }[] = [];
  const grant = (): (() => void) => {
    active++;
    let released = false;
    return () => {
      if (released) throw new Error('Duplicate release');
      released = true; active--;
      const next = queue.shift();
      if (next) { next.signal.removeEventListener('abort', next.abort); next.resolve(grant()); }
    };
  };
  const acquire = vi.fn(async (signal: AbortSignal): Promise<() => void> => {
    if (signal.aborted) throw new MayuraError('CANCELLED', 'Fixture queue cancelled.');
    if (active === 0) return grant();
    return await new Promise((resolve, reject) => {
      const entry = { signal, resolve, reject, abort: () => {
        const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1);
        reject(new MayuraError('CANCELLED', 'Fixture queue cancelled.'));
      } };
      queue.push(entry); signal.addEventListener('abort', entry.abort, { once: true });
    });
  });
  return { acquire, active: () => active, queued: () => queue.length };
}
function context(acquireCallback: InvokeToolContext['acquireCallback'], signal = new AbortController().signal): InvokeToolContext {
  return { runId: 'run', callId: 'call', scope: { principalId: 'principal', projectId: 'project' }, signal,
    permissions: { allow: ['tool:fixture'] }, budget: new Budget(0, 8), ...(acquireCallback ? { acquireCallback } : {}) };
}

describe('tool callback operation admission', () => {
  it.each(['input-schema', 'input-guard', 'output-schema', 'output-guard'] as const)('retains the actual %s slot after timeout', async stage => {
    const permits = limiter(); const started = deferred<void>(); const finish = deferred<void>();
    const hang = async (): Promise<void> => { started.resolve(); await finish.promise; };
    const input = schema(async value => { if (stage === 'input-schema') await hang(); return { value: value as string }; });
    const output = schema(async value => { if (stage === 'output-schema') await hang(); return { value: value as string }; });
    const guard: Guard = { id: 'pending', check: async () => { await hang(); return { decision: 'allow' }; } };
    const first = defineTool({ id: 'fixture', version: '1', description: 'Pending callback.', input, output, effects: 'none', capabilities: [],
      timeoutMs: 30, execute: value => value, guards: stage === 'input-guard' ? { input: [guard] } : stage === 'output-guard' ? { output: [guard] } : {} });
    const inputCalls = vi.fn((value: unknown) => ({ value: value as string }));
    const second = defineTool({ id: 'fixture', version: '1', description: 'Following callback.', input: schema(inputCalls), output: schema(),
      effects: 'none', capabilities: [], timeoutMs: 1_000, execute: value => value });
    const result = invokeTool(first, 'value', context(permits.acquire));
    try {
      await Promise.race([started.promise, result]); expect(permits.acquire).toHaveBeenCalled();
      expect(await result).toMatchObject({ status: 'failed', error: { code: 'TIMEOUT' } });
      expect(permits.active()).toBe(1);
      const following = invokeTool(second, 'value', context(permits.acquire)); await nextTurn();
      expect(inputCalls).not.toHaveBeenCalled(); expect(permits.queued()).toBe(1);
      finish.resolve(); expect((await following).status).toBe('succeeded');
      expect(inputCalls).toHaveBeenCalledOnce(); expect(permits.active()).toBe(0);
    } finally { finish.resolve(); await result; }
  });

  it('uses separate callback permits and releases them before the executor permit', async () => {
    const permits = limiter(); const observations: number[] = [];
    const guard: Guard = { id: 'guard', check: () => { observations.push(permits.active()); return { decision: 'allow' }; } };
    const validate = (value: unknown) => { observations.push(permits.active()); return { value: value as string }; };
    const tool = defineTool({ id: 'fixture', version: '1', description: 'Sequential permits.', input: schema(validate), output: schema(validate),
      effects: 'none', capabilities: [], guards: { input: [guard], output: [guard] }, timeoutMs: 1_000,
      execute: value => { observations.push(permits.active()); return value; } });
    expect(await invokeTool(tool, 'value', { ...context(permits.acquire), acquireExecution: permits.acquire })).toMatchObject({ status: 'succeeded' });
    expect(observations).toEqual([1, 1, 1, 1, 1]); expect(permits.acquire).toHaveBeenCalledTimes(5); expect(permits.active()).toBe(0);
  });

  it('cancels queued callback admission before schema evaluation or cost reservation', async () => {
    const permits = limiter(); const release = await permits.acquire(new AbortController().signal);
    const controller = new AbortController(); const validate = vi.fn((value: unknown) => ({ value: value as string }));
    const execute = vi.fn((value: string) => value);
    const tool = defineTool({ id: 'fixture', version: '1', description: 'Cancelled callback.', input: schema(validate), output: schema(),
      effects: 'none', capabilities: [], execute });
    const supplied = context(permits.acquire, controller.signal); const result = invokeTool(tool, 'value', supplied);
    await nextTurn(); controller.abort();
    expect(await result).toMatchObject({ status: 'cancelled' }); expect(validate).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
    expect(permits.queued()).toBe(0); expect(supplied.budget.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 0 }); release();
  });

  it('releases a late admission after cancellation without invoking its callback', async () => {
    const entered = deferred<void>(); const admission = deferred<() => void>(); const release = vi.fn();
    const acquireCallback = vi.fn(async () => { entered.resolve(); return await admission.promise; });
    const validate = vi.fn((value: unknown) => ({ value: value as string })); const controller = new AbortController();
    const tool = defineTool({ id: 'fixture', version: '1', description: 'Late admission.', input: schema(validate), output: schema(),
      effects: 'none', capabilities: [], execute: value => value });
    const result = invokeTool(tool, 'value', context(acquireCallback, controller.signal));
    try {
      await Promise.race([entered.promise, result]); expect(acquireCallback).toHaveBeenCalled();
      controller.abort(); expect((await result).status).toBe('cancelled');
      admission.resolve(release); await nextTurn(); expect(release).toHaveBeenCalledOnce(); expect(validate).not.toHaveBeenCalled();
    } finally { admission.resolve(release); }
  });

  it('aborts queued parallel guards after another guard fails instead of starting them later', async () => {
    const permits = limiter(); const pending = deferred<void>(); const entered = deferred<void>();
    const last = vi.fn<Guard['check']>(() => ({ decision: 'allow' }));
    const tool = defineTool({ id: 'fixture', version: '1', description: 'Failure cleanup.', input: schema(), output: schema(),
      effects: 'none', capabilities: [], timeoutMs: 1_000, execute: value => value, guards: { input: [
        { id: 'failure', check: () => { throw new Error('SECRET'); } },
        { id: 'pending', check: async () => { entered.resolve(); await pending.promise; return { decision: 'allow' }; } },
        { id: 'queued', check: last },
      ] } });
    const result = invokeTool(tool, 'value', context(permits.acquire));
    try {
      // The first slot may be handed to the next waiter before its rejection reaches the barrier.
      // The remaining waiter must nevertheless be cancelled at the terminal broker boundary.
      expect(await result).toMatchObject({ status: 'blocked', error: { code: 'GUARD_UNAVAILABLE' } });
      expect(last).not.toHaveBeenCalled(); expect(permits.queued()).toBe(0);
      pending.resolve(); await nextTurn(); expect(last).not.toHaveBeenCalled(); expect(permits.active()).toBe(0);
    } finally { pending.resolve(); }
  });

  it.each(['admission', 'release'] as const)('redacts %s scheduler failures', async phase => {
    const acquire = vi.fn(async () => {
      if (phase === 'admission') throw new MayuraError('TOOL_FAILED', 'SECRET');
      return () => { throw new MayuraError('TOOL_FAILED', 'SECRET'); };
    });
    const tool = defineTool({ id: 'fixture', version: '1', description: 'Scheduler failure.', input: schema(), output: schema(),
      effects: 'none', capabilities: [], execute: value => value });
    const result = await invokeTool(tool, 'value', context(acquire));
    expect(acquire).toHaveBeenCalledOnce(); expect(result).toMatchObject({ status: 'failed', error: { code: 'TOOL_FAILED' } });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('does not expose callback admission to tool or guard contexts', async () => {
    const checkContext = (value: object): void => { expect('acquireCallback' in value).toBe(false); expect('budget' in value).toBe(false); };
    const tool = defineTool({ id: 'fixture', version: '1', description: 'Private host seam.', input: schema(), output: schema(),
      effects: 'none', capabilities: [], execute: (value, ctx) => { checkContext(ctx); return value; },
      guards: { input: [{ id: 'guard', check: (_value, ctx) => { checkContext(ctx); return { decision: 'allow' }; } }] } });
    expect((await invokeTool(tool, 'value', context(limiter().acquire))).status).toBe('succeeded');
  });

  it('rejects an accessor callback limiter without executing it', async () => {
    const read = vi.fn(() => { throw new MayuraError('TOOL_FAILED', 'SECRET'); });
    const supplied = context(undefined); Object.defineProperty(supplied, 'acquireCallback', { enumerable: true, get: read });
    const tool = defineTool({ id: 'fixture', version: '1', description: 'Invalid callback field.', input: schema(), output: schema(),
      effects: 'none', capabilities: [], execute: value => value });
    const result = await invokeTool(tool, 'value', supplied);
    expect(result).toMatchObject({ status: 'failed', error: { code: 'INVALID_CONFIG' } }); expect(read).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('rejects noncallable admission and noncallable release values before executing the tool', async () => {
    const execute = vi.fn((value: string) => value);
    const tool = defineTool({ id: 'fixture', version: '1', description: 'Invalid limiter.', input: schema(), output: schema(),
      effects: 'none', capabilities: [], execute });
    const invalid = { ...context(undefined), acquireCallback: 1 } as unknown as InvokeToolContext;
    expect(await invokeTool(tool, 'value', invalid)).toMatchObject({ status: 'failed', error: { code: 'INVALID_CONFIG' } });
    const invalidRelease = { ...context(undefined), acquireCallback: async () => null } as unknown as InvokeToolContext;
    expect(await invokeTool(tool, 'value', invalidRelease)).toMatchObject({ status: 'failed', error: { code: 'TOOL_FAILED' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves known execution and cost when releasing an output callback permit fails', async () => {
    let acquisitions = 0;
    const acquire = async (): Promise<() => void> => {
      const index = ++acquisitions;
      return () => { if (index === 2) throw new MayuraError('TOOL_FAILED', 'SECRET'); };
    };
    const tool = defineTool({ id: 'fixture', version: '1', description: 'Late scheduler failure.', input: schema(), output: schema(),
      effects: 'read', capabilities: [], costMicros: 2, execute: value => value });
    const supplied = { ...context(acquire), permissions: { allow: ['tool:fixture', 'effect:read'] }, budget: new Budget(2, 1) };
    const result = await invokeTool(tool, 'value', supplied);
    expect(result).toMatchObject({ status: 'failed', error: { code: 'TOOL_FAILED' }, receipt: { execution: 'succeeded', disclosure: 'withheld' } });
    expect(supplied.budget.snapshot()).toEqual({ spentMicros: 2, reservedMicros: 0, calls: 1 });
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
});
