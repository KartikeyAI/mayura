import type { Schema } from '@mayura/core';
import { defineWorkflowGraph, createWorkflowGraphRuntime, createWorkflowGraphDiscovery } from '@mayura/workflows/graphs';
import { createScheduledWorkflowRuntime, createWorkflowRuntime } from '@mayura/workflows';
import { workflowAsAgent } from '@mayura/workflows/ephemeral';
import type { WorkflowGraphAggregateStore, WorkflowGraphDiscoveryAggregateStore, ScheduledWorkflowAggregateStore, ExecutionRef } from '@mayura/storage-contracts';

const input: Schema<string, { references: readonly ExecutionRef[] }> = { '~standard': { version: 1, vendor: 'consumer', validate: () => ({ value: { references: [] } }) } };
const output: Schema<unknown, { finished: boolean }> = { '~standard': { version: 1, vendor: 'consumer', validate: () => ({ value: { finished: true } }) } };
const graph = defineWorkflowGraph({ id: 'consumer.wait', version: '1', input, output,
  nodes: [{ kind: 'wait', id: 'observe', targets: { kind: 'input', path: ['references'] } }],
  result: { kind: 'step', stepId: 'observe', path: [] } });

async function verify(store: WorkflowGraphDiscoveryAggregateStore, legacyStore: ScheduledWorkflowAggregateStore, graphOnlyStore: WorkflowGraphAggregateStore): Promise<void> {
  const options = { store, workerId: 'consumer', scope: { principalId: 'consumer', projectId: 'app' }, permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0 };
  const runtime = createWorkflowGraphRuntime(options); const profile: 'scheduled-v2' = runtime.profile;
  const discoveryOptions = { store, scope: options.scope, permissions: options.permissions, policyVersion: '1', maxCostMicros: 0 };
  const discovery = createWorkflowGraphDiscovery(discoveryOptions); const page = await discovery.scan({ limit: 2 });
  if (page.nextCursor) await discovery.scan({ cursor: page.nextCursor });
  if (page.candidates[0]) {
    const candidateStatus: 'running' | 'waiting' = page.candidates[0].status; void candidateStatus;
    // @ts-expect-error Discovery metadata cannot expose workflow payloads.
    void page.candidates[0].output;
    // @ts-expect-error Observed metadata is immutable.
    page.candidates[0].reference.runId = 'b'.repeat(64);
  }
  // @ts-expect-error Discovery is an explicitly selected extra storage capability.
  createWorkflowGraphDiscovery({ ...discoveryOptions, store: graphOnlyStore });
  // @ts-expect-error A plain run ID is not a context-bound cursor.
  await discovery.scan({ cursor: 'a'.repeat(64) });
  await discovery.close();
  void profile; void runtime.submit(graph, { input: 'original', idempotencyKey: 'one' });
  void runtime.runUntilSettled(graph, 'a'.repeat(64)); void runtime.reference('a'.repeat(64));
  // @ts-expect-error Submission takes the original schema input, not the admitted target object.
  void runtime.submit(graph, { input: { references: [] }, idempotencyKey: 'wrong' });
  // @ts-expect-error Existing runs cannot gain wait edges via attachment.
  void runtime.attach(graph, 'a'.repeat(64));
  // @ts-expect-error Legacy stores do not promise graph persistence.
  createWorkflowGraphRuntime({ ...options, store: legacyStore });
  const legacy = createScheduledWorkflowRuntime(options);
  const reference = await legacy.reference('a'.repeat(64));
  const references: readonly ExecutionRef[] = Object.freeze([reference]);
  const literal = defineWorkflowGraph({ id: 'consumer.literal', version: '1', input, output,
    nodes: [{ kind: 'wait', id: 'observe', targets: { kind: 'literal', value: references } }], result: { kind: 'step', stepId: 'observe', path: [] } });
  void runtime.submit(literal, { input: 'original', idempotencyKey: 'literal' });
  defineWorkflowGraph({ id: 'consumer.invalid-literal', version: '1', input, output,
    // @ts-expect-error Literal targets are references, not arbitrary JSON values.
    nodes: [{ kind: 'wait', id: 'observe', targets: { kind: 'literal', value: ['not-a-reference'] } }], result: { kind: 'input', path: [] } });
  // @ts-expect-error Versioned graph definitions cannot enter a v1 scheduled driver.
  void legacy.runUntilSettled(graph, 'a'.repeat(64));
  // @ts-expect-error Versioned graph definitions cannot enter a conservative driver.
  void createWorkflowRuntime(options).submit(graph, { input: 'original', idempotencyKey: 'wrong-profile' });
  // @ts-expect-error Durable waits are not synchronous agent-as-tool callbacks.
  workflowAsAgent(graph, { profile: 'ephemeral' });
  defineWorkflowGraph({ id: 'consumer.invalid', version: '1', input, output,
    // @ts-expect-error Step-output references would bypass admission-time cycle prevention.
    nodes: [{ kind: 'wait', id: 'observe', targets: { kind: 'step', stepId: 'later', path: [] } }], result: { kind: 'input', path: [] } });
}
void verify;
