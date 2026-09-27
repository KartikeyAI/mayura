import { afterEach, describe, expect, it } from 'vitest';
import type { JsonValue, Schema } from '@mayura/core';
import { defineTool } from '@mayura/tools';
import { createWorkflowLifecycleRuntime, defineWorkflowLifecycle } from '../src/lifecycle.js';
import { sqliteFixture, type WorkflowFixture } from './fixtures.js';

const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'lifecycle-runtime-test',
  validate: value => ({ value: value as JsonValue }) } };
const response: Schema<string, { decision: string }> = { '~standard': { version: 1, vendor: 'lifecycle-runtime-test',
  validate: value => typeof value === 'string' ? { value: { decision: value } } : { issues: [] } } };
const tool = defineTool({ id: 'fixture/draft', version: '1', description: 'Create a draft.', input: any, output: any,
  effects: 'none', capabilities: [], costMicros: 2, execute: input => ({ draft: input }) });
const hash = 'a'.repeat(64);
const definition = defineWorkflowLifecycle({ id: 'durable-review', version: '1', input: any, output: any, nodes: [
  { kind: 'tool', id: 'draft', tool, input: { kind: 'input', path: ['payload'] } },
  { kind: 'human', id: 'review', dependsOn: ['draft'], request: { kind: 'correction', schemaId: 'fixture/review',
    schemaDigest: hash, prompt: 'Review the draft.', response, context: { kind: 'step', stepId: 'draft', path: [] },
    subjectDigest: { kind: 'input', path: ['subjectDigest'] }, deadlineAtMs: { kind: 'input', path: ['reviewBy'] } } },
  { kind: 'timer', id: 'publishAt', dependsOn: ['review'], fireAtMs: { kind: 'input', path: ['publishAt'] } },
  { kind: 'join', id: 'done', dependsOn: ['review', 'publishAt'] },
], result: { kind: 'step', stepId: 'review', path: [] } });

