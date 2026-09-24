import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Budget, MayuraError, type Schema } from '@mayura/core';
import {
  capture, collectPages, createRedactedLogger, deadlineSignal, delay, pollUntil, providerSchema, retry, withDeadline,
  runBudgetedTasks, secretReference, transferArtifact, validatedConfig, validatedEnvironment, withCleanup,
  type ArtifactStage,
} from '../src/index.js';

const controller = (): AbortController => new AbortController();
const digest = (value: Uint8Array): string => `sha256:${createHash('sha256').update(value).digest('hex')}`;

const objectSchema: Schema<unknown, { name: string }> = {
  '~standard': { version: 1, vendor: 'mayura-test', validate(value) {
    return value && typeof value === 'object' && (value as { name?: unknown }).name === 'Mayura'
      ? { value: { name: 'Mayura' } } : { issues: [{ message: 'rejected secret detail' }] };
  } },
};

describe('@mayura/helpers configuration', () => {
  it('creates opaque immutable secret references and rejects accessors', () => {
    expect(secretReference({ provider: 'vault', key: 'agents/prod', version: 'v1' })).toEqual({ provider: 'vault', key: 'agents/prod', version: 'v1' });
    expect(Object.isFrozen(secretReference({ provider: 'vault', key: 'key' }))).toBe(true);
    expect(() => secretReference(Object.defineProperty({}, 'provider', { get: () => 'vault' }) as never)).toThrow(MayuraError);
  });

  it('validates frozen config and an explicit allowlisted environment view', async () => {
    const config = await validatedConfig(objectSchema, { name: 'Mayura' });
    expect(config).toEqual({ name: 'Mayura' }); expect(Object.isFrozen(config)).toBe(true);
    await expect(validatedEnvironment({ schema: objectSchema, source: { MAYURA_NAME: 'Mayura', SECRET: 'ignored' }, fields: { name: 'MAYURA_NAME' } })).resolves.toEqual({ name: 'Mayura' });
    await expect(validatedConfig(objectSchema, { name: 'wrong' })).rejects.toMatchObject({ code: 'INVALID_INPUT', message: expect.not.stringContaining('secret') });
  });

  it('requires explicit provider JSON Schema and captures only public errors', async () => {
    expect(providerSchema(objectSchema, { type: 'object' }).jsonSchema).toEqual({ type: 'object' });
    expect(() => providerSchema({} as Schema, {})).toThrow(MayuraError);
    await expect(capture(() => { throw new Error('credential=secret'); })).resolves.toEqual({ ok: false,
      error: { code: 'TOOL_FAILED', message: expect.not.stringContaining('secret') } });
  });
});

