import { type Schema } from '@mayura/core';
import { defineTool, type ToolOutput } from '@mayura/tools';
import { createRuntime } from '@mayura/runtime';
import { composeExternalEffectVerifiers, createScheduledWorkflowRuntime, defineExternalEffectVerifier, defineWorkflow,
  type ExternalEffectReconciliationRequest, type WorkflowOutput } from '@mayura/workflows';
import { workflowAsAgent, workflowAsTool } from '@mayura/workflows/ephemeral';
import { createWorkflowLifecycleFleetRuntime, createWorkflowLifecycleHost, createWorkflowLifecycleHumanTransport, defineWorkflowLifecycle,
  type WorkflowLifecycleDefinition } from '@mayura/workflows/lifecycle';
import { createWorkflowSagaRuntime, defineWorkflowSaga, type WorkflowSagaDefinition,
  type WorkflowSagaOutput } from '@mayura/workflows/sagas';
import { createWorkflowLoopRuntime, defineWorkflowLoop, type WorkflowLoopDefinition,
  type WorkflowLoopOutput } from '@mayura/workflows/loops';
import { createWorkflowCompositeFleetRuntime, createWorkflowCompositeHost,
  type WorkflowCompositeFleetRuntime } from '@mayura/workflows/composites';
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
const lifecycle = defineWorkflowLifecycle({ id: 'consumer.lifecycle', version: '1', input, output,
  nodes: [{ kind: 'human', id: 'review', request: { kind: 'information', schemaId: 'consumer/response',
    schemaDigest: 'a'.repeat(64), prompt: 'Review.', response: number } }],
  result: { kind: 'step', stepId: 'review', path: [] } });
const lifecycleOutput: WorkflowOutput<typeof definition> = { answer: 6 };
void lifecycle; void lifecycleOutput;
const sagaChild = defineWorkflowLifecycle({ id: 'consumer.saga-child', version: '1', input: number, output: number,
  nodes: [{ kind: 'join', id: 'done', dependsOn: [] }], result: { kind: 'input', path: [] } });
const saga = defineWorkflowSaga({ id: 'consumer.saga', version: '1', input: number, output: number,
  steps: [{ id: 'child', forward: sagaChild, input: { kind: 'input', path: [] } }],
  result: { kind: 'step', stepId: 'child', path: [] } });
const sagaOutput: WorkflowSagaOutput<typeof saga> = 3; void sagaOutput;
const loopState: Schema<{ continue: boolean; value: number }> = { '~standard': { version: 1, vendor: 'consumer',
  validate: value => typeof value === 'object' && value !== null && typeof (value as { continue?: unknown }).continue === 'boolean'
    && typeof (value as { value?: unknown }).value === 'number' ? { value: value as { continue: boolean; value: number } } : { issues: [] } } };
const loopBody = defineWorkflowLifecycle({ id: 'consumer.loop-child', version: '1', input: loopState, output: loopState,
  nodes: [{ kind: 'join', id: 'done', dependsOn: [] }], result: { kind: 'input', path: [] } });
const loop = defineWorkflowLoop({ id: 'consumer.loop', version: '1', input: loopState, output: number,
  body: loopBody, maxIterations: 2, initial: { kind: 'input', path: [] }, next: { kind: 'current', path: [] },
  continueWhen: { kind: 'current', path: ['continue'] }, result: { kind: 'current', path: ['value'] } });
const loopOutput: WorkflowLoopOutput<typeof loop> = 3; void loopOutput;
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
  // @ts-expect-error Structural values cannot forge format-5 executable definitions.
  const forgedLifecycle: WorkflowLifecycleDefinition = { id: 'forged' };
  void forgedLifecycle;
  // @ts-expect-error Structural values cannot forge format-1 executable sagas.
  const forgedSaga: WorkflowSagaDefinition = { id: 'forged' };
  void forgedSaga;
  // @ts-expect-error Structural values cannot forge format-1 executable loops.
  const forgedLoop: WorkflowLoopDefinition = { id: 'forged' };
  void forgedLoop;
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
function checkLifecycleAdapter(store: AggregateStore): void {
  const runtime = createWorkflowLifecycleFleetRuntime({ store, scope: { principalId: 'consumer', projectId: 'project' },
    permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0,
    verifyHuman: async () => ({ id: 'reviewer', projectId: 'project', canApprove: false }) });
  const profile: 'lifecycle-v1' = runtime.profile; void profile;
  const humans = createWorkflowLifecycleHumanTransport({ scope: { principalId: 'consumer', projectId: 'project' } });
  humans.register({ agentId: 'consumer', definition: lifecycle, runtime, runId: 'a'.repeat(64) });
  void runtime.submit(lifecycle, { input: 'abc', idempotencyKey: 'lifecycle' });
}
void checkLifecycleAdapter;
function checkLifecycleHost(store: AggregateStore): void {
  const host = createWorkflowLifecycleHost({ store, definitions: [sagaChild],
    scope: { principalId: 'consumer', projectId: 'project' }, permissions: { allow: [] },
    policyVersion: '1', maxCostMicros: 0 });
  host.start(); void host.stop(); void host.close();
}
void checkLifecycleHost;
function checkSagaAdapter(store: AggregateStore): void {
  const runtime = createWorkflowSagaRuntime({ store, scope: { principalId: 'consumer', projectId: 'project' },
    permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0 });
  const profile: 'saga-v1' = runtime.profile; void profile;
  void runtime.submit(saga, { input: 3, idempotencyKey: 'saga' });
  // @ts-expect-error Saga submission accepts the original schema input.
  void runtime.submit(saga, { input: '3', idempotencyKey: 'invalid' });
}
void checkSagaAdapter;
function checkLoopAdapter(store: AggregateStore): void {
  const runtime = createWorkflowLoopRuntime({ store, scope: { principalId: 'consumer', projectId: 'project' },
    permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0 });
  const profile: 'loop-v1' = runtime.profile; void profile;
  void runtime.submit(loop, { input: { continue: false, value: 3 }, idempotencyKey: 'loop' });
  // @ts-expect-error Loop submission preserves its input schema type.
  void runtime.submit(loop, { input: 3, idempotencyKey: 'invalid' });
}
void checkLoopAdapter;
function checkCompositeAdapter(store: AggregateStore): void {
  const runtime: WorkflowCompositeFleetRuntime = createWorkflowCompositeFleetRuntime({ store,
    scope: { principalId: 'consumer', projectId: 'project' }, permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0 });
  void runtime.submitSaga(saga, { input: 3, idempotencyKey: 'saga' });
  void runtime.submitLoop(loop, { input: { continue: false, value: 3 }, idempotencyKey: 'loop' });
  const host = createWorkflowCompositeHost({ store, sagaDefinitions: [saga], loopDefinitions: [loop],
    scope: { principalId: 'consumer-host', projectId: 'project' }, permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0 });
  host.start(); void host.close();
}
void checkCompositeAdapter;
const verifier = defineExternalEffectVerifier({ authorityId: 'consumer.provider', toolId: 'consumer.double', toolVersion: '1',
  verify: async request => ({ attestationId: request.jobId, execution: 'succeeded', knownCostMicros: request.maximumCostMicros }) });
const verification = composeExternalEffectVerifiers([verifier]);
declare const reconciliation: ExternalEffectReconciliationRequest;
void verification(reconciliation, { token: 'opaque' });
await runtime.close();
