import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { defineTool, type AnyTool } from '@mayura/tools';
import type { ExecutionContext, Guard, JsonObject, Scope } from '@mayura/core';
import { StorageError, type ScheduledWorkflowAggregateStore, type ScheduledWorkflowStore } from '@mayura/storage-contracts';
import { createScheduledWorkflowRuntime, createWorkflowRuntime, defineWorkflow } from '../src/index.js';
import { digest } from '../src/definition.js';
import type { ScheduledFixture } from './scheduled-fixtures.js';

type Runtime = ReturnType<typeof createScheduledWorkflowRuntime>;
type Options = Parameters<typeof createScheduledWorkflowRuntime>[0];
const scope = { principalId: 'scheduled-developer', projectId: 'scheduled-project' };
const inputSchema = z.object({ value: z.number() });

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

/** A failed assertion must not leave a fixture handler blocked indefinitely. */
async function bounded<T>(promise: Promise<T>, milliseconds = 3_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Controlled fixture did not reach its barrier.')), milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function tool(options: {
  id?: string; execute?: (input: { value: number }, context: ExecutionContext) => unknown;
  costMicros?: number; output?: z.ZodType; timeoutMs?: number;
  guards?: { input?: readonly Guard[]; output?: readonly Guard[] };
} = {}) {
  return defineTool({
    id: options.id ?? 'scheduled.write', version: '1', description: 'Controlled local scheduled effect',
    input: inputSchema, output: options.output ?? z.unknown(), effects: 'write', capabilities: [],
    costMicros: options.costMicros ?? 1, timeoutMs: options.timeoutMs ?? 5_000,
    execute: options.execute ?? (input => input),
    ...(options.guards ? { guards: options.guards } : {}),
  });
}

function single(definition: AnyTool, approval = false) {
  return defineWorkflow({
    id: 'scheduled.workflow', version: '1', input: inputSchema, output: z.unknown(),
    nodes: [{ kind: 'tool', id: 'write', tool: definition, input: { kind: 'input', path: [] }, approval }],
    result: { kind: 'step', stepId: 'write', path: [] },
  });
}

function parallel(first: AnyTool, second: AnyTool) {
  return defineWorkflow({
    id: 'scheduled.parallel', version: '1', input: inputSchema, output: z.unknown(),
    nodes: [
      { kind: 'tool', id: 'first', tool: first, input: { kind: 'input', path: [] } },
      { kind: 'tool', id: 'second', tool: second, input: { kind: 'input', path: [] } },
      { kind: 'join', id: 'joined', dependsOn: ['second', 'first'] },
    ], result: { kind: 'step', stepId: 'joined', path: [] },
  });
}

