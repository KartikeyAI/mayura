import { scriptedModel } from '@mayura/testing';
import { describe, expect, it } from 'vitest';
import { z as zod } from 'zod';
import { createRuntime, defineAgent, defineTool, jsonSchemaOf, z } from '../src/index.js';

const lookup = defineTool({
  id: 'orders.lookup', version: '1', description: 'Look up an order.',
  input: z.object({ orderId: z.string() }), output: z.object({ status: z.string() }),
  effects: 'read', capabilities: [], execute: () => ({ status: 'shipped' }),
});

const support = (model: ReturnType<typeof scriptedModel>) => defineAgent({
  id: 'support', version: '1', instructions: 'Answer questions about orders.', model, tools: [lookup],
  input: z.object({ message: z.string() }), output: z.object({ reply: z.string() }),
});

const run = async (model: ReturnType<typeof scriptedModel>) => {
  const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:scripted', 'tool:orders.lookup', 'effect:read'] } });
  try {
    return await runtime.submit(support(model), { input: { message: 'Where is A1?' } }).result();
  } finally {
    await runtime.close();
  }
};

const call = { type: 'tool_calls', calls: [{ id: 'call-1', toolId: 'orders.lookup', input: { orderId: 'A1' } }], usage: { costMicros: 0 } } as const;

describe('z from the root import', () => {
  it('is Zod itself, so a project needs no schema library of its own', () => {
    expect(z).toBe(zod);
  });

  it('describes its schemas to model providers', () => {
    expect(jsonSchemaOf(z.object({ orderId: z.string() }))).toMatchObject({
      type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'],
    });
  });

  it('types and validates a run end to end', async () => {
    const result = await run(scriptedModel([call, { type: 'final', output: { reply: 'It has shipped.' }, usage: { costMicros: 0 } }]));
    expect(result.status).toBe('succeeded');
    if (result.status === 'succeeded') expect(result.output.reply).toBe('It has shipped.');
  });

  it('fails a run whose output the schema rejects', async () => {
    const result = await run(scriptedModel([call, { type: 'final', output: { reply: 42 }, usage: { costMicros: 0 } }]));
    expect(result.status).toBe('failed');
  });
});
