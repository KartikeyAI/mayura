import assert from 'node:assert/strict';
import { createRuntime, defineAgent, defineHook, defineTool } from 'mayura';

// Credential-free admission mechanics, not a filesystem or enterprise policy implementation.
const text = { '~standard': { version: 1, vendor: 'example', validate: value =>
  typeof value === 'string' && value.length > 0 ? { value } : { issues: [{ message: 'Expected nonempty text.' }] } } };
const number = { '~standard': { version: 1, vendor: 'example', validate: value =>
  typeof value === 'number' && Number.isSafeInteger(value) ? { value } : { issues: [{ message: 'Expected integer.' }] } } };
const policy = defineTool({ id: 'policy.assert-allowed', version: '1', description: 'Required local assertion.',
  input: text, output: number, effects: 'none', capabilities: [], costMicros: 1,
  guards: { input: [{ id: 'project-prefix', check: value => ({ decision: value.startsWith('project:') ? 'allow' : 'block' }) }] },
  execute: () => 1 });
const length = defineTool({ id: 'text.length', version: '1', description: 'Count text characters.',
  input: text, output: number, effects: 'none', capabilities: [], costMicros: 1, execute: value => value.length });
const hooks = [
  defineHook({ id: 'entry', version: '1', stage: 'beforeExecution', tools: [policy],
    handler: event => ({ decision: 'continue', actions: [{ toolId: policy.id, input: event.input }] }) }),
  defineHook({ id: 'model-request', version: '1', stage: 'beforeModelCall', tools: [],
    handler: event => {
      assert.equal(event.purpose, 'primary'); assert.equal(event.modelId, 'example-model');
      assert.equal('instructions' in event.request, false); assert.equal('continuation' in event.request, false);
      assert(Object.isFrozen(event.request.messages));
      return { decision: 'continue' };
    } }),
  defineHook({ id: 'proposal', version: '1', stage: 'beforeToolCall', tools: [policy],
    handler: event => ({ decision: 'continue', actions: [{ toolId: policy.id, input: event.proposal.input }] }) }),
  defineHook({ id: 'release', version: '1', stage: 'beforeOutputRelease', tools: [],
    handler: event => ({ decision: typeof event.candidate === 'number' && event.candidate > 0 ? 'continue' : 'block' }) }),
];
let primaryCalls = 0;
const agent = defineAgent({ id: 'hook-example', version: '1', instructions: 'Count the supplied text.',
  input: text, output: number, tools: [length], hooks,
  model: { id: 'example-model', maxCostMicros: 0, capabilities: { tools: true, structuredOutput: true },
    generate: async request => {
      assert.deepEqual(request.tools.map(tool => tool.id), [length.id]);
      primaryCalls++;
      return primaryCalls === 1
        ? { type: 'tool_calls', calls: [{ id: 'length.1', toolId: length.id, input: request.messages[0].content }], usage: { costMicros: 0 } }
        : { type: 'final', output: request.messages.at(-1).result, usage: { costMicros: 0 } };
    } } });
const runtime = createRuntime({ profile: 'ephemeral',
  permissions: { allow: ['model:example-model', 'tool:text.length', 'tool:policy.assert-allowed'] },
  limits: { maxCostMicros: 3, maxSteps: 2, maxModelCalls: 2, maxToolCalls: 3, maxHookCalls: 6, maxConcurrentOperations: 1 } });
try {
  const run = runtime.submit(agent, { input: 'project:mayura' });
  const result = await run.result(); assert.equal(result.status, 'succeeded'); assert.equal(result.output, 14);
  assert.equal(result.evidence.length, 3);
  const budget = runtime.inspect(run).budget;
  assert.deepEqual(budget, { spentMicros: 3, reservedMicros: 0, calls: 5 });
  const events = []; for await (const event of run.observe()) events.push(event);
  assert.equal(events.filter(event => event.type === 'hook.started').length, 6);
  assert.equal(events.filter(event => event.type === 'hook.completed' && event.metadata.status === 'continued').length, 6);
  console.log(JSON.stringify({ status: result.status, output: result.output, hooks: 6, toolReceipts: result.evidence.length, budget }));
} finally { await runtime.close(); }
