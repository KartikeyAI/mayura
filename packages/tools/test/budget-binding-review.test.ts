import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Budget, MayuraError } from '@mayura/core';
import { defineTool, invokeTool, type InvokeToolContext } from '../src/index.js';
import { bindToolBudgetTicket } from '../src/host.js';

function fixture() {
  const execute = vi.fn((value: string) => value);
  const tool = defineTool({ id: 'review.tool', version: '1', description: 'Review fixture.', input: z.string(), output: z.string(),
    effects: 'none', capabilities: [], costMicros: 3, execute });
  const budget = new Budget(6, 4);
  const context: InvokeToolContext = { runId: 'run', callId: 'call', scope: { principalId: 'principal', projectId: 'project' },
    signal: new AbortController().signal, budget, permissions: { allow: ['tool:review.tool'] } };
  return { execute, tool, budget, context };
}

describe('tool budget binding independent boundary review', () => {
  it('cannot switch a previously checked genuine budget to a forged reservation facade', async () => {
    const f = fixture(); let reads = 0; const reserve = vi.fn(() => ({ settle() {} }));
    const context = { ...f.context };
    Object.defineProperty(context, 'budget', { enumerable: true, get() { return ++reads === 1 ? f.budget : { reserve }; } });
    expect((await invokeTool(f.tool, 'value', context)).status).not.toBe('succeeded');
    expect(f.execute).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
    expect(f.budget.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 0 });
  });

  it('does not reflect framework-shaped errors thrown during invocation configuration', async () => {
    const f = fixture(); const context = { ...f.context };
    Object.defineProperty(context, 'budget', { enumerable: true, get() { throw new MayuraError('TOOL_FAILED', 'SECRET_PROVIDER_CREDENTIAL'); } });
    const result = await invokeTool(f.tool, 'value', context);
    expect(result.status).not.toBe('succeeded'); expect(JSON.stringify(result)).not.toContain('SECRET_PROVIDER_CREDENTIAL');
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('rejects an accessor binding rather than silently falling back to an ordinary reservation', async () => {
    const f = fixture(); const bundle = f.budget.reserveBundle([{ id: 'protected', maxCostMicros: 3 }]);
    const binding = bindToolBudgetTicket(f.tool, bundle.tickets[0]!, f.context); let reads = 0;
    const context = { ...f.context };
    Object.defineProperty(context, 'budgetBinding', { enumerable: true, get() { reads++; return undefined; } });
    expect((await invokeTool(f.tool, 'value', context)).status).not.toBe('succeeded');
    expect(f.execute).not.toHaveBeenCalled(); expect(reads).toBe(0);
    // Rejecting an unrelated malformed options envelope must not claim an otherwise valid binding.
    expect((await invokeTool(f.tool, 'value', { ...f.context, budgetBinding: binding })).status).toBe('succeeded');
    expect(f.execute).toHaveBeenCalledOnce(); bundle.close();
  });

  it('rejects forged framework exceptions from binding-context reflection without exposing text', () => {
    const f = fixture(); const bundle = f.budget.reserveBundle([{ id: 'protected', maxCostMicros: 3 }]);
    const context = new Proxy(f.context, { getOwnPropertyDescriptor() { throw new MayuraError('TOOL_FAILED', 'SECRET'); } });
    let error: unknown; try { bindToolBudgetTicket(f.tool, bundle.tickets[0]!, context); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: 'INVALID_CONFIG' }); expect(String(error)).not.toContain('SECRET');
    expect(bindToolBudgetTicket(f.tool, bundle.tickets[0]!, f.context).kind).toBe('mayura.tool-budget-ticket'); bundle.close();
  });

  it('withholds a bound dispatch when another admitted operation overruns before dispatch', async () => {
    const f = fixture(); const previous = f.budget.reserve(0); const bundle = f.budget.reserveBundle([{ id: 'protected', maxCostMicros: 3 }]);
    const binding = bindToolBudgetTicket(f.tool, bundle.tickets[0]!, f.context);
    const result = await invokeTool(f.tool, 'value', { ...f.context, budgetBinding: binding,
      beforeDispatch: async () => { try { previous.settle(1); } catch { /* Known overrun is recorded and closes admissions. */ } } });
    expect(result).toMatchObject({ status: 'blocked', error: { code: 'BUDGET_EXCEEDED' } });
    expect(f.execute).not.toHaveBeenCalled(); bundle.close();
    expect(f.budget.snapshot()).toEqual({ spentMicros: 1, reservedMicros: 0, calls: 1 });
  });

  it('retains started usage after cancellation and bundle closure, then settles actual late success once', async () => {
    let finish!: (value: string) => void; let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    const pending = new Promise<string>(resolve => { finish = resolve; });
    let persisted!: () => void; const persistence = new Promise<void>(resolve => { persisted = resolve; });
    const controller = new AbortController(); const f = fixture();
    const tool = defineTool({ id: 'review.tool', version: '1', description: 'Pending review.', input: z.string(), output: z.string(),
      effects: 'none', capabilities: [], costMicros: 3, execute: () => { signalStarted(); return pending; } });
    const context = { ...f.context, signal: controller.signal };
    const bundle = f.budget.reserveBundle([{ id: 'effect', maxCostMicros: 3 }, { id: 'output-check', maxCostMicros: 2 }]);
    const binding = bindToolBudgetTicket(tool, bundle.tickets[0]!, context);
    const run = invokeTool(tool, 'value', { ...context, budgetBinding: binding, onExecutionReceipt: async () => { persisted(); } });
    await started; controller.abort();
    expect(await run).toMatchObject({ status: 'cancelled', receipt: { execution: 'unknown', disclosure: 'withheld' } });
    bundle.close(); expect(f.budget.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 3, calls: 1 });
    expect(f.budget.capacitySnapshot()).toEqual({ heldCalls: 0 });
    finish('late'); await persistence;
    expect(f.budget.snapshot()).toEqual({ spentMicros: 3, reservedMicros: 0, calls: 1 });
    expect(() => bundle.tickets[0]!.cancel()).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
  });
});
