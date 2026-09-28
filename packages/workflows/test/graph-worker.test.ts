import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JsonObject, JsonValue, Schema } from '@mayura/core';
import { defineTool } from '@mayura/tools';
import { initialWorkflowGraphState, StorageError, workflowPolicy,
  type ExecutionRef, type JobRecord, type WorkflowGraphAggregateStore, type WorkflowGraphStore, type WorkflowGraphStoreSnapshot } from '@mayura/storage-contracts';
import { createWorkflowGraphRuntime, defineWorkflowGraph, type WorkflowGraphRuntime, type WorkflowGraphRuntimeOptions } from '../src/graphs.js';
import { createScheduledWorkflowRuntime, createWorkflowRuntime, defineWorkflow, type WorkflowDefinition } from '../src/index.js';
import { digest } from '../src/definition.js';
import { graphManifest } from '../src/graph-definition.js';
import * as graphDefinitions from '../src/graph-definition.js';
import { scheduledState, scheduledTransition, scheduledView } from '../src/scheduled-helpers.js';

const scope = { principalId: 'graph-adapter-tests', projectId: 'project' };
const schema: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'graph-adapter', validate: value => ({ value: value as JsonValue }) } };
const workers: WorkflowGraphRuntime[] = [];
const releases: (() => void)[] = [];
afterEach(async () => { for (const release of releases.splice(0)) release(); await Promise.all(workers.splice(0).map(worker => worker.close())); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve };
}
async function flush(): Promise<void> { for (let index = 0; index < 25; index++) await Promise.resolve(); }

/** Structural boundary fixture; SQL tests independently qualify actual transaction authority. */
function fixture(inputSchema: Schema = schema, maxOutputBytes = 65_536, finishedTools = 0) {
  const policy = workflowPolicy({ scope, permissions: [], policyVersion: '1', maxCostMicros: 0, maxOutputBytes, approvalTtlMs: 3_600_000 });
  const scopeKey = digest('mayura:scope:v1', scope); const policyHash = digest('mayura:policy:v1', policy);
  const reference: ExecutionRef = { kind: 'scheduled-workflow', runId: 'a'.repeat(64), definitionHash: 'b'.repeat(64), policyHash };
  const tools = Array.from({ length: finishedTools }, (_, index) => defineTool({ id: `finished.${index}`, version: '1',
    description: 'Previously completed immutable fixture node.', input: schema, output: schema, effects: 'none', capabilities: [],
    execute: async () => { throw new Error('A completed tool must never be redispatched.'); } }));
  const definition = defineWorkflowGraph({ id: 'wait-boundary', version: '1', input: inputSchema, output: schema,
    nodes: [{ id: 'wait', kind: 'wait', targets: { kind: 'input', path: [] } }, ...tools.map((tool, index) => ({
      id: `done${index}`, kind: 'tool' as const, tool, input: { kind: 'literal' as const, value: null },
    }))], result: { kind: 'step', stepId: 'wait', path: [] } });
  const id = digest('mayura:run-id:v1', { scope: scopeKey, submissionKey: 'key' });
  const state = initialWorkflowGraphState(graphManifest(definition), [reference] as unknown as JsonValue, definition.digest, policyHash, 0);
  state.status = 'waiting'; state.steps['wait']!.status = 'waiting';
  const jobs: JobRecord[] = tools.map((tool, index) => {
    const nodeId = `done${index}`; const candidateHash = 'c'.repeat(64);
    const receipt = { callId: `${id}/step:${nodeId}`, toolId: tool.id, execution: 'succeeded' as const, disclosure: 'released' as const };
    state.steps[nodeId] = { ...state.steps[nodeId]!, status: 'succeeded', output: null, receipt, candidateHash };
    return { scope: scopeKey, jobId: `completed.${index}`, runId: id, nodeId, invocationId: `invocation.${index}`,
      definitionHash: definition.digest, candidateHash, intent: { toolId: tool.id, callId: receipt.callId }, resourceKeys: [],
      state: 'succeeded', version: 4, fence: 1, workerId: 'worker', dueAtMs: 0, deadlineAtMs: null, leaseUntilMs: 3_000, startedAtMs: 1,
      leaseRevoked: false, cancelRequested: false, receipt, output: null };
  });
  const current: WorkflowGraphStoreSnapshot = { profile: 'scheduled-v2', manifestHash: definition.digest, policyHash,
    resourceHash: digest('mayura:workflow-resources:v1', Object.fromEntries(tools.map((_, index) => [`done${index}`, []]))), jobs,
    record: { scope: scopeKey, id, version: 2, definitionHash: definition.digest, idempotencyKey: 'key', state: state as unknown as JsonObject } };
  const view = (): WorkflowGraphStoreSnapshot => structuredClone(current);
  const inspect = vi.fn(async (_command: unknown) => view());
  const submit = vi.fn(async (_command: Parameters<WorkflowGraphStore['submit']>[0]) => ({ snapshot: view(), created: true }));
  const claim = vi.fn(async () => []);
  const advance = vi.fn(async () => view());
  const mutation = vi.fn(async () => { throw new Error('Unexpected graph mutation'); });
  const api = { ...Object.fromEntries(['requestApproval', 'approve', 'prepare', 'renew', 'start', 'recordReceipt', 'complete', 'abandon', 'failNode', 'finalize', 'cancel'].map(name => [name, mutation])),
    initialize: vi.fn(async () => {}), inspect, submit, claim, advance, recover: advance } as unknown as WorkflowGraphStore;
  const legacyAccess = vi.fn(() => { throw new Error('No legacy fallback'); });
  const store = { workflowGraphs: api, read: legacyAccess, events: vi.fn(async () => []), close: vi.fn(async () => {}),
    update: legacyAccess, workflows: {} } as unknown as WorkflowGraphAggregateStore;
  const worker = (options: Partial<Omit<WorkflowGraphRuntimeOptions, 'store'>> = {}) => {
    const result = createWorkflowGraphRuntime({ store, scope, permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0, maxOutputBytes, workerId: 'worker', ...options });
    workers.push(result); return result;
  };
  return { state, current, definition, reference, id, scopeKey, policyHash, api, store, inspect, submit, claim, advance, mutation, legacyAccess, view, worker };
}

