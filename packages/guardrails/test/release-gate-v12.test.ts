import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Budget, type GuardContext, type ModelAdapter, type ModelResponse } from '@mayura/core';
import { defineTool, invokeBatch, invokeTool } from '@mayura/tools';
import { createAuxiliaryCheck } from '../src/index.js';

const scope = { principalId: 'release', projectId: 'mayura' };
const signal = () => new AbortController().signal;
const permissions = { allow: ['tool:budget.write', 'effect:write', 'model:budget.check'] };
const input = z.object({ value: z.number() });
const output = z.object({ result: z.number() });
const final = (result: number, costMicros = 1): ModelResponse => ({
  type: 'final', output: { result }, usage: { costMicros },
});
const context = (): GuardContext => ({ runId: 'release-gate-v12', callId: 'check', scope, boundary: 'input', signal: signal() });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

describe('V12 budget concurrency acceptance', () => {
  it('admits one competing child bundle and starts each genuine reservation at most once', async () => {
    const root = new Budget(6, 2);
    const children = [0, 1, 2].map(index => root.fork({ id: `child-${index}`, maxCostMicros: 6, maxCalls: 2 }));
    const attempts = await Promise.allSettled(children.map(async (child, index) => child.reserveBundle([
      { id: `paid-${index}`, maxCostMicros: 6 }, { id: `free-${index}`, maxCostMicros: 0 },
    ])));
    const accepted = attempts.filter((result): result is PromiseFulfilledResult<ReturnType<Budget['reserveBundle']>> => result.status === 'fulfilled');
    expect(accepted).toHaveLength(1);
    expect(root.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 6, calls: 0 });
    expect(root.capacitySnapshot()).toEqual({ heldCalls: 2 });

    const ticket = accepted[0]!.value.tickets[0]!;
    const starts = await Promise.allSettled([Promise.resolve().then(() => ticket.start()), Promise.resolve().then(() => ticket.start())]);
    expect(starts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(root.snapshot().calls).toBe(1);
  });

  it('shares one atomic account across concurrent batch calls', async () => {
    const execute = vi.fn(({ value }: { value: number }) => ({ result: value }));
    const tool = defineTool({ id: 'budget.write', version: '1', description: 'Budget fixture.', input, output,
      effects: 'write', capabilities: [], costMicros: 5, execute });
    const budget = new Budget(5, 2);
    const result = await invokeBatch([
      { id: 'first', tool, input: { value: 1 } },
      { id: 'second', tool, input: { value: 2 } },
    ], { runId: 'release-gate-v12', scope, permissions, budget, signal: signal(), concurrency: 2 });

    expect(result.map(item => item.outcome.status).sort()).toEqual(['blocked', 'succeeded']);
    expect(execute).toHaveBeenCalledOnce();
    expect(budget.snapshot()).toEqual({ spentMicros: 5, reservedMicros: 0, calls: 1 });
  });

  it('shares one hard reservation ceiling across parallel auxiliary checks', async () => {
    const entered = deferred<void>(); const completion = deferred<ModelResponse>();
    const generate = vi.fn(() => { entered.resolve(); return completion.promise; });
    const model: ModelAdapter = { id: 'budget.check', maxCostMicros: 1, capabilities: { tools: false, structuredOutput: true }, generate };
    const budget = new Budget(1, 2);
    const check = createAuxiliaryCheck({
      id: 'budget-check', version: '1', model, instructions: 'Return the result.', input, output,
      budget, permissions, limits: { timeoutMs: 2_000 },
    });
    const first = check.evaluate({ value: 1 }, context());
    await entered.promise;
    const second = await check.evaluate({ value: 2 }, context());
    expect(second).toMatchObject({ status: 'blocked', error: { code: 'BUDGET_EXCEEDED' } });
    expect(generate).toHaveBeenCalledOnce();
    completion.resolve(final(1));
    expect((await first).status).toBe('succeeded');
    expect(budget.snapshot()).toEqual({ spentMicros: 1, reservedMicros: 0, calls: 1 });
  });

  it('keeps unresolved usage visible and stops new work after exhaustion', async () => {
    const execute = vi.fn((_value: { value: number }, toolContext: { reportUsage(value: { knownCostMicros: number; unknownCostMicros: number }): void }) => {
      toolContext.reportUsage({ knownCostMicros: 0, unknownCostMicros: 3 });
      return { result: 1 };
    });
    const tool = defineTool({ id: 'budget.write', version: '1', description: 'Unknown usage fixture.', input, output,
      effects: 'write', capabilities: [], costMicros: 3, execute });
    const budget = new Budget(3, 2);
    const first = await invokeTool(tool, { value: 1 }, {
      runId: 'release-gate-v12', callId: 'first', scope, permissions, budget, signal: signal(),
    });
    expect(first).toMatchObject({ status: 'outcome_unknown', receipt: { execution: 'unknown', disclosure: 'withheld' } });
    expect(budget.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 3, calls: 1 });

    const second = await invokeTool(tool, { value: 2 }, {
      runId: 'release-gate-v12', callId: 'second', scope, permissions, budget, signal: signal(),
    });
    expect(second).toMatchObject({ status: 'blocked', error: { code: 'BUDGET_EXCEEDED' } });
    expect(execute).toHaveBeenCalledOnce();
    expect(budget.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 3, calls: 1 });
  });
});
