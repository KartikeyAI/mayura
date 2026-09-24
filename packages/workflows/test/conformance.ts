import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, type AnyTool } from '@mayura/tools';
import { createWorkflowRuntime, defineWorkflow, type WorkflowRuntimeOptions, type WorkflowNode } from '@mayura/workflows';
import { StorageError, type AggregateStore, type CreateRecord } from '@mayura/storage';
import type { ExecutionContext, Guard, JsonObject } from '@mayura/core';
import type { WorkflowFixture } from './fixtures.js';

type Runtime = ReturnType<typeof createWorkflowRuntime>;
const numberInput = z.object({ value: z.number() });

function tool(options: {
  id?: string; execute?: (input: { value: number }, context: ExecutionContext) => unknown;
  costMicros?: number; guards?: { readonly output: readonly Guard[] }; output?: z.ZodType;
} = {}) {
  return defineTool({
    id: options.id ?? 'fixture.write', version: '1', description: 'Controlled test effect',
    input: numberInput, output: options.output ?? z.unknown(), effects: 'write', capabilities: [],
    costMicros: options.costMicros ?? 1, timeoutMs: 5_000,
    execute: options.execute ?? ((input) => ({ value: input.value * 2 })),
    ...(options.guards ? { guards: options.guards } : {}),
  });
}

