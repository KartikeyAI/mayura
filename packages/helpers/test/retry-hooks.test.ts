import { describe, expect, it, vi } from 'vitest';
import { MayuraError } from '@mayura/core';
import { retry, type RetryEvent } from '../src/index.js';

const failing = (code: 'TOOL_FAILED' | 'TIMEOUT' = 'TOOL_FAILED') => vi.fn(async (attempt: number) => {
  if (attempt < 3) throw new MayuraError(code, 'transient');
  return `ok-${attempt}`;
});

describe('onRetry lifecycle hook', () => {
  it('is consulted before every further attempt with a metadata-only view', async () => {
    const operation = failing();
    const onRetry = vi.fn((_event: RetryEvent) => ({ decision: 'continue' as const }));
    await expect(retry(operation, { signal: new AbortController().signal, maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 10, safety: 'idempotent', onRetry })).resolves.toBe('ok-3');
    expect(onRetry.mock.calls.map(([event]) => event)).toEqual([
      { attempt: 1, nextAttempt: 2, delayMs: 1, error: { code: 'TOOL_FAILED' } },
      { attempt: 2, nextAttempt: 3, delayMs: 2, error: { code: 'TOOL_FAILED' } },
    ]);
  });

  it('stops and rethrows the original error on block', async () => {
    const operation = failing('TIMEOUT');
    await expect(retry(operation, { signal: new AbortController().signal, maxAttempts: 3, initialDelayMs: 1, safety: 'idempotent',
      onRetry: () => ({ decision: 'block' }) })).rejects.toMatchObject({ code: 'TIMEOUT', message: 'transient' });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('fails closed with no further attempt when the hook throws, misbehaves or times out', async () => {
    for (const onRetry of [() => { throw new Error('x'); }, () => 'yes', () => new Promise(() => {})]) {
      const operation = failing();
      await expect(retry(operation, { signal: new AbortController().signal, maxAttempts: 3, initialDelayMs: 1, safety: 'idempotent',
        onRetry: onRetry as never, onRetryTimeoutMs: 20 })).rejects.toMatchObject({ code: 'GUARD_UNAVAILABLE' });
      expect(operation).toHaveBeenCalledTimes(1);
    }
  });

  it('reports non-framework errors as UNKNOWN, is not called on the final attempt and honors cancellation', async () => {
    const onRetry = vi.fn((_event: RetryEvent) => ({ decision: 'continue' as const }));
    await expect(retry(async () => { throw new Error('raw'); }, { signal: new AbortController().signal, maxAttempts: 2, initialDelayMs: 0, safety: 'read-only', onRetry }))
      .rejects.toThrow('raw');
    expect(onRetry).toHaveBeenCalledTimes(1); expect(onRetry.mock.calls[0]![0].error).toEqual({ code: 'UNKNOWN' });
    const controller = new AbortController();
    await expect(retry(async () => { throw new Error('raw'); }, { signal: controller.signal, maxAttempts: 2, initialDelayMs: 0, safety: 'read-only',
      onRetry: () => { controller.abort(); return new Promise(() => {}); } })).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(retry(async () => 1, { signal: new AbortController().signal, maxAttempts: 1, initialDelayMs: 0, safety: 'single-attempt', onRetry: 'x' as never }))
      .rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });
});
