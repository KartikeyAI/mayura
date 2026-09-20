import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Budget, type BudgetTicket } from '@mayura/core';
import { assertBudgetTicket } from '@mayura/core/host';
import { defineTool, invokeTool, type InvokeToolContext } from '../src/index.js';
import { bindToolBudgetTicket } from '../src/host.js';

function fixture(costMicros = 3) {
  const execute = vi.fn((input: string) => input);
  const tool = defineTool({ id: 'bound.tool', version: '1', description: 'Bound tool.',
    input: z.string(), output: z.string(), effects: 'none', capabilities: [], costMicros, execute });
  const budget = new Budget(5, 2);
  const context: InvokeToolContext = { runId: 'run', callId: 'call', scope: { principalId: 'person', projectId: 'project' },
    signal: new AbortController().signal, budget, permissions: { allow: ['tool:bound.tool'] } };
  const bundle = budget.reserveBundle([{ id: 'effect', maxCostMicros: costMicros }, { id: 'followup', maxCostMicros: 2 }]);
  return { tool, execute, context, budget, bundle, ticket: bundle.tickets[0]! };
}

describe('trusted pre-reserved tool invocation', () => {
  it('uses exactly the held cost and call while preserving required follow-up capacity', async () => {
    const f = fixture(); const binding = bindToolBudgetTicket(f.tool, f.ticket, f.context);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.keys(binding)).toEqual(['kind']);
    expect(await invokeTool(f.tool, 'value', { ...f.context, budgetBinding: binding })).toMatchObject({ status: 'succeeded', output: 'value' });
    expect(f.budget.snapshot()).toEqual({ spentMicros: 3, reservedMicros: 2, calls: 1 });
    expect(f.budget.capacitySnapshot()).toEqual({ heldCalls: 1 });
    f.bundle.tickets[1]!.start().settle(2); f.bundle.close();
    expect(f.budget.snapshot()).toEqual({ spentMicros: 5, reservedMicros: 0, calls: 2 });
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it.each(['copy', 'proxy', 'foreign-root', 'child', 'sibling'] as const)('rejects %s ticket ownership', kind => {
    const f = fixture();
    let ticket: unknown = f.ticket; let owner = f.budget;
    if (kind === 'copy') ticket = { ...f.ticket };
    if (kind === 'proxy') ticket = new Proxy(f.ticket, {});
    if (kind === 'foreign-root') owner = new Budget(5, 2);
    if (kind === 'child') owner = f.budget.fork({ id: 'child', maxCostMicros: 5, maxCalls: 2 });
    if (kind === 'sibling') {
      const root = new Budget(10, 4);
      const left = root.fork({ id: 'left', maxCostMicros: 5, maxCalls: 2 });
      owner = root.fork({ id: 'right', maxCostMicros: 5, maxCalls: 2 });
      ticket = left.reserveBundle([{ id: 'left-ticket', maxCostMicros: 3 }]).tickets[0];
    }
    expect(() => assertBudgetTicket(ticket, owner)).toThrow();
    expect(() => bindToolBudgetTicket(f.tool, ticket as BudgetTicket, { ...f.context, budget: owner })).toThrow();
    expect(f.execute).not.toHaveBeenCalled(); f.bundle.close();
  });

  it('rejects a cost mismatch and cannot rebind the same genuine ticket', () => {
    const f = fixture();
    const wrong = defineTool({ id: 'bound.other', version: '1', description: 'Wrong price.', input: z.string(), output: z.string(),
      effects: 'none', capabilities: [], costMicros: 2, execute: input => input });
    expect(() => bindToolBudgetTicket(wrong, f.ticket, f.context)).toThrow();
    const binding = bindToolBudgetTicket(f.tool, f.ticket, f.context);
    expect(binding.kind).toBe('mayura.tool-budget-ticket');
    expect(() => bindToolBudgetTicket(f.tool, f.ticket, f.context)).toThrow(); f.bundle.close();
  });

  it.each(['budget', 'runId', 'callId', 'principal', 'project', 'signal', 'tool', 'copy', 'proxy'] as const)('rejects a mismatched %s binding before an effect', async field => {
    const f = fixture(); const binding = bindToolBudgetTicket(f.tool, f.ticket, f.context);
    let tool = f.tool;
    const options = { ...f.context, budgetBinding: binding };
    if (field === 'budget') options.budget = new Budget(5, 2);
    if (field === 'runId') options.runId = 'different-run';
    if (field === 'callId') options.callId = 'different-call';
    if (field === 'principal') options.scope = { ...f.context.scope, principalId: 'other' };
    if (field === 'project') options.scope = { ...f.context.scope, projectId: 'other' };
    if (field === 'signal') options.signal = new AbortController().signal;
    if (field === 'tool') tool = fixture().tool; // Same visible metadata, different registration.
    if (field === 'copy') options.budgetBinding = { ...binding };
    if (field === 'proxy') options.budgetBinding = new Proxy(binding, {});
    expect((await invokeTool(tool, 'value', options)).status).not.toBe('succeeded');
    expect(f.execute).not.toHaveBeenCalled(); expect(f.budget.snapshot().calls).toBe(0); f.bundle.close();
  });

  it('claims a binding once across concurrent invocations', async () => {
    const f = fixture(); const binding = bindToolBudgetTicket(f.tool, f.ticket, f.context);
    const results = await Promise.all([1, 2].map(() => invokeTool(f.tool, 'value', { ...f.context, budgetBinding: binding })));
    expect(results.filter(result => result.status === 'succeeded')).toHaveLength(1);
    expect(f.execute).toHaveBeenCalledOnce(); f.bundle.close();
  });

  it('does not bypass grants and does not reuse a denied attempt', async () => {
    const f = fixture(); const binding = bindToolBudgetTicket(f.tool, f.ticket, f.context);
    expect(await invokeTool(f.tool, 'value', { ...f.context, budgetBinding: binding, permissions: { allow: [] } }))
      .toMatchObject({ status: 'blocked', error: { code: 'PERMISSION_DENIED' } });
    expect((await invokeTool(f.tool, 'value', { ...f.context, budgetBinding: binding })).status).not.toBe('succeeded');
    expect(f.execute).not.toHaveBeenCalled(); expect(f.budget.snapshot().calls).toBe(0);
    f.bundle.close(); expect(f.budget.snapshot()).toEqual({ spentMicros: 0, reservedMicros: 0, calls: 0 });
  });

  it('rechecks a cancelled ticket after async input admission', async () => {
    const f = fixture(); const binding = bindToolBudgetTicket(f.tool, f.ticket, f.context);
    expect((await invokeTool(f.tool, 'value', { ...f.context, budgetBinding: binding,
      beforeDispatch: async () => { f.ticket.cancel(); } })).status).not.toBe('succeeded');
    expect(f.execute).not.toHaveBeenCalled(); f.bundle.close(); expect(f.budget.snapshot().calls).toBe(0);
  });
});