function single(definition: AnyTool, approval = false) {
  return defineWorkflow({
    id: 'fixture.workflow', version: '1', input: numberInput, output: z.unknown(),
    nodes: [{ kind: 'tool', id: 'write', tool: definition, input: { kind: 'input', path: [] }, approval }],
    result: { kind: 'step', stepId: 'write', path: [] },
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

export function workflowConformance(name: string, factory: () => Promise<WorkflowFixture>): void {
  describe(`${name} durable workflows`, () => {
    let fixture: WorkflowFixture;
    let store: AggregateStore;
    let runtimes: Runtime[];
    const runtime = (overrides: Partial<WorkflowRuntimeOptions> = {}): Runtime => {
      const instance = createWorkflowRuntime({
        store, scope: { principalId: 'developer', projectId: 'project-a' },
        permissions: { allow: ['tool:fixture.write', 'tool:fixture.second', 'effect:write'] },
        policyVersion: 'policy-1', maxCostMicros: 10,
        verifyHuman: async credential => {
          if (credential !== 'verified-human') throw new Error('Untrusted identity.');
          return { id: 'human-a', projectId: 'project-a', canApprove: true };
        },
        ...overrides,
      });
      runtimes.push(instance);
      return instance;
    };
    beforeEach(async () => { fixture = await factory(); store = fixture.store; runtimes = []; await store.initialize(); });
    afterEach(async () => {
      for (const instance of runtimes ?? []) instance.close();
      await store?.close(); await fixture?.cleanup();
    });

    it('executes two independent branches and joins outputs in declared order', async () => {
      const invoked: string[] = [];
      const first = tool({ execute: input => { invoked.push('first'); return { value: input.value + 1 }; } });
      const second = tool({ id: 'fixture.second', execute: input => { invoked.push('second'); return { value: input.value + 2 }; } });
      const definition = defineWorkflow({
        id: 'parallel', version: '1', input: numberInput, output: z.array(numberInput),
        nodes: [
          { kind: 'tool', id: 'first', tool: first, input: { kind: 'input', path: [] } },
          { kind: 'tool', id: 'second', tool: second, input: { kind: 'input', path: [] } },
          { kind: 'join', id: 'joined', dependsOn: ['second', 'first'] },
        ], result: { kind: 'step', stepId: 'joined', path: [] },
      });
      const engine = runtime();
      const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'parallel' });
      const completed = await engine.runUntilSettled(definition, run.id);
      expect(completed.status).toBe('succeeded');
      expect(completed.output).toEqual([{ value: 4 }, { value: 3 }]);
      expect(invoked.sort()).toEqual(['first', 'second']);
      expect(completed.budget).toEqual({ spentMicros: 2, reservedMicros: 0, maxCostMicros: 10 });
      const events = await engine.events(run.id);
      expect(events.map(event => event.sequence)).toEqual(events.map((_event, index) => index + 1));
      const beforeInspection = invoked.length;
      await engine.inspect(run.id); await engine.events(run.id);
      expect(invoked).toHaveLength(beforeInspection);
    });

    it('resolves an admitted predecessor output binding before dependent execution', async () => {
      const first = tool({ execute: input => ({ value: input.value + 1 }) });
      const second = tool({ id: 'fixture.second', execute: input => ({ value: input.value * 10 }) });
      const definition = defineWorkflow({
        id: 'sequence', version: '1', input: numberInput, output: numberInput,
        nodes: [
          { kind: 'tool', id: 'first', tool: first, input: { kind: 'input', path: [] } },
          { kind: 'tool', id: 'second', tool: second, dependsOn: ['first'], input: { kind: 'step', stepId: 'first', path: [] } },
        ], result: { kind: 'step', stepId: 'second', path: [] },
      });
      const engine = runtime(); const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'sequence' });
      expect((await engine.runUntilSettled(definition, run.id)).output).toEqual({ value: 30 });
    });

    it('starts independent branch handlers before either branch must finish', async () => {
      let started = 0; const bothStarted = deferred<void>(); const release = deferred<{ value: number }>();
      const execute = async () => { started++; if (started === 2) bothStarted.resolve(); return release.promise; };
      const first = tool({ execute }); const second = tool({ id: 'fixture.second', execute });
      const definition = defineWorkflow({
        id: 'actual-parallel', version: '1', input: numberInput, output: z.unknown(),
        nodes: [
          { kind: 'tool', id: 'first', tool: first, input: { kind: 'input', path: [] } },
          { kind: 'tool', id: 'second', tool: second, input: { kind: 'input', path: [] } },
          { kind: 'join', id: 'all', dependsOn: ['first', 'second'] },
        ], result: { kind: 'step', stepId: 'all', path: [] },
      });
      const engine = runtime(); const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'actual-parallel' });
      const execution = engine.runUntilSettled(definition, run.id);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const concurrent = await Promise.race([
          bothStarted.promise.then(() => true),
          new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1_000); }),
        ]);
        expect(concurrent).toBe(true);
      } finally {
        if (timer) clearTimeout(timer);
        release.resolve({ value: 2 }); await execution;
      }
      expect((await engine.inspect(run.id)).status).toBe('succeeded');
    });

    it('persists a human approval across a new store and runtime without dispatching early', async () => {
      let effects = 0; const definition = single(tool({ execute: input => { effects++; return input; } }), true);
      const first = runtime(); const run = await first.submit(definition, { input: { value: 2 }, idempotencyKey: 'approval' });
      const waiting = await first.runUntilSettled(definition, run.id);
      expect(waiting.status).toBe('waiting'); expect(effects).toBe(0);
      const approvalDigest = waiting.steps['write']?.approval?.digest;
      expect(approvalDigest).toBeTypeOf('string');
      first.close(); await store.close(); store = fixture.reopen(); await store.initialize();
      const second = runtime();
      expect((await second.inspect(run.id)).steps['write']?.approval?.digest).toBe(approvalDigest);
      await second.approve({ id: run.id, nodeId: 'write', digest: approvalDigest!, credential: 'verified-human' });
      const completed = await second.runUntilSettled(definition, run.id);
      expect(completed.status).toBe('succeeded'); expect(effects).toBe(1);
      expect(completed.steps['write']?.approval?.humanId).toBe('human-a');
    });

    it('persists a quiescent operator pause across restart before resuming execution', async () => {
      let effects = 0; const definition = single(tool({ execute: input => { effects++; return input; } }));
      const first = runtime(); const run = await first.submit(definition, { input: { value: 2 }, idempotencyKey: 'operator-pause' });
      expect((await first.pause(run.id)).status).toBe('paused');
      expect((await first.pause(run.id)).status).toBe('paused');
      first.close(); await store.close(); store = fixture.reopen(); await store.initialize();
      const second = runtime(); expect((await second.inspect(run.id)).status).toBe('paused');
      expect((await second.runUntilSettled(definition, run.id)).status).toBe('paused'); expect(effects).toBe(0);
      expect((await second.resume(run.id)).status).toBe('running');
      expect((await second.runUntilSettled(definition, run.id)).status).toBe('succeeded'); expect(effects).toBe(1);
      expect((await second.events(run.id)).map(event => event.type)).toEqual(expect.arrayContaining(['run.paused', 'run.resumed']));
    });

    it('resumes an unresolved approval back to waiting without bypassing it', async () => {
      let effects = 0; const definition = single(tool({ execute: input => { effects++; return input; } }), true);
      const engine = runtime(); const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'paused-approval' });
      const waiting = await engine.runUntilSettled(definition, run.id); const approvalDigest = waiting.steps['write']!.approval!.digest;
      expect((await engine.pause(run.id)).status).toBe('paused');
      expect((await engine.resume(run.id)).status).toBe('waiting');
      expect((await engine.runUntilSettled(definition, run.id)).status).toBe('waiting'); expect(effects).toBe(0);
      await engine.pause(run.id); expect((await engine.approve({ id: run.id, nodeId: 'write', digest: approvalDigest,
        credential: 'verified-human' })).status).toBe('paused');
      expect((await engine.resume(run.id)).status).toBe('running');
      expect((await engine.runUntilSettled(definition, run.id)).status).toBe('succeeded'); expect(effects).toBe(1);
    });

    it('rejects a quiescent pause while an external effect is in flight', async () => {
      const started = deferred<void>(); const release = deferred<{ value: number }>();
      const definition = single(tool({ execute: async () => { started.resolve(); return release.promise; } }));
      const engine = runtime(); const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'pause-in-flight' });
      const execution = engine.runUntilSettled(definition, run.id); await started.promise;
      await expect(engine.pause(run.id)).rejects.toMatchObject({ code: 'CONFLICT' });
      release.resolve({ value: 2 }); expect((await execution).status).toBe('succeeded');
    });

    it('rejects unverified identities, wrong-project humans and mismatched approval digests', async () => {
      let effects = 0; const definition = single(tool({ execute: input => { effects++; return input; } }), true);
      const engine = runtime(); const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'denied-approval' });
      const waiting = await engine.runUntilSettled(definition, run.id); const approvalDigest = waiting.steps['write']!.approval!.digest;
      await expect(engine.approve({ id: run.id, nodeId: 'write', digest: approvalDigest, credential: { human: true } })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      await expect(engine.approve({ id: run.id, nodeId: 'write', digest: 'a'.repeat(64), credential: 'verified-human' })).rejects.toMatchObject({ code: 'CONFLICT' });
      const wrongProject = runtime({ verifyHuman: async () => ({ id: 'human-b', projectId: 'project-b', canApprove: true }) });
      await expect(wrongProject.approve({ id: run.id, nodeId: 'write', digest: approvalDigest, credential: 'anything' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      expect(effects).toBe(0); expect((await engine.inspect(run.id)).status).toBe('waiting');
    });

    it('rejects old review after policy changes without executing the tool', async () => {
      let effects = 0; const definition = single(tool({ execute: input => { effects++; return input; } }), true);
      const old = runtime(); const run = await old.submit(definition, { input: { value: 2 }, idempotencyKey: 'policy' });
      const waiting = await old.runUntilSettled(definition, run.id);
      const changed = runtime({ policyVersion: 'policy-2' });
      await expect(changed.approve({ id: run.id, nodeId: 'write', digest: waiting.steps['write']!.approval!.digest, credential: 'verified-human' })).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(changed.runUntilSettled(definition, run.id)).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(effects).toBe(0);
    });

    it('binds approval digests to their exact run instead of reusing identical-argument review', async () => {
      let effects = 0; const definition = single(tool({ execute: input => { effects++; return input; } }), true);
      const engine = runtime();
      const first = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'approval-a' });
      const second = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'approval-b' });
      const [a, b] = await Promise.all([engine.runUntilSettled(definition, first.id), engine.runUntilSettled(definition, second.id)]);
      const firstDigest = a.steps['write']!.approval!.digest; const secondDigest = b.steps['write']!.approval!.digest;
      expect(firstDigest).not.toBe(secondDigest);
      await expect(engine.approve({ id: second.id, nodeId: 'write', digest: firstDigest, credential: 'verified-human' })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(effects).toBe(0);
    });

    it('rejects expired approval without authorizing a new effect', async () => {
      let effects = 0; const definition = single(tool({ execute: input => { effects++; return input; } }), true);
      const engine = runtime({ approvalTtlMs: 1 });
      const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'expired' });
      const waiting = await engine.runUntilSettled(definition, run.id);
      await new Promise(resolve => setTimeout(resolve, 5));
      await expect(engine.approve({ id: run.id, nodeId: 'write', digest: waiting.steps['write']!.approval!.digest, credential: 'verified-human' })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(effects).toBe(0);
    });

    it('blocks a missing effect grant before requesting approval or executing', async () => {
      let effects = 0; const definition = single(tool({ execute: input => { effects++; return input; } }), true);
      const engine = runtime({ permissions: { allow: ['tool:fixture.write'] } });
      const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'permission' });
      const result = await engine.runUntilSettled(definition, run.id);
      expect(result.status).toBe('blocked'); expect(result.steps['write']?.approval).toBeNull(); expect(effects).toBe(0);
    });

    it('deduplicates identical scoped submissions even after successful execution', async () => {
      let effects = 0; const definition = single(tool({ execute: input => { effects++; return input; } }));
      const engine = runtime(); const command = { input: { value: 2 }, idempotencyKey: 'retry-safe' };
      const run = await engine.submit(definition, command);
      await engine.runUntilSettled(definition, run.id);
      const retry = await engine.submit(definition, command);
      expect(retry.id).toBe(run.id); expect(retry.status).toBe('succeeded'); expect(effects).toBe(1);
      await expect(engine.submit(definition, { ...command, input: { value: 3 } })).rejects.toMatchObject({ code: 'CONFLICT' });
      const scoped = runtime({ scope: { principalId: 'developer', projectId: 'project-b' } });
      await expect(scoped.inspect(run.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect((await scoped.submit(definition, command)).id).not.toBe(run.id);
    });

    it('retains a successful effect receipt when output validation fails', async () => {
      let effects = 0;
      const definition = single(tool({ output: z.object({ allowed: z.literal(true) }), execute: () => { effects++; return { invalid: true }; } }));
      const engine = runtime(); const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'invalid-output' });
      const completed = await engine.runUntilSettled(definition, run.id);
      expect(completed.status).toBe('failed');
      expect(completed.steps['write']?.receipt).toMatchObject({ execution: 'succeeded', disclosure: 'withheld' });
      expect(completed.steps['write']?.output).toBeNull();
      await engine.runUntilSettled(definition, run.id); expect(effects).toBe(1);
      expect(completed.budget).toMatchObject({ spentMicros: 1, reservedMicros: 0 });
    });

    it('retains a successful write while output guards withhold disclosure', async () => {
      let effects = 0;
      const definition = single(tool({
        execute: input => { effects++; return input; },
        guards: { output: [{ id: 'deny-output', check: () => ({ decision: 'block' }) }] },
      }));
      const engine = runtime(); const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'blocked-output' });
      const completed = await engine.runUntilSettled(definition, run.id);
      expect(completed.status).toBe('blocked'); expect(effects).toBe(1);
      expect(completed.steps['write']?.receipt).toMatchObject({ execution: 'succeeded', disclosure: 'withheld' });
      expect((await engine.events(run.id)).some(event => event.type === 'effect.receipt' && event.data['execution'] === 'succeeded')).toBe(true);
    });

    it('does not double spend a shared fixed-cost budget across competing branches', async () => {
      let effects = 0; const first = tool({ costMicros: 4, execute: input => { effects++; return input; } });
      const second = tool({ id: 'fixture.second', costMicros: 4, execute: input => { effects++; return input; } });
      const definition = defineWorkflow({
        id: 'budget', version: '1', input: numberInput, output: z.unknown(),
        nodes: [
          { kind: 'tool', id: 'first', tool: first, input: { kind: 'input', path: [] } },
          { kind: 'tool', id: 'second', tool: second, input: { kind: 'input', path: [] } },
          { kind: 'join', id: 'all', dependsOn: ['first', 'second'] },
        ], result: { kind: 'step', stepId: 'all', path: [] },
      });
      const engine = runtime({ maxCostMicros: 4 }); const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'budget' });
      const result = await engine.runUntilSettled(definition, run.id);
      expect(result.status).toBe('blocked'); expect(effects).toBe(1);
      expect(result.budget).toEqual({ spentMicros: 4, reservedMicros: 0, maxCostMicros: 4 });
      expect(result.steps['all']?.status).toBe('skipped');
    });

    it('settles concurrent invalid-input branches without surfacing a storage CAS conflict', async () => {
      const fixtureTool = tool();
      const definition = defineWorkflow({
        id: 'invalid-branches', version: '1', input: numberInput, output: z.unknown(),
        nodes: [
          { kind: 'tool', id: 'first', tool: fixtureTool, input: { kind: 'literal', value: { value: 'invalid' } } },
          { kind: 'tool', id: 'second', tool: fixtureTool, input: { kind: 'literal', value: { value: 'invalid' } } },
        ], result: { kind: 'literal', value: null },
      });
      const engine = runtime(); const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'invalid-branches' });
      const result = await engine.runUntilSettled(definition, run.id);
      expect(result.status).toBe('failed');
      expect(result.steps['first']?.status).toBe('failed'); expect(result.steps['second']?.status).toBe('failed');
      expect(result.budget).toMatchObject({ spentMicros: 0, reservedMicros: 0 });
    });

    it('settles multiple exhausted-budget branches without leaking a storage conflict', async () => {
      let effects = 0; const fixtureTool = tool({ costMicros: 1, execute: input => { effects++; return input; } });
      const definition = defineWorkflow({
        id: 'budget-exhausted', version: '1', input: numberInput, output: z.unknown(),
        nodes: [
          { kind: 'tool', id: 'first', tool: fixtureTool, input: { kind: 'input', path: [] } },
          { kind: 'tool', id: 'second', tool: fixtureTool, input: { kind: 'input', path: [] } },
        ], result: { kind: 'literal', value: null },
      });
      const engine = runtime({ maxCostMicros: 0 }); const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'budget-exhausted' });
      const result = await engine.runUntilSettled(definition, run.id);
      expect(result.status).toBe('blocked'); expect(effects).toBe(0);
      expect(result.steps['first']?.status).toBe('blocked'); expect(result.steps['second']?.status).toBe('blocked');
    });

    it('allows at most one effect when independent drivers race the same pending step', async () => {
      let effects = 0; const began = deferred<void>(); const release = deferred<{ value: number }>();
      const definition = single(tool({ execute: async () => { effects++; began.resolve(); return release.promise; } }));
      const engines = Array.from({ length: 6 }, () => runtime());
      const run = await engines[0]!.submit(definition, { input: { value: 2 }, idempotencyKey: 'race' });
      const executions = engines.map(engine => engine.runUntilSettled(definition, run.id));
      await began.promise; release.resolve({ value: 2 }); await Promise.all(executions);
      expect(effects).toBe(1);
      expect((await engines[0]!.runUntilSettled(definition, run.id)).status).toBe('succeeded');
    });

    it('prevents new effects after durable cancellation', async () => {
      let effects = 0; const definition = single(tool({ execute: input => { effects++; return input; } }));
      const engine = runtime(); const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'cancel-before' });
      await engine.cancel(run.id);
      expect((await engine.runUntilSettled(definition, run.id)).status).toBe('cancelled'); expect(effects).toBe(0);
    });

    it('preserves cancellation and unknown in-flight effects without refund or replay', async () => {
      let effects = 0; const began = deferred<void>(); const release = deferred<{ value: number }>();
      const definition = single(tool({ execute: async () => { effects++; began.resolve(); return release.promise; }, costMicros: 3 }));
      const engine = runtime(); const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'cancel-in-flight' });
      const execution = engine.runUntilSettled(definition, run.id);
      await began.promise;
      await engine.cancel(run.id);
      const cancelled = await execution;
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.steps['write']?.status).toBe('unknown');
      expect(cancelled.steps['write']?.receipt?.execution).toBe('unknown');
      expect(cancelled.budget).toMatchObject({ spentMicros: 0, reservedMicros: 3 });
      release.resolve({ value: 2 });
      await engine.runUntilSettled(definition, run.id); expect(effects).toBe(1);
    });

    it('retains late receipt evidence without advancing an operator-recovered claim', async () => {
      let effects = 0; const began = deferred<void>(); const release = deferred<{ value: number }>();
      const definition = single(tool({ execute: async () => { effects++; began.resolve(); return release.promise; } }));
      const old = runtime(); const operator = runtime();
      const run = await old.submit(definition, { input: { value: 2 }, idempotencyKey: 'late-receipt' });
      const pending = old.runUntilSettled(definition, run.id);
      await began.promise;
      await operator.recoverAbandoned(run.id);
      release.resolve({ value: 2 }); await pending;
      const recovered = await operator.runUntilSettled(definition, run.id);
      expect(recovered.status).toBe('outcome_unknown');
      expect(recovered.steps['write']?.status).toBe('unknown');
      expect(recovered.steps['write']?.receipt?.execution).toBe('succeeded');
      expect(recovered.steps['write']?.output).toBeNull(); expect(effects).toBe(1);
    });

    it('records abandoned dispatch as unknown without invoking or replaying the effect', async () => {
      let effects = 0; let injected = false;
      const faultStore: AggregateStore = { ...store, update: async command => {
        const committed = await store.update(command);
        if (!injected && command.events.some(event => event.type === 'step.dispatching')) { injected = true; throw new StorageError('STORAGE_UNAVAILABLE', 'Injected lost dispatch acknowledgement.'); }
        return committed;
      } };
      const definition = single(tool({ execute: input => { effects++; return input; }, costMicros: 3 }));
      const old = runtime({ store: faultStore }); const run = await old.submit(definition, { input: { value: 2 }, idempotencyKey: 'abandoned' });
      await expect(old.runUntilSettled(definition, run.id)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
      old.close(); await store.close(); store = fixture.reopen(); await store.initialize();
      const restored = runtime();
      expect((await restored.inspect(run.id)).steps['write']?.status).toBe('dispatching');
      await restored.recoverAbandoned(run.id);
      const recovered = await restored.runUntilSettled(definition, run.id);
      expect(recovered.status).toBe('outcome_unknown'); expect(recovered.steps['write']?.status).toBe('unknown');
      expect(recovered.budget).toMatchObject({ spentMicros: 0, reservedMicros: 3 });
      await restored.runUntilSettled(definition, run.id); expect(effects).toBe(0);
    });

    it('fails closed when persisted state violates the state or budget format', async () => {
      let submitted: CreateRecord | undefined;
      const capturing: AggregateStore = { ...store, create: async command => { submitted = command; return store.create(command); } };
      const engine = runtime({ store: capturing }); const definition = single(tool());
      const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'malformed' });
      expect(submitted).toBeDefined();
      await store.update({ scope: submitted!.scope, id: run.id, expectedVersion: run.version, state: { ...submitted!.state, spentMicros: -1 }, events: [] });
      await expect(engine.inspect(run.id)).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(engine.runUntilSettled(definition, run.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('fails closed for malformed nested persisted approval records', async () => {
      let submitted: CreateRecord | undefined;
      const capturing: AggregateStore = { ...store, create: async command => { submitted = command; return store.create(command); } };
      const engine = runtime({ store: capturing }); const definition = single(tool(), true);
      const run = await engine.submit(definition, { input: { value: 2 }, idempotencyKey: 'malformed-approval' });
      const corrupt = structuredClone(submitted!.state);
      const steps = corrupt['steps'] as JsonObject;
      steps['write'] = { ...(steps['write'] as JsonObject), status: 'approved', approval: { digest: 99, expiresAt: 'tomorrow', humanId: false } };
      await store.update({ scope: submitted!.scope, id: run.id, expectedVersion: run.version, state: corrupt, events: [] });
      await expect(engine.inspect(run.id)).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(engine.runUntilSettled(definition, run.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    });
  });
}

export function graphValidation(): void {
  describe('workflow graph validation', () => {
    const fixtureTool = tool();
    const make = (nodes: readonly WorkflowNode[]) => defineWorkflow({
      id: 'invalid', version: '1', input: numberInput, output: z.unknown(), nodes,
      result: { kind: 'literal', value: null },
    });
    it('rejects dependency cycles and unknown dependencies', () => {
      expect(() => make([{ kind: 'join', id: 'a', dependsOn: ['b'] }, { kind: 'join', id: 'b', dependsOn: ['a'] }])).toThrow();
      expect(() => make([{ kind: 'join', id: 'a', dependsOn: ['missing'] }])).toThrow();
    });
    it('rejects step bindings without an explicit dependency and unsafe traversal', () => {
      expect(() => make([
        { kind: 'tool', id: 'first', tool: fixtureTool, input: { kind: 'literal', value: { value: 1 } } },
        { kind: 'tool', id: 'second', tool: fixtureTool, input: { kind: 'step', stepId: 'first', path: [] } },
      ])).toThrow();
      expect(() => make([{ kind: 'tool', id: 'first', tool: fixtureTool, input: { kind: 'input', path: ['__proto__'] } }])).toThrow();
    });
    it('rejects duplicate node IDs and duplicate edges', () => {
      expect(() => make([{ kind: 'join', id: 'a', dependsOn: [] }, { kind: 'join', id: 'a', dependsOn: [] }])).toThrow();
      expect(() => make([{ kind: 'join', id: 'a', dependsOn: [] }, { kind: 'join', id: 'b', dependsOn: ['a', 'a'] }])).toThrow();
    });
  });
}
