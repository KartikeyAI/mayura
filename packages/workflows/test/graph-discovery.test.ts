import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JsonValue } from '@mayura/core';
import { StorageError, workflowPolicy, type WorkflowGraphDiscoveryAggregateStore,
  type WorkflowGraphDiscoveryCursor, type WorkflowGraphDiscoveryPage, type WorkflowGraphDiscoveryScan } from '@mayura/storage-contracts';
import { createWorkflowGraphDiscovery, type WorkflowGraphDiscovery, type WorkflowGraphDiscoveryOptions } from '../src/graphs.js';
import { digest } from '../src/definition.js';

const scope = { principalId: 'reader@example.com', projectId: 'project/मयूर' };
const configuration = { scope, permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0 };
const policy = workflowPolicy({ scope, permissions: [], policyVersion: '1', maxCostMicros: 0,
  maxOutputBytes: 65_536, approvalTtlMs: 3_600_000 });
const scopeKey = digest('mayura:scope:v1', scope); const policyHash = digest('mayura:policy:v1', policy);
const candidate = { reference: { kind: 'scheduled-workflow' as const, runId: '2'.repeat(64),
  definitionHash: 'd'.repeat(64), policyHash }, version: 2, status: 'waiting' as const };
const facades: WorkflowGraphDiscovery[] = []; const releases: (() => void)[] = [];
afterEach(async () => { for (const release of releases.splice(0)) release(); await Promise.all(facades.splice(0).map(facade => facade.close())); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
async function flush(): Promise<void> { for (let index = 0; index < 25; index++) await Promise.resolve(); }
function fixture() {
  const page: WorkflowGraphDiscoveryPage = { candidates: [structuredClone(candidate)], examined: 1, nextCursor: null };
  const initialize = vi.fn(async () => {});
  const scan = vi.fn(async (_command: WorkflowGraphDiscoveryScan) => structuredClone(page));
  const close = vi.fn(async () => {});
  const store = { workflowGraphDiscovery: { initialize, scan }, close } as unknown as WorkflowGraphDiscoveryAggregateStore;
  const create = (options: Partial<WorkflowGraphDiscoveryOptions> = {}): WorkflowGraphDiscovery => {
    const facade = createWorkflowGraphDiscovery({ ...configuration, store, ...options }); facades.push(facade); return facade;
  };
  return { page, initialize, scan, close, store, create };
}
function cursor(afterId = '1'.repeat(64)): WorkflowGraphDiscoveryCursor {
  return { format: 1, scope: scopeKey, policyHash, afterId };
}

describe('finite graph discovery public and custom-adapter contract', () => {
  it('returns only immutable candidate metadata and snapshots graph-compatible policy identity', async () => {
    const source = fixture(); const configured = { ...configuration, scope: { ...scope }, permissions: { allow: [] as string[] } };
    const facade = source.create(configured); configured.scope.projectId = 'mutated'; configured.permissions.allow.push('changed');
    const page = await facade.scan(); await facade.scan();
    expect(source.initialize).toHaveBeenCalledOnce(); expect(source.scan).toHaveBeenCalledTimes(2);
    expect(source.scan).toHaveBeenLastCalledWith({ scope: scopeKey, policyHash, cursor: null, limit: 16 });
    expect(page).toEqual(source.page); expect(Object.isFrozen(page)).toBe(true);
    expect(Object.isFrozen(page.candidates[0]!.reference)).toBe(true);
    expect(Object.keys(facade).sort()).toEqual(['close', 'cursorAfter', 'scan']);
    expect(Object.isFrozen(source.scan.mock.calls[0]![0])).toBe(true);
    await facade.close(); expect(source.close).not.toHaveBeenCalled();
  });

  it('continues over an all-terminal examined page without inventing ready candidates', async () => {
    const source = fixture(); const next = cursor('4'.repeat(64));
    source.scan.mockResolvedValueOnce({ candidates: [], examined: 2, nextCursor: next });
    const facade = source.create(); const page = await facade.scan({ limit: 2 });
    expect(page).toEqual({ candidates: [], examined: 2, nextCursor: next });
    source.scan.mockResolvedValueOnce({ candidates: [], examined: 0, nextCursor: null });
    expect(await facade.scan({ cursor: page.nextCursor!, limit: 2 })).toEqual({ candidates: [], examined: 0, nextCursor: null });
    expect(source.scan.mock.calls[1]![0].cursor).toEqual(next);
    await facade.scan(); expect(source.scan.mock.calls[2]![0].cursor).toBeNull();
    expect(source.scan).toHaveBeenCalledTimes(3);
  });

  it('captures ordinary class capability methods with their receiver', async () => {
    class Capability {
      calls = 0;
      async initialize(): Promise<void> { this.calls++; }
      async scan(_command: WorkflowGraphDiscoveryScan): Promise<WorkflowGraphDiscoveryPage> {
        this.calls++; return { candidates: [], examined: 0, nextCursor: null };
      }
    }
    const source = fixture(); const capability = new Capability();
    await source.create({ store: { workflowGraphDiscovery: capability } as never }).scan();
    expect(capability.calls).toBe(2);
  });

  it('requires a separate capability without executing capability or method getters', () => {
    const source = fixture(); const getter = vi.fn(() => source.store.workflowGraphDiscovery);
    const stores = [{}, { workflowGraphs: {} }, Object.defineProperty({}, 'workflowGraphDiscovery', { enumerable: true, get: getter }),
      { workflowGraphDiscovery: Object.defineProperty({ scan: source.scan }, 'initialize', { enumerable: true, get: getter }) }];
    for (const store of stores) expect(() => source.create({ store: store as never })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_PROFILE' }));
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects option accessors, unknown fields, invalid policy and non-finite callback limits', () => {
    const source = fixture(); const getter = vi.fn(() => scope);
    expect(() => createWorkflowGraphDiscovery(Object.defineProperty({ ...configuration, store: source.store }, 'scope', { enumerable: true, get: getter }))).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(getter).not.toHaveBeenCalled();
    for (const options of [{ workerId: 'not-needed' }, { verifyHuman: () => true }, { maxCostMicros: -1 }, { maxOutputBytes: 65_537 },
      { permissions: { allow: [], extra: true } }, { storageTimeoutMs: 0 }, { storageTimeoutMs: 30_001 },
      { maxPendingStorageOperations: 0 }, { maxPendingStorageOperations: 1_025 }]) {
      expect(() => source.create(options as never)).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    }
  });

  it('rejects malformed user commands before any initialization or getter execution', async () => {
    const source = fixture(); const facade = source.create(); const getter = vi.fn(() => 1);
    for (const command of [null, [], { extra: true }, { limit: 0 }, { limit: 33 }, { limit: 1.5 }, { cursor: {} },
      { cursor: { ...cursor(), scope: 'f'.repeat(64) } }, { cursor: { ...cursor(), policyHash: 'f'.repeat(64) } },
      Object.defineProperty({}, 'limit', { enumerable: true, get: getter })]) {
      await expect(facade.scan(command as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(getter).not.toHaveBeenCalled(); expect(source.initialize).not.toHaveBeenCalled(); expect(source.scan).not.toHaveBeenCalled();
  });

  it('owns scan cursors before an initialization await allows caller mutation', async () => {
    const source = fixture(); const gate = deferred<void>(); source.initialize.mockImplementationOnce(() => gate.promise);
    releases.push(() => gate.resolve()); const command = { cursor: { ...cursor() }, limit: 2 }; const admitted = structuredClone(command);
    const result = source.create().scan(command); command.cursor.afterId = 'f'.repeat(64); command.limit = 32;
    gate.resolve(); expect(await result).toEqual(source.page);
    expect(source.scan).toHaveBeenCalledWith({ scope: scopeKey, policyHash, ...admitted });
  });

  it.each(['extra', 'oversized', 'wrongPolicy', 'duplicate', 'unordered', 'terminal', 'version', 'examined', 'cursorScope', 'cursorPolicy', 'cursorOrder', 'shortContinuation', 'fullWithoutContinuation'] as const)(
    'fails closed on malformed %s response metadata', async field => {
      const source = fixture(); const raw = structuredClone(source.page) as unknown as Record<string, unknown>;
      const entries = raw['candidates'] as Record<string, unknown>[]; const item = entries[0]!;
      if (field === 'extra') raw['input'] = 'secret';
      else if (field === 'oversized') item['secret'] = 'x'.repeat(100_000);
      else if (field === 'wrongPolicy') (item['reference'] as Record<string, unknown>)['policyHash'] = 'f'.repeat(64);
      else if (field === 'duplicate') { entries.push(structuredClone(item)); raw['examined'] = 2; }
      else if (field === 'unordered') { entries.push({ ...item, reference: { ...candidate.reference, runId: '1'.repeat(64) } }); raw['examined'] = 2; }
      else if (field === 'terminal') item['status'] = 'succeeded';
      else if (field === 'version') item['version'] = 0;
      else if (field === 'examined') raw['examined'] = 0;
      else if (field === 'cursorScope') raw['nextCursor'] = { ...cursor('3'.repeat(64)), scope: 'f'.repeat(64) };
      else if (field === 'cursorPolicy') raw['nextCursor'] = { ...cursor('3'.repeat(64)), policyHash: 'f'.repeat(64) };
      else if (field === 'cursorOrder') raw['nextCursor'] = cursor('1'.repeat(64));
      else if (field === 'shortContinuation') raw['nextCursor'] = cursor('3'.repeat(64));
      else raw['examined'] = 16;
      source.scan.mockResolvedValue(raw as unknown as WorkflowGraphDiscoveryPage);
      await expect(source.create().scan()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    },
  );

  it('rejects response accessors without executing them and never retains caller-owned response data', async () => {
    const source = fixture(); const getter = vi.fn(() => []);
    source.scan.mockResolvedValueOnce(Object.defineProperty({ examined: 0, nextCursor: null }, 'candidates', { enumerable: true, get: getter }) as never);
    const facade = source.create(); await expect(facade.scan()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(getter).not.toHaveBeenCalled();
    source.scan.mockResolvedValueOnce(source.page); const admitted = await facade.scan();
    (source.page.candidates[0] as unknown as Record<string, JsonValue>)['version'] = 999;
    expect(admitted.candidates[0]!.version).toBe(2);
  });

  it('rejects non-void initialization acknowledgements before scanning', async () => {
    const source = fixture(); source.initialize.mockResolvedValueOnce({ hidden: true } as never);
    await expect(source.create().scan()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(source.scan).not.toHaveBeenCalled();
  });

  it('sanitizes provider errors without reading exception messages or code accessors', async () => {
    const source = fixture(); const getter = vi.fn(() => 'sensitive provider detail');
    const error = Object.defineProperty(new StorageError('CONFLICT', 'private secret'), 'message', { get: getter });
    source.scan.mockRejectedValueOnce(error); const facade = source.create();
    const response = await facade.scan().catch((failure: unknown) => failure);
    expect(response).toMatchObject({ code: 'CONFLICT' }); expect(String(response)).not.toContain('private secret'); expect(getter).not.toHaveBeenCalled();
    const badCode = Object.defineProperty(new StorageError('CONFLICT', 'private secret'), 'code', { get: getter });
    source.scan.mockRejectedValueOnce(badCode); await expect(facade.scan()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    expect(getter).not.toHaveBeenCalled();
  });

  it('retains callback capacity after timeout until the actual promise settles', async () => {
    const source = fixture(); const gate = deferred<WorkflowGraphDiscoveryPage>(); releases.push(() => gate.resolve(source.page));
    source.scan.mockImplementationOnce(() => gate.promise);
    const facade = source.create({ storageTimeoutMs: 20, maxPendingStorageOperations: 1 });
    await expect(facade.scan()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await expect(facade.scan()).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' }); expect(source.scan).toHaveBeenCalledOnce();
    gate.resolve(source.page); await flush(); expect(await facade.scan()).toEqual(source.page);
  });

  it('retains timed-out initialization capacity and retries only after actual settlement', async () => {
    const source = fixture(); const gate = deferred<void>(); releases.push(() => gate.resolve());
    source.initialize.mockImplementationOnce(() => gate.promise);
    const facade = source.create({ storageTimeoutMs: 20, maxPendingStorageOperations: 1 });
    await expect(facade.scan()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await expect(facade.scan()).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(source.initialize).toHaveBeenCalledOnce(); expect(source.scan).not.toHaveBeenCalled();
    gate.resolve(); await flush(); expect(await facade.scan()).toEqual(source.page);
    expect(source.initialize).toHaveBeenCalledTimes(2);
  });

  it('captures capability methods instead of observing later adapter property replacement', async () => {
    const source = fixture(); const facade = source.create(); const replacement = vi.fn(async () => { throw new Error('replaced'); });
    Object.assign(source.store.workflowGraphDiscovery, { initialize: replacement, scan: replacement });
    expect(await facade.scan()).toEqual(source.page); expect(replacement).not.toHaveBeenCalled();
  });

  it('keeps the optional capability and read-only surface explicit in public types', () => {
    const source = fixture(); const facade = source.create();
    if (false) {
      const graphOnly = {} as Omit<WorkflowGraphDiscoveryAggregateStore, 'workflowGraphDiscovery'>;
      // @ts-expect-error Existing graph stores are not silently discovery-capable.
      createWorkflowGraphDiscovery({ ...configuration, store: graphOnly });
      // @ts-expect-error Discovery does not own workers or their dispatch authority.
      createWorkflowGraphDiscovery({ ...configuration, store: source.store, workerId: 'worker' });
      // @ts-expect-error Discovery has no workflow mutation surface.
      facade.cancel('run');
      // @ts-expect-error Policy is configured once, not replaced by a per-scan command.
      facade.scan({ policyHash });
      void facade.scan({ cursor: null, limit: 32 });
    }
    expect(Object.isFrozen(facade)).toBe(true);
  });

  it('coalesces initialization and never dispatches a late scan after close', async () => {
    const source = fixture(); const entered = deferred<void>(); const gate = deferred<void>(); releases.push(() => gate.resolve());
    source.initialize.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; });
    const facade = source.create(); const first = facade.scan().catch((error: unknown) => error); const second = facade.scan().catch((error: unknown) => error);
    await entered.promise; await facade.close();
    expect(await first).toMatchObject({ code: 'CANCELLED' }); expect(await second).toMatchObject({ code: 'CANCELLED' });
    expect(source.initialize).toHaveBeenCalledOnce(); gate.resolve(); await flush();
    expect(source.scan).not.toHaveBeenCalled(); expect(source.close).not.toHaveBeenCalled();
    await expect(facade.scan()).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('handles actual callback rejection when closed before any callback microtask starts', async () => {
    const source = fixture(); const facade = source.create(); const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const result = facade.scan().catch((error: unknown) => error);
      await facade.close(); expect(await result).toMatchObject({ code: 'CANCELLED' });
      // Let Node report promise rejections that have not been eagerly observed.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(unhandled).not.toHaveBeenCalled();
      expect(source.initialize).not.toHaveBeenCalled(); expect(source.scan).not.toHaveBeenCalled();
      expect(source.close).not.toHaveBeenCalled();
    } finally { process.off('unhandledRejection', unhandled); }
  });

  it('closes a pending scan without returning late observations or closing shared storage', async () => {
    const source = fixture(); const entered = deferred<void>(); const gate = deferred<WorkflowGraphDiscoveryPage>(); releases.push(() => gate.resolve(source.page));
    source.scan.mockImplementationOnce(async () => { entered.resolve(); return await gate.promise; });
    const facade = source.create(); const result = facade.scan().catch((error: unknown) => error); await entered.promise;
    await facade.close(); expect(await result).toMatchObject({ code: 'CANCELLED' }); gate.resolve(source.page); await flush();
    expect(source.close).not.toHaveBeenCalled(); expect(source.scan).toHaveBeenCalledOnce();
  });
});
