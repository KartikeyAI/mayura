import { describe, expect, it, vi } from 'vitest';
import { ClientError } from '../src/index.js';
import { createWorkflowCommandController, createWorkflowGraphProjection, type WorkflowViewInput, type WorkflowViewNode, type WorkflowViewStep } from '../src/workflows.js';

const runId = 'a'.repeat(64); const childRunId = 'b'.repeat(64);
function view(nodes: readonly WorkflowViewNode[], steps: readonly WorkflowViewStep[], overrides: Partial<WorkflowViewInput> = {}): WorkflowViewInput {
  const capturedNodes = Object.freeze(nodes.map(node => Object.freeze({ ...node, dependsOn: Object.freeze([...node.dependsOn]) })));
  const capturedSteps = Object.freeze(steps.map(step => Object.freeze({ ...step })));
  return Object.freeze({ format: 4 as const, definitionId: 'deploy', definitionVersion: '1.0.0', runId, revision: 7,
    status: 'running' as const, nodes: capturedNodes, steps: capturedSteps, ...overrides });
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, deny) => { resolve = accept; reject = deny; }); return { promise, resolve, reject }; }

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

describe('durable workflow command controller', () => {
  const waiting = () => view([{ id: 'child', kind: 'child', dependsOn: [] }], [{ id: 'child', kind: 'child', status: 'waiting', childRunId }]);

  it('is inert until explicit cancellation and publishes one immutable success', async () => {
    const result = view([{ id: 'child', kind: 'child', dependsOn: [] }], [{ id: 'child', kind: 'child', status: 'skipped', childRunId }],
      { revision: 8, status: 'cancelled' });
    const cancelWorkflow = vi.fn(async () => result); const approveWorkflow = vi.fn(async () => result);
    const controller = createWorkflowCommandController({ workflow: waiting(), client: { cancelWorkflow, approveWorkflow } });
    const revisions: number[] = []; controller.subscribe(() => revisions.push(controller.getSnapshot().stateRevision));
    expect(controller.getSnapshot()).toMatchObject({ stateRevision: 0, status: 'idle', workflowRevision: 7, action: null });
    expect(cancelWorkflow).not.toHaveBeenCalled(); await expect(controller.cancel({ commandId: 'cancel-1' })).resolves.toBe(result);
    expect(cancelWorkflow).toHaveBeenCalledWith(runId, 7, expect.objectContaining({ commandId: 'cancel-1' }));
    expect(controller.getSnapshot()).toMatchObject({ status: 'succeeded', workflowRevision: 8, workflowStatus: 'cancelled', action: 'cancel' });
    expect(Object.isFrozen(controller.getSnapshot())).toBe(true); expect(revisions).toEqual([1, 2]); controller.dispose();
  });

  it('binds approval to one waiting node and exact required child', async () => {
    const result = view([{ id: 'child', kind: 'child', dependsOn: [] }], [{ id: 'child', kind: 'child', status: 'approved', childRunId }], { revision: 8 });
    const cancelWorkflow = vi.fn(async () => result); const approveWorkflow = vi.fn(async () => result);
    const controller = createWorkflowCommandController({ workflow: waiting(), client: { cancelWorkflow, approveWorkflow } });
    await expect(controller.approve({ nodeId: 'child', approvalDigest: 'd'.repeat(64), childRunId }, { commandId: 'approve-1' })).resolves.toBe(result);
    expect(approveWorkflow).toHaveBeenCalledWith(runId, { revision: 7, nodeId: 'child', approvalDigest: 'd'.repeat(64), childRunId },
      expect.objectContaining({ commandId: 'approve-1' }));
    expect(() => controller.reset()).toThrow(expect.objectContaining({ code: 'WORKFLOW_CONTROLLER_STALE' }));
    const next = createWorkflowCommandController({ workflow: waiting(), client: { cancelWorkflow, approveWorkflow } });
    await expect(next.approve({ nodeId: 'child', approvalDigest: 'd'.repeat(64) }, { commandId: 'approve-2' }))
      .rejects.toMatchObject({ code: 'INVALID_WORKFLOW_COMMAND' }); expect(approveWorkflow).toHaveBeenCalledOnce();
  });

  it('enforces single flight and never retries or reveals an unknown failure', async () => {
    const pending = deferred<WorkflowViewInput>(); const cancelWorkflow = vi.fn(() => pending.promise); const approveWorkflow = vi.fn(() => pending.promise);
    const controller = createWorkflowCommandController({ workflow: waiting(), client: { cancelWorkflow, approveWorkflow } });
    const first = controller.cancel({ commandId: 'cancel-1' });
    await expect(controller.cancel({ commandId: 'cancel-1' })).rejects.toMatchObject({ code: 'WORKFLOW_CONTROLLER_BUSY' });
    pending.reject(new Error('PRIVATE TRANSPORT DETAIL')); await expect(first).rejects.toMatchObject({ code: 'WORKFLOW_COMMAND_FAILED' });
    expect(cancelWorkflow).toHaveBeenCalledOnce(); expect(controller.getSnapshot()).toMatchObject({ status: 'failed', errorCode: 'WORKFLOW_COMMAND_FAILED' });
  });

  it('classifies conflicts, rejects cross-workflow replies and aborts owned transport on disposal', async () => {
    const conflict = createWorkflowCommandController({ workflow: waiting(), client: { cancelWorkflow: async () => { throw new ClientError('HTTP_ERROR', 409); },
      approveWorkflow: async () => { throw new ClientError('HTTP_ERROR', 409); } } });
    await expect(conflict.cancel({ commandId: 'cancel-1' })).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 409 });
    expect(conflict.getSnapshot()).toMatchObject({ status: 'conflict', errorCode: 'WORKFLOW_COMMAND_CONFLICT' }); conflict.reset();
    const invalid = createWorkflowCommandController({ workflow: waiting(), client: { cancelWorkflow: async () => view([
      { id: 'child', kind: 'child', dependsOn: [] }], [{ id: 'child', kind: 'child', status: 'waiting', childRunId }], { runId: 'c'.repeat(64), revision: 8 }),
      approveWorkflow: async () => waiting() } });
    await expect(invalid.cancel({ commandId: 'cancel-2' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    const pending = deferred<WorkflowViewInput>(); let signal: AbortSignal | undefined;
    const disposed = createWorkflowCommandController({ workflow: waiting(), client: { cancelWorkflow: async (_id, _revision, options) => { signal = options.signal; return pending.promise; },
      approveWorkflow: async () => waiting() } });
    const running = disposed.cancel({ commandId: 'cancel-3' }); disposed.dispose(); expect(signal?.aborted).toBe(true);
    pending.reject(new ClientError('ABORTED')); await expect(running).rejects.toMatchObject({ code: 'ABORTED' });
    expect(disposed.getSnapshot().status).toBe('disposed');
  });
});
