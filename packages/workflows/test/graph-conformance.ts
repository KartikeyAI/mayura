import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { jsonValue, type JsonObject, type Scope } from '@mayura/core';
import { defineTool } from '@mayura/tools';
import { StorageError, type ExecutionCompletion, type ExecutionRef, type WorkflowGraphStore } from '@mayura/storage-contracts';
import { createScheduledWorkflowRuntime, createWorkflowRuntime, defineWorkflow } from '@mayura/workflows';
import { createWorkflowGraphRuntime, defineWorkflowGraph } from '@mayura/workflows/graphs';
import { digest } from '../src/definition.js';
import type { GraphFixture } from './graph-fixtures.js';

type Runtime = ReturnType<typeof createWorkflowGraphRuntime>;
type Options = Parameters<typeof createWorkflowGraphRuntime>[0];
type Store = GraphFixture['store'];
const scope = { principalId: 'graph-developer', projectId: 'graph-project' };
const scopeHash = digest('mayura:scope:v1', scope);
const permissionList = ['tool:graph.effect', 'effect:write'];
const literal = (value: unknown) => ({ kind: 'literal' as const, value: jsonValue(value) });
const refLiteral = (value: readonly ExecutionRef[]) => ({ kind: 'literal' as const, value });
const step = (stepId: string) => ({ kind: 'step' as const, stepId, path: [] });
const action = (execute: (input: unknown) => unknown = input => input, costMicros = 1) => defineTool({
  id: 'graph.effect', version: '1', description: 'Controlled local graph effect',
  input: z.unknown(), output: z.unknown(), effects: 'write', capabilities: [], costMicros, timeoutMs: 15_000, execute,
});
const waitGraph = (references: readonly ExecutionRef[], id = 'graph.wait') => defineWorkflowGraph({
  id, version: '1', input: z.unknown(), output: z.unknown(),
  nodes: [{ kind: 'wait', id: 'wait', targets: refLiteral(references) }], result: step('wait'),
});

