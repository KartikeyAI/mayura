import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MayuraError, ModelProviderError, type ModelAdapter, type ModelDefinitionCheck, type ModelRequest, type ModelResponse } from '@mayura/core';
import { defineTool } from '@mayura/tools';
import { agentAsTool, createRuntime, defineAgent } from '../src/index.js';

const final = (output: unknown): ModelResponse => ({ type: 'final', output: output as never, usage: { costMicros: 0 } });
function model(behaviour: (request: ModelRequest) => ModelResponse | Promise<ModelResponse>, extra: Partial<ModelAdapter> = {}): ModelAdapter & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return { id: 'fixture', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0, requests,
    async generate(request) { requests.push(request); return behaviour(request); }, ...extra };
}
const find = defineTool({ id: 'orders.find', version: '1', description: 'Find an order.', input: z.object({ orderId: z.string() }),
  output: z.object({ found: z.boolean() }), effects: 'read', capabilities: [], execute: () => ({ found: true }) });

describe('JSON Schemas from validators', () => {
  it('are generated for tools and the output, and sent with every model request', async () => {
    expect(find.inputJsonSchema).toEqual({ type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'], additionalProperties: false });
    const adapter = model(() => final({ reply: 'ok' }));
    const agent = defineAgent({ id: 'support', version: '1', instructions: 'Help.', input: z.object({ message: z.string() }), output: z.object({ reply: z.string() }), tools: [find], model: adapter });
    expect(agent.outputJsonSchema).toEqual({ type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'], additionalProperties: false });
    const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:fixture', 'tool:orders.find', 'effect:read'] } });
    try {
      expect(await runtime.submit(agent, { input: { message: 'hi' } }).result()).toMatchObject({ status: 'succeeded' });
      expect(adapter.requests[0]!.outputJsonSchema).toEqual(agent.outputJsonSchema);
      expect(adapter.requests[0]!.tools).toEqual([{ id: 'orders.find', description: 'Find an order.', inputJsonSchema: find.inputJsonSchema }]);
    } finally { await runtime.close(); }
    // A given schema wins, and an agent used as a tool shows its own input to the parent's model.
    const narrower = { type: 'object', properties: { reply: { type: 'string', maxLength: 10 } }, required: ['reply'], additionalProperties: false };
    const child = defineAgent({ id: 'child', version: '1', instructions: 'Help.', input: z.object({ topic: z.string() }), output: z.object({ reply: z.string() }), tools: [], model: adapter, outputJsonSchema: narrower });
    expect(child.outputJsonSchema).toEqual(narrower);
    expect(agentAsTool(child, { id: 'ask.child', description: 'Ask.', permissions: { allow: [] } }).inputJsonSchema).toMatchObject({ required: ['topic'] });
  });

  it('are checked by the model adapter when the agent is defined, with its message', () => {
    const seen: ModelDefinitionCheck[] = [];
    const strict = model(() => final({}), { checkDefinition: definition => { seen.push(definition); if (definition.tools.length) throw new MayuraError('INVALID_CONFIG', 'Tool "orders.find" input schema is not allowed.'); } });
    const options = { id: 'support', version: '1', instructions: 'Help.', input: z.object({ message: z.string() }), output: z.object({ reply: z.string() }), model: strict };
    expect(() => defineAgent({ ...options, tools: [find] })).toThrow('Agent support: Tool "orders.find" input schema is not allowed.');
    expect(() => defineAgent({ ...options, tools: [] })).not.toThrow();
    expect(seen[1]).toEqual({ tools: [], outputJsonSchema: { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'], additionalProperties: false } });
    const hostile = model(() => final({}), { checkDefinition: () => { throw new Error('PRIVATE detail'); } });
    expect(() => defineAgent({ ...options, tools: [], model: hostile })).toThrow('Agent support: the model adapter refused this agent\'s tools or output schema.');
  });
});

describe('model failures in outcomes', () => {
  const agentWith = (adapter: ModelAdapter) => defineAgent({ id: 'a', version: '1', instructions: 'Help.', input: z.string(), output: z.object({ reply: z.string() }), tools: [], model: adapter });
  const run = async (adapter: ModelAdapter) => {
    const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:fixture'] } });
    try { return await runtime.submit(agentWith(adapter), { input: 'hi' }).result(); } finally { await runtime.close(); }
  };

  it('say why, in Mayura\'s words only', async () => {
    expect(await run(model(() => { throw new ModelProviderError('authentication', { httpStatus: 401 }); }))).toEqual({ status: 'failed',
      error: { code: 'MODEL_FAILED', message: 'The model provider refused the credentials or access to this model (HTTP 401). Check the API key and that it may use this model.' } });
    expect(await run(model(() => { throw new ModelProviderError('configuration'); }))).toMatchObject({ status: 'failed', error: { code: 'INVALID_CONFIG' } });
    expect(await run(model(() => { throw new MayuraError('CANCELLED', 'timer'); }))).toMatchObject({ error: { code: 'MODEL_FAILED', message: expect.stringContaining('did not answer in time') } });
    // An adapter's own text never reaches the outcome, even in a MayuraError or a forged reason.
    const leaky = await run(model(() => { throw new MayuraError('MODEL_FAILED', 'PRIVATE provider body'); }));
    expect(leaky).toMatchObject({ error: { message: 'The model adapter failed to produce a response.' } });
    const forged = Object.assign(Object.create(ModelProviderError.prototype) as object, { reason: 'PRIVATE', message: 'PRIVATE' });
    expect(JSON.stringify(await run(model(() => { throw forged; })))).not.toContain('PRIVATE');
  });

  it('name the run budget when the tools the model asked for cost more than is left', async () => {
    const paid = defineTool({ id: 'paid', version: '1', description: 'Paid.', input: z.object({}), output: z.object({}), effects: 'none', capabilities: [], costMicros: 50, execute: () => ({}) });
    const adapter = model(() => ({ type: 'tool_calls', calls: [{ id: 'c1', toolId: 'paid', input: {} }, { id: 'c2', toolId: 'paid', input: {} }], usage: { costMicros: 0 } }));
    const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:fixture', 'tool:paid'] }, limits: { maxCostMicros: 60 } });
    try {
      const agent = defineAgent({ id: 'a', version: '1', instructions: 'Help.', input: z.string(), output: z.object({}), tools: [paid], model: adapter });
      expect(await runtime.submit(agent, { input: 'hi' }).result()).toMatchObject({ status: 'blocked',
        error: { code: 'BUDGET_EXCEEDED', message: 'The tool calls the model asked for may cost up to 100 micros, but only 60 of the run\'s limits.maxCostMicros (60) are left.' } });
    } finally { await runtime.close(); }
  });
});
