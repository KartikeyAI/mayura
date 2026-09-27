import { setImmediate as nextTurn } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { Budget, MayuraError, type ExecutionReceipt, type Guard, type Schema } from '@mayura/core';
import { defineTool, invokeTool, type InvokeToolContext } from '../src/index.js';

const stringSchema: Schema<string> = {
  '~standard': { version: 1, vendor: 'regression', validate: (value) => typeof value === 'string'
    ? { value } : { issues: [{ message: 'String required.' }] } },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function context(overrides: Partial<InvokeToolContext> = {}): InvokeToolContext {
  return {
    runId: 'security-regression', callId: 'write.1', scope: { principalId: 'person', projectId: 'project' },
    signal: new AbortController().signal, permissions: { allow: ['tool:write', 'effect:write'] },
    budget: new Budget(5, 5), ...overrides,
  };
}

describe('tool boundary security regressions', () => {
  it.each(['input', 'output'] as const)('uses one immutable %s guard decision even when its getter changes', async (boundary) => {
    let reads = 0;
    const guard: Guard = { id: 'changing-decision', check: () => ({
      get decision(): 'allow' | 'block' { return ++reads === 1 ? 'block' : 'allow'; },
    }) };
    const execute = vi.fn(() => 'private-output');
    const budget = new Budget(5, 5);
    const tool = defineTool({
      id: 'write', version: '1', description: 'Guard regression.', input: stringSchema, output: stringSchema,
      effects: 'write', capabilities: [], costMicros: 1, guards: { [boundary]: [guard] }, execute,
    });
    const outcome = await invokeTool(tool, 'input', context({ budget }));
    expect(outcome).toMatchObject({ status: 'blocked', error: { code: 'GUARD_BLOCKED' }, receipt: {
      execution: boundary === 'input' ? 'not_started' : 'succeeded', disclosure: 'withheld',
    } });
    expect(reads).toBe(1);
    expect(execute).toHaveBeenCalledTimes(boundary === 'input' ? 0 : 1);
    expect(budget.snapshot().spentMicros).toBe(boundary === 'input' ? 0 : 1);
    expect(JSON.stringify(outcome)).not.toContain('private-output');
  });

  it.each(['cancel', 'timeout'] as const)('persists late known success after %s without resurrecting the returned unknown outcome', async (interruption) => {
    const started = deferred<void>();
    const completion = deferred<string>();
    const recorded = deferred<void>();
    const controller = new AbortController();
    const budget = new Budget(5, 5);
    const validateOutput = vi.fn((value: unknown) => ({ value: value as string }));
    const output: Schema<string> = { '~standard': { version: 1, vendor: 'regression', validate: validateOutput } };
    const outputGuard = vi.fn(() => ({ decision: 'allow' as const }));
    const receipts: ExecutionReceipt[] = [];
    const execute = vi.fn(() => { started.resolve(); return completion.promise; });
    const tool = defineTool({
      id: 'write', version: '1', description: 'Late outcome regression.', input: stringSchema, output,
      effects: 'write', capabilities: [], costMicros: 1, timeoutMs: interruption === 'timeout' ? 25 : 5_000,
      guards: { output: [{ id: 'output-guard', check: outputGuard }] }, execute,
    });
    const pending = invokeTool(tool, 'input', context({ signal: controller.signal, budget,
      onExecutionReceipt: async (receipt) => { receipts.push(receipt); recorded.resolve(); },
    }));
    await started.promise;
    if (interruption === 'cancel') controller.abort('private-abort-reason');
    const initial = await pending;
    const initialJson = JSON.stringify(initial);
    expect(initial).toMatchObject({ status: 'outcome_unknown', error: { code: 'OUTCOME_UNKNOWN' },
      receipt: { execution: 'unknown', disclosure: 'withheld' } });
    expect(budget.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 1, calls: 1 });
    expect(receipts).toEqual([]);

    completion.resolve('private-late-output');
    await recorded.promise;
    await nextTurn();
    expect(receipts).toEqual([{ callId: 'write.1', toolId: 'write', execution: 'succeeded', disclosure: 'withheld' }]);
    expect(Object.isFrozen(receipts[0])).toBe(true);
    expect(budget.snapshot()).toEqual({ spentMicros: 1, reservedMicros: 0, calls: 1 });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(validateOutput).not.toHaveBeenCalled();
    expect(outputGuard).not.toHaveBeenCalled();
    expect(await pending).toBe(initial);
    expect(JSON.stringify(initial)).toBe(initialJson);
    expect(Object.isFrozen(initial.receipt)).toBe(true);
    expect(JSON.stringify([initial, receipts])).not.toContain('private');
  });

  it.each([
    { label: 'ordinary error', error: new Error('private-persistence-detail') },
    { label: 'framework-shaped error', error: new MayuraError('OUTCOME_UNKNOWN', 'private-persistence-detail') },
  ])('handles late receipt persistence rejection ($label) without unhandled rejection or disclosure', async ({ error }) => {
    const started = deferred<void>();
    const completion = deferred<string>();
    const callbackStarted = deferred<void>();
    const controller = new AbortController();
    const budget = new Budget(5, 5);
    const unhandled = vi.fn();
    const outputGuard = vi.fn(() => ({ decision: 'allow' as const }));
    const receiptCallback = vi.fn(async () => { callbackStarted.resolve(); throw error; });
    const tool = defineTool({
      id: 'write', version: '1', description: 'Late persistence failure.', input: stringSchema, output: stringSchema,
      effects: 'write', capabilities: [], costMicros: 1,
      guards: { output: [{ id: 'output-guard', check: outputGuard }] },
      execute: () => { started.resolve(); return completion.promise; },
    });
    process.on('unhandledRejection', unhandled);
    try {
      const pending = invokeTool(tool, 'input', context({ signal: controller.signal, budget, onExecutionReceipt: receiptCallback }));
      await started.promise;
      controller.abort();
      const initial = await pending;
      completion.resolve('private-late-output');
      await callbackStarted.promise;
      // Let both the callback rejection and Node's unhandled-rejection checkpoint run.
      await nextTurn();
      await nextTurn();
      expect(receiptCallback).toHaveBeenCalledExactlyOnceWith(
        { callId: 'write.1', toolId: 'write', execution: 'succeeded', disclosure: 'withheld' },
        { knownCostMicros: 1, unknownCostMicros: 0 },
      );
      expect(unhandled).not.toHaveBeenCalled();
      expect(outputGuard).not.toHaveBeenCalled();
      expect(budget.snapshot()).toEqual({ spentMicros: 1, reservedMicros: 0, calls: 1 });
      expect(await pending).toBe(initial);
      expect(initial).toMatchObject({ status: 'outcome_unknown', error: { code: 'OUTCOME_UNKNOWN' },
        receipt: { execution: 'unknown', disclosure: 'withheld' } });
      expect(JSON.stringify(initial)).not.toContain('private');
      expect('output' in initial).toBe(false);
    } finally { process.removeListener('unhandledRejection', unhandled); }
  });
});