/** These deadlines bound test barriers, not production leases; no blind scheduling sleeps. */
async function bounded<T>(promise: Promise<T>, milliseconds = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Controlled graph fixture did not reach its barrier.')), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Identical public scenarios exercise the real selected SQL adapters. */
export function graphWorkflowConformance(name: string, factory: () => Promise<GraphFixture>): void {
  describe(`${name} versioned workflow graph waits`, () => {
    let fixture: GraphFixture;
    let store: Store;
    let stores: Store[];
    let runtimes: { close(): void | Promise<void> }[];
    let worker = 0;
    const options = () => ({ store, scope, permissions: { allow: permissionList }, policyVersion: 'graph-policy-1',
      maxCostMicros: 20, maxOutputBytes: 65_536, approvalTtlMs: 60_000,
      verifyHuman: async (credential: unknown) => {
        if (credential !== 'verified-graph-human') throw new Error('SECRET verifier');
        return { id: 'graph-human', projectId: scope.projectId, canApprove: true };
      },
    });
    const runtime = (overrides: Partial<Options> = {}): Runtime => {
      const instance = createWorkflowGraphRuntime({ ...options(), workerId: `graph-worker-${++worker}`, ...overrides });
      runtimes.push(instance); return instance;
    };
    const wrapped = (methods: Partial<WorkflowGraphStore>): Store => ({ ...store, workflowGraphs: { ...store.workflowGraphs, ...methods } });
    const access = async (id: string, owner: Scope = scope) => {
      const record = await store.read(digest('mayura:scope:v1', owner), id);
      if (!record || typeof record.state['policy'] !== 'string') throw new Error('Missing controlled graph record.');
      return { scope: record.scope, id, policyHash: record.state['policy'] };
    };
    const detail = async (id: string) => store.workflowGraphs.inspect(await access(id));
    const graphCommand = async (id: string) => ({ ...await access(id), expectedVersion: (await detail(id)).record.version, commandId: randomUUID() });
    const target = async (overrides: Partial<Options> = {}) => {
      const engine = createScheduledWorkflowRuntime({ ...options(), workerId: `target-worker-${++worker}`, ...overrides });
      runtimes.push(engine);
      const definition = defineWorkflow({ id: 'graph.target', version: '1', input: z.unknown(), output: z.unknown(),
        nodes: [{ kind: 'tool', id: 'work', tool: action(() => 'SECRET_TARGET_OUTPUT'), input: literal(null) }], result: step('work') });
      const run = await engine.submit(definition, { input: 'SECRET_TARGET_INPUT', idempotencyKey: randomUUID() });
      return { engine, definition, run, reference: await engine.reference(run.id) };
    };
    const finish = async (reference: ExecutionRef, outcome: ExecutionCompletion['outcome']) => {
      const key = await access(reference.runId);
      const command = async () => ({ ...key, expectedVersion: (await store.workflows.inspect(key)).record.version, commandId: randomUUID() });
      if (outcome === 'cancelled') { await store.workflows.cancel(await command()); return; }
      if (outcome === 'failed' || outcome === 'blocked') {
        await store.workflows.failNode({ ...await command(), nodeId: 'work', outcome }); await store.workflows.advance(await command()); return;
      }
      await store.workflows.prepare({ ...await command(), nodeId: 'work', input: null });
      const claim = (await store.workflows.claim({ ...key, workerId: 'target-finish', limit: 1, leaseMs: 60_000 }))[0]!;
      await store.workflows.start({ ...await command(), claim: claim.claim, input: null });
      await store.workflows.recordReceipt({ ...key, jobId: claim.job.jobId, fence: claim.claim.fence, evidenceId: 'initial-evidence',
        receipt: { callId: claim.job.intent['callId'] as string, toolId: 'graph.effect', execution: outcome === 'succeeded' ? 'succeeded' : 'unknown', disclosure: 'withheld' } });
      if (outcome === 'succeeded') {
        await store.workflows.complete({ ...await command(), claim: claim.claim, evidenceId: 'initial-evidence', outcome: 'succeeded', output: 'SECRET_TARGET_OUTPUT' });
        await store.workflows.finalize({ ...await command(), validation: 'passed', output: 'SECRET_TARGET_OUTPUT' });
      } else await store.workflows.advance(await command());
    };
    const reopen = async () => {
      const next = fixture.reopen(); stores.push(next); await next.initialize(); await next.workflows.initialize(); await next.workflowGraphs.initialize(); return next;
    };
    beforeEach(async () => {
      fixture = await factory(); store = fixture.store; stores = [store]; runtimes = []; worker = 0;
      await store.initialize(); await store.workflows.initialize(); await store.workflowGraphs.initialize();
    });
    afterEach(async () => {
      await Promise.all((runtimes ?? []).map(instance => instance.close()));
      await Promise.all((stores ?? []).map(instance => instance.close())); await fixture?.cleanup();
    });

    it('exposes the opt-in versioned graph runtime and definition entry', () => {
      expect(createWorkflowGraphRuntime).toBeTypeOf('function');
      expect(defineWorkflowGraph).toBeTypeOf('function');
      const engine = runtime(); expect(engine.profile).toBe('scheduled-v2'); expect('attach' in engine).toBe(false);
    });

    it('waits without a job or charge and resumes from durable facts after close/reopen', async () => {
      const source = await target(); const definition = waitGraph([source.reference]); const engine = runtime();
      const run = await engine.submit(definition, { input: null, idempotencyKey: 'restart' });
      const waiting = await engine.runUntilSettled(definition, run.id);
      expect(waiting.status).toBe('waiting'); expect(waiting.steps['wait']).toMatchObject({ kind: 'wait', status: 'waiting', receipt: null, approval: null, candidateHash: null, costReserved: 0, output: null });
      expect(waiting.budget).toMatchObject({ spentMicros: 0, reservedMicros: 0 }); expect((await detail(run.id)).jobs).toEqual([]);
      expect((await store.read(scopeHash, run.id))!.state['format']).toBe(3);
      await engine.close(); await store.close(); store = await reopen(); await finish(source.reference, 'succeeded');
      const completed = await runtime().runUntilSettled(definition, run.id);
      expect(completed.status).toBe('succeeded'); expect(completed.output).toMatchObject([{ reference: source.reference, outcome: 'succeeded' }]);
      expect(JSON.stringify(completed)).not.toContain('SECRET'); expect((await detail(run.id)).jobs).toEqual([]);
    });

    it.each(['succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown'] as const)('satisfies terminal-all with an explicit %s observation', async outcome => {
      const source = await target(); await finish(source.reference, outcome); const definition = waitGraph([source.reference]); const engine = runtime();
      const run = await engine.submit(definition, { input: null, idempotencyKey: `terminal-${outcome}` }); const completed = await engine.runUntilSettled(definition, run.id);
      expect(completed.status).toBe('succeeded'); expect(completed.output).toMatchObject([{ reference: source.reference, outcome }]);
      expect(completed.budget).toMatchObject({ spentMicros: 0, reservedMicros: 0 });
      if (outcome === 'outcome_unknown') expect((await store.workflows.inspect(await access(source.run.id))).record.state['reservedMicros']).toBe(1);
    });

    it('resolves input targets after schema transformation and preserves declared target order', async () => {
      const first = await target(); const second = await target();
      const definition = defineWorkflowGraph({ id: 'graph.transformed', version: '1',
        input: z.object({ first: z.unknown(), second: z.unknown() }).transform(value => ({ references: [value.second, value.first] })), output: z.unknown(),
        nodes: [{ kind: 'wait', id: 'wait', targets: { kind: 'input', path: ['references'] } }], result: step('wait') });
      const engine = runtime(); const run = await engine.submit(definition, { input: { first: first.reference, second: second.reference }, idempotencyKey: 'transformed' });
      await finish(first.reference, 'blocked'); expect((await engine.runUntilSettled(definition, run.id)).status).toBe('waiting'); await finish(second.reference, 'cancelled');
      const completed = await engine.runUntilSettled(definition, run.id); const observations = completed.output as unknown as ExecutionCompletion[];
      expect(observations.map(item => item.reference.runId)).toEqual([second.run.id, first.run.id]); expect(observations.map(item => item.outcome)).toEqual(['cancelled', 'blocked']);
    });

    it('pins targets before their predecessor is ready and progresses independent branches', async () => {
      const source = await target(); let independent = 0;
      const definition = defineWorkflowGraph({ id: 'graph.dependencies', version: '1', input: z.unknown(), output: z.unknown(), nodes: [
        { kind: 'tool', id: 'approval', tool: action(), input: literal(null), approval: true },
        { kind: 'wait', id: 'wait', dependsOn: ['approval'], targets: refLiteral([source.reference]) },
        { kind: 'tool', id: 'independent', tool: action(() => { independent++; return null; }), input: literal(null) },
      ], result: step('wait') });
      const engine = runtime(); const run = await engine.submit(definition, { input: null, idempotencyKey: 'dependencies' });
      await finish(source.reference, 'failed'); const waiting = await engine.runUntilSettled(definition, run.id);
      expect(waiting.steps['wait']!.status).toBe('pending'); expect(independent).toBe(1);
      await engine.approve({ id: run.id, nodeId: 'approval', digest: waiting.steps['approval']!.approval!.digest, credential: 'verified-graph-human' });
      expect((await engine.runUntilSettled(definition, run.id)).output).toMatchObject([{ outcome: 'failed' }]); expect(independent).toBe(1);
    });

    it('gates one downstream human-approved effect on the persisted wait metadata', async () => {
      const source = await target(); let effects = 0; let received: unknown;
      const definition = defineWorkflowGraph({ id: 'graph.followup', version: '1', input: z.unknown(), output: z.unknown(), nodes: [
        { kind: 'wait', id: 'wait', targets: refLiteral([source.reference]) },
        { kind: 'tool', id: 'effect', dependsOn: ['wait'], tool: action(input => { effects++; received = input; return 'done'; }, 3), input: step('wait'), approval: true },
      ], result: step('effect') });
      const engine = runtime(); const run = await engine.submit(definition, { input: null, idempotencyKey: 'followup' });
      expect((await engine.runUntilSettled(definition, run.id)).steps['effect']!.approval).toBeNull(); await finish(source.reference, 'cancelled');
      const waiting = await engine.runUntilSettled(definition, run.id); expect(waiting.steps['wait']!.status).toBe('succeeded'); expect(effects).toBe(0); expect(waiting.budget.reservedMicros).toBe(0);
      await engine.approve({ id: run.id, nodeId: 'effect', digest: waiting.steps['effect']!.approval!.digest, credential: 'verified-graph-human' });
      const completed = await engine.runUntilSettled(definition, run.id); expect(completed.status).toBe('succeeded'); expect(completed.output).toBe('done'); expect(effects).toBe(1);
      expect(received).toEqual(waiting.steps['wait']!.output); expect(completed.budget.spentMicros).toBe(3); expect((await detail(run.id)).jobs.map(job => job.nodeId)).toEqual(['effect']);
    });

    it('skips a wait and downstream effect after a predecessor fails without touching its target', async () => {
      const source = await target(); let effects = 0;
      const definition = defineWorkflowGraph({ id: 'graph.skipped', version: '1', input: z.unknown(), output: z.unknown(), nodes: [
        { kind: 'tool', id: 'failure', tool: action(() => { throw new Error('SECRET controlled failure'); }), input: literal(null) },
        { kind: 'wait', id: 'wait', dependsOn: ['failure'], targets: refLiteral([source.reference]) },
        { kind: 'tool', id: 'effect', dependsOn: ['wait'], tool: action(() => { effects++; return null; }), input: literal(null) },
      ], result: step('effect') });
      const engine = runtime(); const run = await engine.submit(definition, { input: null, idempotencyKey: 'skip' });
      await store.workflowGraphs.failNode({ ...await graphCommand(run.id), nodeId: 'failure', outcome: 'failed' });
      const failed = await engine.runUntilSettled(definition, run.id);
      expect(failed.status).toBe('failed'); expect(failed.steps['wait']!.status).toBe('skipped'); expect(failed.steps['effect']!.status).toBe('skipped');
      expect(effects).toBe(0); expect((await source.engine.inspect(source.run.id)).status).toBe('running');
    });

    it('observes earlier graph runs and remains compatible with external completion joins', async () => {
      const source = await target(); const inner = waitGraph([source.reference], 'graph.inner'); const engine = runtime();
      const innerRun = await engine.submit(inner, { input: null, idempotencyKey: 'inner' }); const reference = await engine.reference(innerRun.id);
      const outer = waitGraph([reference], 'graph.outer'); const outerRun = await engine.submit(outer, { input: null, idempotencyKey: 'outer' });
      const stream = { scope: scopeHash, streamId: 'graph-external', policyHash: reference.policyHash };
      await store.executionWaits.initialize(); await store.executionWaits.open(stream); await store.executionWaits.register({ ...stream, id: 'outer', targets: [await engine.reference(outerRun.id)] });
      expect((await engine.runUntilSettled(outer, outerRun.id)).status).toBe('waiting'); await finish(source.reference, 'blocked'); await engine.runUntilSettled(inner, innerRun.id);
      expect((await engine.runUntilSettled(outer, outerRun.id)).output).toMatchObject([{ reference, outcome: 'succeeded' }]);
      expect((await store.executionWaits.drainReady({ ...stream, limit: 1 }))[0]!.observations[0]!.outcome).toBe('succeeded');
    });

    it('does not spend command history, versions, events or budget on repeated waiting controls', async () => {
      const source = await target(); const definition = waitGraph([source.reference]); const engine = runtime();
      const run = await engine.submit(definition, { input: null, idempotencyKey: 'no-op' }); await engine.runUntilSettled(definition, run.id);
      const before = await detail(run.id); const history = await engine.events(run.id); const key = await access(run.id);
      const owners = () => fixture.query(`SELECT data FROM ${fixture.prefix}mayura_workflow_owners WHERE scope = ? AND aggregate_id = ?`, [scopeHash, run.id]); const journal = await owners();
      for (let index = 0; index < 1_030; index++) {
        const command = { ...key, expectedVersion: before.record.version, commandId: `unchanged-${index}` };
        await store.workflowGraphs.advance(command); await store.workflowGraphs.recover(command);
      }
      expect(await detail(run.id)).toEqual(before); expect(await engine.events(run.id)).toEqual(history); expect(await owners()).toEqual(journal);
      await finish(source.reference, 'cancelled'); expect((await engine.runUntilSettled(definition, run.id)).status).toBe('succeeded');
    }, 60_000);

    it.each(['missing', 'scope', 'policy', 'definition', 'unowned', 'self'] as const)('rejects %s targets before persisting any parent or target index', async mismatch => {
      const source = await target(mismatch === 'scope' ? { scope: { ...scope, principalId: 'another-principal' } } : mismatch === 'policy' ? { policyVersion: 'another-policy' } : {});
      const idempotencyKey = `invalid-${mismatch}`; let reference = source.reference;
      if (mismatch === 'missing') reference = { ...reference, runId: 'f'.repeat(64) };
      if (mismatch === 'definition') reference = { ...reference, definitionHash: 'f'.repeat(64) };
      if (mismatch === 'self') reference = { ...reference, runId: digest('mayura:run-id:v1', { scope: scopeHash, submissionKey: idempotencyKey }) };
      if (mismatch === 'unowned') {
        const id = 'e'.repeat(64); await store.create({ scope: scopeHash, id, idempotencyKey: 'not-enrolled', definitionHash: reference.definitionHash, state: {}, events: [] });
        reference = { ...reference, runId: id };
      }
      const definition = waitGraph([reference]); const engine = runtime(); const before = await fixture.query(`SELECT id FROM ${fixture.prefix}mayura_aggregates ORDER BY id`);
      await expect(engine.submit(definition, { input: null, idempotencyKey })).rejects.toBeDefined();
      expect(await fixture.query(`SELECT id FROM ${fixture.prefix}mayura_aggregates ORDER BY id`)).toEqual(before);
      expect(await fixture.query(`SELECT * FROM ${fixture.prefix}mayura_workflow_wait_targets`)).toEqual([]);
    });

    it('accepts 32 targets per wait and 128 total edges without conflating repeated cross-node targets', async () => {
      const sources = [];
      for (let index = 0; index < 32; index++) sources.push(await target());
      const references = sources.map(source => source.reference);
      const nodes = Array.from({ length: 4 }, (_value, index) => ({ kind: 'wait' as const, id: `wait-${index}`, targets: refLiteral(references) }));
      const definition = defineWorkflowGraph({ id: 'graph.edge-cap', version: '1', input: z.unknown(), output: z.unknown(), nodes, result: step('wait-3') });
      const engine = runtime(); const run = await engine.submit(definition, { input: null, idempotencyKey: 'edge-cap' });
      expect(await fixture.query(`SELECT node_id FROM ${fixture.prefix}mayura_workflow_wait_targets WHERE scope = ? AND aggregate_id = ?`, [scopeHash, run.id])).toHaveLength(128);
      for (const source of sources) await finish(source.reference, 'cancelled');
      const completed = await engine.runUntilSettled(definition, run.id); expect(completed.status).toBe('succeeded');
      for (const node of nodes) expect(completed.steps[node.id]!.output).toHaveLength(32);
      expect((completed.output as unknown as ExecutionCompletion[]).map(item => item.reference)).toEqual(references);
    }, 30_000);

    it('does not lose readiness when target completion races parent registration', async () => {
      const source = await target(); const definition = waitGraph([source.reference]); const engine = runtime();
      const [run] = await Promise.all([engine.submit(definition, { input: null, idempotencyKey: 'registration-race' }), finish(source.reference, 'cancelled')]);
      expect((await engine.runUntilSettled(definition, run.id)).output).toMatchObject([{ reference: source.reference, outcome: 'cancelled' }]);
      expect((await engine.events(run.id)).filter(event => event.type === 'workflow.wait_registered')).toHaveLength(1);
    });

    it('checks all targets before source creation and refuses changed targets on submission retry', async () => {
      const source = await target(); await finish(source.reference, 'succeeded'); const engine = runtime();
      await expect(engine.submit(waitGraph([source.reference, { ...source.reference, runId: 'f'.repeat(64) }]), { input: null, idempotencyKey: 'all-validate' })).rejects.toBeDefined();
      expect(await fixture.query(`SELECT * FROM ${fixture.prefix}mayura_workflow_wait_targets`)).toEqual([]);
      const other = await target(); const definition = waitGraph([source.reference]); const run = await engine.submit(definition, { input: null, idempotencyKey: 'immutable' });
      expect((await engine.submit(definition, { input: null, idempotencyKey: 'immutable' })).id).toBe(run.id);
      await expect(engine.submit(waitGraph([other.reference]), { input: null, idempotencyKey: 'immutable' })).rejects.toBeDefined();
    });

    it('fences legacy workflow entry points and generic aggregate updates from graph runs', async () => {
      const source = await target(); const definition = waitGraph([source.reference]); const engine = runtime();
      const run = await engine.submit(definition, { input: null, idempotencyKey: 'profile-fence' }); const record = (await detail(run.id)).record;
      await expect(store.workflows.inspect(await access(run.id))).rejects.toBeDefined();
      await expect(store.update({ scope: scopeHash, id: run.id, expectedVersion: record.version, state: record.state, events: [] })).rejects.toBeDefined();
      const legacy = createWorkflowRuntime(options()); runtimes.push(legacy); await expect(legacy.inspect(run.id)).rejects.toBeDefined();
      const v1 = createScheduledWorkflowRuntime({ ...options(), workerId: 'v1-reader' }); runtimes.push(v1); await expect(v1.inspect(run.id)).rejects.toBeDefined();
      await expect(engine.submit(definition, { input: null, idempotencyKey: (await store.read(scopeHash, source.run.id))!.idempotencyKey })).rejects.toBeDefined();
      expect(await engine.inspect(run.id)).toMatchObject({ id: run.id, status: 'running' });
    });

    it('cancels only the parent and never resumes it after late target completion', async () => {
      const source = await target(); const engine = runtime(); const definition = waitGraph([source.reference]);
      const run = await engine.submit(definition, { input: null, idempotencyKey: 'cancel' }); await engine.runUntilSettled(definition, run.id);
      const cancelled = await engine.cancel(run.id); expect(cancelled.steps['wait']!.status).toBe('skipped');
      expect((await source.engine.inspect(source.run.id)).status).toBe('running'); await finish(source.reference, 'succeeded');
      expect(await engine.runUntilSettled(definition, run.id)).toEqual(cancelled); expect(cancelled.output).toBeNull();
    });

    it('retains the original unknown observation after late successful target receipt accounting', async () => {
      const source = await target(); await finish(source.reference, 'outcome_unknown'); const definition = waitGraph([source.reference]); const engine = runtime();
      const run = await engine.submit(definition, { input: null, idempotencyKey: 'late-known' }); const before = await engine.runUntilSettled(definition, run.id);
      const targetKey = await access(source.run.id); const job = (await store.workflows.inspect(targetKey)).jobs[0]!;
      await store.workflows.recordReceipt({ ...targetKey, jobId: job.jobId, fence: job.fence, evidenceId: 'late-success',
        receipt: { callId: job.intent['callId'] as string, toolId: 'graph.effect', execution: 'succeeded', disclosure: 'withheld' } });
      expect(await engine.inspect(run.id)).toEqual(before); expect(before.output).toMatchObject([{ outcome: 'outcome_unknown' }]);
      const current = await store.workflows.inspect(targetKey); expect(current.record.state['spentMicros']).toBe(1); expect(current.record.state['reservedMicros']).toBe(0);
    });

    it('serializes concurrent resolution and downstream dispatch across independent owners', async () => {
      const source = await target(); let effects = 0;
      const definition = defineWorkflowGraph({ id: 'graph.race', version: '1', input: z.unknown(), output: z.unknown(), nodes: [
        { kind: 'wait', id: 'wait', targets: refLiteral([source.reference]) },
        { kind: 'tool', id: 'effect', dependsOn: ['wait'], tool: action(() => { effects++; return 'once'; }), input: step('wait') },
      ], result: step('effect') });
      const engine = runtime(); const other = runtime({ store: await reopen() }); const run = await engine.submit(definition, { input: null, idempotencyKey: 'race' });
      await engine.runUntilSettled(definition, run.id); await finish(source.reference, 'succeeded');
      await Promise.all([engine.runUntilSettled(definition, run.id), other.runUntilSettled(definition, run.id)]);
      expect((await engine.runUntilSettled(definition, run.id)).status).toBe('succeeded'); expect(effects).toBe(1);
      const events = await engine.events(run.id); expect(events.filter(event => event.type === 'workflow.wait_resolved' && event.data['nodeId'] === 'wait')).toHaveLength(1);
      expect(events.map(event => event.sequence)).toEqual(events.map((_event, index) => index + 1));
    });

    it('recovers lost submit and resolution acknowledgments without duplicate graph transitions', async () => {
      const source = await target(); const definition = waitGraph([source.reference]); let loseSubmit = true; let loseAdvance = true;
      const fault = wrapped({
        submit: async command => { const result = await store.workflowGraphs.submit(command); if (loseSubmit) { loseSubmit = false; throw new StorageError('STORAGE_UNAVAILABLE', 'SECRET lost submit'); } return result; },
        advance: async command => {
          const result = await store.workflowGraphs.advance(command);
          if (loseAdvance && ((result.record.state['steps'] as JsonObject)['wait'] as JsonObject)['status'] === 'succeeded') { loseAdvance = false; throw new StorageError('STORAGE_UNAVAILABLE', 'SECRET lost advance'); }
          return result;
        },
      });
      const engine = runtime({ store: fault }); const submission = { input: null, idempotencyKey: 'lost' };
      await expect(engine.submit(definition, submission)).rejects.toBeDefined(); const run = await engine.submit(definition, submission);
      await engine.runUntilSettled(definition, run.id); await finish(source.reference, 'succeeded'); await expect(engine.runUntilSettled(definition, run.id)).rejects.toBeDefined();
      const clean = runtime(); expect((await clean.runUntilSettled(definition, run.id)).status).toBe('succeeded');
      expect((await clean.events(run.id)).filter(event => event.type === 'workflow.wait_resolved' && event.data['nodeId'] === 'wait')).toHaveLength(1);
    });

    it('serializes cancellation versus resolution with a durable terminal winner', async () => {
      const source = await target(); const definition = waitGraph([source.reference]); const engine = runtime(); const other = runtime({ store: await reopen() });
      const run = await engine.submit(definition, { input: null, idempotencyKey: 'cancel-race' }); await engine.runUntilSettled(definition, run.id); await finish(source.reference, 'succeeded');
      await Promise.allSettled([engine.cancel(run.id), other.runUntilSettled(definition, run.id)]);
      const current = await engine.inspect(run.id); expect(['cancelled', 'succeeded']).toContain(current.status); expect(await engine.runUntilSettled(definition, run.id)).toEqual(current);
      expect((await source.engine.inspect(source.run.id)).status).toBe('succeeded');
    });

    it('advances a parent without acquiring a mutable target lock after target admission', async () => {
      // SQLite serializes all writers. PostgreSQL exercises the finer row-lock exclusion.
      if (fixture.dialect !== 'postgres') return;
      const source = await target(); const definition = waitGraph([source.reference]); const engine = runtime();
      const run = await engine.submit(definition, { input: null, idempotencyKey: 'lock-order' }); await engine.runUntilSettled(definition, run.id); await finish(source.reference, 'succeeded');
      const release = await fixture.lockAggregate(scopeHash, source.run.id);
      try { expect((await bounded(engine.runUntilSettled(definition, run.id))).status).toBe('succeeded'); }
      finally { await release(); }
    }, 25_000);

    it.each(['missing', 'ordinal', 'definition', 'extra'] as const)('fails closed on a corrupt %s target index without advancing history', async mutation => {
      const source = await target(); const definition = waitGraph([source.reference]); const engine = runtime();
      const run = await engine.submit(definition, { input: null, idempotencyKey: `corrupt-${mutation}` }); await engine.runUntilSettled(definition, run.id); await finish(source.reference, 'succeeded');
      const parameters = [scopeHash, run.id];
      if (mutation === 'missing') await fixture.query(`DELETE FROM ${fixture.prefix}mayura_workflow_wait_targets WHERE scope = ? AND aggregate_id = ?`, parameters);
      else if (mutation === 'ordinal') await fixture.query(`UPDATE ${fixture.prefix}mayura_workflow_wait_targets SET ordinal = 2 WHERE scope = ? AND aggregate_id = ?`, parameters);
      else if (mutation === 'definition') await fixture.query(`UPDATE ${fixture.prefix}mayura_workflow_wait_targets SET definition_hash = ? WHERE scope = ? AND aggregate_id = ?`, ['f'.repeat(64), ...parameters]);
      else {
        const extra = await target();
        await fixture.query(`INSERT INTO ${fixture.prefix}mayura_workflow_wait_targets (scope,aggregate_id,node_id,ordinal,run_id,definition_hash,policy_hash) VALUES (?,?,?,?,?,?,?)`, [scopeHash, run.id, 'wait', 1, extra.run.id, extra.reference.definitionHash, extra.reference.policyHash]);
      }
      const history = await store.events(scopeHash, run.id); const result = await Promise.allSettled([engine.inspect(run.id), engine.runUntilSettled(definition, run.id)]);
      expect(result.every(item => item.status === 'rejected')).toBe(true); expect(await store.events(scopeHash, run.id)).toEqual(history); expect(JSON.stringify(result)).not.toContain('SECRET');
    });

    it.each(['fact-digest', 'output', 'reservation', 'receipt'] as const)('rejects corrupt wait %s rather than trusting aggregate claims', async mutation => {
      const source = await target(); await finish(source.reference, 'succeeded'); const definition = waitGraph([source.reference]); const engine = runtime();
      const run = await engine.submit(definition, { input: null, idempotencyKey: `corrupt-state-${mutation}` }); await engine.runUntilSettled(definition, run.id);
      if (mutation === 'fact-digest') await fixture.query(`UPDATE ${fixture.prefix}mayura_execution_completions SET digest = ? WHERE scope = ? AND run_id = ?`, ['f'.repeat(64), scopeHash, source.run.id]);
      else {
        const record = (await store.read(scopeHash, run.id))!; const state = JSON.parse(JSON.stringify(record.state)) as JsonObject; const waiting = (state['steps'] as JsonObject)['wait'] as JsonObject;
        if (mutation === 'output') (waiting['output'] as JsonObject[])[0]!['outcome'] = 'failed';
        if (mutation === 'reservation') { waiting['costReserved'] = 1; state['reservedMicros'] = 1; }
        if (mutation === 'receipt') waiting['receipt'] = { callId: `${run.id}/step:wait`, toolId: 'graph.effect', execution: 'succeeded', disclosure: 'released' };
        await fixture.query(`UPDATE ${fixture.prefix}mayura_aggregates SET state = ? WHERE scope = ? AND id = ?`, [JSON.stringify(state), scopeHash, run.id]);
      }
      await expect(engine.inspect(run.id)).rejects.toBeDefined(); await expect(engine.runUntilSettled(definition, run.id)).rejects.toBeDefined();
    });

    it('rejects a forged failed wait while its target is still nonterminal', async () => {
      const source = await target(); const engine = runtime(); const definition = waitGraph([source.reference]);
      const run = await engine.submit(definition, { input: null, idempotencyKey: 'forged-failure' }); await engine.runUntilSettled(definition, run.id);
      const record = (await store.read(scopeHash, run.id))!; const state = JSON.parse(JSON.stringify(record.state)) as JsonObject;
      ((state['steps'] as JsonObject)['wait'] as JsonObject)['status'] = 'failed'; state['status'] = 'running';
      await fixture.query(`UPDATE ${fixture.prefix}mayura_aggregates SET state = ? WHERE scope = ? AND id = ?`, [JSON.stringify(state), scopeHash, run.id]);
      await expect(engine.inspect(run.id)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    });

    it('fails an oversized metadata output without inventing an effect or blocking cancellation', async () => {
      const source = await target({ maxOutputBytes: 128 }); const engine = runtime({ maxOutputBytes: 128 }); const definition = waitGraph([source.reference]);
      const run = await engine.submit(definition, { input: null, idempotencyKey: 'small-output' }); await finish(source.reference, 'cancelled'); const failed = await engine.runUntilSettled(definition, run.id);
      expect(failed.status).toBe('failed'); expect(failed.steps['wait']).toMatchObject({ status: 'failed', output: null, receipt: null, costReserved: 0 });
      expect(failed.budget).toMatchObject({ spentMicros: 0, reservedMicros: 0 }); await engine.cancel(run.id);
    });

    it('reserves observation headroom for pending waits alongside an earlier large output', async () => {
      const source = await target(); const waits = Array.from({ length: 127 }, (_value, index) => ({ kind: 'wait' as const, id: `wait-${index}`, targets: refLiteral([source.reference]), dependsOn: ['large'] }));
      const definition = defineWorkflowGraph({ id: 'graph.headroom', version: '1', input: z.unknown(), output: z.unknown(), nodes: [
        { kind: 'tool', id: 'large', tool: action(() => 'x'.repeat(60_000)), input: literal(null) }, ...waits,
      ], result: step('wait-126') });
      const engine = runtime(); const run = await engine.submit(definition, { input: null, idempotencyKey: 'headroom' });
      const waiting = await engine.runUntilSettled(definition, run.id); expect(waiting.status).toBe('waiting'); expect(waiting.steps['large']!.receipt?.execution).toBe('succeeded');
      await finish(source.reference, 'succeeded'); const completed = await engine.runUntilSettled(definition, run.id);
      expect(completed.status).toBe('succeeded'); expect(completed.steps['wait-126']!.status).toBe('succeeded');
      expect(Buffer.byteLength(JSON.stringify((await detail(run.id)).record.state))).toBeLessThanOrEqual(1_048_576); expect(completed.budget).toMatchObject({ spentMicros: 1, reservedMicros: 0 });
    }, 30_000);

    it('withholds near-limit tool output before future wait observations can exhaust aggregate headroom', async () => {
      const source = await target(); const tools = Array.from({ length: 16 }, (_value, index) => ({ kind: 'tool' as const, id: `large-${index}`, tool: action(() => 'x'.repeat(62_000)), input: literal(null) }));
      const waits = Array.from({ length: 112 }, (_value, index) => ({ kind: 'wait' as const, id: `wait-${index}`, targets: refLiteral([source.reference]), dependsOn: tools.map(node => node.id) }));
      const definition = defineWorkflowGraph({ id: 'graph.headroom-limit', version: '1', input: z.unknown(), output: z.unknown(), nodes: [...tools, ...waits], result: step('wait-111') });
      // This checks aggregate bounds rather than the minimum lease's throughput envelope.
      // The 16-effect / near-one-MiB public path took 58.75 s in a focused paired run;
      // allow a bounded 120 s runner window under the full four-worker suite. Production
      // deadlines, the explicit fixture lease and every headroom/receipt assertion stay fixed.
      const engine = runtime({ maxConcurrentJobs: 1, leaseMs: 30_000 }); const run = await engine.submit(definition, { input: null, idempotencyKey: 'headroom-limit' });
      const blocked = await engine.runUntilSettled(definition, run.id); expect(blocked.status).toBe('blocked');
      const withheld = Object.values(blocked.steps).filter(node => node.kind === 'tool' && node.status === 'blocked');
      expect(withheld.length).toBeGreaterThan(0);
      for (const node of withheld) expect(node).toMatchObject({ output: null, receipt: { execution: 'succeeded', disclosure: 'withheld' }, costReserved: 0 });
      const toolSteps = Object.values(blocked.steps).filter(node => node.kind === 'tool');
      expect(toolSteps.every(node => node.receipt?.execution === 'succeeded')).toBe(true); expect(blocked.budget).toMatchObject({ spentMicros: tools.length, reservedMicros: 0 });
      const record = (await detail(run.id)).record;
      // All attempted outputs fit individually. A hypothetical aggregate containing every tool
      // output still fits now, but retaining its future wait observations would not.
      const unprojected = JSON.parse(JSON.stringify(record.state)) as JsonObject;
      for (const node of tools) ((unprojected['steps'] as JsonObject)[node.id] as JsonObject)['output'] = 'x'.repeat(62_000);
      expect(Buffer.byteLength(JSON.stringify(unprojected))).toBeLessThanOrEqual(1_048_576);
      for (const node of waits) ((unprojected['steps'] as JsonObject)[node.id] as JsonObject)['output'] = jsonValue([{ reference: source.reference, outcome: 'outcome_unknown', sourceVersion: Number.MAX_SAFE_INTEGER, sourceEventSequence: Number.MAX_SAFE_INTEGER }]);
      expect(Buffer.byteLength(JSON.stringify(unprojected))).toBeGreaterThan(1_048_576);
      await engine.cancel(run.id); await finish(source.reference, 'succeeded'); expect((await engine.inspect(run.id)).status).toBe('blocked');
    }, 120_000);

    it.each(['registration-before', 'registration-after', 'resolution-before', 'resolution-after'] as const)('recovers atomic parent/index/history state after process termination at %s commit', async phase => {
      const source = await target(); const definition = waitGraph([source.reference]); const engine = runtime(); const submission = { input: null, idempotencyKey: `crash-${phase}` };
      let enrollment: Parameters<WorkflowGraphStore['submit']>[0] | undefined;
      const capturing = runtime({ store: wrapped({ submit: async command => { enrollment = command; throw new StorageError('STORAGE_UNAVAILABLE', 'Controlled capture before persistence.'); } }) });
      await expect(capturing.submit(definition, submission)).rejects.toBeDefined(); expect(enrollment).toBeDefined();
      let parentId: string | undefined; let command: Awaited<ReturnType<typeof graphCommand>> | undefined;
      if (phase.startsWith('resolution')) { const run = await engine.submit(definition, submission); parentId = run.id; await engine.runUntilSettled(definition, run.id); await finish(source.reference, 'succeeded'); command = await graphCommand(run.id); }
      const before = parentId ? await detail(parentId) : undefined; const history = parentId ? await store.events(scopeHash, parentId) : [];
      const child = fork(fileURLToPath(new URL('./fixtures/graph-child.mjs', import.meta.url)), [JSON.stringify({ phase, backend: fixture.childConfig, enrollment, command })], { silent: true, windowsHide: true, execArgv: [] });
      let exited = false; const exit = new Promise<void>(resolve => { child.once('exit', () => { exited = true; resolve(); }); child.once('error', () => { exited = true; resolve(); }); });
      try {
        await bounded(new Promise<void>((resolve, reject) => {
          child.on('message', message => {
            if (message && typeof message === 'object' && 'kind' in message && message.kind === 'checkpoint') resolve();
            else {
              const stage = message && typeof message === 'object' && 'stage' in message && typeof message.stage === 'string'
                && ['host-import', 'configuration', 'public-initialize', 'public-command', 'backend-create', 'reducer-initialize', 'reducer-command'].includes(message.stage) ? message.stage : 'unknown';
              reject(new Error(`Graph child fixture failed at ${stage}.`));
            }
          });
          child.once('exit', () => reject(new Error('Graph child exited before checkpoint.'))); child.once('error', () => reject(new Error('Graph child failed to start.')));
        }), 20_000);
      } finally { if (!exited) child.kill('SIGKILL'); await bounded(exit); }
      if (phase === 'registration-before') {
        expect(await fixture.query(`SELECT id FROM ${fixture.prefix}mayura_aggregates WHERE scope = ? AND idempotency_key = ?`, [scopeHash, submission.idempotencyKey])).toEqual([]);
        expect(await fixture.query(`SELECT * FROM ${fixture.prefix}mayura_workflow_wait_targets`)).toEqual([]);
      }
      if (phase === 'resolution-before') { expect(await detail(parentId!)).toEqual(before); expect(await store.events(scopeHash, parentId!)).toEqual(history); }
      const acknowledged = await engine.submit(definition, submission); parentId = acknowledged.id;
      expect(await fixture.query(`SELECT node_id FROM ${fixture.prefix}mayura_workflow_wait_targets WHERE scope = ? AND aggregate_id = ?`, [scopeHash, parentId])).toHaveLength(1);
      if (phase === 'resolution-after') expect((await engine.inspect(parentId)).steps['wait']!.status).toBe('succeeded');
      if (phase.startsWith('registration')) await finish(source.reference, 'succeeded');
      expect((await engine.runUntilSettled(definition, parentId)).status).toBe('succeeded');
      expect((await engine.events(parentId)).filter(event => event.type === 'workflow.wait_resolved' && event.data['nodeId'] === 'wait')).toHaveLength(1); expect((await detail(parentId)).jobs).toEqual([]);
    }, 40_000);

    it('admits wait-only graphs at a zero execution-cost limit', async () => {
      const source = await target({ maxCostMicros: 0 }); const engine = runtime({ maxCostMicros: 0 }); const definition = waitGraph([source.reference]);
      const run = await engine.submit(definition, { input: null, idempotencyKey: 'zero' }); expect((await engine.runUntilSettled(definition, run.id)).status).toBe('waiting'); await source.engine.cancel(source.run.id);
      expect((await engine.runUntilSettled(definition, run.id)).budget).toEqual({ maxCostMicros: 0, spentMicros: 0, reservedMicros: 0 });
    });
  });
}
