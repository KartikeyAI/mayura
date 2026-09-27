import { describe, expect, it } from 'vitest';
import { MayuraError, type JsonValue, type ModelResponse, type Schema } from '@mayura/core';
import { createRuntime, defineAgent } from '../src/index.js';

const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'limits-test', validate: value => ({ value: value as JsonValue }) } };
const agent = (response: ModelResponse) => defineAgent({ id: 'writer', version: '1', instructions: 'x', input: any, output: any, tools: [],
  model: { id: 'fixture', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0, generate: async () => response } });

describe('runtime limits', () => {
  it('accepts zero tool calls for an agent without tools, and fails closed if its model proposes one anyway', async () => {
    const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:fixture'] }, limits: { maxToolCalls: 0 } });
    try {
      expect(await runtime.submit(agent({ type: 'final', output: 'done', usage: { costMicros: 0 } }), { input: 'x' }).result()).toMatchObject({ status: 'succeeded', output: 'done' });
      const proposed = await runtime.submit(agent({ type: 'tool_calls', calls: [{ id: 'c1', toolId: 'lookup', input: {} }], usage: { costMicros: 0 } }), { input: 'x' }).result();
      expect(proposed.status).not.toBe('succeeded');
    } finally { await runtime.close(); }
    expect(() => createRuntime({ profile: 'ephemeral', permissions: { allow: [] }, limits: { maxToolCalls: -1 } })).toThrow(MayuraError);
    expect(() => createRuntime({ profile: 'ephemeral', permissions: { allow: [] }, limits: { maxModelCalls: 0 } })).toThrow(MayuraError);
  });
});
