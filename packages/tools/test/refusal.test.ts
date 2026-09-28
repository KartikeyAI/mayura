import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Budget, type ExecutionReceipt, type ExecutionSettlement } from '@mayura/core';
import { defineTool, invokeTool, ToolRefusal, withPreflight, type InvokeToolContext } from '../src/index.js';

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

  it('carry the author\'s reason, and a preflight can refuse before the executor runs', async () => {
    const reasoned = await invokeTool(write(() => { throw new ToolRefusal('The person declined tickets.close.'); }), { ticketId: 'T-7' }, context([]));
    expect(reasoned).toMatchObject({ status: 'failed', error: { message: 'The person declined tickets.close.' }, receipt: { execution: 'not_started' } });
    const ran: string[] = []; const seen: string[] = [];
    const base = write(value => { ran.push(value.ticketId); return { ok: true }; });
    const checked = withPreflight(base, (value, execution) => { seen.push(`${value.ticketId}@${execution.runId}`); if (value.ticketId === 'T-0') throw new ToolRefusal('Not this one.'); },
      { extraTimeoutMs: 60_000, description: 'Close a ticket after a check.' });
    expect(checked).toMatchObject({ id: base.id, version: base.version, effects: 'write', timeoutMs: base.timeoutMs + 60_000, description: 'Close a ticket after a check.' });
    expect(await invokeTool(checked, { ticketId: 'T-0' }, context([]))).toMatchObject({ status: 'failed', error: { message: 'Not this one.' }, receipt: { execution: 'not_started' } });
    expect(await invokeTool(checked, { ticketId: 'T-1' }, context([]))).toMatchObject({ status: 'succeeded', output: { ok: true } });
    expect(seen).toEqual(['T-0@run-1', 'T-1@run-1']); expect(ran).toEqual(['T-1']);
    expect(() => withPreflight({ ...base }, () => {})).toThrow(/not created by this tools package/u);
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
