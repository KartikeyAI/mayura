import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool } from '@mayura/tools';
import { StorageError, type WorkflowGraphStore, type WorkflowResourcePlan } from '@mayura/storage-contracts';
import { createScheduledWorkflowRuntime, defineWorkflow } from '@mayura/workflows';
import * as Graphs from '@mayura/workflows/graphs';
import { digest } from '../src/definition.js';
import type { GraphFixture } from './graph-fixtures.js';

type Store = GraphFixture['store'];
type Runtime = ReturnType<typeof Graphs.createWorkflowGraphRuntime>;
type Coordinator = ReturnType<typeof Graphs.createWorkflowGraphCoordinator>;
type Options = Parameters<typeof Graphs.createWorkflowGraphCoordinator>[0];
type RuntimeOptions = Parameters<typeof Graphs.createWorkflowGraphRuntime>[0];
const scope = { principalId: 'coordinator-developer', projectId: 'coordinator-project' };
const scopeHash = digest('mayura:scope:v1', scope);
const policy = { scope, permissions: ['tool:coordinator.effect', 'effect:write'], policyVersion: 'coordinator-policy-1',
  maxCostMicros: 10, maxOutputBytes: 65_536, approvalTtlMs: 60_000 };
const policyHash = digest('mayura:policy:v1', { ...policy, permissions: [...policy.permissions].sort() });
const result = (stepId: string) => ({ kind: 'step' as const, stepId, path: [] });
const runId = (key: string) => digest('mayura:run-id:v1', { scope: scopeHash, submissionKey: key });
/** Arrange semantic A/B/C scenarios by authoritative owner order, never insertion order. */
const orderedKeys = (prefix: string, count: number): string[] => Array.from({ length: count }, (_, index) => `${prefix}-${index}`)
  .sort((left, right) => runId(left) < runId(right) ? -1 : 1);
function graph(id: string, execute: (input: unknown) => unknown = input => input, options: { approval?: boolean; timeoutMs?: number } = {}) {
  const tool = defineTool({ id: 'coordinator.effect', version: '1', description: 'Controlled coordinator effect',
    input: z.unknown(), output: z.unknown(), effects: 'write', capabilities: [], costMicros: 1, timeoutMs: options.timeoutMs ?? 15_000, execute });
  return Graphs.defineWorkflowGraph({ id, version: '1', input: z.unknown(), output: z.unknown(),
    nodes: [{ kind: 'tool', id: 'write', tool, input: { kind: 'input', path: [] }, approval: options.approval ?? false }], result: result('write') });
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, timeoutMs = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Coordinator fixture did not reach its bounded barrier.')), timeoutMs);
  })]); } finally { if (timer) clearTimeout(timer); }
}

