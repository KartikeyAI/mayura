import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Budget, type ExecutionReceipt, type ExecutionSettlement } from '@mayura/core';
import { defineTool, invokeTool, ToolRefusal, type InvokeToolContext } from '../src/index.js';

const input = z.object({ ticketId: z.string() }); const output = z.object({ ok: z.boolean() });
function write(execute: Parameters<typeof defineTool<typeof input, typeof output>>[0]['execute']) {
  return defineTool({ id: 'tickets.close', version: '1', description: 'Close a ticket.', input, output, effects: 'write', capabilities: [], costMicros: 5, execute });
}
function context(receipts: [ExecutionReceipt, ExecutionSettlement][]): InvokeToolContext {
  return { runId: 'run-1', callId: 'call-1', scope: { principalId: 'p', projectId: 'x' }, signal: new AbortController().signal,
    permissions: { allow: ['tool:tickets.close', 'effect:write'] }, budget: new Budget(100, 20),
    onExecutionReceipt: async (receipt, settlement) => { receipts.push([receipt, settlement]); } };
}

describe('tool refusals', () => {
  it('record a refused call as not started: failed, nothing charged, no reconciliation', async () => {
    const receipts: [ExecutionReceipt, ExecutionSettlement][] = []; const budget = context(receipts).budget;
    const result = await invokeTool(write(() => { throw new ToolRefusal(); }), { ticketId: 'T-404' }, { ...context(receipts), budget });
    expect(result).toMatchObject({ status: 'failed', error: { code: 'TOOL_FAILED', message: 'The tool refused the call before any external effect.' },
      receipt: { execution: 'not_started' } });
    expect(receipts).toEqual([[expect.objectContaining({ execution: 'not_started' }), { knownCostMicros: 0, unknownCostMicros: 0 }]]);
    expect(budget.snapshot()).toMatchObject({ spentMicros: 0, reservedMicros: 0 });
  });

  it('are not believed after the tool reported spending, and any other exception stays possibly executed', async () => {
    const afterUsage = await invokeTool(write((_value, execution) => { execution.reportUsage({ knownCostMicros: 2, unknownCostMicros: 0 }); throw new ToolRefusal(); }),
      { ticketId: 'T-1' }, context([]));
    expect(afterUsage.status).toBe('outcome_unknown');
    const ordinary = await invokeTool(write(() => { throw new Error('ticket not found'); }), { ticketId: 'T-2' }, context([]));
    expect(ordinary).toMatchObject({ status: 'outcome_unknown', error: { code: 'OUTCOME_UNKNOWN' } });
    expect(JSON.stringify(ordinary)).not.toContain('ticket not found');
  });
});
