import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createRuntime, defineAgent } from '@mayura/runtime';
import { defineTool, ToolRefusal } from '@mayura/tools';
import { scriptedModel, testTool, toolGrants } from '../src/index.js';

describe('scriptedModel', () => {
  it('streams a final answer in pieces for an agent with a stream policy, like a provider', async () => {
    const agent = defineAgent({ id: 'writer', version: '1', instructions: 'Write.', input: z.string(), output: z.object({ reply: z.string() }), tools: [],
      model: scriptedModel([{ type: 'final', output: { reply: 'A streamed reply, one piece at a time.' }, usage: { costMicros: 0 } }], { streamChunk: 8 }),
      stream: { field: ['reply'], guards: [], batch: { minChars: 1, maxChars: 64 } } });
    const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:scripted'] } });
    try {
      const run = runtime.submit(agent, { input: 'go' }); const deltas: string[] = [];
      for await (const event of run.observe()) if (event.type === 'output.delta') deltas.push(String(event.metadata['text']));
      expect(deltas.length).toBeGreaterThan(1);
      expect(deltas.join('')).toBe('A streamed reply, one piece at a time.');
      expect(await run.result()).toEqual({ status: 'succeeded', output: { reply: 'A streamed reply, one piece at a time.' } });
    } finally { await runtime.close(); }
    expect(() => scriptedModel([], { streamChunk: 0 })).toThrow(/streamChunk/u);
  });
});

describe('testTool', () => {
  const refund = defineTool({ id: 'orders.refund', version: '1', description: 'Refund.', input: z.object({ orderId: z.string() }), output: z.object({ refunded: z.boolean() }),
    effects: 'write', capabilities: ['payments:refund'], costMicros: 10,
    execute: ({ orderId }) => { if (orderId === 'missing') throw new ToolRefusal('No such order.'); if (orderId === 'boom') throw new Error('PRIVATE'); return { refunded: true }; } });

  it('runs one tool through the broker with exactly the grants it needs', async () => {
    expect(toolGrants(refund)).toEqual(['tool:orders.refund', 'payments:refund', 'effect:write']);
    expect(await testTool(refund, { orderId: 'A1' })).toMatchObject({ outcome: { status: 'succeeded', output: { refunded: true } }, spentMicros: 10, reservedMicros: 0,
      receipt: { toolId: 'orders.refund', execution: 'succeeded' } });
  });

  it('shows permission, validation, refusal and uncertain outcomes as a run would', async () => {
    expect((await testTool(refund, { orderId: 'A1' }, { permissions: ['tool:orders.refund', 'effect:write'] })).outcome).toMatchObject({ status: 'blocked', error: { code: 'PERMISSION_DENIED' } });
    expect((await testTool(refund, { order: 'A1' })).outcome).toMatchObject({ status: 'failed', error: { code: 'INVALID_INPUT' } });
    expect(await testTool(refund, { orderId: 'missing' })).toMatchObject({ outcome: { status: 'failed', error: { message: 'No such order.' } }, spentMicros: 0 });
    const uncertain = await testTool(refund, { orderId: 'boom' });
    expect(uncertain).toMatchObject({ outcome: { status: 'outcome_unknown' }, receipt: { execution: 'unknown' } });
    expect(JSON.stringify(uncertain)).not.toContain('PRIVATE');
    expect((await testTool(refund, { orderId: 'A1' }, { budgetMicros: 5 })).outcome).toMatchObject({ status: 'blocked', error: { code: 'BUDGET_EXCEEDED' } });
  });
});