/** The coordinator must preserve identical authority and recovery behavior on both SQL adapters. */
export function graphCoordinatorConformance(name: string, factory: () => Promise<GraphFixture>): void {
  describe(`${name} registered graph continuation coordinator`, () => {
    let fixture: GraphFixture; let store: Store; let stores: Store[]; let clients: { close(): Promise<void> }[]; let worker = 0;
    const base = () => ({ store, scope, permissions: { allow: policy.permissions }, policyVersion: policy.policyVersion,
      maxCostMicros: policy.maxCostMicros, maxOutputBytes: policy.maxOutputBytes, approvalTtlMs: policy.approvalTtlMs });
    const runtime = (overrides: Partial<RuntimeOptions> = {}): Runtime => {
      const client = Graphs.createWorkflowGraphRuntime({ ...base(), workerId: `coordinator-producer-${++worker}`, ...overrides }); clients.push(client); return client;
    };
    const coordinator = (definitions: Options['definitions'], overrides: Partial<Options> = {}): Coordinator => {
      const client = Graphs.createWorkflowGraphCoordinator({ ...base(), workerId: `coordinator-${++worker}`, definitions, ...overrides }); clients.push(client); return client;
    };
    const wrapped = (methods: Partial<WorkflowGraphStore>): Store => ({ ...store, workflowGraphs: { ...store.workflowGraphs, ...methods } });
    const detail = (id: string) => store.workflowGraphs.inspect({ scope: scopeHash, id, policyHash });
    const submit = (definition: ReturnType<typeof graph>, key: string = randomUUID(), resources: WorkflowResourcePlan = {}) =>
      runtime({ resources }).submit(definition, { input: 'SECRET_COORDINATOR_INPUT', idempotencyKey: key });
    const fingerprint = () => Promise.all(['mayura_aggregates', 'mayura_events', 'mayura_workflow_owners',
      'mayura_workflow_wait_targets', 'mayura_scheduler_jobs', 'mayura_execution_completions'].map(async table => ({
      table, rows: await fixture.query(`SELECT * FROM ${fixture.prefix}${table} ORDER BY 1,2`),
    })));
    const reopen = async () => { const next = fixture.reopen(); stores.push(next); await next.initialize(); await next.workflowGraphs.initialize(); return next; };
    beforeEach(async () => {
      fixture = await factory(); store = fixture.store; stores = [store]; clients = []; worker = 0;
      await store.initialize(); await store.workflowGraphs.initialize(); await store.workflows.initialize();
    });
    afterEach(async () => { await Promise.all((clients ?? []).map(client => client.close())); await Promise.all((stores ?? []).map(item => item.close())); await fixture?.cleanup(); });

    it('exports the opt-in registered graph coordinator', () => {
      expect(Graphs).toHaveProperty('createWorkflowGraphCoordinator', expect.any(Function));
    });

    it('continues distinct definitions and their own immutable resource plans after close and reopen', async () => {
      const effects = [0, 0]; const keys = orderedKeys('reopen', 2);
      const first = graph('coordinator.first', () => { effects[0]!++; return 'SECRET_FIRST_OUTPUT'; });
      const second = graph('coordinator.second', () => { effects[1]!++; return 'SECRET_SECOND_OUTPUT'; });
      const firstResources = { write: ['first-resource'] }; const secondResources = { write: ['second-resource'] };
      const a = await submit(first, keys[0], firstResources); const b = await submit(second, keys[1], secondResources);
      const initial = coordinator([{ definition: first, resources: firstResources }, { definition: second, resources: secondResources }]);
      await initial.close(); await store.close(); store = await reopen();
      const entries = [{ definition: first, resources: { write: ['first-resource'] } }, { definition: second, resources: { write: ['second-resource'] } }];
      const client = coordinator(entries); entries[0]!.resources.write[0] = 'mutated-after-registration';
      const report = await client.runPage();
      expect(report.status).toBe('completed'); expect(report.examined).toBe(2);
      expect(report.outcomes.map(item => item.reference.runId)).toEqual([a.id, b.id]);
      expect(report.outcomes.every(item => item.kind === 'observed' && item.status === 'succeeded')).toBe(true);
      expect(effects).toEqual([1, 1]); expect(Object.isFrozen(report)).toBe(true); expect(Object.isFrozen(report.outcomes)).toBe(true);
      expect(report.outcomes.every(item => Object.isFrozen(item) && Object.isFrozen(item.reference))).toBe(true);
      expect(JSON.stringify(report)).not.toMatch(/SECRET|receipt|budget|resourceKeys|candidateHash/);
      expect((await detail(a.id)).jobs[0]!.resourceKeys).not.toEqual((await detail(b.id)).jobs[0]!.resourceKeys);
      for (const id of [a.id, b.id]) expect((await runtime().inspect(id)).budget).toMatchObject({ spentMicros: 1, reservedMicros: 0 });
    });

    it('skips an unknown exact digest unchanged and later continues it only through a new catalog and restarted sweep', async () => {
      let effects = 0; const known = graph('coordinator.known');
      const unknown = graph('coordinator.unknown', () => { effects++; return null; });
      const run = await submit(unknown, 'unknown-definition'); const before = await fingerprint();
      const client = coordinator([{ definition: known }]); const page = await client.runPage({ limit: 1 });
      expect(page.status).toBe('completed');
      expect(page.outcomes).toEqual([{ kind: 'skipped', reference: await runtime().reference(run.id), reason: 'unregistered_definition' }]);
      expect(effects).toBe(0); expect(await fingerprint()).toEqual(before);
      if (page.status !== 'completed' || !page.nextCursor) throw new Error('Full unknown page must retain an examined-owner cursor.');
      const registered = coordinator([{ definition: unknown }]);
      expect((await registered.runPage({ cursor: page.nextCursor })).outcomes).toEqual([]); expect(effects).toBe(0);
      expect((await registered.runPage()).outcomes).toMatchObject([{ kind: 'observed', status: 'succeeded' }]); expect(effects).toBe(1);
    });

    it('preserves A and committed B when B loses final acknowledgement, reports C unattempted, and retries without replay', async () => {
      const effects = [0, 0, 0]; const keys = orderedKeys('lost-final-ack', 3);
      const definitions = effects.map((_value, index) => graph(`coordinator.ack${index}`, () => { effects[index]!++; return 'SECRET_EFFECT_OUTPUT'; }));
      const runs: Graphs.WorkflowGraphSnapshot[] = [];
      for (let index = 0; index < 3; index++) runs.push(await submit(definitions[index]!, keys[index]));
      let lost = false;
      const observedStore = wrapped({ async finalize(command) {
        const reply = await store.workflowGraphs.finalize(command);
        if (command.id === runs[1]!.id && !lost) { lost = true; throw new StorageError('STORAGE_UNAVAILABLE', 'SECRET lost completion acknowledgement'); }
        return reply;
      } });
      const client = coordinator(definitions.map(definition => ({ definition })), { store: observedStore });
      const cursor = { format: 1 as const, scope: scopeHash, policyHash, afterId: '0'.repeat(64) };
      const report = await client.runPage({ cursor, limit: 3 });
      expect(report).toMatchObject({ status: 'interrupted', examined: 3, code: 'STORAGE_UNAVAILABLE', retryCursor: cursor,
        outcomes: [{ kind: 'observed', status: 'succeeded' }, { kind: 'failed', code: 'STORAGE_UNAVAILABLE' }, { kind: 'not_attempted' }] });
      expect(report).not.toHaveProperty('nextCursor'); expect(effects).toEqual([1, 1, 0]);
      expect(report.outcomes.map(item => item.reference.runId)).toEqual(runs.map(run => run.id));
      expect(JSON.stringify(report)).not.toContain('SECRET');
      expect((await runtime().inspect(runs[0]!.id)).status).toBe('succeeded');
      expect((await runtime().inspect(runs[1]!.id)).status).toBe('succeeded'); expect((await detail(runs[2]!.id)).jobs).toEqual([]);
      if (report.status !== 'interrupted') throw new Error('Lost acknowledgement must interrupt the page.');
      expect(report.retryCursor).not.toBe(cursor); expect(Object.isFrozen(report.retryCursor)).toBe(true);
      const retry = await client.runPage({ cursor: report.retryCursor, limit: 3 });
      expect(retry.status).toBe('completed'); expect(retry.outcomes).toMatchObject([{ kind: 'observed', status: 'succeeded' }]);
      expect(retry.outcomes[0]!.reference.runId).toBe(runs[2]!.id); expect(effects).toEqual([1, 1, 1]);
      for (const run of runs) expect((await runtime().inspect(run.id)).budget).toMatchObject({ spentMicros: 1, reservedMicros: 0 });
    });

    it('shares one handler permit across definitions and pages until a timed-out handler actually settles', async () => {
      const began = deferred<void>(); const release = deferred<unknown>(); const lateReceipt = deferred<void>(); const effects = [0, 0];
      const keys = orderedKeys('retained-capacity', 2);
      const first = graph('coordinator.uncertain', () => { effects[0]!++; began.resolve(); return release.promise; }, { timeoutMs: 1_000 });
      const second = graph('coordinator.independent', () => { effects[1]!++; return null; });
      const a = await submit(first, keys[0], { write: ['uncertain-resource'] }); const b = await submit(second, keys[1], { write: ['independent-resource'] });
      const observedStore = wrapped({ async recordReceipt(command) {
        const reply = await store.workflowGraphs.recordReceipt(command);
        if (command.id === a.id && command.receipt.execution === 'succeeded') lateReceipt.resolve();
        return reply;
      } });
      const client = coordinator([{ definition: first, resources: { write: ['uncertain-resource'] } },
        { definition: second, resources: { write: ['independent-resource'] } }], { store: observedStore, maxConcurrentJobs: 1, leaseMs: 10_000 });
      const execution = client.runPage(); void execution.catch(() => {});
      try {
        await bounded(began.promise); const page = await bounded(execution);
        expect(page.status).toBe('completed'); expect(effects).toEqual([1, 0]);
        expect((await runtime().inspect(a.id)).steps['write']!.receipt).toMatchObject({ execution: 'unknown' });
        expect((await detail(b.id)).jobs).toHaveLength(1); expect((await detail(b.id)).jobs[0]!.startedAtMs).toBeNull();
        const before = await fingerprint(); await client.runPage();
        expect(effects).toEqual([1, 0]); expect(await fingerprint()).toEqual(before);
        release.resolve('SECRET_LATE_RESULT'); await bounded(lateReceipt.promise);
        // Explicit finite sweeps account for the permit release following receipt settlement.
        await vi.waitFor(async () => { await client.runPage(); expect(effects).toEqual([1, 1]); }, { timeout: 10_000, interval: 25 });
        expect((await runtime().inspect(b.id)).status).toBe('succeeded');
        const late = await runtime().inspect(a.id); expect(late.steps['write']!.output).toBeNull();
        expect(late.steps['write']!.receipt).toMatchObject({ execution: 'succeeded', disclosure: 'withheld' });
        expect(late.budget).toMatchObject({ spentMicros: 1, reservedMicros: 0 });
      } finally {
        release.resolve(null); await Promise.allSettled([execution]);
        if (effects[0] === 1) await bounded(lateReceipt.promise);
      }
    }, 30_000);

    it('releases a waiting run slot so a later independent graph progresses at one job', async () => {
      const targetRuntime = createScheduledWorkflowRuntime({ ...base(), workerId: `coordinator-target-${++worker}` }); clients.push(targetRuntime);
      const targetDefinition = defineWorkflow({ id: 'coordinator.target', version: '1', input: z.unknown(), output: z.unknown(),
        nodes: [{ kind: 'join', id: 'joined', dependsOn: [] }], result: result('joined') });
      const target = await targetRuntime.submit(targetDefinition, { input: null, idempotencyKey: 'waiting-target' });
      const targetRef = await targetRuntime.reference(target.id); const targetBefore = await targetRuntime.inspect(target.id);
      const waiting = Graphs.defineWorkflowGraph({ id: 'coordinator.waiting', version: '1', input: z.unknown(), output: z.unknown(),
        nodes: [{ kind: 'wait', id: 'watched', targets: { kind: 'literal', value: [targetRef] } }], result: result('watched') });
      let effects = 0; const ready = graph('coordinator.ready', () => { effects++; return null; }); const keys = orderedKeys('waiting-ready', 2);
      const a = await submit(waiting, keys[0]); const b = await submit(ready, keys[1]);
      const client = coordinator([{ definition: waiting }, { definition: ready }], { maxConcurrentJobs: 1 });
      const report = await client.runPage();
      expect(report.outcomes).toMatchObject([{ kind: 'observed', status: 'waiting' }, { kind: 'observed', status: 'succeeded' }]);
      expect(report.outcomes.map(item => item.reference.runId)).toEqual([a.id, b.id]); expect(effects).toBe(1);
      expect((await detail(a.id)).jobs).toEqual([]); expect((await runtime().inspect(a.id)).budget).toMatchObject({ spentMicros: 0, reservedMicros: 0 });
      expect(await targetRuntime.inspect(target.id)).toEqual(targetBefore);
      await targetRuntime.runUntilSettled(targetDefinition, target.id);
      expect((await client.runPage()).outcomes).toMatchObject([{ kind: 'observed', status: 'succeeded' }]);
      expect(effects).toBe(1);
    });

    it('allows competing coordinators to observe the same run but dispatches its effect only once', async () => {
      const began = deferred<void>(); const release = deferred<unknown>(); let effects = 0;
      const definition = graph('coordinator.competition', () => { effects++; began.resolve(); return release.promise; });
      const run = await submit(definition, 'competing-coordinators');
      const first = coordinator([{ definition }]); const second = coordinator([{ definition }]);
      const executions = [first.runPage(), second.runPage()]; executions.forEach(value => { void value.catch(() => {}); });
      try { await bounded(began.promise); expect(effects).toBe(1); }
      finally { release.resolve(null); }
      const reports = await bounded(Promise.all(executions));
      expect(reports.every(page => page.status === 'completed')).toBe(true); expect(effects).toBe(1);
      expect((await runtime().inspect(run.id)).status).toBe('succeeded');
      expect((await detail(run.id)).jobs).toHaveLength(1);
      await first.runPage(); await second.runPage(); expect(effects).toBe(1);
    });

    it('closes during an active candidate without starting its successor, cancelling runs, or losing late evidence', async () => {
      const began = deferred<void>(); const release = deferred<unknown>(); const lateReceipt = deferred<void>(); const effects = [0, 0];
      const keys = orderedKeys('close-active', 2);
      const first = graph('coordinator.closeA', () => { effects[0]!++; began.resolve(); return release.promise; });
      const second = graph('coordinator.closeB', () => { effects[1]!++; return null; });
      const a = await submit(first, keys[0]); const b = await submit(second, keys[1]);
      const observedStore = wrapped({ async recordReceipt(command) {
        const reply = await store.workflowGraphs.recordReceipt(command);
        if (command.id === a.id && command.receipt.execution === 'succeeded') lateReceipt.resolve();
        return reply;
      } });
      const client = coordinator([{ definition: first }, { definition: second }], { store: observedStore });
      const execution = client.runPage(); void execution.catch(() => {});
      try {
        await bounded(began.promise); await bounded(client.close());
        const page = await bounded(execution);
        expect(page).toMatchObject({ status: 'interrupted', code: 'CANCELLED', retryCursor: null,
          outcomes: [{ kind: 'failed', code: 'CANCELLED' }, { kind: 'not_attempted' }] });
        expect(page).not.toHaveProperty('nextCursor'); expect(effects).toEqual([1, 0]);
        expect((await runtime().inspect(a.id)).status).not.toBe('cancelled');
        expect((await runtime().inspect(b.id)).status).toBe('running'); expect((await detail(b.id)).jobs).toEqual([]);
        await expect(client.runPage()).rejects.toMatchObject({ code: 'CANCELLED' });
        release.resolve('SECRET_LATE_CLOSE_RESULT'); await bounded(lateReceipt.promise);
        const late = await runtime().inspect(a.id);
        expect(late.steps['write']!.output).toBeNull(); expect(late.steps['write']!.receipt).toMatchObject({ execution: 'succeeded', disclosure: 'withheld' });
        expect(late.budget).toMatchObject({ spentMicros: 1, reservedMicros: 0 }); expect(effects).toEqual([1, 0]);
      } finally {
        release.resolve(null); await Promise.allSettled([execution]);
        if (effects[0] === 1) await bounded(lateReceipt.promise);
      }
    }, 30_000);

    it('preserves each independent root budget instead of inventing a shared page spending ceiling', async () => {
      let effects = 0; const definition = graph('coordinator.independentBudgets', () => { effects++; return null; });
      const producer = runtime({ maxCostMicros: 1 }); const runs = [];
      for (const key of orderedKeys('independent-budget', 2)) runs.push(await producer.submit(definition, { input: null, idempotencyKey: key }));
      const report = await coordinator([{ definition }], { maxCostMicros: 1, maxConcurrentJobs: 1 }).runPage();
      expect(report.status).toBe('completed'); expect(report.outcomes.every(item => item.kind === 'observed' && item.status === 'succeeded')).toBe(true);
      expect(effects).toBe(2);
      for (const run of runs) expect((await producer.inspect(run.id)).budget).toEqual({ spentMicros: 1, reservedMicros: 0, maxCostMicros: 1 });
    });

    it('rechecks a cancelled stale discovery hint before any dispatch', async () => {
      let effects = 0; const definition = graph('coordinator.cancelled', () => { effects++; return null; });
      const producer = runtime(); const run = await producer.submit(definition, { input: null, idempotencyKey: 'cancelled-hint' });
      const observedStore: Store = { ...store, workflowGraphDiscovery: { ...store.workflowGraphDiscovery, async scan(command) {
        const page = await store.workflowGraphDiscovery.scan(command); await producer.cancel(run.id); return page;
      } } };
      const page = await coordinator([{ definition }], { store: observedStore }).runPage();
      expect(page.outcomes).toMatchObject([{ kind: 'observed', status: 'cancelled' }]); expect(effects).toBe(0);
      expect((await detail(run.id)).jobs).toEqual([]);
    });

    it('waits for an external verified approval without reserving money or inventing approval authority', async () => {
      let effects = 0; const definition = graph('coordinator.approval', () => { effects++; return null; }, { approval: true });
      const run = await submit(definition, 'approval-wait'); const client = coordinator([{ definition }]);
      expect(client).not.toHaveProperty('approve'); expect((await client.runPage()).outcomes).toMatchObject([{ kind: 'observed', status: 'waiting' }]);
      const current = await runtime().inspect(run.id); expect(current.budget).toMatchObject({ spentMicros: 0, reservedMicros: 0 });
      expect((await detail(run.id)).jobs).toEqual([]); expect(effects).toBe(0);
      const approver = runtime({ verifyHuman: async () => ({ id: 'verified-operator', projectId: scope.projectId, canApprove: true }) });
      const approval = current.steps['write']!.approval; if (!approval) throw new Error('Waiting approval must expose its exact review digest.');
      await approver.approve({ id: run.id, nodeId: 'write', digest: approval.digest, credential: 'SECRET_APPROVAL_CREDENTIAL' });
      expect((await client.runPage()).outcomes).toMatchObject([{ kind: 'observed', status: 'succeeded' }]); expect(effects).toBe(1);
      expect(JSON.stringify(await runtime().events(run.id))).not.toContain('SECRET_APPROVAL_CREDENTIAL');
    });

    it('interrupts on a registered resource-plan mismatch before changing the owner or executing', async () => {
      let effects = 0; const definition = graph('coordinator.resources', () => { effects++; return null; });
      await submit(definition, 'resource-plan-mismatch', { write: ['admitted-resource'] }); const before = await fingerprint();
      const page = await coordinator([{ definition, resources: { write: ['replacement-resource'] } }]).runPage();
      expect(page).toMatchObject({ status: 'interrupted', code: 'CONFLICT', retryCursor: null, outcomes: [{ kind: 'failed', code: 'CONFLICT' }] });
      expect(page).not.toHaveProperty('nextCursor'); expect(effects).toBe(0); expect(await fingerprint()).toEqual(before);
    });

    it.each(['policy', 'grants'] as const)('does not discover runs whose configured %s differ from persisted authority', async mismatch => {
      let effects = 0; const definition = graph('coordinator.authority', () => { effects++; return null; });
      await submit(definition, `authority-${mismatch}`); const before = await fingerprint();
      const options = mismatch === 'policy' ? { policyVersion: 'coordinator-other-policy' } : { permissions: { allow: ['effect:write'] } };
      const page = await coordinator([{ definition }], options).runPage();
      expect(page).toEqual({ status: 'completed', examined: 0, nextCursor: null, outcomes: [] });
      expect(effects).toBe(0); expect(await fingerprint()).toEqual(before);
    });

    it('blocks a graph enrolled without its required grant and never dispatches the registered tool', async () => {
      let effects = 0; const definition = graph('coordinator.denied', () => { effects++; return null; });
      const permissions = { allow: ['effect:write'] }; const producer = runtime({ permissions });
      const run = await producer.submit(definition, { input: null, idempotencyKey: 'enrolled-without-grant' });
      const page = await coordinator([{ definition }], { permissions }).runPage();
      expect(page.outcomes).toMatchObject([{ kind: 'observed', status: 'blocked' }]); expect(effects).toBe(0);
      expect((await producer.inspect(run.id)).budget).toMatchObject({ spentMicros: 0, reservedMicros: 0 });
    });

    it('survives a real process kill after A finalizes and before B starts without replaying A', async () => {
      const keys = orderedKeys('process-coordinator', 2); const effects = [0, 0];
      const definitions = [graph('coordinator.crashA', () => { effects[0]!++; return null; }), graph('coordinator.crashB', () => { effects[1]!++; return null; })];
      const entries = definitions.map((definition, index) => ({ definition, resources: { write: [`coordinator-crash-${index}`] } }));
      const a = await submit(definitions[0]!, keys[0], entries[0]!.resources); const b = await submit(definitions[1]!, keys[1], entries[1]!.resources);
      const { store: _store, ...options } = base();
      const child = fork(fileURLToPath(new URL('./fixtures/graph-coordinator-child.mjs', import.meta.url)), [JSON.stringify({
        backend: fixture.childConfig, options, firstRunId: a.id,
        definitions: entries.map(entry => ({ id: entry.definition.id, resources: entry.resources })),
      })], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      let exited = false; const exit = new Promise<void>(resolve => { child.once('exit', () => { exited = true; resolve(); }); });
      const marker = new Promise<{ effects: number[] }>((resolve, reject) => {
        child.once('error', reject);
        child.on('message', (message: { kind?: string; effects?: number[] }) => {
          if (message.kind === 'checkpoint' && Array.isArray(message.effects) && message.effects.length === 2
            && message.effects.every(value => Number.isSafeInteger(value) && value >= 0 && value <= 1)) resolve({ effects: message.effects });
          else reject(new Error('Coordinator child failed before its committed boundary.'));
        });
        child.once('exit', () => { reject(new Error('Coordinator child exited before its committed boundary.')); });
      });
      try {
        const checkpoint = await bounded(marker); expect(checkpoint.effects).toEqual([1, 0]);
        child.kill('SIGKILL'); await bounded(exit);
        expect((await runtime().inspect(a.id)).status).toBe('succeeded'); expect((await detail(b.id)).jobs).toEqual([]);
        await store.close(); store = await reopen();
        const page = await coordinator(entries).runPage();
        expect(page.outcomes).toMatchObject([{ kind: 'observed', status: 'succeeded' }]); expect(page.outcomes[0]!.reference.runId).toBe(b.id);
        expect(effects).toEqual([0, 1]);
        for (const id of [a.id, b.id]) expect((await runtime().inspect(id)).budget).toMatchObject({ spentMicros: 1, reservedMicros: 0 });
      } finally { if (!exited) child.kill('SIGKILL'); await bounded(exit); }
    }, 30_000);
  });
}
