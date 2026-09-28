import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JsonObject, JsonValue, Schema } from '@mayura/core';
import { defineTool } from '@mayura/tools';
import { initialWorkflowGraphState, StorageError, workflowGraphResources, workflowPolicy,
  type WorkflowGraphDiscoveryAggregateStore, type WorkflowGraphDiscoveryCandidate, type WorkflowGraphDiscoveryCursor,
  type WorkflowGraphDiscoveryPage, type WorkflowGraphDiscoveryScan, type WorkflowGraphStore, type WorkflowGraphStoreSnapshot } from '@mayura/storage-contracts';
import { createWorkflowGraphCoordinator, defineWorkflowGraph, type WorkflowGraphCoordinatorOptions,
  type WorkflowGraphCatalogEntry, type WorkflowGraphPageReport } from '../src/graphs.js';
import { defineWorkflow } from '../src/index.js';
import { digest } from '../src/definition.js';
import { graphManifest } from '../src/graph-definition.js';
import * as discoveryModule from '../src/graph-discovery.js';
import * as scheduledModule from '../src/scheduled.js';

const scope = { principalId: 'coordinator@example.com', projectId: 'project/मयूर' };
const configuration = { scope, permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0, workerId: 'coordinator' };
const policy = workflowPolicy({ scope, permissions: [], policyVersion: '1', maxCostMicros: 0, maxOutputBytes: 65_536, approvalTtlMs: 3_600_000 });
const scopeKey = digest('mayura:scope:v1', scope); const policyHash = digest('mayura:policy:v1', policy);
const schema: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'coordinator', validate: value => ({ value: value as JsonValue }) } };
const clients: { close(): Promise<void> }[] = []; const releases: (() => void)[] = [];
afterEach(async () => { for (const release of releases.splice(0)) release(); await Promise.all(clients.splice(0).map(client => client.close())); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }
async function flush(): Promise<void> { for (let index = 0; index < 30; index++) await Promise.resolve(); }
function definition(id: string, payload: JsonValue = null) {
  const tool = defineTool({ id: `tool.${id}`, version: '1', description: 'Never execute a cancelled fixture.', input: schema, output: schema,
    effects: 'none', capabilities: [], execute: () => { throw new Error('Unexpected cancelled fixture effect'); } });
  return defineWorkflowGraph({ id, version: '1', input: schema, output: schema,
    nodes: [{ kind: 'tool', id: 'work', tool, input: { kind: 'literal', value: payload } }], result: { kind: 'step', stepId: 'work', path: [] } });
}
function fixture() {
  const definitions: WorkflowGraphCatalogEntry[] = ['alpha', 'beta', 'gamma'].map(id => ({ definition: definition(id), resources: { work: [`resource/${id}`] } }));
  const records = new Map<string, WorkflowGraphStoreSnapshot>();
  const candidates: WorkflowGraphDiscoveryCandidate[] = definitions.map((entry, index) => {
    const id = String((index + 1) * 2).repeat(64); const manifest = graphManifest(entry.definition);
    const state = initialWorkflowGraphState(manifest, 'PRIVATE_INPUT', entry.definition.digest, policyHash, 0);
    state.status = 'cancelled'; state.steps['work']!.status = 'skipped';
    records.set(id, { profile: 'scheduled-v2', manifestHash: entry.definition.digest, policyHash,
      resourceHash: digest('mayura:workflow-resources:v1', workflowGraphResources(entry.resources ?? {}, manifest)), jobs: [],
      record: { scope: scopeKey, id, idempotencyKey: `key-${index}`, definitionHash: entry.definition.digest, version: 2, state: state as unknown as JsonObject } });
    return { reference: { kind: 'scheduled-workflow', runId: id, definitionHash: entry.definition.digest, policyHash }, version: 1, status: 'running' };
  });
  const page: WorkflowGraphDiscoveryPage = { candidates, examined: candidates.length, nextCursor: null };
  const discoveryInitialize = vi.fn(async () => {});
  const scan = vi.fn(async (_command: WorkflowGraphDiscoveryScan) => structuredClone(page));
  const initialize = vi.fn(async () => {});
  const inspect = vi.fn(async (command: { id: string }) => {
    const current = records.get(command.id); if (!current) throw new StorageError('NOT_FOUND', 'Private missing run'); return structuredClone(current);
  });
  const mutation = vi.fn(async () => { throw new Error('Unexpected cancelled fixture mutation'); });
  const api = { ...Object.fromEntries(['submit', 'requestApproval', 'approve', 'prepare', 'claim', 'renew', 'start', 'recordReceipt', 'complete', 'abandon', 'failNode', 'advance', 'finalize', 'cancel', 'recover'].map(name => [name, mutation])), initialize, inspect } as unknown as WorkflowGraphStore;
  const unused = vi.fn(async () => { throw new Error('Unexpected ambient store use'); }); const close = vi.fn(async () => {});
  const store = { workflowGraphs: api, workflowGraphDiscovery: { initialize: discoveryInitialize, scan }, read: unused, events: unused, close } as unknown as WorkflowGraphDiscoveryAggregateStore;
  const create = (options: Partial<WorkflowGraphCoordinatorOptions> = {}) => {
    const client = createWorkflowGraphCoordinator({ ...configuration, store, definitions, ...options }); clients.push(client); return client;
  };
  return { definitions, candidates, page, records, discoveryInitialize, scan, initialize, inspect, mutation, api, unused, close, store, create };
}
function cursor(afterId = '1'.repeat(64)): WorkflowGraphDiscoveryCursor { return { format: 1, scope: scopeKey, policyHash, afterId }; }

describe('finite registered graph coordinator', () => {
  it('continues a page sequentially with distinct immutable enrollment resource plans', async () => {
    const source = fixture(); const entries = source.definitions.map(entry => ({ definition: entry.definition, resources: structuredClone(entry.resources ?? {}) }));
    const client = source.create({ definitions: entries }); (entries[0]!.resources as Record<string, string[]>)['work']!.push('mutated');
    const report = await client.runPage();
    expect(report).toEqual({ status: 'completed', examined: 3, nextCursor: null,
      outcomes: source.candidates.map(candidate => ({ kind: 'observed', reference: candidate.reference, version: 2, status: 'cancelled' })) });
    expect(source.inspect.mock.calls.map(([command]) => command.id)).toEqual(source.candidates.map(candidate => candidate.reference.runId));
    expect(source.initialize).toHaveBeenCalledOnce(); expect(source.discoveryInitialize).toHaveBeenCalledOnce();
    expect(Object.keys(client).sort()).toEqual(['close', 'drain', 'runPage']); expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.outcomes[0]!.reference)).toBe(true); expect(JSON.stringify(report)).not.toContain('PRIVATE');
    expect(source.mutation).not.toHaveBeenCalled(); expect(source.unused).not.toHaveBeenCalled();
    await client.close(); expect(source.close).not.toHaveBeenCalled();
  });

  it('returns a held page without discovery while the durable fleet hold is set, and fails closed', async () => {
    const source = fixture(); let held = true; const hold = { isHeld: vi.fn(async () => held) };
    const client = source.create({ hold });
    expect(await client.runPage({ cursor: cursor() })).toEqual({ status: 'interrupted', examined: 0, retryCursor: cursor(), code: 'CANCELLED', outcomes: [] });
    expect(source.scan).not.toHaveBeenCalled(); expect(source.inspect).not.toHaveBeenCalled();
    held = false; expect((await client.runPage()).status).toBe('completed'); expect(source.scan).toHaveBeenCalledOnce();
    const broken = source.create({ hold: { isHeld: async () => { throw new Error('PRIVATE hold failure'); } } });
    await expect(broken.runPage()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' }); expect(source.scan).toHaveBeenCalledOnce();
    expect(() => source.create({ hold: {} as never })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it('skips unknown definitions without attempting them or silently changing cursor progress', async () => {
    const source = fixture(); const client = source.create({ definitions: [source.definitions[0]!] });
    source.scan.mockResolvedValueOnce({ ...source.page, nextCursor: cursor('6'.repeat(64)) });
    const report = await client.runPage({ limit: 3 });
    expect(report).toMatchObject({ status: 'completed', examined: 3, nextCursor: { afterId: '6'.repeat(64) },
      outcomes: [{ kind: 'observed' }, { kind: 'skipped', reason: 'unregistered_definition' }, { kind: 'skipped', reason: 'unregistered_definition' }] });
    expect(source.inspect).toHaveBeenCalledOnce();
  });

  it('keeps full terminal-only pages finite and returns their discovery cursor', async () => {
    const source = fixture(); source.scan.mockResolvedValueOnce({ candidates: [], examined: 2, nextCursor: cursor('a'.repeat(64)) });
    expect(await source.create().runPage({ limit: 2 })).toEqual({ status: 'completed', examined: 2, nextCursor: cursor('a'.repeat(64)), outcomes: [] });
    expect(source.initialize).not.toHaveBeenCalled(); expect(source.inspect).not.toHaveBeenCalled();
  });

  it('rejects empty, excessive, forged, legacy and duplicate-digest catalogs before storage callbacks', () => {
    const source = fixture(); const same = definition('alpha');
    const legacy = defineWorkflow({ id: 'legacy', version: '1', input: schema, output: schema, nodes: [{ kind: 'join', id: 'join', dependsOn: [] }], result: { kind: 'literal', value: null } });
    for (const entries of [[], Array.from({ length: 33 }, () => source.definitions[0]), [{ definition: { ...source.definitions[0]!.definition } }],
      [{ definition: legacy }], [source.definitions[0], source.definitions[0]], [source.definitions[0], { definition: same }], [{ definition: source.definitions[0]!.definition, extra: true }]]) {
      expect(() => source.create({ definitions: entries as never })).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    }
    expect(source.initialize).not.toHaveBeenCalled(); expect(source.discoveryInitialize).not.toHaveBeenCalled();
  });

  it('rejects catalog, entry, definition and resource accessors without executing them', () => {
    const source = fixture(); const getter = vi.fn(() => source.definitions[0]);
    const array = Object.defineProperty([source.definitions[0]], '0', { get: getter });
    const entry = Object.defineProperty({}, 'definition', { enumerable: true, get: getter });
    const resources = Object.defineProperty({}, 'work', { enumerable: true, get: getter });
    const forged = Object.defineProperty({}, 'digest', { enumerable: true, get: getter });
    for (const definitions of [array, [entry], [{ definition: source.definitions[0]!.definition, resources }], [{ definition: forged }]]) {
      expect(() => source.create({ definitions: definitions as never })).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it('bounds cumulative canonical manifest and resource metadata rather than only catalog length', () => {
    const source = fixture(); const definitions = Array.from({ length: 8 }, (_, index) => ({ definition: definition(`large${index}`, 'x'.repeat(550_000)) }));
    expect(() => source.create({ definitions })).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(source.initialize).not.toHaveBeenCalled(); expect(source.discoveryInitialize).not.toHaveBeenCalled();
  });

  it('validates plans and rejects unrelated worker options before any callbacks', () => {
    const source = fixture();
    for (const options of [{ resources: {} }, { verifyHuman: () => true }, { maxConcurrentRuns: 2 }, { workerId: '' }, { leaseMs: 999 },
      { maxConcurrentJobs: 33 }, { storageTimeoutMs: 0 }, { maxPendingStorageOperations: 1_025 },
      { definitions: [{ definition: source.definitions[0]!.definition, resources: { missing: ['resource'] } }] }]) {
      expect(() => source.create(options as never)).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    }
    expect(source.initialize).not.toHaveBeenCalled(); expect(source.discoveryInitialize).not.toHaveBeenCalled();
  });

  it('rejects option and capability accessors without executing them', () => {
    const source = fixture(); const getter = vi.fn(() => source.store);
    const options = Object.defineProperty({ ...configuration, definitions: source.definitions }, 'store', { enumerable: true, get: getter });
    expect(() => createWorkflowGraphCoordinator(options as never)).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    for (const store of [{}, { workflowGraphs: source.api }, Object.defineProperty({}, 'workflowGraphs', { enumerable: true, get: getter })]) {
      expect(() => source.create({ store: store as never })).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_PROFILE' }));
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it('captures store methods and policy instead of observing later property replacement', async () => {
    const source = fixture(); const allow: string[] = []; const configuredScope = { ...scope };
    const client = source.create({ scope: configuredScope, permissions: { allow } });
    configuredScope.projectId = 'changed'; allow.push('changed');
    const replacement = vi.fn(async () => { throw new Error('replaced'); });
    Object.assign(source.api, { inspect: replacement }); Object.assign(source.store.workflowGraphDiscovery, { scan: replacement });
    expect((await client.runPage()).status).toBe('completed'); expect(replacement).not.toHaveBeenCalled();
  });

  it('rejects malformed page commands before discovery or getter execution', async () => {
    const source = fixture(); const client = source.create(); const getter = vi.fn(() => 1);
    for (const command of [null, [], { extra: true }, { limit: 0 }, { limit: 33 }, { cursor: { ...cursor(), policyHash: 'f'.repeat(64) } },
      Object.defineProperty({}, 'limit', { enumerable: true, get: getter })]) {
      await expect(client.runPage(command as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(getter).not.toHaveBeenCalled(); expect(source.scan).not.toHaveBeenCalled(); expect(source.discoveryInitialize).not.toHaveBeenCalled();
  });

  it('fails fast after partial progress with an owned original retry cursor and no advancing cursor', async () => {
    const source = fixture(); const gate = deferred<void>(); source.discoveryInitialize.mockImplementationOnce(() => gate.promise); releases.push(() => gate.resolve());
    source.inspect.mockImplementation(async command => {
      if (command.id === source.candidates[1]!.reference.runId) throw new StorageError('CONFLICT', 'PRIVATE_FAILURE');
      return structuredClone(source.records.get(command.id)!);
    });
    const supplied = { cursor: { ...cursor() } }; const result = source.create().runPage(supplied); supplied.cursor.afterId = 'f'.repeat(64); gate.resolve();
    const report = await result;
    expect(report).toEqual({ status: 'interrupted', examined: 3, retryCursor: cursor(), code: 'CONFLICT', outcomes: [
      { kind: 'observed', reference: source.candidates[0]!.reference, version: 2, status: 'cancelled' },
      { kind: 'failed', reference: source.candidates[1]!.reference, code: 'CONFLICT' },
      { kind: 'not_attempted', reference: source.candidates[2]!.reference },
    ] });
    expect(Object.hasOwn(report, 'nextCursor')).toBe(false); expect(source.inspect).toHaveBeenCalledTimes(2); expect(JSON.stringify(report)).not.toContain('PRIVATE');
    expect(Object.isFrozen(report)).toBe(true);
  });

  it('treats omitted plans as empty and reports resource mismatch without dispatch', async () => {
    const source = fixture(); const report = await source.create({ definitions: source.definitions.map(({ definition }) => ({ definition })) }).runPage();
    expect(report).toMatchObject({ status: 'interrupted', retryCursor: null, code: 'CONFLICT', outcomes: [{ kind: 'failed' }, { kind: 'not_attempted' }, { kind: 'not_attempted' }] });
    expect(source.mutation).not.toHaveBeenCalled();
  });

  it('sanitizes unknown adapter codes and exception accessors in failed-candidate reports', async () => {
    const source = fixture(); const getter = vi.fn(() => 'PRIVATE');
    // Both the general code and the exact storage condition are accessors here; neither may be invoked.
    const error = Object.defineProperties(new StorageError('CONFLICT', 'PRIVATE'), { code: { get: getter }, storageCode: { get: getter } }); source.inspect.mockRejectedValueOnce(error);
    const report = await source.create().runPage(); expect(report).toMatchObject({ status: 'interrupted', code: 'STORAGE_UNAVAILABLE' });
    expect(report.outcomes[0]).toMatchObject({ kind: 'failed', code: 'STORAGE_UNAVAILABLE' });
    expect(getter).not.toHaveBeenCalled(); expect(JSON.stringify(report)).not.toContain('PRIVATE');
  });

  it('rejects overlapping pages without queueing a second scan', async () => {
    const source = fixture(); const gate = deferred<WorkflowGraphDiscoveryPage>(); source.scan.mockImplementationOnce(() => gate.promise); releases.push(() => gate.resolve(source.page));
    const client = source.create(); const first = client.runPage(); await expect(client.runPage()).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    gate.resolve(source.page); expect((await first).status).toBe('completed'); expect(source.scan).toHaveBeenCalledOnce();
    expect((await client.runPage()).status).toBe('completed');
  });

  it('admits one page before reflecting on caller-owned proxy commands', async () => {
    const source = fixture(); const client = source.create(); let reflected = false; let nested: Promise<unknown> | undefined;
    const command = new Proxy({}, { getPrototypeOf(target) {
      if (!reflected) { reflected = true; nested = client.runPage().catch((error: unknown) => error); }
      return Reflect.getPrototypeOf(target);
    } });
    expect((await client.runPage(command)).status).toBe('completed');
    expect(await nested).toMatchObject({ code: 'LIMIT_EXCEEDED' }); expect(source.scan).toHaveBeenCalledOnce();
  });

  it('releases admission after invalid commands and honors close during command reflection', async () => {
    const source = fixture(); const client = source.create();
    await expect(client.runPage({ extra: true } as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await client.runPage()).status).toBe('completed');
    source.scan.mockClear(); source.discoveryInitialize.mockClear(); source.inspect.mockClear();
    const command = new Proxy({}, { getPrototypeOf(target) { void client.close(); return Reflect.getPrototypeOf(target); } });
    await expect(client.runPage(command)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(source.scan).not.toHaveBeenCalled(); expect(source.discoveryInitialize).not.toHaveBeenCalled(); expect(source.inspect).not.toHaveBeenCalled();
  });

  it('rejects failed or malformed discovery before any candidate drive', async () => {
    const source = fixture(); const client = source.create(); source.scan.mockRejectedValueOnce(new Error('PRIVATE'));
    await expect(client.runPage()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    source.scan.mockResolvedValueOnce({ ...source.page, examined: 0 });
    await expect(client.runPage()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' }); expect(source.inspect).not.toHaveBeenCalled();
  });

  it('retains a timed-out driver storage callback across later pages', async () => {
    const source = fixture(); const gate = deferred<WorkflowGraphStoreSnapshot>(); releases.push(() => gate.resolve(structuredClone(source.records.values().next().value!)));
    source.inspect.mockImplementationOnce(() => gate.promise); const client = source.create({ storageTimeoutMs: 20, maxPendingStorageOperations: 1 });
    expect(await client.runPage()).toMatchObject({ status: 'interrupted', code: 'STORAGE_UNAVAILABLE' });
    expect(await client.runPage()).toMatchObject({ status: 'interrupted', code: 'LIMIT_EXCEEDED' }); expect(source.inspect).toHaveBeenCalledOnce();
    gate.resolve(structuredClone(source.records.values().next().value!)); await flush(); expect((await client.runPage()).status).toBe('completed');
  });

  it('closes immediately before discovery without dispatch or unhandled late rejection', async () => {
    const source = fixture(); const client = source.create(); const unhandled = vi.fn(); process.on('unhandledRejection', unhandled);
    try {
      const result = client.runPage().catch((error: unknown) => error); await client.close(); expect(await result).toMatchObject({ code: 'CANCELLED' });
      await new Promise<void>(resolve => setTimeout(resolve, 0)); expect(unhandled).not.toHaveBeenCalled();
      expect(source.scan).not.toHaveBeenCalled(); expect(source.inspect).not.toHaveBeenCalled(); expect(source.close).not.toHaveBeenCalled();
    } finally { process.off('unhandledRejection', unhandled); }
  });

  it('reports all candidates unattempted when close wins after successful discovery', async () => {
    const source = fixture(); let client: ReturnType<typeof source.create>;
    const original = discoveryModule.createWorkflowGraphDiscovery;
    const factory = vi.spyOn(discoveryModule, 'createWorkflowGraphDiscovery').mockImplementation(options => {
      const actual = original(options);
      return { ...actual, async scan(command) {
        const page = await actual.scan(command); queueMicrotask(() => { void client.close(); }); return page;
      } };
    });
    try {
      client = source.create();
      expect(await client.runPage()).toEqual({ status: 'interrupted', code: 'CANCELLED', examined: 3, retryCursor: null,
        outcomes: source.candidates.map(candidate => ({ kind: 'not_attempted', reference: candidate.reference })) });
      expect(source.inspect).not.toHaveBeenCalled(); expect(source.initialize).not.toHaveBeenCalled(); expect(source.close).not.toHaveBeenCalled();
    } finally { factory.mockRestore(); }
  });

  it('preserves the last successful drive if close wins before report publication', async () => {
    const source = fixture(); let client: ReturnType<typeof source.create>; let completed = 0;
    const original = scheduledModule.createScheduledDriver;
    const factory = vi.spyOn(scheduledModule, 'createScheduledDriver').mockImplementation((...args) => {
      const actual = original(...args);
      return { ...actual, async runUntilSettled(...command) {
        const result = await actual.runUntilSettled(...command);
        if (++completed === 3) queueMicrotask(() => { void client.close(); });
        return result;
      } };
    });
    try {
      client = source.create();
      expect(await client.runPage()).toEqual({ status: 'interrupted', code: 'CANCELLED', examined: 3, retryCursor: null,
        outcomes: source.candidates.map(candidate => ({ kind: 'observed', reference: candidate.reference, version: 2, status: 'cancelled' })) });
      expect(source.inspect).toHaveBeenCalledTimes(3); expect(source.mutation).not.toHaveBeenCalled(); expect(source.close).not.toHaveBeenCalled();
    } finally { factory.mockRestore(); }
  });

  it('preserves completed observations and unattempted suffix when closed during a later drive', async () => {
    const source = fixture(); const entered = deferred<void>(); const gate = deferred<WorkflowGraphStoreSnapshot>(); releases.push(() => gate.resolve(structuredClone(source.records.get('4'.repeat(64))!)));
    source.inspect.mockImplementation(async command => {
      if (command.id === '4'.repeat(64)) { entered.resolve(); return await gate.promise; }
      return structuredClone(source.records.get(command.id)!);
    });
    const client = source.create(); const result = client.runPage(); await entered.promise; await client.close();
    expect(await result).toMatchObject({ status: 'interrupted', code: 'CANCELLED', retryCursor: null,
      outcomes: [{ kind: 'observed' }, { kind: 'failed', code: 'CANCELLED' }, { kind: 'not_attempted' }] });
    gate.resolve(structuredClone(source.records.get('4'.repeat(64))!)); await flush(); expect(source.inspect).toHaveBeenCalledTimes(2);
    expect(source.mutation).not.toHaveBeenCalled(); expect(source.close).not.toHaveBeenCalled();
    await expect(client.runPage()).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('does not retroactively alter a completed report when later closed', async () => {
    const source = fixture(); const client = source.create(); const report = await client.runPage(); await client.close();
    expect(report.status).toBe('completed'); expect(report.outcomes).toHaveLength(3);
  });

  it('exposes the narrow public options and discriminated report types', () => {
    if (false) {
      const source = fixture(); const options = { ...configuration, store: source.store, definitions: source.definitions };
      // @ts-expect-error Approval is not a coordinator operation.
      createWorkflowGraphCoordinator({ ...options, verifyHuman: () => true });
      // @ts-expect-error Resource plans belong to individual catalog entries.
      createWorkflowGraphCoordinator({ ...options, resources: {} });
      // @ts-expect-error One sequential page driver is the only supported run admission mode.
      createWorkflowGraphCoordinator({ ...options, maxConcurrentRuns: 2 });
    }
    function checkReport(report: WorkflowGraphPageReport): void {
      if (report.status === 'completed') {
        void report.nextCursor;
        // @ts-expect-error Completed reports have no retry cursor.
        void report.retryCursor;
      } else {
        void report.retryCursor; void report.code;
        // @ts-expect-error Interrupted reports cannot advance the discovery cursor.
        void report.nextCursor;
      }
    }
    void checkReport;
    expect(true).toBe(true);
  });
});
