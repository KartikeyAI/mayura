import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Budget } from '@mayura/core';
import { defineTool, invokeTool, withPreflight } from '../src/index.js';
import { bindToolApproval, toolNeedsApproval } from '../src/host.js';

const base = { version: '1', description: 'Refund an order', input: z.object({ amount: z.number() }), output: z.object({ ok: z.boolean() }),
  effects: 'write' as const, capabilities: [], execute: () => ({ ok: true }) };

describe('a tool that needs approval', () => {
  it('declares it in its public definition, without the deciding function', () => {
    expect(defineTool({ ...base, id: 'always', approval: 'required' }).approval).toBe('required');
    const conditional = defineTool({ ...base, id: 'large', approval: input => input.amount > 100 });
    expect(conditional.approval).toBe('conditional');
    expect(JSON.stringify(conditional)).not.toContain('amount >');
    expect('approval' in defineTool({ ...base, id: 'never' })).toBe(false);
  });

  it('decides from the proposed input', () => {
    const tool = defineTool({ ...base, id: 'large', approval: input => input.amount > 100 });
    expect(toolNeedsApproval(tool, { amount: 5 })).toBe(false);
    expect(toolNeedsApproval(tool, { amount: 500 })).toBe(true);
    expect(toolNeedsApproval(defineTool({ ...base, id: 'always', approval: 'required' }), { amount: 0 })).toBe(true);
    expect(toolNeedsApproval(defineTool({ ...base, id: 'never' }), { amount: 1e9 })).toBe(false);
  });

  it('asks for approval when the deciding function throws or returns something other than false', () => {
    const throws = defineTool({ ...base, id: 'throws', approval: () => { throw new Error('broken policy'); } });
    expect(toolNeedsApproval(throws, { amount: 1 })).toBe(true);
    const odd = defineTool({ ...base, id: 'odd', approval: (() => undefined) as unknown as () => boolean });
    expect(toolNeedsApproval(odd, { amount: 1 })).toBe(true);
  });

  it('keeps its approval rule through withPreflight', () => {
    const tool = withPreflight(defineTool({ ...base, id: 'large', approval: input => input.amount > 100 }), () => undefined);
    expect(tool.approval).toBe('conditional');
    expect(toolNeedsApproval(tool, { amount: 500 })).toBe(true);
    expect(toolNeedsApproval(tool, { amount: 5 })).toBe(false);
  });

  it('refuses an approval that is neither required nor a function', () => {
    expect(() => defineTool({ ...base, id: 'bad', approval: 'sometimes' as never })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => toolNeedsApproval({ ...defineTool({ ...base, id: 'copy' }) }, {})).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });
});

describe('the broker and a call that needs approval', () => {
  const context = (tool: { id: string; effects: string }, extra: Record<string, unknown> = {}) => ({ runId: 'run-1', callId: 'call-1', scope: { principalId: 'p', projectId: 'q' },
    signal: new AbortController().signal, permissions: { allow: [`tool:${tool.id}`, `effect:${tool.effects}`] }, budget: new Budget(0, 1), ...extra });

  it('refuses the call without proof that a person approved it, and never runs it', async () => {
    const execute = vi.fn(() => ({ ok: true }));
    const tool = defineTool({ ...base, id: 'always', approval: 'required', execute });
    const outcome = await invokeTool(tool, { amount: 1 }, context(tool));
    expect(outcome).toMatchObject({ status: 'failed', error: { code: 'APPROVAL_UNAVAILABLE' }, receipt: { execution: 'not_started' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('runs exactly the approved call, once', async () => {
    const execute = vi.fn(() => ({ ok: true }));
    const tool = defineTool({ ...base, id: 'always', approval: 'required', execute });
    const approvalBinding = bindToolApproval(tool, { runId: 'run-1', callId: 'call-1', input: { amount: 1 } });
    expect((await invokeTool(tool, { amount: 1 }, context(tool, { approvalBinding }))).status).toBe('succeeded');
    expect((await invokeTool(tool, { amount: 1 }, context(tool, { approvalBinding }))).status).not.toBe('succeeded');
    for (const [input, extra] of [[{ amount: 2 }, {}], [{ amount: 1 }, { callId: 'call-2' }], [{ amount: 1 }, { runId: 'run-2' }]] as const) {
      const other = bindToolApproval(tool, { runId: 'run-1', callId: 'call-1', input: { amount: 1 } });
      expect(await invokeTool(tool, input, context(tool, { approvalBinding: other, ...extra }))).toMatchObject({ error: { code: 'APPROVAL_UNAVAILABLE' } });
    }
    const forTool = bindToolApproval(defineTool({ ...base, id: 'other', approval: 'required' }), { runId: 'run-1', callId: 'call-1', input: { amount: 1 } });
    expect(await invokeTool(tool, { amount: 1 }, context(tool, { approvalBinding: forTool }))).toMatchObject({ error: { code: 'APPROVAL_UNAVAILABLE' } });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('runs a call its rule does not pick without any proof', async () => {
    const tool = defineTool({ ...base, id: 'large', approval: input => input.amount > 100 });
    expect((await invokeTool(tool, { amount: 5 }, context(tool))).status).toBe('succeeded');
    expect(await invokeTool(tool, { amount: 500 }, context(tool))).toMatchObject({ error: { code: 'APPROVAL_UNAVAILABLE' } });
  });
});