describe('durable format-5 lifecycle runtime on SQLite', () => {
  let fixture: WorkflowFixture | undefined; let currentStore: WorkflowFixture['store'] | undefined; let opens = 0;
  afterEach(async () => { await currentStore?.close(); await fixture?.cleanup(); fixture = undefined; currentStore = undefined; opens = 0; });

  const open = async (clock: { value: number }) => {
    if (!fixture) fixture = await sqliteFixture();
    currentStore = opens++ === 0 ? fixture.store : fixture.reopen(); await currentStore.initialize();
    return createWorkflowLifecycleRuntime({ store: currentStore, scope: { principalId: 'operator', projectId: 'project' },
      permissions: { allow: ['tool:fixture/draft'] }, policyVersion: '1', maxCostMicros: 2, now: () => clock.value,
      approvalTtlMs: 50,
      verifyHuman: async credential => ({ id: String(credential), projectId: 'project', canApprove: credential === 'approver' }) });
  };

  it('survives two restarts across human and timer suspension without retaining work', async () => {
    const clock = { value: 100 }; let runtime = await open(clock);
    const submitted = await runtime.submit(definition, { input: { payload: 'draft', subjectDigest: hash, reviewBy: 1_000, publishAt: 500 }, idempotencyKey: 'review-1' });
    const waitingHuman = await runtime.runUntilSettled(definition, submitted.id);
    expect(waitingHuman).toMatchObject({ status: 'waiting', nextWakeAtMs: 1_000,
      steps: { draft: { status: 'succeeded' }, review: { status: 'waiting' }, publishAt: { status: 'pending' } } });
    const requestDigest = waitingHuman.steps['review']?.kind === 'human' ? waitingHuman.steps['review'].requestDigest! : '';
    expect(await runtime.humanRequest(definition, submitted.id, 'review')).toMatchObject({ status: 'waiting',
      kind: 'correction', digest: requestDigest, context: { draft: 'draft' }, subjectDigest: hash, deadlineAtMs: 1_000 });
    runtime.close(); await currentStore!.close(); currentStore = undefined;

    runtime = await open(clock);
    const answered = await runtime.respond(definition, { id: submitted.id, nodeId: 'review', requestDigest,
      commandId: 'response-1', credential: 'reviewer', value: 'accept' });
    expect(answered.steps['review']).toMatchObject({ status: 'succeeded', actorId: 'reviewer', output: { decision: 'accept' } });
    const duplicate = await runtime.respond(definition, { id: submitted.id, nodeId: 'review', requestDigest,
      commandId: 'response-1', credential: 'reviewer', value: 'accept' });
    expect(duplicate.version).toBe(answered.version);
    const waitingTimer = await runtime.runUntilSettled(definition, submitted.id);
    expect(waitingTimer).toMatchObject({ status: 'waiting', nextWakeAtMs: 500,
      steps: { publishAt: { status: 'waiting', fireAtMs: 500 } } });
    runtime.close(); await currentStore!.close(); currentStore = undefined;

    clock.value = 500; runtime = await open(clock);
    const completed = await runtime.runUntilSettled(definition, submitted.id);
    expect(completed).toMatchObject({ status: 'succeeded', nextWakeAtMs: null, output: { decision: 'accept' },
      steps: { publishAt: { status: 'succeeded', fireAtMs: 500, firedAtMs: 500 }, done: { status: 'succeeded' } },
      budget: { spentMicros: 2, reservedMicros: 0, maxCostMicros: 2 } });
  });

  it('persists deadline timeout and rejects late responses', async () => {
    const clock = { value: 100 }; const runtime = await open(clock);
    const submitted = await runtime.submit(definition, { input: { payload: 'draft', subjectDigest: hash, reviewBy: 200, publishAt: 500 }, idempotencyKey: 'timeout' });
    const waiting = await runtime.runUntilSettled(definition, submitted.id);
    const requestDigest = waiting.steps['review']?.kind === 'human' ? waiting.steps['review'].requestDigest! : '';
    clock.value = 200;
    const timedOut = await runtime.runUntilSettled(definition, submitted.id);
    expect(timedOut).toMatchObject({ status: 'failed', steps: { review: { status: 'timed_out' }, publishAt: { status: 'skipped' } } });
    await expect(runtime.respond(definition, { id: submitted.id, nodeId: 'review', requestDigest,
      commandId: 'late', credential: 'reviewer', value: 'accept' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('keeps tool approval and cancellation guarded by verified identities', async () => {
    const clock = { value: 100 }; const runtime = await open(clock);
    const approvalDefinition = defineWorkflowLifecycle({ id: 'approval', version: '1', input: any, output: any,
      nodes: [{ kind: 'tool', id: 'draft', tool, approval: true, input: { kind: 'input', path: [] } }],
      result: { kind: 'step', stepId: 'draft', path: [] } });
    const submitted = await runtime.submit(approvalDefinition, { input: 'draft', idempotencyKey: 'approval' });
    const waiting = await runtime.runUntilSettled(approvalDefinition, submitted.id);
    const expiredDigest = waiting.steps['draft']?.kind === 'tool' ? waiting.steps['draft'].approval?.digest ?? '' : '';
    // The approver sees the exact tool call the digest binds, reconstructed and verified by the runtime.
    expect(await runtime.approvalRequest(approvalDefinition, submitted.id, 'draft')).toEqual({ runId: submitted.id, nodeId: 'draft', status: 'waiting',
      toolId: 'fixture/draft', toolVersion: '1', input: 'draft', digest: expiredDigest, expiresAtMs: 150 });
    expect(waiting.nextWakeAtMs).toBe(150); clock.value = 150;
    const refreshed = await runtime.runUntilSettled(approvalDefinition, submitted.id);
    const digest = refreshed.steps['draft']?.kind === 'tool' ? refreshed.steps['draft'].approval?.digest ?? '' : '';
    expect(digest).not.toBe(expiredDigest); expect(refreshed.nextWakeAtMs).toBe(200);
    expect(await runtime.approvalRequest(approvalDefinition, submitted.id, 'draft')).toMatchObject({ digest, expiresAtMs: 200 });
    await expect(runtime.approve({ id: submitted.id, nodeId: 'draft', digest: expiredDigest, credential: 'approver' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(runtime.approve({ id: submitted.id, nodeId: 'draft', digest, credential: 'reviewer' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const approved = await runtime.approve({ id: submitted.id, nodeId: 'draft', digest, credential: 'approver' });
    expect((await runtime.approve({ id: submitted.id, nodeId: 'draft', digest, credential: 'approver' })).version).toBe(approved.version);
    expect(await runtime.runUntilSettled(approvalDefinition, submitted.id)).toMatchObject({ status: 'succeeded' });
    expect(await runtime.approvalRequest(approvalDefinition, submitted.id, 'draft')).toBeUndefined();
    await expect(runtime.approvalRequest(definition, submitted.id, 'draft')).rejects.toBeDefined();

    const pending = await runtime.submit(definition, { input: { payload: 'draft', subjectDigest: hash, reviewBy: 1_000, publishAt: 500 }, idempotencyKey: 'cancel' });
    await runtime.runUntilSettled(definition, pending.id);
    expect(await runtime.cancel(pending.id)).toMatchObject({ status: 'cancelled', nextWakeAtMs: null,
      steps: { review: { status: 'skipped' }, publishAt: { status: 'skipped' } } });
  });

  it('persists a quiescent operator pause across restart and resumes without bypassing waits', async () => {
    const clock = { value: 100 }; let effects = 0; let runtime = await open(clock);
    const counted = defineTool({ id: 'fixture/draft', version: '1', description: 'Create a draft.', input: any, output: any,
      effects: 'none', capabilities: [], costMicros: 2, execute: input => { effects++; return { draft: input }; } });
    const pausable = defineWorkflowLifecycle({ id: 'pausable', version: '1', input: any, output: any, nodes: [
      { kind: 'tool', id: 'draft', tool: counted, input: { kind: 'input', path: ['payload'] } },
      { kind: 'human', id: 'review', dependsOn: ['draft'], request: { kind: 'information', schemaId: 'fixture/review',
        schemaDigest: hash, prompt: 'Review the draft.', response } },
      { kind: 'timer', id: 'publishAt', dependsOn: ['review'], fireAtMs: { kind: 'input', path: ['publishAt'] } },
    ], result: { kind: 'step', stepId: 'review', path: [] } });
    const submitted = await runtime.submit(pausable, { input: { payload: 'draft', publishAt: 500 }, idempotencyKey: 'pause' });
    const paused = await runtime.pause(submitted.id); expect(paused.status).toBe('paused');
    expect((await runtime.pause(submitted.id)).version).toBe(paused.version);
    runtime.close(); await currentStore!.close(); currentStore = undefined;

    runtime = await open(clock);
    expect(await runtime.runUntilSettled(pausable, submitted.id)).toMatchObject({ status: 'paused', steps: { draft: { status: 'pending' } } });
    expect(effects).toBe(0);
    expect((await runtime.resume(submitted.id)).status).toBe('running');
    const waiting = await runtime.runUntilSettled(pausable, submitted.id);
    expect(waiting).toMatchObject({ status: 'waiting', steps: { draft: { status: 'succeeded' }, review: { status: 'waiting' } } });
    expect(effects).toBe(1);
    const requestDigest = waiting.steps['review']?.kind === 'human' ? waiting.steps['review'].requestDigest! : '';

    expect((await runtime.pause(submitted.id)).status).toBe('paused');
    expect((await runtime.resume(submitted.id)).status).toBe('waiting');
    await runtime.pause(submitted.id);
    expect(await runtime.respond(pausable, { id: submitted.id, nodeId: 'review', requestDigest, commandId: 'answer',
      credential: 'reviewer', value: 'accept' })).toMatchObject({ status: 'paused', steps: { review: { status: 'succeeded' } } });
    clock.value = 500;
    expect(await runtime.runUntilSettled(pausable, submitted.id)).toMatchObject({ status: 'paused', steps: { publishAt: { status: 'pending' } } });
    expect((await runtime.resume(submitted.id)).status).toBe('running');
    expect(await runtime.runUntilSettled(pausable, submitted.id)).toMatchObject({ status: 'succeeded', output: { decision: 'accept' },
      steps: { publishAt: { status: 'succeeded', firedAtMs: 500 } } });
    expect(effects).toBe(1);
    expect((await runtime.events(submitted.id)).map(event => event.type)).toEqual(expect.arrayContaining(['lifecycle.run.paused', 'lifecycle.run.resumed']));
    await expect(runtime.pause(submitted.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(runtime.resume(submitted.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('keeps approval, cancellation and in-flight effects consistent with a pause', async () => {
    const clock = { value: 100 }; const runtime = await open(clock);
    const approvalDefinition = defineWorkflowLifecycle({ id: 'approval', version: '1', input: any, output: any,
      nodes: [{ kind: 'tool', id: 'draft', tool, approval: true, input: { kind: 'input', path: [] } }],
      result: { kind: 'step', stepId: 'draft', path: [] } });
    const submitted = await runtime.submit(approvalDefinition, { input: 'draft', idempotencyKey: 'paused-approval' });
    const waiting = await runtime.runUntilSettled(approvalDefinition, submitted.id);
    const digest = waiting.steps['draft']?.kind === 'tool' ? waiting.steps['draft'].approval?.digest ?? '' : '';
    await runtime.pause(submitted.id);
    expect((await runtime.resume(submitted.id)).status).toBe('waiting');
    expect((await runtime.runUntilSettled(approvalDefinition, submitted.id)).status).toBe('waiting');
    await runtime.pause(submitted.id);
    expect((await runtime.approve({ id: submitted.id, nodeId: 'draft', digest, credential: 'approver' })).status).toBe('paused');
    expect((await runtime.runUntilSettled(approvalDefinition, submitted.id)).status).toBe('paused');
    expect((await runtime.cancel(submitted.id)).status).toBe('cancelled');
    await expect(runtime.resume(submitted.id)).rejects.toMatchObject({ code: 'CONFLICT' });

    let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
    let release!: (value: JsonValue) => void; const released = new Promise<JsonValue>(resolve => { release = resolve; });
    const slow = defineTool({ id: 'fixture/draft', version: '1', description: 'Create a draft.', input: any, output: any,
      effects: 'none', capabilities: [], costMicros: 2, execute: () => { started(); return released; } });
    const slowDefinition = defineWorkflowLifecycle({ id: 'in-flight', version: '1', input: any, output: any,
      nodes: [{ kind: 'tool', id: 'draft', tool: slow, input: { kind: 'input', path: [] } }],
      result: { kind: 'step', stepId: 'draft', path: [] } });
    const inFlight = await runtime.submit(slowDefinition, { input: 'draft', idempotencyKey: 'in-flight' });
    const execution = runtime.runUntilSettled(slowDefinition, inFlight.id); await entered;
    await expect(runtime.pause(inFlight.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    release('done'); expect((await execution).status).toBe('succeeded');
  });

  it('does not let a scheduling transition overwrite a pause committed after its read', async () => {
    fixture = await sqliteFixture(); currentStore = fixture.store; opens = 1; await currentStore.initialize();
    const store = currentStore; let beforeRead: (() => Promise<unknown>) | undefined; let armed = false; let runId = '';
    const intercepted = new Proxy(store, { get(target, property) {
      if (property === 'read') return async (...args: Parameters<typeof store.read>) => {
        const hook = beforeRead; beforeRead = undefined; if (hook) await hook(); return target.read(...args);
      };
      const value = Reflect.get(target, property) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    } });
    const options = { scope: { principalId: 'operator', projectId: 'project' }, permissions: { allow: [] },
      policyVersion: '1', maxCostMicros: 0 };
    const operator = createWorkflowLifecycleRuntime({ ...options, store });
    // The timer path reads the clock after its initial load and before its transition reloads the run.
    const scheduler = createWorkflowLifecycleRuntime({ ...options, store: intercepted, now: () => {
      if (armed) { armed = false; beforeRead = () => operator.pause(runId); } return 100;
    } });
    const timer = defineWorkflowLifecycle({ id: 'raced-timer', version: '1', input: any, output: any,
      nodes: [{ kind: 'timer', id: 'wake', fireAtMs: { kind: 'input', path: ['fireAtMs'] } }],
      result: { kind: 'step', stepId: 'wake', path: [] } });
    runId = (await scheduler.submit(timer, { input: { fireAtMs: 500 }, idempotencyKey: 'raced' })).id;
    armed = true;
    expect(await scheduler.runUntilSettled(timer, runId)).toMatchObject({ status: 'paused', steps: { wake: { status: 'pending', fireAtMs: null } } });
    expect(await operator.inspect(runId)).toMatchObject({ status: 'paused' });
    scheduler.close(); operator.close();
  });

  it('drains an admitted lifecycle effect without starting the next wave', async () => {
    const clock = { value: 100 }; const runtime = await open(clock); let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void; const released = new Promise<void>(resolve => { release = resolve; }); let effects = 0;
    const slow = defineTool({ id: 'fixture/draft', version: '1', description: 'Create a draft.', input: any, output: any,
      effects: 'none', capabilities: [], costMicros: 2, execute: async input => { effects++; started(); await released; return input; } });
    const chained = defineWorkflowLifecycle({ id: 'drained', version: '1', input: any, output: any, nodes: [
      { kind: 'tool', id: 'draft', tool: slow, input: { kind: 'input', path: [] } },
      { kind: 'timer', id: 'later', dependsOn: ['draft'], fireAtMs: { kind: 'literal', value: 50 } },
    ], result: { kind: 'step', stepId: 'draft', path: [] } });
    const submitted = await runtime.submit(chained, { input: 'value', idempotencyKey: 'drain' });
    const execution = runtime.runUntilSettled(chained, submitted.id).catch(() => undefined); await entered;
    const draining = runtime.drain({ timeoutMs: 5_000 });
    await expect(runtime.runUntilSettled(chained, submitted.id)).rejects.toMatchObject({ code: 'CANCELLED' });
    release(); expect(await draining).toEqual({ drained: true, interrupted: 0 }); await execution;
    await currentStore!.close(); currentStore = undefined; const observer = await open(clock);
    expect(await observer.inspect(submitted.id)).toMatchObject({ status: 'running', steps: { draft: { status: 'succeeded' }, later: { status: 'pending' } } });
    expect(effects).toBe(1);
  });

  it('retains callback admission after a noncooperative validator times out', async () => {
    fixture = await sqliteFixture(); currentStore = fixture.store; opens = 1; await currentStore.initialize();
    let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
    const stuck: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'stuck-validator', validate: () => {
      started(); return new Promise<never>(() => {});
    } } };
    const stuckDefinition = defineWorkflowLifecycle({ id: 'stuck', version: '1', input: stuck, output: any,
      nodes: [{ kind: 'join', id: 'done', dependsOn: [] }], result: { kind: 'literal', value: null } });
    const runtime = createWorkflowLifecycleRuntime({ store: currentStore, scope: { principalId: 'operator', projectId: 'project' },
      permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0, callbackTimeoutMs: 20, maxPendingCallbacks: 1 });
    const first = runtime.submit(stuckDefinition, { input: null, idempotencyKey: 'first' }); await entered;
    await expect(runtime.submit(stuckDefinition, { input: null, idempotencyKey: 'second' })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(first).rejects.toMatchObject({ code: 'TIMEOUT' });
    await expect(runtime.submit(stuckDefinition, { input: null, idempotencyKey: 'third' })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    runtime.close();
  });
});
