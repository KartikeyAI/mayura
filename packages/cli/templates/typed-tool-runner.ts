import { createRuntime, defineAgent, defineTool } from 'mayura';
import { scriptedModel } from 'mayura/testing';
import { z } from 'zod';

const add = defineTool({ id: 'math.add', version: '1.0.0', description: 'Add two finite numbers.',
  input: z.object({ left: z.number().finite(), right: z.number().finite() }), output: z.object({ sum: z.number().finite() }),
  effects: 'none', capabilities: [], execute: input => ({ sum: input.left + input.right }) });
const agent = defineAgent({ id: 'starter.typed-tool-runner', version: '1.0.0', instructions: 'Use the typed addition tool.',
  input: z.object({ request: z.string() }), output: z.object({ answer: z.number() }), tools: [add], model: scriptedModel([
    { type: 'tool_calls', calls: [{ id: 'call-1', toolId: 'math.add', input: { left: 20, right: 22 } }], usage: { costMicros: 0 } },
    { type: 'final', output: { answer: 42 }, usage: { costMicros: 0 } },
  ]) });
const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:scripted', 'tool:math.add'] } });
try { const result = await runtime.submit(agent, { input: { request: 'Add 20 and 22.' } }).result(); console.log(JSON.stringify(result)); }
finally { await runtime.close(); }
