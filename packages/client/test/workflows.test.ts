import { describe, expect, it } from 'vitest';
import { createWorkflowGraphProjection, type WorkflowViewInput, type WorkflowViewNode, type WorkflowViewStep } from '../src/workflows.js';

const runId = 'a'.repeat(64); const childRunId = 'b'.repeat(64);
function view(nodes: readonly WorkflowViewNode[], steps: readonly WorkflowViewStep[], overrides: Partial<WorkflowViewInput> = {}): WorkflowViewInput {
  const capturedNodes = Object.freeze(nodes.map(node => Object.freeze({ ...node, dependsOn: Object.freeze([...node.dependsOn]) })));
  const capturedSteps = Object.freeze(steps.map(step => Object.freeze({ ...step })));
  return Object.freeze({ format: 4 as const, definitionId: 'deploy', definitionVersion: '1.0.0', runId, revision: 7,
    status: 'running' as const, nodes: capturedNodes, steps: capturedSteps, ...overrides });
}

describe('durable workflow graph projection', () => {
  it('projects a required-child DAG in manifest order with stable depths and readiness', () => {
    const projection = createWorkflowGraphProjection(view([
      { id: 'prepare', kind: 'tool', dependsOn: [] }, { id: 'child', kind: 'child', dependsOn: ['prepare'] },
      { id: 'finish', kind: 'join', dependsOn: ['child'] },
    ], [
      { id: 'prepare', kind: 'tool', status: 'succeeded' }, { id: 'child', kind: 'child', status: 'dispatching', childRunId },
      { id: 'finish', kind: 'join', status: 'pending' },
    ]));
    expect(projection.nodes).toEqual([
      { id: 'prepare', kind: 'tool', status: 'succeeded', depth: 0, ready: false, childRunId: null },
      { id: 'child', kind: 'child', status: 'dispatching', depth: 1, ready: false, childRunId },
      { id: 'finish', kind: 'join', status: 'pending', depth: 2, ready: false, childRunId: null },
    ]);
    expect(projection.edges).toEqual([{ from: 'prepare', to: 'child' }, { from: 'child', to: 'finish' }]);
    expect(projection.progress).toEqual({ total: 3, terminal: 1, succeeded: 1, active: 1, waiting: 0, failed: 0 });
    expect(Object.isFrozen(projection)).toBe(true); expect(Object.isFrozen(projection.nodes)).toBe(true); expect(projection.nodes.every(Object.isFrozen)).toBe(true);
  });

  it('supports each versioned durable node vocabulary without exposing payloads', () => {
    for (const [format, kind, status] of [[2, 'tool', 'pending'], [3, 'wait', 'waiting'], [5, 'human', 'timed_out'], [5, 'timer', 'succeeded']] as const) {
      const projection = createWorkflowGraphProjection(view([{ id: 'node', kind, dependsOn: [] }], [{ id: 'node', kind, status }], { format }));
      expect(projection.nodes[0]).toMatchObject({ kind, status, depth: 0, ready: status === 'pending' });
      expect(JSON.stringify(projection)).not.toContain('output');
    }
  });

  it('rejects cycles, dangling edges and manifest/snapshot disagreement', () => {
    expect(() => createWorkflowGraphProjection(view([{ id: 'a', kind: 'tool', dependsOn: ['b'] }, { id: 'b', kind: 'tool', dependsOn: ['a'] }],
      [{ id: 'a', kind: 'tool', status: 'pending' }, { id: 'b', kind: 'tool', status: 'pending' }]))).toThrow(expect.objectContaining({ code: 'INVALID_WORKFLOW_VIEW' }));
    expect(() => createWorkflowGraphProjection(view([{ id: 'a', kind: 'tool', dependsOn: ['missing'] }], [{ id: 'a', kind: 'tool', status: 'pending' }]))).toThrow(expect.objectContaining({ code: 'INVALID_WORKFLOW_VIEW' }));
    expect(() => createWorkflowGraphProjection(view([{ id: 'a', kind: 'tool', dependsOn: [] }], [{ id: 'a', kind: 'join', status: 'pending' }]))).toThrow(expect.objectContaining({ code: 'INVALID_WORKFLOW_VIEW' }));
  });

  it('rejects unsupported format/kind/status combinations and forged child links', () => {
    expect(() => createWorkflowGraphProjection(view([{ id: 'a', kind: 'child', dependsOn: [] }], [{ id: 'a', kind: 'child', status: 'pending' }], { format: 3 }))).toThrow(expect.objectContaining({ code: 'INVALID_WORKFLOW_VIEW' }));
    expect(() => createWorkflowGraphProjection(view([{ id: 'a', kind: 'timer', dependsOn: [] }], [{ id: 'a', kind: 'timer', status: 'timed_out' }], { format: 5 }))).toThrow(expect.objectContaining({ code: 'INVALID_WORKFLOW_VIEW' }));
    expect(() => createWorkflowGraphProjection(view([{ id: 'a', kind: 'tool', dependsOn: [] }], [{ id: 'a', kind: 'tool', status: 'pending', childRunId }]))).toThrow(expect.objectContaining({ code: 'INVALID_WORKFLOW_VIEW' }));
  });

  it('requires deeply immutable, exact content-free input', () => {
    const valid = view([{ id: 'a', kind: 'tool', dependsOn: [] }], [{ id: 'a', kind: 'tool', status: 'pending' }]);
    expect(() => createWorkflowGraphProjection({ ...valid })).toThrow(expect.objectContaining({ code: 'INVALID_WORKFLOW_VIEW' }));
    const hostile = Object.freeze({ ...valid, nodes: Object.freeze([Object.freeze({ id: 'a', kind: 'tool', dependsOn: Object.freeze([]), output: '<script />' })]) }) as unknown as WorkflowViewInput;
    expect(() => createWorkflowGraphProjection(hostile)).toThrow(expect.objectContaining({ code: 'INVALID_WORKFLOW_VIEW' }));
  });
});
