import { describe, expect, it, vi } from 'vitest';
import type { JsonValue, Schema } from '@mayura/core';
import type { ExecutionRef, WorkflowGraphAggregateStore } from '@mayura/storage-contracts';
import { createWorkflowGraphRuntime, defineWorkflowGraph, type WorkflowGraphDefinition } from '../src/graphs.js';
import { createScheduledWorkflowRuntime, createWorkflowRuntime, defineWorkflow, type WorkflowDefinition } from '../src/index.js';
import { workflowAsAgent } from '../src/ephemeral.js';

const schema: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'graph-public-test', validate: value => ({ value: value as JsonValue }) } };
const options = { id: 'public-graph', version: '1', input: schema, output: schema,
  nodes: [{ kind: 'join' as const, id: 'done', dependsOn: [] }], result: { kind: 'literal' as const, value: null } };
const runtimeOptions = { scope: { principalId: 'reader', projectId: 'project' }, permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0, workerId: 'worker' };

describe('versioned workflow graph public contract', () => {
  it('accepts typed readonly execution references without JSON casts', () => {
    const reference: ExecutionRef = { kind: 'scheduled-workflow', runId: 'a'.repeat(64), definitionHash: 'b'.repeat(64), policyHash: 'c'.repeat(64) };
    const references: readonly ExecutionRef[] = Object.freeze([reference]);
    const graph = defineWorkflowGraph({ ...options, nodes: [{ kind: 'wait', id: 'done', targets: { kind: 'literal', value: references } }] });
    expect(graph.nodes[0]).toMatchObject({ targets: { kind: 'literal', value: references } });
  });

  it('keeps graph definitions immutable and distinct even without wait nodes', () => {
    const legacy = defineWorkflow(options); const graph = defineWorkflowGraph(options);
    expect(graph.format).toBe(3); expect(graph.digest).not.toBe(legacy.digest);
    expect(Object.isFrozen(graph)).toBe(true); expect(Object.isFrozen(graph.nodes)).toBe(true);
    expect(() => workflowAsAgent(graph as unknown as WorkflowDefinition, { profile: 'ephemeral' })).toThrow();
    expect(() => workflowAsAgent({ ...legacy }, { profile: 'ephemeral' })).toThrow();
  });

  it('rejects step-derived wait bindings, cycles, unsafe paths and malformed target bindings', () => {
    for (const targets of [
      { kind: 'step', stepId: 'done', path: [] }, { kind: 'input', path: ['__proto__'] },
      { kind: 'input', path: [], extra: true }, { kind: 'future', path: [] },
    ]) expect(() => defineWorkflowGraph({ ...options,
      nodes: [{ kind: 'wait', id: 'done', targets }],
    } as never)).toThrow();
    expect(() => defineWorkflowGraph({ ...options, nodes: [{ kind: 'wait', id: 'done',
      dependsOn: ['done'], targets: { kind: 'input', path: [] } }] })).toThrow();
  });

  it('owns input and literal bindings instead of retaining caller mutation', () => {
    const path = ['refs']; const dependsOn: string[] = [];
    const graph = defineWorkflowGraph({ ...options, nodes: [{ kind: 'wait', id: 'done', dependsOn,
      targets: { kind: 'input', path } }] });
    path.push('changed'); dependsOn.push('done');
    expect(graph.nodes[0]).toMatchObject({ dependsOn: [], targets: { kind: 'input', path: ['refs'] } });
    expect(Object.isFrozen(graph.nodes[0])).toBe(true);
  });

  it('requires the new capability and does not fall back to the v1 store', () => {
    const workflows = new Proxy({}, { get: () => vi.fn() });
    expect(() => createWorkflowGraphRuntime({ ...runtimeOptions, store: { workflows } as never })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_PROFILE' }));
  });

  it('keeps compile-time profile boundaries and exposes no graph attachment', () => {
    const graph = defineWorkflowGraph(options); const legacy = defineWorkflow(options);
    if (false) {
      const store = {} as WorkflowGraphAggregateStore;
      const graphs = createWorkflowGraphRuntime({ ...runtimeOptions, store });
      const scheduled = createScheduledWorkflowRuntime({ ...runtimeOptions, store });
      const conservative = createWorkflowRuntime({ ...runtimeOptions, store });
      // @ts-expect-error Graph definitions are not conservative workflow definitions.
      conservative.submit(graph, { input: null, idempotencyKey: 'key' });
      // @ts-expect-error Graph definitions cannot enter the scheduled-v1 dispatcher.
      scheduled.submit(graph, { input: null, idempotencyKey: 'key' });
      // @ts-expect-error Graph definitions cannot enter ephemeral composition.
      workflowAsAgent(graph, { profile: 'ephemeral' });
      // @ts-expect-error Legacy definitions cannot enter the graph dispatcher.
      graphs.submit(legacy, { input: null, idempotencyKey: 'key' });
      // @ts-expect-error Format-3 attachment is deliberately unsupported.
      graphs.attach(graph, 'a'.repeat(64));
      // @ts-expect-error A structural clone lacks the graph definition brand.
      const forged: WorkflowGraphDefinition = options;
      void forged;
    }
    expect(graph.digest).not.toBe(legacy.digest);
  });
});
