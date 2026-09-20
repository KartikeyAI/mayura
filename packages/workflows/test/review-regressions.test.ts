import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool } from '@mayura/tools';
import { createWorkflowRuntime, defineWorkflow, type VerifiedHuman, type WorkflowRuntimeOptions } from '@mayura/workflows';
import type { AggregateStore, CreateRecord } from '@mayura/storage';
import type { JsonObject } from '@mayura/core';
import { postgresFixture, sqliteFixture, type WorkflowFixture } from './fixtures.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

const shape = z.object({ value: z.number() });
const human: VerifiedHuman = { id: 'reviewer', projectId: 'review-project', canApprove: true };
type Runtime = ReturnType<typeof createWorkflowRuntime>;

/** Deterministic interleavings at the public storage seam, using real transactional adapters. */
function reviewRegressions(name: string, factory: () => Promise<WorkflowFixture>) {
  describe(`${name} workflow review regressions`, () => {
    let fixture: WorkflowFixture;
    let store: AggregateStore;
    let runtimes: Runtime[];
    const runtime = (overrides: Partial<WorkflowRuntimeOptions> = {}) => {
      const result = createWorkflowRuntime({
        store, scope: { principalId: 'review-principal', projectId: 'review-project' },
        permissions: { allow: ['tool:review.write', 'effect:write'] },
        policyVersion: '1', maxCostMicros: 10, verifyHuman: async () => human, ...overrides,
      });
      runtimes.push(result);
      return result;
    };
    const definition = (execute: (input: { value: number }) => unknown, approval = false, effects: 'write' | 'none' = 'write') => defineWorkflow({
      id: 'review.workflow', version: '1', input: shape, output: z.unknown(),
      nodes: [{ kind: 'tool', id: 'write', approval, input: { kind: 'input', path: [] }, tool: defineTool({
        id: 'review.write', version: '1', description: 'Controlled regression effect',
        input: shape, output: z.unknown(), effects, capabilities: [], costMicros: 3, timeoutMs: 5_000, execute,
      }) }], result: { kind: 'step', stepId: 'write', path: [] },
    });

    beforeEach(async () => {
      fixture = await factory(); store = fixture.store; runtimes = []; await store.initialize();
    });
    afterEach(async () => {
      for (const instance of runtimes ?? []) instance.close();
      await store?.close(); await fixture?.cleanup();
    });

    it('snapshots submission input and idempotency key before asynchronous validation', async () => {
      const engine = runtime(); const graph = definition(input => input);
      const command = { input: { value: 1 }, idempotencyKey: 'original-submission' };
      const submitting = engine.submit(graph, command);
      command.input.value = 999; command.idempotencyKey = 'substituted-submission';
      const run = await submitting;
      const retry = await engine.submit(graph, { input: { value: 1 }, idempotencyKey: 'original-submission' });
      expect(retry.id).toBe(run.id);
      expect((await engine.runUntilSettled(graph, run.id)).output).toEqual({ value: 1 });
    });

    it('rejects a forged definition before submission writes or execution', async () => {
      let creates = 0; let effects = 0;
      const observing: AggregateStore = { ...store, create: async command => { creates++; return store.create(command); } };
      const engine = runtime({ store: observing });
      const graph = definition(input => { effects++; return input; }, true);
      const forged = { ...graph, nodes: graph.nodes.map(node => node.kind === 'tool' ? { ...node, approval: false } : node) };
      await expect(engine.submit(forged, { input: { value: 1 }, idempotencyKey: 'forged' })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
      expect(creates).toBe(0);
      const run = await engine.submit(graph, { input: { value: 1 }, idempotencyKey: 'authentic' });
      await expect(engine.runUntilSettled(forged, run.id)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
      expect(effects).toBe(0);
      expect((await engine.inspect(run.id)).steps['write']?.status).toBe('pending');
    });

    it('binds approval to the command snapshot taken before asynchronous identity verification', async () => {
      const verifying = deferred<void>(); const releaseVerifier = deferred<VerifiedHuman>();
      const engine = runtime({ verifyHuman: async () => { verifying.resolve(); return releaseVerifier.promise; } });
      const graph = definition(input => input, true);
      const first = await engine.submit(graph, { input: { value: 1 }, idempotencyKey: 'first' });
      const second = await engine.submit(graph, { input: { value: 2 }, idempotencyKey: 'second' });
      const a = await engine.runUntilSettled(graph, first.id);
      const b = await engine.runUntilSettled(graph, second.id);
      const command = { id: first.id, nodeId: 'write', digest: a.steps['write']!.approval!.digest, credential: 'credential' };
      const approving = engine.approve(command);
      await verifying.promise;
      command.id = second.id; command.digest = b.steps['write']!.approval!.digest;
      releaseVerifier.resolve(human);
      const approved = await approving;
      expect(approved.id).toBe(first.id);
      expect((await engine.inspect(first.id)).steps['write']?.status).toBe('approved');
      expect((await engine.inspect(second.id)).steps['write']?.status).toBe('waiting');
    });

    it('does not approve a run cancelled while identity verification was pending', async () => {
      const verifying = deferred<void>(); const releaseVerifier = deferred<VerifiedHuman>();
      const engine = runtime({ verifyHuman: async () => { verifying.resolve(); return releaseVerifier.promise; } });
      const graph = definition(input => input, true);
      const run = await engine.submit(graph, { input: { value: 1 }, idempotencyKey: 'cancel-review' });
      const waiting = await engine.runUntilSettled(graph, run.id);
      const approving = engine.approve({ id: run.id, nodeId: 'write', digest: waiting.steps['write']!.approval!.digest, credential: 'credential' });
      await verifying.promise;
      await engine.cancel(run.id);
      releaseVerifier.resolve(human);
      await expect(approving).rejects.toMatchObject({ code: 'CONFLICT' });
      expect((await engine.inspect(run.id)).status).toBe('cancelled');
    });

    it('does not overwrite a late successful receipt with a stale cancelled invocation outcome', async () => {
      const began = deferred<void>(); const releaseHandler = deferred<{ value: number }>();
      const finalizationPaused = deferred<void>(); const releaseFinalization = deferred<void>();
      const receiptCommitted = deferred<void>();
      let pauseOnce = true;
      const interleavedStore: AggregateStore = { ...store, update: async command => {
        if (pauseOnce && command.events.some(event => event.type === 'step.completed')) {
          pauseOnce = false; finalizationPaused.resolve(); await releaseFinalization.promise;
        }
        const record = await store.update(command);
        if (command.events.some(event => event.type === 'effect.receipt' && event.data['execution'] === 'succeeded')) receiptCommitted.resolve();
        return record;
      } };
      let effects = 0;
      const engine = runtime({ store: interleavedStore });
      const graph = definition(async () => { effects++; began.resolve(); return releaseHandler.promise; });
      const run = await engine.submit(graph, { input: { value: 1 }, idempotencyKey: 'cancel-late-receipt' });
      const execution = engine.runUntilSettled(graph, run.id);
      try {
        await began.promise;
        await engine.cancel(run.id);
        await finalizationPaused.promise;
        releaseHandler.resolve({ value: 1 });
        await receiptCommitted.promise;
      } finally { releaseHandler.resolve({ value: 1 }); releaseFinalization.resolve(); }
      const result = await execution;
      expect(result.status).toBe('cancelled');
      expect(result.steps['write']?.status).toBe('unknown');
      expect(result.steps['write']?.receipt).toMatchObject({ execution: 'succeeded', disclosure: 'withheld' });
      expect(result.steps['write']?.output).toBeNull();
      expect(result.budget).toMatchObject({ spentMicros: 3, reservedMicros: 0 });
      expect(effects).toBe(1);
    });

    it('retains late evidence after runtime close while its externally owned store remains open', async () => {
      const began = deferred<void>(); const releaseHandler = deferred<{ value: number }>();
      const receiptCommitted = deferred<void>();
      const observingStore: AggregateStore = { ...store, update: async command => {
        const record = await store.update(command);
        if (command.events.some(event => event.type === 'effect.receipt' && event.data['execution'] === 'succeeded')) receiptCommitted.resolve();
        return record;
      } };
      const engine = runtime({ store: observingStore }); const observer = runtime();
      const graph = definition(async () => { began.resolve(); return releaseHandler.promise; });
      const run = await engine.submit(graph, { input: { value: 1 }, idempotencyKey: 'close-late-receipt' });
      const execution = engine.runUntilSettled(graph, run.id);
      await began.promise;
      engine.close();
      await expect(execution).rejects.toMatchObject({ code: 'CANCELLED' });
      releaseHandler.resolve({ value: 1 });
      await receiptCommitted.promise;
      const evidence = await observer.inspect(run.id);
      expect(evidence.steps['write']?.receipt).toMatchObject({ execution: 'succeeded', disclosure: 'withheld' });
      expect(evidence.steps['write']?.output).toBeNull();
      expect(evidence.budget).toMatchObject({ spentMicros: 3, reservedMicros: 0 });
    });

    it('settles late successful pure computation after cancellation without losing stronger evidence', async () => {
      const began = deferred<void>(); const releaseHandler = deferred<{ value: number }>();
      const engine = runtime();
      const graph = definition(async () => { began.resolve(); return releaseHandler.promise; }, false, 'none');
      const run = await engine.submit(graph, { input: { value: 1 }, idempotencyKey: 'cancel-pure' });
      const execution = engine.runUntilSettled(graph, run.id);
      await began.promise;
      await engine.cancel(run.id);
      const cancelled = await execution;
      expect(cancelled.status).toBe('cancelled');
      releaseHandler.resolve({ value: 1 });
      await vi.waitFor(async () => {
        const evidence = await engine.inspect(run.id);
        expect(evidence.steps['write']?.receipt).toMatchObject({ execution: 'succeeded', disclosure: 'withheld' });
        expect(evidence.budget).toMatchObject({ spentMicros: 3, reservedMicros: 0 });
        expect(evidence.steps['write']?.output).toBeNull();
      }, { timeout: 1_000, interval: 10 });
    });

    it.each(['missing-receipt', 'withheld-receipt'] as const)('rejects persisted success with %s before disclosing or using its output', async kind => {
      let created: CreateRecord | undefined;
      const capturing: AggregateStore = { ...store, create: async command => { created = command; return store.create(command); } };
      const engine = runtime({ store: capturing });
      const graph = definition(input => input);
      const run = await engine.submit(graph, { input: { value: 1 }, idempotencyKey: kind });
      const corrupt = structuredClone(created!.state);
      corrupt['spentMicros'] = 3;
      const steps = corrupt['steps'] as JsonObject;
      steps['write'] = {
        ...(steps['write'] as JsonObject), status: 'succeeded', candidateHash: 'a'.repeat(64), output: { secret: 'not-admitted' },
        receipt: kind === 'missing-receipt' ? null : { callId: `${run.id}/step:write`, toolId: 'review.write', execution: 'succeeded', disclosure: 'withheld' },
      };
      await store.update({ scope: created!.scope, id: run.id, expectedVersion: run.version, state: corrupt, events: [] });
      await expect(engine.runUntilSettled(graph, run.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    });
  });
}

reviewRegressions('SQLite', sqliteFixture);
const postgresUrl = process.env['MAYURA_TEST_POSTGRES_URL'];
if (postgresUrl) reviewRegressions('PostgreSQL', () => postgresFixture(postgresUrl));
