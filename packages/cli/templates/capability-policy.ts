import { createRuntime, defineAgent, defineTool } from '@mayura/sdk';
import { scriptedModel } from '@mayura/testing';
import { z } from 'zod';

let executions = 0;
const protectedWrite = defineTool({ id: 'records.write', version: '1.0.0', description: 'Illustrate an explicitly gated write.',
  input: z.object({ value: z.string() }), output: z.object({ stored: z.boolean() }), effects: 'write',
  capabilities: ['records:write'], execute: () => { executions++; return { stored: true }; } });
const definition = defineAgent({ id: 'starter.capability-policy', version: '1.0.0', instructions: 'Request the protected write.',
  input: z.object({ request: z.string() }), output: z.object({ stored: z.boolean() }), tools: [protectedWrite], model: scriptedModel([
    { type: 'tool_calls', calls: [{ id: 'write-1', toolId: protectedWrite.id, input: { value: 'approved-data' } }], usage: { costMicros: 0 } },
  ]) });
const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:scripted', 'tool:records.write'] } });
try {
  const outcome = await runtime.submit(definition, { input: { request: 'Write without the records:write capability.' } }).result();
  if (outcome.status === 'succeeded' || executions !== 0) throw new Error('The missing capability did not fail closed.');
  console.log(JSON.stringify({ status: 'passed', deniedBeforeExecution: true }));
} finally { await runtime.close(); }
