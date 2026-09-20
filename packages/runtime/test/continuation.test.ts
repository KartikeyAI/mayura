import { expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '@mayura/tools';
import type { ModelAdapter, ModelMessage } from '@mayura/core';
import { defineAgent, createRuntime } from '../src/index.js';

it('keeps opaque provider continuation private, immutable and isolated between concurrent runs', async () => {
  const double = defineTool({ id: 'double', version: '1', description: 'Double a number', input: z.number(), output: z.number(), effects: 'none', capabilities: [], execute: value => value * 2 });
  const model: ModelAdapter = {
    id: 'continuation-fixture', maxCostMicros: 0, capabilities: { tools: true, structuredOutput: true },
    async generate(request) {
      const first = request.messages[0] as Extract<ModelMessage, { role: 'user' }>;
      const value = first.content as number;
      if (request.continuation === undefined) {
        return { type: 'tool_calls', calls: [{ id: `double-${value}`, toolId: 'double', input: value }], usage: { costMicros: 0 }, continuation: { protected: 'private-continuation', value } };
      }
      expect(Object.isFrozen(request.continuation)).toBe(true);
      expect(request.continuation).toEqual({ protected: 'private-continuation', value });
      expect(JSON.stringify(request.messages)).not.toContain('private-continuation');
      return { type: 'final', output: value * 2, usage: { costMicros: 0 } };
    },
  };
  const agent = defineAgent({ id: 'continuation', version: '1', instructions: 'Double', input: z.number(), output: z.number(), tools: [double], model });
  const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:continuation-fixture', 'tool:double'] } });
  try {
    const first = runtime.submit(agent, { input: 2 }); const second = runtime.submit(agent, { input: 7 });
    expect(await Promise.all([first.result(), second.result()])).toEqual([{ status: 'succeeded', output: 4 }, { status: 'succeeded', output: 14 }]);
    for (const run of [first, second]) {
      for await (const event of run.observe()) expect(JSON.stringify(event)).not.toContain('private-continuation');
    }
  } finally { await runtime.close(); }
});
