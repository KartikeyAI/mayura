import { defineTool, defineAgent, createRuntime } from '@mayura/sdk';
import { scriptedModel } from '@mayura/testing';
import { z } from 'zod';

// This fixture verifies tool execution; it is not an inference model or a reasoning demonstration.
const add = defineTool({
  id: 'math.add', version: '1.0.0', description: 'Add two finite numbers.',
  input: z.object({ left: z.number().finite(), right: z.number().finite() }),
  output: z.object({ sum: z.number().finite() }),
  effects: 'none', capabilities: [],
  execute: ({ left, right }) => ({ sum: left + right }),
});
const agent = defineAgent({
  id: 'calculator', version: '1.0.0', instructions: 'Use the addition tool.',
  input: z.object({ request: z.string() }), output: z.object({ answer: z.number() }), tools: [add],
  model: scriptedModel([
    { type: 'tool_calls', calls: [{ id: 'add-1', toolId: 'math.add', input: { left: 2, right: 3 } }], usage: { costMicros: 0 } },
    { type: 'final', output: { answer: 5 }, usage: { costMicros: 0 } },
  ]),
});
const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:scripted', 'tool:math.add'] } });
try {
  const run = runtime.submit(agent, { input: { request: 'Add 2 and 3.' } });
  const result = await run.result();
  console.log(JSON.stringify(result));
  if (result.status !== 'succeeded') process.exitCode = 1;
} finally { await runtime.close(); }