describe('@mayura/helpers control flow', () => {
  it('links deadlines and disposes listeners and timers', async () => {
    const parent = controller(); const deadline = deadlineSignal(parent.signal, 5);
    await delay(10, deadline.signal).catch(error => expect(error).toMatchObject({ code: 'CANCELLED' }));
    expect(deadline.signal.aborted).toBe(true); deadline.dispose(); deadline.dispose();
    const linked = deadlineSignal(parent.signal, 100); parent.abort(); expect(linked.signal.aborted).toBe(true); linked.dispose();
  });

  it('withholds late deadline output and distinguishes parent cancellation', async () => {
    const parent = controller();
    await expect(withDeadline(async () => { await new Promise(resolve => setTimeout(resolve, 20)); return 'late'; }, parent.signal, 2))
      .rejects.toMatchObject({ code: 'TIMEOUT' });
    parent.abort();
    await expect(withDeadline(() => 'never', parent.signal, 10)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('retries only explicitly safe operations with bounded backoff', async () => {
    const signal = controller().signal; let calls = 0;
    await expect(retry(() => { calls += 1; if (calls < 3) throw new Error('temporary'); return 'ok'; },
      { signal, maxAttempts: 3, initialDelayMs: 0, safety: 'idempotent' })).resolves.toBe('ok');
    expect(calls).toBe(3);
    await expect(retry(() => 'no', { signal, maxAttempts: 2, initialDelayMs: 0, safety: 'single-attempt' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('runs cleanup once and keeps the primary failure', async () => {
    const release = vi.fn(async () => { throw new Error('cleanup'); });
    await expect(withCleanup(() => 'resource', () => { throw new Error('primary'); }, release)).rejects.toThrow('primary');
    expect(release).toHaveBeenCalledOnce();
    await expect(withCleanup(() => 'resource', () => 'ok', release)).rejects.toThrow('cleanup');
  });

  it('polls and paginates within finite limits while rejecting cursor cycles', async () => {
    const signal = controller().signal;
    await expect(pollUntil(attempt => attempt, value => value === 3, { signal, maxAttempts: 3, intervalMs: 0 })).resolves.toBe(3);
    await expect(collectPages(async cursor => cursor === undefined ? { items: [1, 2], nextCursor: 'next' } : { items: [3] },
      { signal, maxPages: 2, maxItems: 3 })).resolves.toEqual([1, 2, 3]);
    await expect(collectPages(async () => ({ items: [], nextCursor: 'same' }),
      { signal, maxPages: 3, maxItems: 1, initialCursor: 'same' })).rejects.toMatchObject({ code: 'CONFLICT' });
    const hostile = Object.defineProperty({}, 'items', { get: () => { throw new Error('getter'); }, enumerable: true });
    await expect(collectPages(async () => hostile as never, { signal, maxPages: 1, maxItems: 1 }))
      .rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
  });
});

describe('@mayura/helpers bounded data', () => {
  function fixture(): { stage: ArtifactStage<string>; writes: Uint8Array[]; commit: ReturnType<typeof vi.fn>; discard: ReturnType<typeof vi.fn> } {
    const writes: Uint8Array[] = []; const commit = vi.fn(async () => 'stored'); const discard = vi.fn(async () => undefined);
    return { writes, commit, discard, stage: { write: async chunk => { writes.push(chunk); }, commit, discard } };
  }

  it('commits only a bounded digest-verified artifact', async () => {
    const bytes = new TextEncoder().encode('mayura'); const target = fixture();
    async function* source(): AsyncIterable<Uint8Array> { yield bytes.subarray(0, 2); yield bytes.subarray(2); }
    await expect(transferArtifact(source(), target.stage, { signal: controller().signal, expectedDigest: digest(bytes), maxBytes: 16 }))
      .resolves.toEqual({ result: 'stored', bytes: 6, digest: digest(bytes) });
    expect(target.commit).toHaveBeenCalledOnce(); expect(target.discard).not.toHaveBeenCalled();
  });

  it('discards mismatched and oversized staged artifacts without commit', async () => {
    const bytes = new TextEncoder().encode('mayura'); const mismatch = fixture();
    async function* source(): AsyncIterable<Uint8Array> { yield bytes; }
    await expect(transferArtifact(source(), mismatch.stage, { signal: controller().signal, expectedDigest: digest(new Uint8Array([1])), maxBytes: 16 }))
      .rejects.toMatchObject({ code: 'INTEGRITY_VIOLATION' });
    expect(mismatch.discard).toHaveBeenCalledOnce(); expect(mismatch.commit).not.toHaveBeenCalled();
    const oversized = fixture();
    await expect(transferArtifact(source(), oversized.stage, { signal: controller().signal, expectedDigest: digest(bytes), maxBytes: 2 }))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(oversized.discard).toHaveBeenCalledOnce();
  });

  it('allowlists structured logs and redacts configured fields', async () => {
    const entries: unknown[] = []; const logger = createRedactedLogger(entry => { entries.push(entry); },
      { allowedFields: ['requestId', 'token'], redactedFields: ['token'], clock: () => 42 });
    await logger.log('info', 'agent.started', { requestId: 'r1', token: 'secret', ignored: 'drop' });
    expect(entries).toEqual([{ timestamp: 42, level: 'info', event: 'agent.started', fields: { requestId: 'r1', token: '[REDACTED]' } }]);
    expect(JSON.stringify(entries)).not.toContain('secret'); expect(JSON.stringify(entries)).not.toContain('ignored');
  });
});

describe('@mayura/helpers budget-aware concurrency', () => {
  it('atomically admits tasks, bounds parallelism and preserves result order', async () => {
    const budget = new Budget(10, 3); let active = 0; let maximum = 0;
    const tasks = [0, 1, 2].map(index => ({ id: `task-${index}`, maxCostMicros: 2, execute: async () => {
      active += 1; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 2)); active -= 1;
      return { value: index, costMicros: 1 };
    } }));
    const results = await runBudgetedTasks(tasks, { budget, signal: controller().signal, concurrency: 2 });
    expect(maximum).toBe(2); expect(results.map(result => result.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(results.map(result => result.status === 'succeeded' ? result.value : -1)).toEqual([0, 1, 2]);
    expect(budget.snapshot()).toEqual({ spentMicros: 3, reservedMicros: 0, calls: 3 });
  });

  it('retains the complete bound when task outcome or usage is unknown', async () => {
    const budget = new Budget(5, 1);
    const [result] = await runBudgetedTasks([{ id: 'unknown', maxCostMicros: 5, execute: async () => { throw new Error('secret'); } }],
      { budget, signal: controller().signal, concurrency: 1 });
    expect(result).toMatchObject({ status: 'outcome_unknown', error: { code: 'OUTCOME_UNKNOWN' } });
    expect(JSON.stringify(result)).not.toContain('secret'); expect(budget.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 5, calls: 1 });
  });

  it('cancels undispatched work without consuming its held call', async () => {
    const abort = controller(); const budget = new Budget(2, 2); let secondCalled = false;
    const results = await runBudgetedTasks([
      { id: 'first', maxCostMicros: 1, execute: async () => { abort.abort(); return { value: 1, costMicros: 1 }; } },
      { id: 'second', maxCostMicros: 1, execute: async () => { secondCalled = true; return { value: 2, costMicros: 1 }; } },
    ], { budget, signal: abort.signal, concurrency: 1 });
    expect(results.map(result => result.status)).toEqual(['succeeded', 'cancelled']); expect(secondCalled).toBe(false);
    expect(budget.snapshot()).toEqual({ spentMicros: 1, reservedMicros: 0, calls: 1 });
  });

  it('rejects forged budgets and duplicate task identities before dispatch', async () => {
    const task = { id: 'duplicate', maxCostMicros: 0, execute: vi.fn(async () => ({ value: 1, costMicros: 0 })) };
    await expect(runBudgetedTasks([task], { budget: { reserveBundle: vi.fn() } as never, signal: controller().signal, concurrency: 1 }))
      .rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(runBudgetedTasks([task, task], { budget: new Budget(0, 2), signal: controller().signal, concurrency: 1 }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(task.execute).not.toHaveBeenCalled();
  });
});
