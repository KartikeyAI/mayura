import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { JsonObject } from '@mayura/core';
import { defineTool } from '@mayura/tools';
import {
  initialWorkflowState, StorageError, workflowPolicy, workflowResources,
  type Claim, type JobRecord, type ScheduledWorkflowAggregateStore, type ScheduledWorkflowSnapshot,
  type ScheduledWorkflowStore, type StoredRecord,
} from '@mayura/storage-contracts';
import { createScheduledWorkflowRuntime, defineWorkflow, type ScheduledWorkflowRuntime, type ScheduledWorkflowRuntimeOptions } from '../src/index.js';
import { digest } from '../src/definition.js';
import { scheduledManifest } from '../src/scheduled-helpers.js';

const scope = { principalId: 'worker-tests', projectId: 'project' };
const permissions = { allow: ['tool:write', 'effect:write'] };
const schema = z.number();
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
async function within<T>(promise: Promise<T>, ms = 500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Worker fixture exceeded its bounded wait.')), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
const flush = async (): Promise<void> => { for (let index = 0; index < 25; index++) await Promise.resolve(); };
const workers: ScheduledWorkflowRuntime[] = [];
const releaseFixtures: (() => void)[] = [];
afterEach(async () => {
  for (const release of releaseFixtures.splice(0)) release();
  await Promise.all(workers.splice(0).map(worker => worker.close()));
});

/** A trusted structural adapter fixture, not a substitute for SQL transaction conformance. */
function fixture(execute = vi.fn(async (value: number) => value + 1), options: { nodeIds?: readonly string[]; timeoutMs?: number; inputSchema?: typeof schema; permissionsAllow?: readonly string[] } = {}) {
  const nodeIds = options.nodeIds ?? ['write'];
  const fixturePermissions = options.permissionsAllow ? { allow: options.permissionsAllow } : permissions;
  const selected = defineTool({ id: 'write', version: '1', description: 'Controlled worker fixture.', input: schema, output: schema,
    effects: 'write', capabilities: [], costMicros: 0, timeoutMs: options.timeoutMs ?? 1_000, execute,
    ...(options.inputSchema ? { input: options.inputSchema } : {}),
  });
  const definition = defineWorkflow({ id: 'worker-fixture', version: '1', input: schema, output: schema,
    nodes: nodeIds.map(id => ({ kind: 'tool', id, tool: selected, input: { kind: 'input', path: [] } })),
    result: { kind: 'step', stepId: nodeIds[0]!, path: [] },
  });
  const manifest = scheduledManifest(definition);
  const policy = workflowPolicy({ scope, permissions: fixturePermissions.allow, policyVersion: 'v1', maxCostMicros: 0, maxOutputBytes: 65_536, approvalTtlMs: 3_600_000 });
  const scopeKey = digest('mayura:scope:v1', scope); const policyHash = digest('mayura:policy:v1', policy);
  const id = digest('mayura:run-id:v1', { scope: scopeKey, submissionKey: 'worker' });
  const state = initialWorkflowState(manifest, 1, definition.digest, policyHash, 0);
  const record: StoredRecord = { scope: scopeKey, id, idempotencyKey: 'worker', definitionHash: definition.digest, version: 1, state: state as unknown as JsonObject };
  const jobs: JobRecord[] = nodeIds.map(nodeId => {
    const candidateHash = digest('mayura:approval:v1', { runId: id, nodeId, tool: 'write', toolVersion: '1', input: 1, policy: policyHash, expiresAt: null });
    state.steps[nodeId]!.candidateHash = candidateHash;
    return { scope: scopeKey, jobId: `job.${nodeId}`, runId: id, nodeId, invocationId: `invoke.${nodeId}`,
    definitionHash: definition.digest, candidateHash, intent: { toolId: 'write', callId: `${id}/step:${nodeId}` }, resourceKeys: [],
    state: 'ready', version: 1, fence: 0, workerId: null, dueAtMs: 0, deadlineAtMs: null, leaseUntilMs: null, startedAtMs: null,
    leaseRevoked: false, cancelRequested: false, receipt: null, output: null };
  });
  let current: ScheduledWorkflowSnapshot = { record, profile: 'scheduled-v1', manifestHash: definition.digest, policyHash,
    resourceHash: digest('mayura:workflow-resources:v1', workflowResources({}, manifest)), jobs };
  const view = (): ScheduledWorkflowSnapshot => structuredClone(current);
  const setJob = (patch: Partial<JobRecord>, jobId = current.jobs[0]!.jobId): void => {
    current = { ...current, jobs: current.jobs.map(job => job.jobId === jobId ? { ...job, ...patch } : job), record: { ...current.record, version: current.record.version + 1 } };
  };
  const leased = (jobId = current.jobs[0]!.jobId): { job: JobRecord; claim: Claim } => {
    setJob({ state: 'leased', fence: 1, workerId: 'worker', leaseUntilMs: Date.now() + 3_000 }, jobId);
    const claimed = current.jobs.find(job => job.jobId === jobId)!;
    return { job: structuredClone(claimed), claim: { scope: scopeKey, jobId: claimed.jobId, fence: 1, workerId: 'worker', leaseUntilMs: claimed.leaseUntilMs! } };
  };
  const started = (jobId = current.jobs[0]!.jobId): ScheduledWorkflowSnapshot => {
    const job = current.jobs.find(job => job.jobId === jobId)!;
    state.steps[job.nodeId]!.status = 'dispatching'; setJob({ state: 'started', startedAtMs: Date.now() }, jobId); return view();
  };
  const api: ScheduledWorkflowStore = {
    initialize: vi.fn(async () => {}), submit: async () => ({ snapshot: view(), created: true }), attach: async () => view(), inspect: async () => view(),
    requestApproval: async () => view(), approve: async () => view(), prepare: async () => view(),
    claim: async command => current.jobs.filter(job => job.state === 'ready').slice(0, command.limit).map(job => leased(job.jobId)),
    renew: async command => ({ ...command.claim, leaseUntilMs: Date.now() + 3_000 }),
    start: async command => ({ status: 'started', snapshot: started(command.claim.jobId) }),
    recordReceipt: async command => {
      const job = current.jobs.find(job => job.jobId === command.jobId)!; state.steps[job.nodeId]!.receipt = command.receipt;
      if (command.receipt.execution === 'unknown') state.steps[job.nodeId]!.status = 'unknown';
      setJob({ receipt: command.receipt, ...(command.receipt.execution === 'unknown' ? { state: 'outcome_unknown' } : {}) }, job.jobId); return view();
    },
    complete: vi.fn(async command => {
      const job = current.jobs.find(job => job.jobId === command.claim.jobId)!;
      if (command.outcome === 'succeeded') {
        const receipt = { ...job.receipt!, disclosure: 'released' as const };
        state.steps[job.nodeId] = { ...state.steps[job.nodeId]!, status: 'succeeded', output: command.output, receipt };
        setJob({ state: 'succeeded', output: command.output, receipt }, job.jobId);
      }
      return view();
    }), abandon: async () => view(), failNode: async () => view(), advance: async () => view(), finalize: async command => {
      state.status = command.validation === 'passed' ? 'succeeded' : 'failed'; state.output = command.validation === 'passed' ? command.output : null;
      current = { ...current, record: { ...current.record, version: current.record.version + 1 } }; return view();
    },
    cancel: async () => view(), recover: async () => view(),
  };
  const store: ScheduledWorkflowAggregateStore = {
    initialize: vi.fn(async () => {}), create: async () => ({ record, created: true }), read: async () => record,
    update: vi.fn(async () => { throw new Error('Legacy writes must not be used.'); }), events: vi.fn(async () => []), close: vi.fn(async () => {}),
    scheduler: {} as ScheduledWorkflowAggregateStore['scheduler'], workflows: api,
  };
  const worker = (options: Partial<Omit<ScheduledWorkflowRuntimeOptions, 'store'>> = {}): ScheduledWorkflowRuntime => {
    const value = createScheduledWorkflowRuntime({ store, scope, permissions: fixturePermissions, policyVersion: 'v1', maxCostMicros: 0,
      workerId: 'worker', leaseMs: 3_000, ...options }); workers.push(value); return value;
  };
  return { definition, execute, store, api, id, worker, view, leased, started, setJob, state, clearJobs: () => { current = { ...current, jobs: [] }; } };
}

describe('bounded scheduled worker and custom adapter boundaries', () => {
  it.each(['initialize', 'inspect'] as const)('closes promptly when %s never settles, without closing the caller store', async method => {
    const source = fixture(); const entered = deferred<void>(); const blocked = deferred<never>();
    if (method === 'initialize') source.api.initialize = async () => { entered.resolve(); return blocked.promise; };
    else source.api.inspect = async () => { entered.resolve(); return blocked.promise; };
    const worker = source.worker(); const result = worker.runUntilSettled(source.definition, source.id).catch((error: unknown) => error);
    await within(entered.promise); const closing = worker.close(); expect(worker.close()).toBe(closing); await within(closing);
    expect(await within(result)).toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(source.execute).not.toHaveBeenCalled(); expect(source.store.close).not.toHaveBeenCalled(); expect(source.store.update).not.toHaveBeenCalled();
  });

  it('closes promptly while a claimed batch acknowledgement never settles', async () => {
    const source = fixture(); const entered = deferred<void>();
    source.api.claim = async () => { entered.resolve(); return new Promise(() => {}); };
    const worker = source.worker(); const result = worker.runUntilSettled(source.definition, source.id).catch((error: unknown) => error);
    await within(entered.promise); await within(worker.close()); expect(await within(result)).toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(source.execute).not.toHaveBeenCalled();
  });

  it('never dispatches a late claim acknowledgement after close', async () => {
    const source = fixture(); const entered = deferred<void>(); const reply = deferred<Awaited<ReturnType<ScheduledWorkflowStore['claim']>>>();
    source.api.claim = async () => { entered.resolve(); return reply.promise; };
    const worker = source.worker(); const result = worker.runUntilSettled(source.definition, source.id).catch((error: unknown) => error);
    await within(entered.promise); await within(worker.close()); await within(result);
    reply.resolve([source.leased()]); await flush(); expect(source.execute).not.toHaveBeenCalled(); expect(source.api.complete).not.toHaveBeenCalled();
  });

  it('never dispatches a late committed start acknowledgement after close', async () => {
    const source = fixture(); const entered = deferred<void>(); const reply = deferred<Awaited<ReturnType<ScheduledWorkflowStore['start']>>>();
    source.api.start = async () => { source.started(); entered.resolve(); return reply.promise; };
    const worker = source.worker(); const result = worker.runUntilSettled(source.definition, source.id).catch((error: unknown) => error);
    await within(entered.promise); await within(worker.close()); await within(result);
    reply.resolve({ status: 'started', snapshot: source.view() }); await flush();
    expect(source.execute).not.toHaveBeenCalled(); expect(source.api.complete).not.toHaveBeenCalled();
  });

  it('times out a stuck adapter without shutdown and never exposes its raw errors', async () => {
    const source = fixture(); source.api.inspect = async () => new Promise(() => {});
    const worker = source.worker({ storageTimeoutMs: 20 });
    await expect(within(worker.inspect(source.id))).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    const failing = fixture(); failing.api.inspect = async () => { throw new StorageError('CONFLICT', 'SECRET connection password'); };
    const result = await failing.worker().inspect(failing.id).catch((error: unknown) => error);
    expect(result).toMatchObject({ code: 'CONFLICT' }); expect(String(result)).not.toContain('SECRET');
  });

  it('quarantines a timed-out persistence slot until the underlying adapter call actually settles', async () => {
    const source = fixture(); const late = deferred<ScheduledWorkflowSnapshot>();
    const inspect = vi.fn(async () => inspect.mock.calls.length === 1 ? late.promise : source.view()); source.api.inspect = inspect;
    releaseFixtures.push(() => late.resolve(source.view()));
    const worker = source.worker({ storageTimeoutMs: 20, maxPendingStorageOperations: 1 });
    await expect(within(worker.inspect(source.id))).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await expect(within(worker.inspect(source.id))).rejects.toMatchObject({ code: 'QUEUE_FULL' });
    expect(inspect).toHaveBeenCalledOnce();
    late.resolve(source.view()); await flush();
    expect(await within(worker.inspect(source.id))).toMatchObject({ id: source.id }); expect(inspect).toHaveBeenCalledTimes(2);
  });

  it('retains late known receipt persistence after close without releasing output or closing storage', async () => {
    const entered = deferred<void>(); const finish = deferred<number>(); releaseFixtures.push(() => finish.resolve(2));
    const execute = vi.fn(async () => { entered.resolve(); return finish.promise; }); const source = fixture(execute);
    const persist = vi.fn(source.api.recordReceipt); source.api.recordReceipt = persist;
    const worker = source.worker(); const result = worker.runUntilSettled(source.definition, source.id).catch((error: unknown) => error);
    await within(entered.promise); await within(worker.close()); await within(result); finish.resolve(2);
    await vi.waitFor(() => expect(persist).toHaveBeenCalled(), { timeout: 500 });
    expect(persist.mock.calls.some(([command]) => command.receipt.execution === 'succeeded' && command.receipt.disclosure === 'withheld')).toBe(true);
    expect(execute).toHaveBeenCalledOnce(); expect(source.api.complete).not.toHaveBeenCalled(); expect(source.store.close).not.toHaveBeenCalled();
  });

  it('snapshots adapter methods before later object replacement', async () => {
    const source = fixture(); const inspect = vi.fn(source.api.inspect); source.api.inspect = inspect;
    const worker = source.worker(); source.api.inspect = async () => { throw new Error('SECRET replacement'); };
    expect(await worker.inspect(source.id)).toMatchObject({ id: source.id, status: 'running' }); expect(inspect).toHaveBeenCalledOnce();
  });

  it.each(['advance', 'submit', 'attach'] as const)('rejects a foreign run returned by %s instead of disclosing it', async method => {
    const source = fixture();
    const foreign = (): ScheduledWorkflowSnapshot => {
      const value = source.view(); return { ...value, record: { ...value.record, id: 'f'.repeat(64) } };
    };
    if (method === 'submit') source.api.submit = async () => ({ snapshot: foreign(), created: true });
    else source.api[method] = async () => foreign();
    const worker = source.worker();
    const action = method === 'advance' ? worker.runUntilSettled(source.definition, source.id)
      : method === 'submit' ? worker.submit(source.definition, { input: 1, idempotencyKey: 'worker' }) : worker.attach(source.definition, source.id);
    await expect(action).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' }); expect(source.execute).not.toHaveBeenCalled();
  });

  it('coalesces matching definitions and rejects mismatched definitions for an active run', async () => {
    const source = fixture(); const entered = deferred<void>(); source.api.inspect = async () => { entered.resolve(); return new Promise(() => {}); };
    const worker = source.worker(); const first = worker.runUntilSettled(source.definition, source.id); void first.catch(() => {});
    expect(worker.runUntilSettled(source.definition, source.id)).toBe(first); await within(entered.promise);
    const other = defineWorkflow({ id: 'different', version: '1', input: schema, output: schema, nodes: source.definition.nodes, result: source.definition.result });
    await expect(worker.runUntilSettled(other, source.id)).rejects.toMatchObject({ code: 'CONFLICT' }); await within(worker.close());
  });

  it('rejects unsupported capabilities and invalid finite worker bounds', () => {
    const source = fixture(); const options = { store: source.store, scope, permissions, policyVersion: 'v1', maxCostMicros: 0, workerId: 'worker' };
    expect(() => createScheduledWorkflowRuntime({ ...options, store: { ...source.store, workflows: undefined } as unknown as ScheduledWorkflowAggregateStore })).toThrow();
    for (const storageTimeoutMs of [0, -1, Infinity, 30_001]) expect(() => createScheduledWorkflowRuntime({ ...options, storageTimeoutMs })).toThrow();
    for (const maxConcurrentJobs of [0, 33]) expect(() => createScheduledWorkflowRuntime({ ...options, maxConcurrentJobs })).toThrow();
    for (const maxPendingStorageOperations of [0, 1_025]) expect(() => createScheduledWorkflowRuntime({ ...options, maxPendingStorageOperations })).toThrow();
  });

  it.each(['oversized', 'duplicate', 'foreign-run', 'worker-substitution', 'revoked', 'getter'] as const)('rejects %s claim batches without dispatch', async kind => {
    const source = fixture(); const getter = vi.fn(() => { throw new Error('SECRET'); });
    source.api.claim = async () => {
      const claim = source.leased();
      const raw = kind === 'oversized' ? [claim, { ...claim, job: { ...claim.job, jobId: 'other' } }]
        : kind === 'duplicate' ? [claim, claim]
          : kind === 'foreign-run' ? [{ ...claim, job: { ...claim.job, runId: 'f'.repeat(64) } }]
            : kind === 'worker-substitution' ? [{ ...claim, claim: { ...claim.claim, workerId: 'another-worker' } }]
              : kind === 'revoked' ? [{ ...claim, job: { ...claim.job, leaseRevoked: true } }]
                : [Object.defineProperty({ claim: claim.claim }, 'job', { enumerable: true, get: getter })];
      return raw as unknown as Awaited<ReturnType<ScheduledWorkflowStore['claim']>>;
    };
    const worker = source.worker({ maxConcurrentJobs: kind === 'oversized' ? 1 : 2 });
    const result = await worker.runUntilSettled(source.definition, source.id).catch((error: unknown) => error);
    expect(result).toMatchObject({ code: 'STORAGE_UNAVAILABLE' }); expect(source.execute).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled(); expect(String(result)).not.toContain('SECRET');
  });

  it('rejects substituted renewal identity and withholds a pending handler result', async () => {
    const entered = deferred<void>(); const finish = deferred<number>(); releaseFixtures.push(() => finish.resolve(2));
    const execute = vi.fn(async () => { entered.resolve(); return finish.promise; }); const source = fixture(execute);
    const renew = vi.fn(async (command: Parameters<ScheduledWorkflowStore['renew']>[0]) => ({ ...command.claim, workerId: 'substituted-worker' }));
    source.api.renew = renew;
    const worker = source.worker({ leaseMs: 1_000 }); const result = worker.runUntilSettled(source.definition, source.id);
    await within(entered.promise); const outcome = await within(result, 900);
    expect(renew).toHaveBeenCalledOnce(); expect(outcome.steps['write']?.status).toBe('unknown');
    expect(source.api.complete).not.toHaveBeenCalled(); expect(execute).toHaveBeenCalledOnce();
  });

  it('redacts failed human verification and never calls the approval command', async () => {
    const source = fixture(); const approve = vi.fn(source.api.approve); source.api.approve = approve;
    const worker = source.worker({ verifyHuman: async () => { throw new StorageError('CONFLICT', 'SECRET identity-provider token'); } });
    const result = await worker.approve({ id: source.id, nodeId: 'write', digest: 'a'.repeat(64), credential: 'opaque credential' }).catch((error: unknown) => error);
    expect(result).toMatchObject({ code: 'PERMISSION_DENIED' }); expect(String(result)).not.toContain('SECRET'); expect(approve).not.toHaveBeenCalled();
  });

  it('checks permissions before invoking a node input schema or requesting preparation', async () => {
    const validate = vi.fn(() => true); const source = fixture(undefined, { inputSchema: schema.refine(validate), permissionsAllow: [] });
    source.clearJobs(); source.state.steps['write']!.candidateHash = null;
    const failNode = vi.fn(async () => { source.state.steps['write']!.status = 'blocked'; source.state.status = 'blocked'; return source.view(); });
    const prepare = vi.fn(source.api.prepare); source.api.prepare = prepare; source.api.failNode = failNode;
    expect((await source.worker().runUntilSettled(source.definition, source.id)).status).toBe('blocked');
    expect(validate).not.toHaveBeenCalled(); expect(source.execute).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled(); expect(failNode).toHaveBeenCalledOnce();
  });

  it('keeps its global job slot while a timed-out handler is still unsettled', async () => {
    const first = deferred<number>(); releaseFixtures.push(() => first.resolve(2)); let invocations = 0;
    const execute = vi.fn(async () => ++invocations === 1 ? first.promise : 2);
    const source = fixture(execute, { nodeIds: ['write', 'second'], timeoutMs: 25 });
    const claim = vi.fn(source.api.claim); source.api.claim = claim;
    const worker = source.worker({ maxConcurrentJobs: 1 });
    const firstResult = await within(worker.runUntilSettled(source.definition, source.id));
    expect(firstResult.steps['write']?.status).toBe('unknown'); expect(execute).toHaveBeenCalledOnce(); expect(claim).toHaveBeenCalledOnce();
    await within(worker.runUntilSettled(source.definition, source.id));
    expect(execute).toHaveBeenCalledOnce(); expect(claim).toHaveBeenCalledOnce();
    first.resolve(2); await flush();
    await within(worker.runUntilSettled(source.definition, source.id)); expect(execute).toHaveBeenCalledTimes(2);
  });

  it('joins all running claimed siblings when one sibling persistence operation fails', async () => {
    const secondStarted = deferred<void>(); const finish = deferred<number>(); releaseFixtures.push(() => finish.resolve(2)); let invocations = 0;
    const execute = vi.fn(async () => { if (++invocations === 2) { secondStarted.resolve(); return finish.promise; } return 2; });
    const source = fixture(execute, { nodeIds: ['write', 'second'] }); const record = source.api.recordReceipt;
    const failedReceipt = deferred<void>();
    source.api.recordReceipt = async command => {
      if (command.jobId === 'job.write') { failedReceipt.resolve(); throw new StorageError('STORAGE_UNAVAILABLE', 'SECRET adapter failure'); }
      return record(command);
    };
    const worker = source.worker({ maxConcurrentJobs: 2 }); let settled = false;
    const result = worker.runUntilSettled(source.definition, source.id).then(value => { settled = true; return value; }, (error: unknown) => { settled = true; return error; });
    await within(secondStarted.promise); await within(failedReceipt.promise); await flush();
    expect(settled).toBe(false); expect(execute).toHaveBeenCalledTimes(2);
    finish.resolve(2); const outcome = await within(result);
    expect(outcome).toMatchObject({ code: 'STORAGE_UNAVAILABLE' }); expect(String(outcome)).not.toContain('SECRET');
    expect(source.api.complete).toHaveBeenCalledOnce();
  });
});
