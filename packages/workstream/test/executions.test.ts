import { createHash } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { StorageError, workflowHashMaterial, type ExecutionWaitAggregateStore, type ExecutionWaitSnapshot, type ExecutionWaitStore } from '@mayura/storage-contracts';
import { createExecutionWorkStream } from '../src/executions.js';

const scope = { principalId: 'principal', projectId: 'project' };
const policyHash = 'a'.repeat(64); const definitionHash = 'b'.repeat(64);
const target = { kind: 'scheduled-workflow' as const, runId: 'c'.repeat(64), definitionHash, policyHash };
const hash = (domain: string, value: unknown): string => createHash('sha256').update(workflowHashMaterial(domain, value)).digest('hex');
const key = { scope: hash('mayura:scope:v1', scope), streamId: 'joins', policyHash };
function snapshot(id = 'join', targets = [target], status: 'waiting' | 'resolved' | 'cancelled' = 'waiting'): ExecutionWaitSnapshot {
  return { id, version: status === 'cancelled' ? 2 : 1, definitionHash: hash('mayura:execution-wait:v1', { format: 1, key, id, targets }), status, targets,
    observations: status === 'resolved' ? targets.map(reference => ({ reference, outcome: 'outcome_unknown' as const, sourceVersion: 3, sourceEventSequence: 5 })) : [] };
}
function fixture() {
  const api = {
    initialize: vi.fn(async (): Promise<void> => undefined), open: vi.fn(async (_command: unknown): Promise<void> => undefined), materialize: vi.fn(async () => undefined),
    register: vi.fn(async (_command: unknown) => snapshot()), inspect: vi.fn(async (_command: unknown): Promise<ExecutionWaitSnapshot | undefined> => snapshot()),
    cancel: vi.fn(async (_command: unknown) => snapshot('join', [target], 'cancelled')),
    drainReady: vi.fn(async (_command: unknown): Promise<readonly ExecutionWaitSnapshot[]> => []), events: vi.fn(async (_command: unknown) => []),
  } satisfies ExecutionWaitStore;
  const close = vi.fn(async () => undefined);
  const store = { executionWaits: api, close } as unknown as ExecutionWaitAggregateStore;
  return { api, store, close };
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; }); return { promise, resolve, reject };
}

