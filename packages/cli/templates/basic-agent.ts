import { createRuntime, defineAgent } from '@mayura/sdk';
import { scriptedModel } from '@mayura/testing';
import { z } from 'zod';

const agent = defineAgent({ id: 'starter.basic-agent', version: '1.0.0', instructions: 'Return a structured greeting.',
  input: z.object({ name: z.string().min(1).max(80) }), output: z.object({ greeting: z.string() }), tools: [],
  model: scriptedModel([{ type: 'final', output: { greeting: 'Hello from Mayura.' }, usage: { costMicros: 0 } }]) });
const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:scripted'] } });
try { const result = await runtime.submit(agent, { input: { name: 'developer' } }).result(); console.log(JSON.stringify(result)); }
finally { await runtime.close(); }