/** The same assertions exercise the actual SQL adapters; wrappers inject transport failures only. */
export function scheduledWorkflowConformance(name: string, factory: () => Promise<ScheduledFixture>): void {
  describe(`${name} public scheduled workflows`, () => {
    let fixture: ScheduledFixture;
    let store: ScheduledWorkflowAggregateStore;
    let runtimes: Runtime[];
    let worker = 0;
    const base = () => ({
      store, scope, permissions: { allow: ['tool:scheduled.write', 'tool:scheduled.second', 'effect:write'] },
      policyVersion: 'scheduled-policy-1', maxCostMicros: 10, maxOutputBytes: 65_536,
      approvalTtlMs: 60_000,
      verifyHuman: async (credential: unknown) => {
        if (credential !== 'verified-scheduled-human') throw new Error('SECRET verifier diagnostics');
        return { id: 'human-a', projectId: scope.projectId, canApprove: true };
      },
    });
    const runtime = (overrides: Partial<Options> = {}): Runtime => {
      // Ordinary conformance uses the production default lease. Tests that exercise
      // expiry/renewal opt into 1 s explicitly, rather than making every assertion
      // depend on a heavily contended test machine completing SQL within that window.
      const instance = createScheduledWorkflowRuntime({ ...base(), workerId: `worker-${++worker}`, ...overrides });
      runtimes.push(instance); return instance;
    };
    const wrapped = (methods: Partial<ScheduledWorkflowStore>): ScheduledWorkflowAggregateStore => ({
      ...store, workflows: { ...store.workflows, ...methods },
    });
    const access = async (id: string, owner: Scope = scope) => {
      const record = await store.read(digest('mayura:scope:v1', owner), id);
      if (!record || typeof record.state['policy'] !== 'string') throw new Error('Missing controlled workflow record.');
      return { scope: record.scope, id, policyHash: record.state['policy'] };
    };
    const detail = async (id: string) => store.workflows.inspect(await access(id));
    beforeEach(async () => {
      fixture = await factory(); store = fixture.store as ScheduledWorkflowAggregateStore;
      runtimes = []; worker = 0;
      await store.initialize(); await store.workflows.initialize();
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await Promise.all((runtimes ?? []).map(instance => instance.close()));
      await store?.close(); await fixture?.cleanup();
    });

    it('executes independent branches and joins in declared order with one event sequence', async () => {
      const effects: string[] = [];
      const definition = parallel(
        tool({ execute: input => { effects.push('first'); return { value: input.value + 1 }; } }),
        tool({ id: 'scheduled.second', execute: input => { effects.push('second'); return { value: input.value + 2 }; } }),
      );
      const engine = runtime(); const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'parallel' });
      const completed = await engine.runUntilSettled(definition, run.id);
      expect(completed.status).toBe('succeeded'); expect(completed.output).toEqual([{ value: 4 }, { value: 3 }]);
      expect(effects.sort()).toEqual(['first', 'second']);
      expect(completed.budget).toEqual({ spentMicros: 2, reservedMicros: 0, maxCostMicros: 10 });
      const events = await engine.events(run.id);
      expect(events.map(event => event.sequence)).toEqual(events.map((_event, index) => index + 1));
      expect(await engine.events(run.id, events.at(-1)!.sequence)).toEqual([]);
      const before = await detail(run.id); await engine.inspect(run.id); await engine.events(run.id);
      expect(await detail(run.id)).toEqual(before); expect(effects).toHaveLength(2);
      expect(Object.isFrozen(completed)).toBe(true); expect(Object.isFrozen(completed.steps)).toBe(true);
    });

    it('deduplicates concurrent submission and retries after completion without replacing intent', async () => {
      let effects = 0; const definition = single(tool({ execute: input => { effects++; return input; } }));
      const engine = runtime(); const command = { input: { value: 2 }, idempotencyKey: 'deduplicate' };
      const runs = await Promise.all(Array.from({ length: 8 }, () => engine.submit(definition, command)));
      expect(new Set(runs.map(run => run.id)).size).toBe(1);
      const run = runs[0]!; const completed = await engine.runUntilSettled(definition, run.id);
      let diagnostics: string | undefined;
      if (completed.status !== 'succeeded') {
        const observed = await detail(run.id);
        diagnostics = JSON.stringify({ status: completed.status, effects, jobs: observed.jobs.map(job => ({
          state: job.state, fence: job.fence, leaseUntilMs: job.leaseUntilMs, startedAtMs: job.startedAtMs,
          leaseRevoked: job.leaseRevoked, cancelRequested: job.cancelRequested, receipt: job.receipt,
        })), events: await engine.events(run.id) });
      }
      expect(completed.status, diagnostics).toBe('succeeded');
      expect((await engine.submit(definition, command)).status).toBe('succeeded'); expect(effects).toBe(1);
      await expect(engine.submit(definition, { ...command, input: { value: 3 } })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect((await detail(run.id)).jobs).toHaveLength(1);
    });

    it('preserves pristine legacy identity when explicitly attaching and blocks old writes', async () => {
      let effects = 0; const definition = single(tool({ execute: input => { effects++; return input; } }));
      const legacy = createWorkflowRuntime(base());
      try {
        const run = await legacy.submit(definition, { input: { value: 2 }, idempotencyKey: 'attach' });
        const key = await access(run.id); const before = await store.read(key.scope, run.id);
        const events = await legacy.events(run.id); const engine = runtime();
        const attached = await engine.attach(definition, run.id);
        const after = await store.read(key.scope, run.id);
        expect(after!.state).toEqual(before!.state); expect(after!.definitionHash).toBe(before!.definitionHash);
        expect(after!.idempotencyKey).toBe(before!.idempotencyKey); expect(after!.id).toBe(before!.id);
        expect((await engine.events(run.id)).slice(0, events.length)).toEqual(events);
        expect((await legacy.submit(definition, { input: { value: 2 }, idempotencyKey: 'attach' })).id).toBe(run.id);
        await expect(store.update({ scope: key.scope, id: run.id, expectedVersion: attached.version, state: before!.state, events: [] })).rejects.toMatchObject({ code: 'SCHEDULED_WRITER_REQUIRED' });
        await expect(legacy.runUntilSettled(definition, run.id)).rejects.toBeDefined(); expect(effects).toBe(0);
        expect((await engine.runUntilSettled(definition, run.id)).status).toBe('succeeded'); expect(effects).toBe(1);
      } finally { legacy.close(); }
    });

    it('rejects attachment of waiting approval or completed legacy state', async () => {
      const legacy = createWorkflowRuntime(base()); const engine = runtime();
      try {
        const approvalDefinition = single(tool(), true);
        const waiting = await legacy.submit(approvalDefinition, { input: { value: 2 }, idempotencyKey: 'attach-waiting' });
        await legacy.runUntilSettled(approvalDefinition, waiting.id);
        await expect(engine.attach(approvalDefinition, waiting.id)).rejects.toMatchObject({ code: 'CONFLICT' });
        const completeDefinition = single(tool());
        const completed = await legacy.submit(completeDefinition, { input: { value: 2 }, idempotencyKey: 'attach-completed' });
        await legacy.runUntilSettled(completeDefinition, completed.id);
        await expect(engine.attach(completeDefinition, completed.id)).rejects.toMatchObject({ code: 'CONFLICT' });
      } finally { legacy.close(); }
    });

    it('rejects attaching the conservative default one-MiB policy', async () => {
      const { maxOutputBytes: _scheduledLimit, ...legacyOptions } = base();
      const legacy = createWorkflowRuntime(legacyOptions); const definition = single(tool());
      try {
        const run = await legacy.submit(definition, { input: { value: 2 }, idempotencyKey: 'wrong-policy-limit' });
        await expect(runtime().attach(definition, run.id)).rejects.toMatchObject({ code: 'CONFLICT' });
      } finally { legacy.close(); }
    });

    it('denies changed policy and cross-scope read, execution, cancel and recovery', async () => {
      let effects = 0; const definition = single(tool({ execute: input => { effects++; return input; } }));
      const engine = runtime(); const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'scope' });
      const changed = runtime({ policyVersion: 'changed' });
      await expect(changed.runUntilSettled(definition, run.id)).rejects.toMatchObject({ code: 'CONFLICT' });
      for (const foreignScope of [{ ...scope, principalId: 'other' }, { ...scope, projectId: 'other' }]) {
        const foreign = runtime({ scope: foreignScope });
        for (const operation of [() => foreign.inspect(run.id), () => foreign.runUntilSettled(definition, run.id), () => foreign.cancel(run.id), () => foreign.recoverExpired(run.id)]) {
          await expect(operation()).rejects.toMatchObject({ code: 'NOT_FOUND' });
        }
      }
      expect(effects).toBe(0);
    });

    it('pins resource identity on enrollment and rejects replacement on retry', async () => {
      const definition = single(tool());
      const engine = runtime({ resources: { write: ['resource-a'] } });
      const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'resources-pinned' });
      const changed = runtime({ resources: { write: ['resource-b'] } });
      await expect(changed.submit(definition, { input: { value: 2 }, idempotencyKey: 'resources-pinned' })).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(changed.runUntilSettled(definition, run.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('waits for verified human approval without reserving budget or resources', async () => {
      let effects = 0; const definition = single(tool({ execute: input => { effects++; return input; } }), true);
      const engine = runtime({ resources: { write: ['approval-resource'] } });
      const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'approval' });
      const waiting = await engine.runUntilSettled(definition, run.id); const approval = waiting.steps['write']!.approval!;
      expect(waiting.status).toBe('waiting'); expect(waiting.budget.reservedMicros).toBe(0);
      expect((await detail(run.id)).jobs).toEqual([]); expect(effects).toBe(0);
      await expect(engine.approve({ id: run.id, nodeId: 'write', digest: approval.digest, credential: 'wrong' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      await expect(engine.approve({ id: run.id, nodeId: 'write', digest: 'a'.repeat(64), credential: 'verified-scheduled-human' })).rejects.toMatchObject({ code: 'CONFLICT' });
      await engine.approve({ id: run.id, nodeId: 'write', digest: approval.digest, credential: 'verified-scheduled-human' });
      expect((await engine.runUntilSettled(definition, run.id)).status).toBe('succeeded'); expect(effects).toBe(1);
    });

    it('persists approval and ownership across store/runtime restart', async () => {
      let effects = 0; const definition = single(tool({ execute: input => { effects++; return input; } }), true);
      const old = runtime(); const run = await old.submit(definition, { input: { value: 2 }, idempotencyKey: 'restart' });
      const waiting = await old.runUntilSettled(definition, run.id); const approval = waiting.steps['write']!.approval!;
      await old.close(); await store.close(); store = fixture.reopen() as ScheduledWorkflowAggregateStore;
      await store.initialize(); await store.workflows.initialize();
      const current = runtime(); expect((await current.inspect(run.id)).steps['write']!.approval).toEqual(approval);
      await current.approve({ id: run.id, nodeId: 'write', digest: approval.digest, credential: 'verified-scheduled-human' });
      expect((await current.runUntilSettled(definition, run.id)).status).toBe('succeeded'); expect(effects).toBe(1);
    });

    it('uses storage time instead of a future caller clock for approval admission', async () => {
      const definition = single(tool(), true); const engine = runtime();
      const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'storage-time' });
      const waiting = await engine.runUntilSettled(definition, run.id);
      const approval = waiting.steps['write']!.approval!;
      const clock = vi.spyOn(Date, 'now').mockReturnValue(approval.expiresAt + 86_400_000);
      try { await engine.approve({ id: run.id, nodeId: 'write', digest: approval.digest, credential: 'verified-scheduled-human' }); }
      finally { clock.mockRestore(); }
      expect((await engine.runUntilSettled(definition, run.id)).status).toBe('succeeded');
    });

    it('rejects approval that expires while its admission waits behind a real database lock', async () => {
      let effects = 0; const verified = deferred<void>();
      const definition = single(tool({ execute: input => { effects++; return input; } }), true);
      const engine = runtime({ approvalTtlMs: 500, verifyHuman: async () => {
        verified.resolve(); return { id: 'human-a', projectId: scope.projectId, canApprove: true };
      } });
      const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'approval-lock-delay' });
      const waiting = await engine.runUntilSettled(definition, run.id); const key = await access(run.id);
      const release = await fixture.lockAggregate(key.scope, run.id);
      const operation = engine.approve({ id: run.id, nodeId: 'write', digest: waiting.steps['write']!.approval!.digest, credential: 'verified-scheduled-human' });
      // Retain a rejection handler while intentionally holding the competing database transaction.
      const observed = operation.then(value => ({ accepted: true as const, value }), (error: unknown) => ({ accepted: false as const, error }));
      try { await bounded(verified.promise); await new Promise(resolve => setTimeout(resolve, 550)); }
      finally { await release(); }
      const result = await observed; expect(result.accepted).toBe(false);
      if (!result.accepted) expect(result.error).toMatchObject({ code: 'CONFLICT' });
      expect((await engine.inspect(run.id)).steps['write']!.approval!.humanId).toBeNull(); expect(effects).toBe(0);
    });

    it('blocks missing grants before creating a job or requesting approval', async () => {
      let effects = 0; const definition = single(tool({ execute: input => { effects++; return input; } }), true);
      const engine = runtime({ permissions: { allow: ['tool:scheduled.write'] } });
      const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'permission' });
      const result = await engine.runUntilSettled(definition, run.id);
      expect(result.status).toBe('blocked'); expect(result.steps['write']!.approval).toBeNull();
      expect((await detail(run.id)).jobs).toEqual([]); expect(effects).toBe(0);
    });

    it('does not double reserve or spend when independent branches contend for one budget', async () => {
      let effects = 0; const execute = (input: { value: number }) => { effects++; return input; };
      const definition = parallel(tool({ costMicros: 6, execute }), tool({ id: 'scheduled.second', costMicros: 6, execute }));
      const engine = runtime({ maxCostMicros: 10 }); const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'budget' });
      const result = await engine.runUntilSettled(definition, run.id);
      expect(result.status).toBe('blocked'); expect(effects).toBe(1);
      expect(result.budget).toEqual({ spentMicros: 6, reservedMicros: 0, maxCostMicros: 10 });
      expect((await detail(run.id)).jobs).toHaveLength(1);
    });

    it('executes one handler when multiple workers race the same node', async () => {
      let effects = 0; const began = deferred<void>(); const release = deferred<{ value: number }>();
      const definition = single(tool({ execute: () => { effects++; began.resolve(); return release.promise; } }));
      const engines = Array.from({ length: 4 }, () => runtime());
      const run = await engines[0]!.submit(definition, { input: { value: 2 }, idempotencyKey: 'worker-race' });
      const executions = engines.map(engine => engine.runUntilSettled(definition, run.id));
      const completed = Promise.all(executions);
      // Observe a losing driver's rejection immediately, even while the test awaits handler entry.
      void completed.catch(() => {});
      try { await bounded(began.promise); }
      catch (error) {
        const observed = await detail(run.id);
        throw new Error(`Worker race did not reach dispatch: ${JSON.stringify({
          status: observed.record.state['status'], budget: {
            spent: observed.record.state['spentMicros'], reserved: observed.record.state['reservedMicros'],
          }, jobs: observed.jobs.map(job => ({ state: job.state, fence: job.fence, workerId: job.workerId, receipt: job.receipt })),
        })}`, { cause: error });
      }
      finally { release.resolve({ value: 2 }); await completed; }
      expect(effects).toBe(1); expect((await engines[0]!.runUntilSettled(definition, run.id)).status).toBe('succeeded');
    });

    it('starts independent operations concurrently and tolerates unrelated aggregate version changes', async () => {
      let started = 0; const both = deferred<void>(); const firstRelease = deferred<{ value: number }>();
      const secondRelease = deferred<{ value: number }>();
      const enter = (which: typeof firstRelease) => { if (++started === 2) both.resolve(); return which.promise; };
      const definition = parallel(tool({ execute: () => enter(firstRelease) }), tool({ id: 'scheduled.second', execute: () => enter(secondRelease) }));
      const engine = runtime({ maxConcurrentJobs: 2 }); const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'parallel-completion' });
      const execution = engine.runUntilSettled(definition, run.id);
      try { await bounded(both.promise); secondRelease.resolve({ value: 20 }); await vi.waitFor(async () => {
        expect((await engine.inspect(run.id)).steps['second']!.status).toBe('succeeded');
      }); }
      finally { firstRelease.resolve({ value: 10 }); secondRelease.resolve({ value: 20 }); await execution; }
      const result = await engine.inspect(run.id);
      expect(result.status).toBe('succeeded'); expect(result.output).toEqual([{ value: 20 }, { value: 10 }]); expect(started).toBe(2);
    });

    it('bounds concurrent local handlers without serializing the definition permanently', async () => {
      let active = 0; let maximum = 0;
      const execute = async (input: { value: number }) => {
        active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 15)); active--; return input;
      };
      const definition = parallel(tool({ execute }), tool({ id: 'scheduled.second', execute }));
      const engine = runtime({ maxConcurrentJobs: 1 }); const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'concurrency-cap' });
      expect((await engine.runUntilSettled(definition, run.id)).status).toBe('succeeded'); expect(maximum).toBe(1);
    });

    it('retains a known successful effect when output validation rejects its result', async () => {
      let effects = 0; const definition = single(tool({ output: z.object({ allowed: z.literal(true) }), execute: () => { effects++; return { SECRET: 'invalid-output' }; } }));
      const engine = runtime(); const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'invalid-output' });
      const result = await engine.runUntilSettled(definition, run.id);
      expect(['failed', 'blocked']).toContain(result.status);
      expect(result.steps['write']!.receipt).toMatchObject({ execution: 'succeeded', disclosure: 'withheld' });
      expect(result.steps['write']!.output).toBeNull(); expect(result.budget).toMatchObject({ spentMicros: 1, reservedMicros: 0 });
      expect(JSON.stringify(await engine.events(run.id))).not.toContain('SECRET');
      await engine.runUntilSettled(definition, run.id); expect(effects).toBe(1);
    });

    it('blocks disclosure but charges a successful effect when an output guard denies', async () => {
      const definition = single(tool({ guards: { output: [{ id: 'deny', check: () => ({ decision: 'block' }) }] } }));
      const engine = runtime(); const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'guard' });
      const result = await engine.runUntilSettled(definition, run.id);
      expect(result.status).toBe('blocked'); expect(result.steps['write']!.output).toBeNull();
      expect(result.steps['write']!.receipt).toMatchObject({ execution: 'succeeded', disclosure: 'withheld' });
      expect(result.budget).toMatchObject({ spentMicros: 1, reservedMicros: 0 });
    });

    it('releases prepared cost when an input guard blocks before persistent start', async () => {
      let effects = 0; const definition = single(tool({ costMicros: 3, execute: input => { effects++; return input; }, guards: { input: [{ id: 'deny-input', check: () => ({ decision: 'block' }) }] } }));
      const engine = runtime(); const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'pre-dispatch-denial' });
      const result = await engine.runUntilSettled(definition, run.id);
      expect(result.status).toBe('blocked'); expect(effects).toBe(0);
      expect(result.budget).toMatchObject({ spentMicros: 0, reservedMicros: 0 });
      expect((await detail(run.id)).jobs.every(job => job.startedAtMs === null)).toBe(true);
    });

    it('rejects oversized admitted output without losing its successful effect receipt', async () => {
      const definition = single(tool({ execute: () => ({ value: 'x'.repeat(65_536) }) }));
      const engine = runtime(); const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'output-limit' });
      const result = await engine.runUntilSettled(definition, run.id);
      expect(['failed', 'blocked']).toContain(result.status); expect(result.output).toBeNull();
      expect(result.steps['write']!.receipt).toMatchObject({ execution: 'succeeded', disclosure: 'withheld' });
      expect(result.budget).toMatchObject({ spentMicros: 1, reservedMicros: 0 });
    });

    it('cancels before preparation without a handler, resource hold or reservation', async () => {
      let effects = 0; const definition = single(tool({ execute: input => { effects++; return input; } }));
      const engine = runtime(); const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'cancel-before' });
      await engine.cancel(run.id); const result = await engine.runUntilSettled(definition, run.id);
      expect(result.status).toBe('cancelled'); expect(result.budget).toMatchObject({ spentMicros: 0, reservedMicros: 0 });
      expect((await detail(run.id)).jobs).toEqual([]); expect(effects).toBe(0);
    });

    it('records late known cost after cancellation without resurrecting output or replaying', async () => {
      let effects = 0; const began = deferred<void>(); const release = deferred<{ value: number }>();
      const definition = single(tool({ costMicros: 3, execute: () => { effects++; began.resolve(); return release.promise; } }));
      const engine = runtime({ resources: { write: ['late-resource'] } });
      const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'late' });
      const execution = engine.runUntilSettled(definition, run.id);
      try {
        await bounded(began.promise); await engine.cancel(run.id); await bounded(execution);
        const initial = await engine.inspect(run.id);
        expect(initial.status).toBe('cancelled'); expect(initial.budget).toMatchObject({ spentMicros: 0, reservedMicros: 3 });
        release.resolve({ value: 2 });
        await vi.waitFor(async () => { expect((await engine.inspect(run.id)).budget).toMatchObject({ spentMicros: 3, reservedMicros: 0 }); });
        const late = await engine.inspect(run.id);
        expect(late.status).toBe('cancelled'); expect(late.steps['write']!.output).toBeNull();
        expect(late.steps['write']!.receipt).toMatchObject({ execution: 'succeeded', disclosure: 'withheld' });
        expect(initial.budget).toMatchObject({ spentMicros: 0, reservedMicros: 3 });
        expect((await detail(run.id)).jobs[0]!.state).toBe('outcome_unknown');
        await engine.recoverExpired(run.id); await engine.runUntilSettled(definition, run.id); expect(effects).toBe(1);
      } finally { release.resolve({ value: 2 }); await execution; }
    });

    it('keeps overlapping work excluded after cancellation while independent resources progress', async () => {
      let effects = 0; const began = deferred<void>(); const release = deferred<{ value: number }>();
      const definition = single(tool({ execute: input => {
        effects++; if (input.value === 1) { began.resolve(); return release.promise; } return input;
      } }));
      const shared = runtime({ resources: { write: ['shared'] } }); const unrelated = runtime({ resources: { write: ['independent'] } });
      const a = await shared.submit(definition, { input: { value: 1 }, idempotencyKey: 'resource-owner' });
      const b = await shared.submit(definition, { input: { value: 2 }, idempotencyKey: 'resource-blocked' });
      const c = await unrelated.submit(definition, { input: { value: 3 }, idempotencyKey: 'resource-free' });
      const execution = shared.runUntilSettled(definition, a.id);
      try {
        await bounded(began.promise);
        const whileActive = await shared.runUntilSettled(definition, b.id);
        expect(whileActive.steps['write']!.status).not.toBe('succeeded'); expect(effects).toBe(1);
        await shared.cancel(a.id); await bounded(execution);
        const blocked = await shared.runUntilSettled(definition, b.id);
        expect(blocked.steps['write']!.status).not.toBe('succeeded');
        expect((await unrelated.runUntilSettled(definition, c.id)).status).toBe('succeeded'); expect(effects).toBe(2);
        release.resolve({ value: 1 });
        await vi.waitFor(async () => { expect((await shared.inspect(a.id)).budget.spentMicros).toBe(1); });
        await shared.runUntilSettled(definition, b.id); expect(effects).toBe(2);
      } finally { release.resolve({ value: 1 }); await execution; }
    });

    it('recovers a lost preparation acknowledgement without duplicating job or reserved cost', async () => {
      let failed = false; const backing = store.workflows;
      const fault = wrapped({ prepare: async command => {
        const result = await backing.prepare(command);
        if (!failed) { failed = true; throw new StorageError('STORAGE_UNAVAILABLE', 'SECRET lost prepare acknowledgement'); }
        return result;
      } });
      let effects = 0; const definition = single(tool({ costMicros: 3, execute: input => { effects++; return input; } }));
      const old = runtime({ store: fault }); const run = await old.submit(definition, { input: { value: 2 }, idempotencyKey: 'lost-prepare' });
      await Promise.allSettled([old.runUntilSettled(definition, run.id)]); await old.close();
      const current = runtime(); const result = await current.runUntilSettled(definition, run.id);
      expect(result.status).toBe('succeeded'); expect(effects).toBe(1);
      expect(result.budget).toMatchObject({ spentMicros: 3, reservedMicros: 0 }); expect((await detail(run.id)).jobs).toHaveLength(1);
    });

    it('never dispatches again after a persistent start acknowledgement is lost', async () => {
      let failed = false; const backing = store.workflows;
      const fault = wrapped({ start: async command => {
        const result = await backing.start(command);
        if (!failed && result.status === 'started') { failed = true; throw new StorageError('STORAGE_UNAVAILABLE', 'SECRET lost start acknowledgement'); }
        return result;
      } });
      let effects = 0; const definition = single(tool({ execute: input => { effects++; return input; } }));
      const old = runtime({ store: fault, leaseMs: 1_000 }); const run = await old.submit(definition, { input: { value: 2 }, idempotencyKey: 'lost-start' });
      await Promise.allSettled([old.runUntilSettled(definition, run.id)]); await old.close();
      const current = runtime(); await current.runUntilSettled(definition, run.id);
      await new Promise(resolve => setTimeout(resolve, 1_050)); await current.recoverExpired(run.id);
      await current.runUntilSettled(definition, run.id);
      expect(failed).toBe(true); expect(effects).toBe(0);
      const jobs = (await detail(run.id)).jobs;
      expect(jobs).toHaveLength(1); expect(jobs[0]!.startedAtMs).not.toBeNull(); expect(jobs[0]!.output).toBeNull();
    });

    it('retains committed completion after a lost acknowledgement without repeating the handler', async () => {
      let failed = false; const backing = store.workflows;
      const fault = wrapped({ complete: async command => {
        const result = await backing.complete(command);
        if (!failed) { failed = true; throw new StorageError('STORAGE_UNAVAILABLE', 'SECRET lost complete acknowledgement'); }
        return result;
      } });
      let effects = 0; const definition = single(tool({ execute: input => { effects++; return input; } }));
      const old = runtime({ store: fault }); const run = await old.submit(definition, { input: { value: 2 }, idempotencyKey: 'lost-complete' });
      await Promise.allSettled([old.runUntilSettled(definition, run.id)]); await old.close();
      const current = runtime(); const result = await current.runUntilSettled(definition, run.id);
      expect(result.status).toBe('succeeded'); expect(effects).toBe(1);
      expect(result.budget).toMatchObject({ spentMicros: 1, reservedMicros: 0 });
    });

    it('reclaims an expired never-started lease without reserving its cost again', async () => {
      const leased = deferred<void>(); const continueOld = deferred<void>(); const backing = store.workflows;
      let held = false;
      const fault = wrapped({ claim: async command => {
        // Deliver only the original delayed claim to this worker. A fresh fenced
        // claim belongs to the replacement worker below, not another old-worker wave.
        if (held) return [];
        const result = await backing.claim(command);
        if (!held && result.length) { held = true; leased.resolve(); await continueOld.promise; }
        return result;
      } });
      let effects = 0; const definition = single(tool({ costMicros: 3, execute: input => { effects++; return input; } }));
      const old = runtime({ store: fault, leaseMs: 1_000 }); const run = await old.submit(definition, { input: { value: 2 }, idempotencyKey: 'pre-start-expiry' });
      const execution = old.runUntilSettled(definition, run.id);
      try {
        await bounded(leased.promise); const before = await detail(run.id);
        expect(before.jobs[0]!.state).toBe('leased'); expect(before.jobs[0]!.startedAtMs).toBeNull();
        await new Promise(resolve => setTimeout(resolve, 1_050)); const current = runtime();
        await current.recoverExpired(run.id);
        expect((await current.inspect(run.id)).budget).toMatchObject({ spentMicros: 0, reservedMicros: 3 });
        continueOld.resolve(); await Promise.allSettled([execution]);
        expect(effects).toBe(0); // The expired original claim cannot dispatch before a fresh worker claim.
        const result = await current.runUntilSettled(definition, run.id);
        expect(result.status).toBe('succeeded'); expect(result.budget).toMatchObject({ spentMicros: 3, reservedMicros: 0 });
        expect(effects).toBe(1); const after = await detail(run.id);
        expect(after.jobs).toHaveLength(1); expect(after.jobs[0]!.fence).toBeGreaterThan(before.jobs[0]!.fence);
      } finally { continueOld.resolve(); await Promise.allSettled([execution]); }
    });

    it('blocks a candidate whose approval expires after preparation instead of minting another job', async () => {
      const backing = store.workflows; let paused = false;
      const fault = wrapped({ prepare: async command => {
        const result = await backing.prepare(command);
        if (!paused) { paused = true; await new Promise(resolve => setTimeout(resolve, 550)); }
        return result;
      } });
      let effects = 0; const definition = single(tool({ costMicros: 3, execute: input => { effects++; return input; } }), true);
      const engine = runtime({ store: fault, approvalTtlMs: 500 });
      const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'prepared-expired-review' });
      const waiting = await engine.runUntilSettled(definition, run.id);
      await engine.approve({ id: run.id, nodeId: 'write', digest: waiting.steps['write']!.approval!.digest, credential: 'verified-scheduled-human' });
      const result = await engine.runUntilSettled(definition, run.id);
      expect(result.status).toBe('blocked'); expect(effects).toBe(0);
      expect(result.budget).toMatchObject({ spentMicros: 0, reservedMicros: 0 });
      const jobs = (await detail(run.id)).jobs; expect(jobs).toHaveLength(1); expect(jobs[0]!.startedAtMs).toBeNull();
      await engine.runUntilSettled(definition, run.id); expect((await detail(run.id)).jobs).toHaveLength(1); expect(effects).toBe(0);
    });

    it('renews a live long-running handler and does not replay it after one lease interval', async () => {
      let effects = 0;
      const definition = single(tool({ execute: async input => { effects++; await new Promise(resolve => setTimeout(resolve, 1_300)); return input; } }));
      const engine = runtime({ leaseMs: 1_000 }); const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'renewal' });
      const result = await engine.runUntilSettled(definition, run.id);
      expect(result.status).toBe('succeeded'); expect(effects).toBe(1); expect((await detail(run.id)).jobs[0]!.fence).toBe(1);
    });

    it('does not retry completion after receipt persistence observes an expired started lease', async () => {
      let effects = 0; let completions = 0; let delayed = false;
      const definition = single(tool({ execute: input => { effects++; return input; } }));
      const engine = runtime({ leaseMs: 1_000, store: wrapped({
        async recordReceipt(command) {
          if (!delayed && command.receipt.execution === 'succeeded') {
            delayed = true;
            const unlock = await fixture.lockAggregate(command.scope, command.id);
            // The real SQL receipt and heartbeat both wait for this lock. Whichever
            // wakes first must observe the already expired storage-clock lease.
            const release = setTimeout(() => { void unlock(); }, 1_200);
            try { return await store.workflows.recordReceipt(command); }
            finally { clearTimeout(release); await unlock(); }
          }
          return store.workflows.recordReceipt(command);
        },
        async complete(command) { completions++; return store.workflows.complete(command); },
      }) });
      const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'expired-receipt-completion' });
      const result = await engine.runUntilSettled(definition, run.id);
      expect(result.status).toBe('outcome_unknown');
      expect(result.steps['write']!.receipt).toMatchObject({ execution: 'succeeded', disclosure: 'withheld' });
      expect(result.budget).toMatchObject({ spentMicros: 1, reservedMicros: 0 });
      expect(completions).toBe(0); expect(effects).toBe(1);
      expect((await engine.runUntilSettled(definition, run.id)).status).toBe('outcome_unknown');
      expect(effects).toBe(1);
    });

    it('does not retry completion when cancellation commits during known receipt persistence', async () => {
      let effects = 0; let completions = 0; let cancelled = false;
      const definition = single(tool({ execute: input => { effects++; return input; } }));
      const engine = runtime({ store: wrapped({
        async recordReceipt(command) {
          if (!cancelled && command.receipt.execution === 'succeeded') {
            cancelled = true;
            const key = { scope: command.scope, id: command.id, policyHash: command.policyHash };
            const current = await store.workflows.inspect(key);
            await store.workflows.cancel({ ...key, commandId: 'cancel-during-receipt', expectedVersion: current.record.version });
          }
          return store.workflows.recordReceipt(command);
        },
        async complete(command) { completions++; return store.workflows.complete(command); },
      }) });
      const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'cancelled-receipt-completion' });
      const result = await engine.runUntilSettled(definition, run.id);
      expect(result.status).toBe('cancelled');
      expect(result.steps['write']!.receipt).toMatchObject({ execution: 'succeeded', disclosure: 'withheld' });
      expect(result.budget).toMatchObject({ spentMicros: 1, reservedMicros: 0 });
      expect(completions).toBe(0); expect(effects).toBe(1);
    });

    it('drains an in-flight heartbeat before attempting the completed handler CAS', async () => {
      const renewing = deferred<void>(); const finalReceipt = deferred<void>(); const releaseRenewal = deferred<void>();
      let effects = 0; let completions = 0; let receipts = 0; let renewalSettled = false;
      const definition = single(tool({ execute: async input => { effects++; await renewing.promise; return input; } }));
      const engine = runtime({ leaseMs: 1_000, store: wrapped({
        async renew(command) {
          renewing.resolve(); await releaseRenewal.promise;
          const claim = await store.workflows.renew(command); renewalSettled = true; return claim;
        },
        async recordReceipt(command) {
          const result = await store.workflows.recordReceipt(command);
          if (++receipts === 2) finalReceipt.resolve();
          return result;
        },
        async complete(command) {
          completions++;
          expect(renewalSettled).toBe(true);
          return store.workflows.complete(command);
        },
      }) });
      const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'drained-renewal-completion' });
      const execution = engine.runUntilSettled(definition, run.id);
      // Attach a handler immediately; an old runtime can reject before the barrier assertion.
      void execution.catch(() => {});
      try {
        await bounded(finalReceipt.promise);
        await new Promise(resolve => setTimeout(resolve, 75));
        expect(completions).toBe(0);
      } finally { releaseRenewal.resolve(); }
      expect((await execution).status).toBe('succeeded');
      expect(completions).toBe(1); expect(effects).toBe(1);
    });

    it.each(['profile', 'aggregate-version', 'unknown-field'] as const)('fails closed on %s ownership corruption', async mutation => {
      let effects = 0; const definition = single(tool({ execute: input => { effects++; return input; } }));
      const engine = runtime(); const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'corrupt-owner' });
      const key = await access(run.id); const table = `${fixture.prefix}mayura_workflow_owners`;
      if (mutation === 'aggregate-version') {
        await fixture.query(`UPDATE ${table} SET aggregate_version = aggregate_version + 1 WHERE scope = ? AND aggregate_id = ?`, [key.scope, run.id]);
      } else {
        const rows = await fixture.query(`SELECT data FROM ${table} WHERE scope = ? AND aggregate_id = ?`, [key.scope, run.id]);
        const data = JSON.parse(rows[0]!['data'] as string) as JsonObject;
        if (mutation === 'profile') data['format'] = 999; else data['SECRET_unrecognized_field'] = 'not-public';
        await fixture.query(`UPDATE ${table} SET data = ? WHERE scope = ? AND aggregate_id = ?`, [JSON.stringify(data), key.scope, run.id]);
      }
      await expect(engine.inspect(run.id)).rejects.toBeDefined();
      await expect(engine.runUntilSettled(definition, run.id)).rejects.toBeDefined(); expect(effects).toBe(0);
    });

    it('fails closed when a prepared node loses its ownership/job link', async () => {
      const backing = store.workflows; let injected = false;
      const fault = wrapped({ prepare: async command => {
        const result = await backing.prepare(command);
        if (!injected) {
          injected = true;
          await fixture.query(`DELETE FROM ${fixture.prefix}mayura_workflow_jobs WHERE scope = ? AND aggregate_id = ? AND node_id = ?`, [command.scope, command.id, command.nodeId]);
        }
        return result;
      } });
      let effects = 0; const definition = single(tool({ execute: input => { effects++; return input; } }));
      const engine = runtime({ store: fault }); const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'corrupt-link' });
      await expect(engine.runUntilSettled(definition, run.id)).rejects.toBeDefined(); expect(effects).toBe(0);
      await expect(engine.inspect(run.id)).rejects.toBeDefined();
    });

    it('rejects structurally valid spending that has no matching persisted execution evidence', async () => {
      const definition = single(tool()); const engine = runtime();
      const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'forged-spend' });
      await engine.runUntilSettled(definition, run.id);
      const key = await access(run.id); const record = await store.read(key.scope, run.id);
      const state = structuredClone(record!.state); state['spentMicros'] = 2;
      await fixture.query(`UPDATE ${fixture.prefix}mayura_aggregates SET state = ? WHERE scope = ? AND id = ?`, [JSON.stringify(state), key.scope, run.id]);
      await expect(engine.inspect(run.id)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    });

    it('rejects a structurally valid dispatch receipt without any owned job attempt', async () => {
      let effects = 0; const definition = single(tool({ costMicros: 0, execute: input => { effects++; return input; } }));
      const engine = runtime(); const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'phantom-attempt' });
      const key = await access(run.id); const record = await store.read(key.scope, run.id);
      const state = structuredClone(record!.state); const step = (state['steps'] as JsonObject)['write'] as JsonObject;
      step['status'] = 'dispatching'; step['candidateHash'] = 'a'.repeat(64);
      step['receipt'] = { callId: `${run.id}/step:write`, toolId: 'scheduled.write', execution: 'succeeded', disclosure: 'withheld' };
      await fixture.query(`UPDATE ${fixture.prefix}mayura_aggregates SET state = ? WHERE scope = ? AND id = ?`, [JSON.stringify(state), key.scope, run.id]);
      await expect(engine.inspect(run.id)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
      await expect(engine.runUntilSettled(definition, run.id)).rejects.toBeDefined(); expect(effects).toBe(0);
    });

    it('blocks all standalone scheduler mutation paths into an enrolled job', async () => {
      const prepared = deferred<void>(); const continueClaim = deferred<void>(); const backing = store.workflows;
      const fault = wrapped({ claim: async command => { prepared.resolve(); await continueClaim.promise; return backing.claim(command); } });
      let effects = 0; const definition = single(tool({ execute: input => { effects++; return input; } }));
      const engine = runtime({ store: fault }); const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'standalone-bypass' });
      const execution = engine.runUntilSettled(definition, run.id);
      try {
        await bounded(prepared.promise); const saved = await detail(run.id); const job = saved.jobs[0]!;
        await store.scheduler.initialize();
        expect(await store.scheduler.claim({ scope: job.scope, workerId: 'rogue', limit: 1, leaseMs: 1_000 })).toEqual([]);
        await expect(store.scheduler.cancel({ scope: job.scope, jobId: job.jobId, commandId: 'rogue-cancel' })).rejects.toMatchObject({ code: 'SCHEDULED_WRITER_REQUIRED' });
        await expect(store.scheduler.reserve({ scope: job.scope, jobId: 'rogue-job', reservationKey: 'rogue-reservation', runId: run.id, nodeId: 'rogue', invocationId: 'rogue-invocation', definitionHash: job.definitionHash, candidateHash: job.candidateHash, intent: { toolId: 'scheduled.write', callId: 'rogue-call' }, resourceKeys: [], delayMs: 0 })).rejects.toMatchObject({ code: 'SCHEDULED_WRITER_REQUIRED' });
        expect((await detail(run.id)).jobs).toEqual(saved.jobs); expect(effects).toBe(0);
      } finally { continueClaim.resolve(); await execution; }
    });

    it('denies standalone start, renew, receipt and completion even with the live job token', async () => {
      const began = deferred<void>(); const release = deferred<{ value: number }>();
      const definition = single(tool({ execute: () => { began.resolve(); return release.promise; } }));
      const engine = runtime(); const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'live-token-bypass' });
      const execution = engine.runUntilSettled(definition, run.id);
      try {
        await bounded(began.promise); await store.scheduler.initialize();
        const job = (await detail(run.id)).jobs[0]!;
        const claim = { scope: job.scope, jobId: job.jobId, workerId: job.workerId!, fence: job.fence, leaseUntilMs: job.leaseUntilMs! };
        for (const operation of [
          () => store.scheduler.start({ claim, candidateHash: job.candidateHash }),
          () => store.scheduler.renew({ claim, leaseMs: 1_000 }),
          () => store.scheduler.recordReceipt({ scope: job.scope, jobId: job.jobId, fence: job.fence, evidenceId: 'rogue-evidence', receipt: { callId: `${run.id}/step:write`, toolId: 'scheduled.write', execution: 'succeeded', disclosure: 'withheld' } }),
          () => store.scheduler.complete({ claim, commandId: 'rogue-complete', evidenceId: 'rogue-evidence', outcome: 'succeeded', output: { value: 99 } }),
        ]) await expect(operation()).rejects.toMatchObject({ code: 'SCHEDULED_WRITER_REQUIRED' });
        expect((await engine.inspect(run.id)).steps['write']!.output).toBeNull();
      } finally { release.resolve({ value: 2 }); await execution; }
      expect((await engine.inspect(run.id)).status).toBe('succeeded');
    });

    it('closes a worker promptly while retaining late evidence without cancelling the shared run', async () => {
      const began = deferred<void>(); const release = deferred<{ value: number }>();
      const definition = single(tool({ costMicros: 3, execute: () => { began.resolve(); return release.promise; } }));
      const engine = runtime(); const other = runtime();
      const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'worker-close' });
      const execution = engine.runUntilSettled(definition, run.id);
      try {
        await bounded(began.promise); await bounded(engine.close()); await Promise.allSettled([execution]);
        expect((await other.inspect(run.id)).status).not.toBe('cancelled');
        release.resolve({ value: 2 });
        await vi.waitFor(async () => { expect((await other.inspect(run.id)).budget).toMatchObject({ spentMicros: 3, reservedMicros: 0 }); });
        expect((await other.inspect(run.id)).steps['write']!.output).toBeNull();
      } finally { release.resolve({ value: 2 }); await Promise.allSettled([execution]); }
    });

    it.each(['start', 'receipt', 'complete'] as const)('survives real process termination after %s commit without replay', async stage => {
      const { store: _store, verifyHuman: _verifier, ...policy } = base();
      const config = { stage, backend: fixture.childConfig, options: { ...policy, resources: { write: ['crash-resource'] } } };
      const child = fork(fileURLToPath(new URL('./fixtures/scheduled-crash.mjs', import.meta.url)), [JSON.stringify(config)], {
        execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      let exited = false;
      const exit = new Promise<void>(resolve => { child.once('exit', () => { exited = true; resolve(); }); });
      const marker = new Promise<{ runId: string; effects: number }>((resolve, reject) => {
        child.once('error', reject);
        child.on('message', (message: { kind?: string; runId?: string; effects?: number; phase?: unknown; status?: unknown; code?: unknown }) => {
          if (message.kind === 'checkpoint' && typeof message.runId === 'string' && typeof message.effects === 'number') resolve({ runId: message.runId, effects: message.effects });
          else {
            // Do not reflect arbitrary IPC fields or child exception messages into test output.
            const codes = ['INVALID_CONFIG', 'INVALID_INPUT', 'INVALID_OUTPUT', 'INVALID_JSON', 'PERMISSION_DENIED',
              'BUDGET_EXCEEDED', 'LIMIT_EXCEEDED', 'CANCELLED', 'TIMEOUT', 'TOOL_FAILED', 'MODEL_FAILED', 'GUARD_BLOCKED',
              'GUARD_UNAVAILABLE', 'OUTCOME_UNKNOWN', 'UNSUPPORTED_PROFILE', 'NOT_FOUND', 'CONFLICT', 'STORAGE_UNAVAILABLE',
              'STORE_CLOSED', 'STORE_NOT_INITIALIZED', 'QUEUE_FULL', 'STALE_CLAIM', 'SCHEDULED_WRITER_REQUIRED'];
            const diagnostic = {
              stage,
              phase: typeof message.phase === 'string' && ['initialize', 'submit', 'drive', 'drive-returned'].includes(message.phase) ? message.phase : 'unknown',
              status: typeof message.status === 'string' && ['running', 'waiting', 'succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown'].includes(message.status) ? message.status : null,
              code: typeof message.code === 'string' && codes.includes(message.code) ? message.code : 'UNKNOWN',
              effects: typeof message.effects === 'number' && Number.isSafeInteger(message.effects) && message.effects >= 0 && message.effects <= 128 ? message.effects : null,
            };
            reject(new Error(`Owned scheduled process failed before its checkpoint: ${JSON.stringify(diagnostic)}.`));
          }
        });
        child.once('exit', () => { reject(new Error('Owned scheduled process exited before its checkpoint.')); });
      });
      try {
        const checkpoint = await bounded(marker, 8_000);
        expect(checkpoint.effects).toBe(stage === 'start' ? 0 : 1);
        child.kill('SIGKILL'); await bounded(exit);
        // Wait for the last committed renewal to expire; local process time is not an admission override.
        await new Promise(resolve => setTimeout(resolve, 1_050));
        let replayed = 0;
        const definition = single(tool({ costMicros: 3, execute: input => { replayed++; return input; } }));
        const engine = runtime({ resources: { write: ['crash-resource'] } });
        await engine.recoverExpired(checkpoint.runId);
        const result = await engine.runUntilSettled(definition, checkpoint.runId);
        await engine.runUntilSettled(definition, checkpoint.runId); expect(replayed).toBe(0);
        if (stage === 'complete') {
          expect(result.status).toBe('succeeded'); expect(result.output).toEqual({ value: 2 });
          expect(result.steps['write']!.receipt).toMatchObject({ execution: 'succeeded', disclosure: 'released' });
        } else {
          expect(['outcome_unknown', 'blocked']).toContain(result.status); expect(result.output).toBeNull();
          expect(result.steps['write']!.output).toBeNull();
          expect((await detail(checkpoint.runId)).jobs[0]!.state).toBe('outcome_unknown');
          if (stage === 'receipt') expect(result.steps['write']!.receipt).toMatchObject({ execution: 'succeeded', disclosure: 'withheld' });
        }
        expect(result.budget).toMatchObject(stage === 'start' ? { spentMicros: 0, reservedMicros: 3 } : { spentMicros: 3, reservedMicros: 0 });
      } finally {
        // Only the child created above is terminated; no process enumeration or unrelated PID is used.
        if (!exited) child.kill('SIGKILL'); await bounded(exit);
      }
    }, 15_000);

    it('keeps a new scheduled submission unavailable to legacy dispatch before ownership exists', async () => {
      let effects = 0; const definition = single(tool({ execute: input => { effects++; return input; } }));
      const engine = runtime(); const legacy = createWorkflowRuntime(base());
      try {
        const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'new-owned' });
        await expect(legacy.runUntilSettled(definition, run.id)).rejects.toBeDefined(); expect(effects).toBe(0);
        expect((await detail(run.id)).profile).toBe('scheduled-v1');
      } finally { legacy.close(); }
    });

    it('fails a final-output schema without erasing successful step evidence', async () => {
      const action = tool(); const definition = defineWorkflow({
        id: 'final-schema', version: '1', input: inputSchema, output: z.literal('expected'),
        nodes: [{ kind: 'tool', id: 'write', tool: action, input: { kind: 'input', path: [] } }],
        result: { kind: 'step', stepId: 'write', path: [] },
      });
      const engine = runtime(); const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'final-schema' });
      const result = await engine.runUntilSettled(definition, run.id);
      expect(result.status).toBe('failed'); expect(result.output).toBeNull();
      expect(result.steps['write']!.receipt).toMatchObject({ execution: 'succeeded', disclosure: 'released' });
      expect(result.budget).toMatchObject({ spentMicros: 1, reservedMicros: 0 });
    });

    it('rejects an unsupported adapter instead of falling back to conservative writes', () => {
      const { workflows: _unsupported, ...aggregateOnly } = store;
      expect(() => runtime({ store: aggregateOnly as ScheduledWorkflowAggregateStore })).toThrow();
    });
  });
}