describe('execution completion facade', () => {
  it('pins configured scope/policy, captures callbacks and releases only immutable metadata', async () => {
    const { api, store, close } = fixture(); const inputScope = { ...scope };
    const stream = createExecutionWorkStream({ store, scope: inputScope, policyHash, streamId: 'joins' });
    inputScope.projectId = 'changed'; const captured = api.register; api.register = vi.fn(async () => { throw new Error('replacement must not run'); });
    await stream.initialize(); const result = await stream.register({ id: 'join', targets: [target] });
    expect(api.open).toHaveBeenCalledWith(key); expect(captured).toHaveBeenCalledWith({ ...key, id: 'join', targets: [target] });
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.targets)).toBe(true); expect(Object.isFrozen(result.targets[0])).toBe(true);
    await stream.close(); expect(close).not.toHaveBeenCalled();
  });

  it('coalesces initialization and snapshots commands before the first asynchronous store callback', async () => {
    const { api, store } = fixture(); const stream = createExecutionWorkStream({ store, scope, policyHash, streamId: 'joins' });
    await expect(stream.inspect('join')).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await Promise.all([stream.initialize(), stream.initialize(), stream.initialize()]);
    expect(api.initialize).toHaveBeenCalledTimes(1); expect(api.open).toHaveBeenCalledTimes(1);
    const mutable = { id: 'join', targets: [{ ...target }] }; const pending = stream.register(mutable);
    mutable.id = 'changed'; mutable.targets[0]!.runId = '0'.repeat(64);
    expect(await pending).toEqual(snapshot()); expect(api.register).toHaveBeenCalledWith({ ...key, id: 'join', targets: [target] });
    await stream.close();
  });

  it('does not continue initialization after a timed-out adapter callback settles late', async () => {
    const { api, store } = fixture(); const late = deferred<void>(); api.initialize.mockImplementation(() => late.promise);
    const stream = createExecutionWorkStream({ store, scope, policyHash, streamId: 'joins', storageTimeoutMs: 20, maxPendingStorageOperations: 1 });
    await expect(stream.initialize()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await expect(stream.initialize()).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' }); expect(api.initialize).toHaveBeenCalledTimes(1);
    late.resolve(); await nextTurn(); expect(api.open).not.toHaveBeenCalled();
    await stream.initialize(); expect(api.initialize).toHaveBeenCalledTimes(2); expect(api.open).toHaveBeenCalledTimes(1); await stream.close();
  });

  it('retains no partial response identities when a drain batch fails validation', async () => {
    const { api, store } = fixture(); api.inspect.mockImplementation(async command => snapshot((command as { id: string }).id));
    const stream = createExecutionWorkStream({ store, scope, policyHash, streamId: 'joins' }); await stream.initialize();
    for (let index = 0; index < 127; index++) await stream.inspect(`join${index}`);
    api.drainReady.mockResolvedValue([snapshot('not-retained', [target], 'resolved'), { ...snapshot('invalid', [target], 'resolved'), definitionHash: '0'.repeat(64) }]);
    await expect(stream.drainReady()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(await stream.inspect('last')).toMatchObject({ id: 'last' });
    await expect(stream.inspect('overflow')).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(await stream.inspect('join0')).toMatchObject({ id: 'join0' }); await stream.close();
  });

  it('rejects payload getters without executing them and rechecks closure after async response hashing', async () => {
    const { api, store } = fixture(); const stream = createExecutionWorkStream({ store, scope, policyHash, streamId: 'joins' }); await stream.initialize();
    const getter = vi.fn(() => 'PRIVATE'); const malformed = snapshot(); Object.defineProperty(malformed, 'output', { enumerable: true, get: getter });
    api.inspect.mockResolvedValue(malformed); await expect(stream.inspect('join')).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' }); expect(getter).not.toHaveBeenCalled();
    api.inspect.mockResolvedValue(snapshot());
    const material = workflowHashMaterial('mayura:execution-wait:v1', { format: 1, key, id: 'join', targets: [target] });
    const genuineDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
    const pending = deferred<ArrayBuffer>(); const hashStarted = deferred<void>();
    const hashing = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(() => { hashStarted.resolve(); return pending.promise; });
    try {
      const reading = stream.inspect('join'); const failure = expect(reading).rejects.toMatchObject({ code: 'CANCELLED' });
      await hashStarted.promise; await stream.close(); pending.resolve(genuineDigest); await failure;
    } finally { pending.resolve(genuineDigest); hashing.mockRestore(); await stream.close(); }
  });

  it('rejects forged adapter content before disclosing workflow payloads', async () => {
    const { api, store } = fixture(); api.register.mockResolvedValue({ ...snapshot(), output: 'PRIVATE workflow content' } as ExecutionWaitSnapshot);
    const stream = createExecutionWorkStream({ store, scope, policyHash, streamId: 'joins' }); await stream.initialize();
    await expect(stream.register({ id: 'join', targets: [target] })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await stream.close();
  });

  it('retains actual pending adapter capacity after timeout and bounds close without closing storage', async () => {
    const { api, store, close } = fixture(); const pending = deferred<ExecutionWaitSnapshot | undefined>(); api.inspect.mockImplementation(() => pending.promise);
    const stream = createExecutionWorkStream({ store, scope, policyHash, streamId: 'joins', storageTimeoutMs: 20, maxPendingStorageOperations: 1 }); await stream.initialize();
    await expect(stream.inspect('join')).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await expect(stream.inspect('join')).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' }); expect(api.inspect).toHaveBeenCalledTimes(1);
    pending.resolve(snapshot()); await nextTurn(); api.inspect.mockResolvedValue(snapshot());
    expect(await stream.inspect('join')).toMatchObject({ id: 'join' }); await stream.close(); expect(close).not.toHaveBeenCalled();
  });

  it('stops new commands and bounded pending waits on close without dispatching cleanup or target cancellation', async () => {
    const { api, store, close } = fixture(); const pending = deferred<ExecutionWaitSnapshot | undefined>(); api.inspect.mockImplementation(() => pending.promise);
    const stream = createExecutionWorkStream({ store, scope, policyHash, streamId: 'joins' }); await stream.initialize();
    const reading = stream.inspect('join'); const rejection = expect(reading).rejects.toMatchObject({ code: 'CANCELLED' });
    await nextTurn(); await stream.close(); await rejection;
    await expect(stream.register({ id: 'join', targets: [target] })).rejects.toMatchObject({ code: 'CANCELLED' });
    pending.reject(new Error('PRIVATE late failure')); await nextTurn(); expect(close).not.toHaveBeenCalled(); expect(api.cancel).not.toHaveBeenCalled();
  });

  it.each(['id', 'digest', 'policy', 'definition', 'target-order', 'observations', 'version'] as const)('rejects an adapter registration with invalid %s', async invalid => {
    const { api, store } = fixture(); const other = { ...target, runId: 'd'.repeat(64) }; const targets = [target, other];
    const good = snapshot('join', targets, 'resolved'); let bad: unknown = good;
    if (invalid === 'id') bad = snapshot('other', targets, 'resolved');
    if (invalid === 'digest') bad = { ...good, definitionHash: '0'.repeat(64) };
    if (invalid === 'policy') bad = snapshot('join', targets.map(item => ({ ...item, policyHash: '0'.repeat(64) })), 'resolved');
    if (invalid === 'definition') bad = snapshot('join', targets.map(item => ({ ...item, definitionHash: '0'.repeat(64) })), 'resolved');
    if (invalid === 'target-order') bad = snapshot('join', [other, target], 'resolved');
    if (invalid === 'observations') bad = { ...good, observations: [...good.observations].reverse() };
    if (invalid === 'version') bad = { ...good, version: 99 };
    api.register.mockResolvedValue(bad as ExecutionWaitSnapshot);
    const stream = createExecutionWorkStream({ store, scope, policyHash, streamId: 'joins' }); await stream.initialize();
    await expect(stream.register({ id: 'join', targets })).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' }); await stream.close();
  });

  it.each(['policy', 'duplicate', 'uppercase', 'extra', 'empty', 'oversize'] as const)('rejects malformed %s targets before storage dispatch', async invalid => {
    const { api, store } = fixture(); let targets: unknown = [target];
    if (invalid === 'policy') targets = [{ ...target, policyHash: '0'.repeat(64) }];
    if (invalid === 'duplicate') targets = [target, target];
    if (invalid === 'uppercase') targets = [{ ...target, runId: 'C'.repeat(64) }];
    if (invalid === 'extra') targets = [{ ...target, scope: 'forged', output: 'PRIVATE' }];
    if (invalid === 'empty') targets = [];
    if (invalid === 'oversize') targets = Array.from({ length: 33 }, (_, index) => ({ ...target, runId: index.toString(16).padStart(64, '0') }));
    const stream = createExecutionWorkStream({ store, scope, policyHash, streamId: 'joins' }); await stream.initialize();
    await expect(stream.register({ id: 'join', targets: targets as typeof target[] })).rejects.toMatchObject({ code: invalid === 'policy' ? 'CONFLICT' : 'INVALID_INPUT' });
    expect(api.register).not.toHaveBeenCalled(); await stream.close();
  });

  it('pins exact known wait identity across reads while accepting undefined for unknown IDs', async () => {
    const { api, store } = fixture(); const stream = createExecutionWorkStream({ store, scope, policyHash, streamId: 'joins' }); await stream.initialize();
    await stream.register({ id: 'join', targets: [target] });
    api.inspect.mockResolvedValue(snapshot('join', [{ ...target, definitionHash: '0'.repeat(64) }]));
    await expect(stream.inspect('join')).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    api.inspect.mockResolvedValue(undefined); expect(await stream.inspect('unknown')).toBeUndefined();
    api.cancel.mockRejectedValue(new StorageError('NOT_FOUND', 'PRIVATE SQL/path'));
    await expect(stream.cancel('unknown')).rejects.toMatchObject({ code: 'NOT_FOUND' }); await stream.close();
  });

  it('bounds drains and rejects nonterminal, duplicate, oversized or wrong-policy pages', async () => {
    const { api, store } = fixture(); const stream = createExecutionWorkStream({ store, scope, policyHash, streamId: 'joins' }); await stream.initialize();
    for (const page of [[snapshot()], [snapshot('join', [target], 'resolved'), snapshot('join', [target], 'resolved')], Array.from({ length: 33 }, (_, i) => snapshot(`join${i}`, [target], 'resolved'))]) {
      api.drainReady.mockResolvedValue(page); await expect(stream.drainReady()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    }
    api.drainReady.mockResolvedValue([snapshot('join', [target], 'resolved')]);
    expect(await stream.drainReady({ limit: 1 })).toEqual([snapshot('join', [target], 'resolved')]);
    expect(api.drainReady).toHaveBeenLastCalledWith({ ...key, limit: 1 });
    for (const limit of [0, -1, 33, NaN, 1.5]) await expect(stream.drainReady({ limit })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await stream.close();
  });

  it('validates exact ordered metadata event pages without exposing payloads', async () => {
    const { api, store } = fixture(); const stream = createExecutionWorkStream({ store, scope, policyHash, streamId: 'joins' }); await stream.initialize();
    const createdAt = '2026-09-20T00:00:00.000Z';
    const good = [{ sequence: 1, createdAt, type: 'stream.created', data: {} }, { sequence: 2, createdAt, type: 'wait.registered', data: { waitId: 'join' } }];
    api.events.mockResolvedValue(good as never); expect(await stream.events()).toEqual(good);
    expect(api.events).toHaveBeenLastCalledWith({ ...key, after: 0 });
    for (const bad of [[good[1], good[0]], [{ ...good[0], type: 'private.raw' }], [{ ...good[1], data: { waitId: 'join', output: 'PRIVATE' } }], [{ ...good[1], createdAt: 'yesterday' }]]) {
      api.events.mockResolvedValue(bad as never); await expect(stream.events()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    }
    await stream.close();
  });

  it.each(['CONFLICT', 'QUEUE_FULL', 'STORAGE_UNAVAILABLE'] as const)('sanitizes custom-store %s messages and preserves only documented codes', async code => {
    const { api, store } = fixture(); api.inspect.mockRejectedValue(new StorageError(code, 'PRIVATE credential://secret'));
    const stream = createExecutionWorkStream({ store, scope, policyHash, streamId: 'joins' }); await stream.initialize();
    const failure: unknown = await stream.inspect('join').catch(error => error);
    expect(failure).toMatchObject({ code: code === 'QUEUE_FULL' ? 'LIMIT_EXCEEDED' : code }); expect(String(failure)).not.toContain('PRIVATE'); await stream.close();
  });

  it('rejects accessor configuration and adapter methods without executing their getters', () => {
    const { api, store } = fixture(); const getter = vi.fn(() => async () => undefined);
    Object.defineProperty(api, 'register', { enumerable: true, get: getter });
    expect(() => createExecutionWorkStream({ store, scope, policyHash, streamId: 'joins' })).toThrow(); expect(getter).not.toHaveBeenCalled();
    for (const storageTimeoutMs of [0, NaN, 30_001]) expect(() => createExecutionWorkStream({ store: fixture().store, scope, policyHash, streamId: 'joins', storageTimeoutMs })).toThrow();
    for (const maxPendingStorageOperations of [0, 1.5, 1_025]) expect(() => createExecutionWorkStream({ store: fixture().store, scope, policyHash, streamId: 'joins', maxPendingStorageOperations })).toThrow();
  });
});
