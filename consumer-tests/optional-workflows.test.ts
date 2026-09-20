import { type Schema } from '@mayura/core';
import { defineTool, type ToolOutput } from '@mayura/tools';
import { createRuntime } from '@mayura/runtime';
import { createScheduledWorkflowRuntime, defineWorkflow, type WorkflowOutput } from '@mayura/workflows';
import { workflowAsAgent, workflowAsTool } from '@mayura/workflows/ephemeral';
import { StorageError, type AggregateStore, type ScheduledWorkflowAggregateStore } from '@mayura/storage-contracts';

const number: Schema<number> = { '~standard': { version: 1, vendor: 'consumer', validate: value => typeof value === 'number' ? { value } : { issues: [] } } };
const input: Schema<string, number> = { '~standard': { version: 1, vendor: 'consumer', validate: value => typeof value === 'string' ? { value: value.length } : { issues: [] } } };
const output: Schema<number, { answer: number }> = { '~standard': { version: 1, vendor: 'consumer', validate: value => typeof value === 'number' ? { value: { answer: value } } : { issues: [] } } };
const tool = defineTool({ id: 'consumer.double', version: '1', description: 'Double admitted input.', input: number, output: number, effects: 'none', capabilities: [], execute: value => value * 2 });
const definition = defineWorkflow({ id: 'consumer.graph', version: '1', input, output,
  nodes: [{ id: 'double', kind: 'tool', tool, input: { kind: 'input', path: [] } }], result: { kind: 'step', stepId: 'double', path: [] },
});
const compiled = workflowAsAgent(definition, { profile: 'ephemeral' });
const wrapped = workflowAsTool(definition, { profile: 'ephemeral', id: 'consumer.graph-tool', description: 'Run the graph as a required child.', permissions: { allow: ['model:mayura.workflow', 'tool:consumer.double'] } });
const expected: WorkflowOutput<typeof definition> = { answer: 6 };
const expectedTool: ToolOutput<typeof wrapped> = expected;
// @ts-expect-error Composition retains the transformed output, not the pre-transform number.
const invalidTool: ToolOutput<typeof wrapped> = 6;
void expectedTool; void invalidTool;
const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:mayura.workflow', 'tool:consumer.double'] } });
const result = await runtime.submit(compiled, { input: 'abc' }).result();
if (result.status === 'succeeded') {
  const answer: number = result.output.answer;
  // @ts-expect-error Agent output is still schema-derived.
  const invalid: string = result.output.answer;
  void answer; void invalid;
}
if (false) {
  // @ts-expect-error Submission accepts the schema's original input, not the transformed length.
  runtime.submit(compiled, { input: 3 });
  // @ts-expect-error Composition requires explicit ephemeral opt-in.
  workflowAsAgent(definition, {});
  // @ts-expect-error A durable profile is not supported by this adapter.
  workflowAsAgent(definition, { profile: 'durable' });
}
const error: StorageError = new StorageError('CONFLICT', 'Safe fixture conflict.');
const contract: Pick<AggregateStore, 'close'> = { close: async () => {} };
void error; void contract;
// Compiles against the published-shape atomic capability without installing any SQL driver.
function checkScheduledAdapter(store: ScheduledWorkflowAggregateStore): void {
  const scheduled = createScheduledWorkflowRuntime({ store, workerId: 'consumer',
    scope: { principalId: 'consumer', projectId: 'project' }, permissions: { allow: ['tool:consumer.double'] },
    policyVersion: '1', maxCostMicros: 0, storageTimeoutMs: 1_000, maxPendingStorageOperations: 8,
  });
  const profile: 'scheduled-v1' = scheduled.profile;
  void profile;
  const reference = scheduled.reference('a'.repeat(64));
  void reference.then(value => { const kind: 'scheduled-workflow' = value.kind; void kind; });
  void scheduled.submit(definition, { input: 'abc', idempotencyKey: 'original-input' });
  // @ts-expect-error Scheduled submission accepts the original schema input, not its transformed value.
  void scheduled.submit(definition, { input: 3, idempotencyKey: 'invalid-input' });
  // @ts-expect-error Generic aggregate access does not provide atomic scheduled execution.
  createScheduledWorkflowRuntime({ store: contract, workerId: 'consumer', scope: { principalId: 'consumer', projectId: 'project' }, permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0 });
}
void checkScheduledAdapter;
await runtime.close();
