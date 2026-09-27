import assert from 'node:assert/strict';
import { createRuntime, defineAgent } from 'mayura';
import { defineModerationGuard } from '../packages/guardrails/dist/index.js';

// Credential-free adapters establish mechanics only; they do not perform semantic moderation.
const schema = { '~standard': { version: 1, vendor: 'mayura-example', validate: value =>
  typeof value === 'string' ? { value } : { issues: [{ message: 'Expected text.' }] } } };
const moderator = { id: 'moderator', maxCostMicros: 3, capabilities: { tools: false, structuredOutput: true },
  async generate(request) {
    assert.equal(request.tools.length, 0); assert.equal(request.messages.length, 1);
    return { type: 'final', output: { decision: 'allow', categories: [] }, usage: { costMicros: 3 } };
  } };
const moderation = defineModerationGuard({ id: 'example-policy', version: '1', model: moderator,
  instructions: 'Return the example policy verdict.', egressGuards: [] });
const agent = defineAgent({ id: 'example-agent', version: '1', instructions: 'Return the example answer.',
  input: schema, output: schema, tools: [], guards: { input: [moderation], output: [moderation] },
  model: { id: 'primary', maxCostMicros: 2, capabilities: { tools: false, structuredOutput: true },
    async generate() { return { type: 'final', output: 'Checked answer.', usage: { costMicros: 2 } }; } } });
const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:primary', 'model:moderator'] },
  limits: { maxCostMicros: 8, maxModelCalls: 3, maxSteps: 1, maxConcurrentOperations: 1 } });
try {
  const run = runtime.submit(agent, { input: 'Example request.' });
  const result = await run.result(); assert.equal(result.status, 'succeeded');
  const budget = runtime.inspect(run).budget;
  assert.deepEqual(budget, { spentMicros: 8, reservedMicros: 0, calls: 3 });
  console.log(JSON.stringify({ status: result.status, output: result.output, budget }));
} finally { await runtime.close(); }
