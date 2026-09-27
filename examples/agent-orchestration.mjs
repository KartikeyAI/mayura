import { agentAsTool, createRuntime, defineAgent } from 'mayura';
import { scriptedModel } from 'mayura/testing';

// These Standard Schema validators need no application validator dependency.
const text = { '~standard': { version: 1, vendor: 'example', validate: (value) => typeof value === 'string'
  ? { value } : { issues: [{ message: 'Expected text.' }] } } };
const lengthInput = { '~standard': { version: 1, vendor: 'example', validate: (value) => typeof value === 'string'
  ? { value: value.length } : { issues: [{ message: 'Expected text.' }] } } };
const lengthOutput = { '~standard': { version: 1, vendor: 'example', validate: (value) => Number.isSafeInteger(value) && value >= 0
  ? { value: { length: value } } : { issues: [{ message: 'Expected a nonnegative integer.' }] } } };
const resultSchema = { '~standard': { version: 1, vendor: 'example', validate: (value) => value !== null && typeof value === 'object'
  && Number.isSafeInteger(value.length) && value.length >= 0
  ? { value } : { issues: [{ message: 'Expected a length result.' }] } } };

const child = defineAgent({
  id: 'length-child', version: '1', instructions: 'Return the admitted character count.',
  input: lengthInput, output: lengthOutput, tools: [],
  // A deterministic protocol fixture, not an actual model or reasoning demonstration.
  model: scriptedModel([(request) => {
    const input = request.messages[0];
    if (input?.role !== 'user' || typeof input.content !== 'number') throw new Error('Missing admitted child input.');
    return { type: 'final', output: input.content, usage: { costMicros: 0 } };
  }]),
});
const childTool = agentAsTool(child, {
  id: 'text.length', description: 'Count text characters in a required child run.',
  permissions: { allow: ['model:scripted'] }, limits: { maxCostMicros: 0 },
});
const parent = defineAgent({
  id: 'length-parent', version: '1', instructions: 'Delegate the calculation and return its admitted result.',
  input: text, output: resultSchema, tools: [childTool],
  model: scriptedModel([
    (request) => {
      const input = request.messages[0];
      if (input?.role !== 'user') throw new Error('Missing parent input.');
      return { type: 'tool_calls', calls: [{ id: 'length-1', toolId: 'text.length', input: input.content }], usage: { costMicros: 0 } };
    },
    (request) => {
      const output = request.messages.at(-1);
      if (output?.role !== 'tool') throw new Error('Missing admitted child result.');
      return { type: 'final', output: output.result, usage: { costMicros: 0 } };
    },
  ]),
});
const runtime = createRuntime({
  profile: 'ephemeral', permissions: { allow: ['agent:delegate', 'model:scripted', 'tool:text.length'] },
  limits: { maxCostMicros: 0, maxDescendantRuns: 1, maxDepth: 1, maxConcurrentOperations: 1 },
});
try {
  const run = runtime.submit(parent, { input: 'Mayura' });
  const outcome = await run.result();
  if (outcome.status !== 'succeeded') throw new Error(`Example did not succeed: ${outcome.error.code}`);
  const inspection = runtime.inspect(run);
  console.log(JSON.stringify({ result: outcome.output, runs: inspection.runs.length, budget: inspection.budget }));
} finally { await runtime.close(); }