describe('workflow graph custom-adapter and worker boundaries', () => {
  it('returns finite waiting views without retaining a run slot or mutating target runs', async () => {
    const source = fixture(); const worker = source.worker({ maxConcurrentRuns: 1, maxConcurrentJobs: 1 });
    expect(worker.profile).toBe('scheduled-v2'); expect(Object.hasOwn(worker, 'attach')).toBe(false);
    for (let attempt = 0; attempt < 3; attempt++) expect(await worker.runUntilSettled(source.definition, source.id)).toMatchObject({ status: 'waiting', version: 2,
      budget: { spentMicros: 0, reservedMicros: 0 }, steps: { wait: { status: 'waiting', receipt: null, candidateHash: null } } });
    expect(source.mutation).not.toHaveBeenCalled(); expect(source.legacyAccess).not.toHaveBeenCalled();
    await worker.close(); expect(source.store.close).not.toHaveBeenCalled();
  });

  it('does not reload a full aggregate once per already completed or enrolled tool node', async () => {
    const source = fixture(schema, 65_536, 4); const worker = source.worker();
    expect(await worker.runUntilSettled(source.definition, source.id)).toMatchObject({ status: 'waiting', version: 2 });
    // Initial view, recover CAS view, advance CAS view, and the final advance CAS view.
    // Completed jobs are immutable; they cannot become candidates for another preparation.
    expect(source.inspect).toHaveBeenCalledTimes(4);
    expect(source.mutation).not.toHaveBeenCalled();
  });

  it('compiles immutable branded enrollment once per worker rather than once per state check', async () => {
    const source = fixture(); const manifest = vi.spyOn(graphDefinitions, 'graphManifest');
    try {
      const first = source.worker();
      await first.runUntilSettled(source.definition, source.id);
      await first.runUntilSettled(source.definition, source.id);
      expect(manifest).toHaveBeenCalledTimes(1);
      await source.worker().runUntilSettled(source.definition, source.id);
      expect(manifest).toHaveBeenCalledTimes(2);
      expect(() => first.runUntilSettled({ ...source.definition }, source.id)).toThrow();
    } finally { manifest.mockRestore(); }
  });

  it('reuses only privately owned validated views and decoded states', () => {
    const source = fixture();
    const checked = scheduledView(source.current, source.scopeKey, source.id, source.policyHash, 'scheduled-v2');
    expect(scheduledView(checked, source.scopeKey, source.id, source.policyHash, 'scheduled-v2')).toBe(checked);
    const state = scheduledState(checked.record, 'scheduled-v2');
    expect(scheduledState(checked.record, 'scheduled-v2')).toBe(state);
    expect(Object.isFrozen(state)).toBe(true); expect(Object.isFrozen(state.steps['wait'])).toBe(true);
    // Adapter ownership and mere deep freezing are not validation-cache credentials.
    source.current.record.state['format'] = 2;
    expect(() => scheduledView(source.current, source.scopeKey, source.id, source.policyHash, 'scheduled-v2')).toThrow();
    const frozen = Object.freeze({ ...checked, manifestHash: 'bad' });
    expect(() => scheduledView(frozen, source.scopeKey, source.id, source.policyHash, 'scheduled-v2')).toThrow();
    expect(scheduledState(checked.record, 'scheduled-v2').format).toBe(3);
  });

  it('rechecks requested authority context even when a view was previously validated', () => {
    const source = fixture();
    const checked = scheduledView(source.current, source.scopeKey, source.id, source.policyHash, 'scheduled-v2');
    for (const [scopeKey, id, policyHash, profile] of [
      ['0'.repeat(64), source.id, source.policyHash, 'scheduled-v2'],
      [source.scopeKey, '0'.repeat(64), source.policyHash, 'scheduled-v2'],
      [source.scopeKey, source.id, '0'.repeat(64), 'scheduled-v2'],
      [source.scopeKey, source.id, source.policyHash, 'scheduled-v1'],
    ] as const) expect(() => scheduledView(checked, scopeKey, id, policyHash, profile)).toThrow();
    expect(() => scheduledState(checked.record, 'scheduled-v1')).toThrow();
  });

  it('does not cache mutable adapter records across state decoder calls', () => {
    const source = fixture();
    expect(scheduledState(source.current.record, 'scheduled-v2').format).toBe(3);
    source.current.record.state['format'] = 2;
    expect(() => scheduledState(source.current.record, 'scheduled-v2')).toThrow();
  });

  it('retains the owned validated view in direct and wrapped mutation acknowledgements', () => {
    const source = fixture();
    const direct = scheduledTransition(source.current, source.scopeKey, source.id, source.policyHash, 'scheduled-v2');
    expect(scheduledView(direct, source.scopeKey, source.id, source.policyHash, 'scheduled-v2')).toBe(direct);
    const wrapped = scheduledTransition({ status: 'started' as const, snapshot: source.current }, source.scopeKey, source.id, source.policyHash, 'scheduled-v2');
    expect(scheduledView(wrapped.snapshot, source.scopeKey, source.id, source.policyHash, 'scheduled-v2')).toBe(wrapped.snapshot);
    expect(Object.isFrozen(wrapped)).toBe(true);
  });

  it('returns immutable scoped references without exposing the graph input', async () => {
    const source = fixture(); const reference = await source.worker().reference(source.id);
    expect(reference).toEqual({ kind: 'scheduled-workflow', runId: source.id, definitionHash: source.definition.digest, policyHash: source.policyHash });
    expect(Object.isFrozen(reference)).toBe(true); expect(JSON.stringify(reference)).not.toContain(source.reference.runId);
    expect(source.inspect).toHaveBeenCalledWith({ scope: source.scopeKey, id: source.id, policyHash: source.policyHash });
  });

  it.each(['profile', 'format', 'scope', 'policy', 'definition', 'waitReceipt', 'waitReservation', 'waitApproval', 'waitDispatch', 'unknownOutput'] as const)('rejects malformed %s before returning a graph snapshot', async field => {
    const source = fixture(); const bad = source.view();
    const record = bad.record as unknown as JsonObject; const state = bad.record.state; const wait = (state['steps'] as JsonObject)['wait'] as JsonObject;
    if (field === 'profile') (bad as unknown as JsonObject)['profile'] = 'scheduled-v1';
    else if (field === 'format') state['format'] = 2;
    else if (field === 'scope') record['scope'] = '0'.repeat(64);
    else if (field === 'policy') state['policy'] = '0'.repeat(64);
    else if (field === 'definition') record['definitionHash'] = '0'.repeat(64);
    else if (field === 'waitReceipt') wait['receipt'] = { callId: `${source.id}/step:wait`, toolId: 'fake', execution: 'succeeded', disclosure: 'released' };
    else if (field === 'waitReservation') { wait['costReserved'] = 1; state['reservedMicros'] = 1; state['maxCostMicros'] = 1; }
    else if (field === 'waitApproval') wait['approval'] = { digest: 'e'.repeat(64), expiresAt: 1, humanId: null };
    else if (field === 'waitDispatch') wait['status'] = 'dispatching';
    else wait['output'] = ['hidden'];
    source.inspect.mockResolvedValue(bad);
    await expect(source.worker().inspect(source.id)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });

  it('checks succeeded wait metadata against the registered definition before continuation', async () => {
    const source = fixture(); source.state.steps['wait']!.status = 'succeeded'; source.state.status = 'running';
    source.state.steps['wait']!.output = [{ reference: { ...source.reference, runId: 'c'.repeat(64) }, outcome: 'succeeded', sourceVersion: 1, sourceEventSequence: 1 }] as unknown as JsonValue;
    await expect(source.worker().runUntilSettled(source.definition, source.id)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(source.advance).not.toHaveBeenCalled(); expect(source.claim).not.toHaveBeenCalled();
  });

  it('rejects an inflated budget despite a correct policy hash', async () => {
    const source = fixture(); source.state.maxCostMicros = 1;
    await expect(source.worker().inspect(source.id)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });

  it.each(['input', 'output', 'stepOutput'] as const)('enforces configured %s bytes on structurally valid adapter replies', async field => {
    const source = fixture(schema, 1_024);
    if (field === 'input') source.state.input = 'x'.repeat(1_025);
    else {
      source.state.steps['wait']!.status = 'succeeded';
      source.state.steps['wait']!.output = Array.from({ length: field === 'stepOutput' ? 4 : 1 }, (_, index) => ({
        reference: { ...source.reference, runId: String(index + 1).repeat(64) }, outcome: 'outcome_unknown', sourceVersion: 1, sourceEventSequence: 1,
      })) as unknown as JsonValue;
      if (field === 'output') { source.state.status = 'succeeded'; source.state.output = 'x'.repeat(1_025); }
    }
    await expect(source.worker().inspect(source.id)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });

  it('rejects submission wrapper accessors without executing them', async () => {
    const source = fixture(); const getter = vi.fn(() => source.view());
    const response = { created: true }; Object.defineProperty(response, 'snapshot', { enumerable: true, get: getter });
    source.submit.mockResolvedValue(response as never);
    await expect(source.worker().submit(source.definition, { input: [source.reference] as never, idempotencyKey: 'key' })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects changed admitted input in a graph submission acknowledgement', async () => {
    const source = fixture(); const changed = source.view();
    changed.record.state['input'] = [{ ...source.reference, runId: 'c'.repeat(64) }] as unknown as JsonValue;
    source.submit.mockResolvedValue({ snapshot: changed, created: true });
    await expect(source.worker().submit(source.definition, { input: [source.reference] as never, idempotencyKey: 'key' })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });

  it('rejects a valid but wrong node kind in the registered graph', async () => {
    const source = fixture(); const changed = source.view();
    ((changed.record.state['steps'] as JsonObject)['wait'] as JsonObject)['kind'] = 'join';
    source.inspect.mockResolvedValue(changed);
    await expect(source.worker().runUntilSettled(source.definition, source.id)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(source.advance).not.toHaveBeenCalled(); expect(source.claim).not.toHaveBeenCalled();
  });

  it('validates resolved metadata in an advance acknowledgement before claiming more work', async () => {
    const source = fixture(); const bad = source.view(); const wait = (bad.record.state['steps'] as JsonObject)['wait'] as JsonObject;
    wait['status'] = 'succeeded'; wait['output'] = [{ reference: { ...source.reference, runId: 'c'.repeat(64) }, outcome: 'succeeded', sourceVersion: 1, sourceEventSequence: 1 }] as unknown as JsonValue;
    source.advance.mockResolvedValue(bad);
    await expect(source.worker().runUntilSettled(source.definition, source.id)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(source.claim).not.toHaveBeenCalled();
  });

  it('resolves targets after schema transformation and owns the submitted value', async () => {
    let admitted: JsonValue;
    const schema: Schema<unknown, JsonValue> = { '~standard': { version: 1, vendor: 'transform', validate: () => ({ value: admitted }) } };
    const source = fixture(schema); admitted = [source.reference] as unknown as JsonValue;
    await source.worker().submit(source.definition, { input: 'replace-me', idempotencyKey: 'key' });
    expect(source.submit.mock.calls[0]![0].input).toEqual(admitted);
    expect(Object.isFrozen(source.submit.mock.calls[0]![0].input)).toBe(true);
  });

  it('rejects invalid resolved targets before any persistence admission', async () => {
    const source = fixture(); const worker = source.worker();
    for (const input of [[], [source.reference, source.reference], null, [{ ...source.reference, extra: 'secret' }]]) {
      await expect(worker.submit(source.definition, { input: input as never, idempotencyKey: 'key' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(source.api.initialize).not.toHaveBeenCalled(); expect(source.submit).not.toHaveBeenCalled();
  });

  it('preserves timeout capacity until the actual adapter promise settles', async () => {
    const source = fixture(); const pending = deferred<WorkflowGraphStoreSnapshot>();
    source.inspect.mockImplementationOnce(() => pending.promise); releases.push(() => pending.resolve(source.view()));
    const worker = source.worker({ storageTimeoutMs: 20, maxPendingStorageOperations: 1 });
    await expect(worker.inspect(source.id)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await expect(worker.inspect(source.id)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED', storageCode: 'QUEUE_FULL' }); expect(source.inspect).toHaveBeenCalledOnce();
    pending.resolve(source.view()); await flush(); expect(await worker.inspect(source.id)).toMatchObject({ status: 'waiting' });
  });

  it('closes a blocked graph driver without closing the store or accepting a late response', async () => {
    const source = fixture(); const entered = deferred<void>(); const pending = deferred<WorkflowGraphStoreSnapshot>();
    source.inspect.mockImplementation(async () => { entered.resolve(); return pending.promise; }); releases.push(() => pending.resolve(source.view()));
    const worker = source.worker(); const result = worker.runUntilSettled(source.definition, source.id).catch((error: unknown) => error);
    await entered.promise; await worker.close(); expect(await result).toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    pending.resolve(source.view()); await flush(); expect(source.advance).not.toHaveBeenCalled(); expect(source.store.close).not.toHaveBeenCalled();
    await expect(worker.inspect(source.id)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('does not disclose private adapter diagnostics', async () => {
    const source = fixture(); source.inspect.mockRejectedValue(new StorageError('CONFLICT', 'PRIVATE connection secret'));
    const error: unknown = await source.worker().inspect(source.id).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'CONFLICT' }); expect(String(error)).not.toContain('PRIVATE');
  });

  it('rejects forged or legacy definitions before accessing either persistence profile', async () => {
    const source = fixture(); const worker = source.worker();
    const legacy = defineWorkflow({ id: 'legacy', version: '1', input: schema, output: schema, nodes: [{ kind: 'join', id: 'done', dependsOn: [] }], result: { kind: 'literal', value: null } });
    for (const definition of [legacy, { ...source.definition }]) {
      await expect(worker.submit(definition as never, { input: null, idempotencyKey: 'key' })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
      expect(() => worker.runUntilSettled(definition as never, source.id)).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    }
    expect(source.inspect).not.toHaveBeenCalled(); expect(source.submit).not.toHaveBeenCalled();
    const options = { store: source.store, scope, permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0, workerId: 'worker' };
    const conservative = createWorkflowRuntime(options);
    await expect(conservative.submit(source.definition as unknown as WorkflowDefinition, { input: null, idempotencyKey: 'key' })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await conservative.close();
    // A complete legacy capability is supplied solely to prove its definition gate remains strict.
    const workflows = { ...source.api, attach: async () => source.view() };
    const scheduled = createScheduledWorkflowRuntime({ ...options, store: { ...source.store, workflows } as never });
    await expect(scheduled.submit(source.definition as unknown as WorkflowDefinition, { input: null, idempotencyKey: 'key' })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(() => scheduled.runUntilSettled(source.definition as unknown as WorkflowDefinition, source.id)).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    await scheduled.close();
  });
});
