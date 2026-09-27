import { createRuntime, defineTool } from 'mayura';
import { defineWorkflow } from 'mayura/workflows';
import { workflowAsAgent, workflowAsTool } from 'mayura/workflows/ephemeral';

// Small Standard Schema validators keep this example dependency-free.
const text = { '~standard': { version: 1, vendor: 'example', validate: value => typeof value === 'string'
  ? { value } : { issues: [{ message: 'Expected text.' }] } } };
const summary = { '~standard': { version: 1, vendor: 'example', validate: value => value !== null && typeof value === 'object'
  && typeof value.text === 'string' && Number.isSafeInteger(value.characters) && value.characters >= 0
  ? { value } : { issues: [{ message: 'Expected a text summary.' }] } } };

const normalize = defineTool({
  id: 'text.normalize', version: '1', description: 'Trim and normalize whitespace.',
  input: text, output: text, effects: 'none', capabilities: [],
  execute: value => value.trim().replace(/\s+/gu, ' '),
});
const describe = defineTool({
  id: 'text.describe', version: '1', description: 'Return text and its Unicode code-point count.',
  input: text, output: summary, effects: 'none', capabilities: [],
  execute: value => ({ text: value, characters: [...value].length }),
});
const textWorkflow = defineWorkflow({
  id: 'text-summary', version: '1', input: text, output: summary,
  nodes: [
    { kind: 'tool', id: 'normalize', tool: normalize, input: { kind: 'input', path: [] } },
    { kind: 'tool', id: 'describe', tool: describe, dependsOn: ['normalize'], input: { kind: 'step', stepId: 'normalize', path: [] } },
  ],
  result: { kind: 'step', stepId: 'describe', path: [] },
});
const childGrants = ['model:mayura.workflow', 'tool:text.normalize', 'tool:text.describe'];
const summarize = workflowAsTool(textWorkflow, {
  profile: 'ephemeral', id: 'workflow.summarize', description: 'Run the text workflow as a required child.',
  permissions: { allow: childGrants }, limits: { maxCostMicros: 0 },
});
const parentWorkflow = defineWorkflow({
  id: 'summary-parent', version: '1', input: text, output: summary,
  nodes: [{ kind: 'tool', id: 'summary', tool: summarize, input: { kind: 'input', path: [] } }],
  result: { kind: 'step', stepId: 'summary', path: [] },
});
const runtime = createRuntime({
  profile: 'ephemeral', permissions: { allow: [...childGrants, 'tool:workflow.summarize', 'agent:delegate'] },
  limits: { maxCostMicros: 0, maxModelCalls: 8, maxToolCalls: 4, maxDescendantRuns: 1, maxDepth: 1, maxConcurrentOperations: 1 },
});
try {
  // This planner is local deterministic framework code, not an LLM or model fixture.
  const run = runtime.submit(workflowAsAgent(parentWorkflow, { profile: 'ephemeral' }), { input: '  Mayura   framework  ' });
  const outcome = await run.result();
  if (outcome.status !== 'succeeded') throw new Error(`Workflow example did not succeed: ${outcome.error.code}`);
  const inspection = runtime.inspect(run);
  console.log(JSON.stringify({ result: outcome.output, runs: inspection.runs.length, budget: inspection.budget }));
} finally { await runtime.close(); }
