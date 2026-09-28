import { afterEach, describe, expect, it } from 'vitest';
import { MayuraError, type JsonValue, type Schema } from '@mayura/core';
import { defineTool } from '@mayura/tools';
import { createAgentServer } from '../../server/dist/index.js';
import { createClient } from '../../client/dist/index.js';
import { createWorkflowLifecycleFleetRuntime, defineWorkflowLifecycle, defineWorkflowMigration } from '../src/lifecycle.js';
import { createWorkflowCommandJournal, createWorkflowOperatorTransports, lifecycleOperatorTarget } from '../src/index.js';
import { digest } from '../src/definition.js';
import { sqliteFixture, type WorkflowFixture } from './fixtures.js';

const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'signal-test', validate: value => ({ value: value as JsonValue }) } };
/** The payload: exactly `{ amountCents: <positive integer> }`. */
const payment: Schema<{ amountCents: number }> = { '~standard': { version: 1, vendor: 'signal-test', validate: value => {
  const candidate = value as { amountCents?: unknown } | null;
  return candidate && typeof candidate === 'object' && Object.keys(candidate).length === 1 && Number.isSafeInteger(candidate.amountCents) && (candidate.amountCents as number) > 0
    ? { value: { amountCents: candidate.amountCents as number } } : { issues: [{ message: 'amountCents required' }] };
} } };
const effects: JsonValue[] = [];
const place = defineTool({ id: 'orders/place', version: '1', description: 'Place.', input: any, output: any, effects: 'none', capabilities: [], execute: input => input });
const ship = defineTool({ id: 'orders/ship', version: '1', description: 'Ship.', input: any, output: any, effects: 'none', capabilities: [],
  execute: input => { effects.push(input); return { shipped: input }; } });
const nodes = (deadline: boolean) => [
  { kind: 'tool' as const, id: 'place', tool: place, input: { kind: 'input' as const, path: ['order'] } },
  { kind: 'signal' as const, id: 'paid', name: 'payment.received', dependsOn: ['place'], payload: payment,
    ...(deadline ? { deadlineAtMs: { kind: 'input' as const, path: ['payBy'] } } : {}) },
  // The payload is the signal step's output: later steps bind to it like any step output.
  { kind: 'tool' as const, id: 'ship', tool: ship, dependsOn: ['paid'], input: { kind: 'step' as const, stepId: 'paid', path: ['amountCents'] } },
];
const definition = defineWorkflowLifecycle({ id: 'orders', version: '1', input: any, output: any, nodes: nodes(true), result: { kind: 'step', stepId: 'ship', path: [] } });
const scope = { principalId: 'operator', projectId: 'project' };
const permissions = { allow: ['tool:orders/place', 'tool:orders/ship'] };

describe('lifecycle signal steps', () => {
  let fixture: WorkflowFixture | undefined; let store: WorkflowFixture['store'] | undefined; let opens = 0;
  afterEach(async () => { await store?.close(); await fixture?.cleanup(); fixture = undefined; store = undefined; opens = 0; effects.length = 0; });
  const open = async (clock: { value: number }) => {
    if (!fixture) fixture = await sqliteFixture();
    store = opens++ === 0 ? fixture.store : fixture.reopen(); await store.initialize();
    return createWorkflowLifecycleFleetRuntime({ store, scope, permissions, policyVersion: '1', maxCostMicros: 0, now: () => clock.value });
  };
  const restart = async (runtime: { close(): void }, clock: { value: number }) => { runtime.close(); await store!.close(); store = undefined; return open(clock); };

  it('waits without a worker, survives a restart, and hands the payload to later steps', async () => {
    const clock = { value: 100 }; let runtime = await open(clock);
    const run = await runtime.submit(definition, { input: { order: 'o-1', payBy: 10_000 }, idempotencyKey: 'order-1' });
    const waiting = await runtime.runUntilSettled(definition, run.id);
    expect(waiting).toMatchObject({ status: 'waiting', nextWakeAtMs: 10_000, steps: { paid: { kind: 'signal', status: 'waiting', deadlineAtMs: 10_000, signalId: null } } });
    // Waiting holds nothing: the fleet index knows when to look again, and a restart loses nothing.
    expect((await runtime.scan({ limit: 128, maxShardReads: 256 })).candidates).toEqual([expect.objectContaining({ runId: run.id, status: 'waiting', nextWakeAtMs: 10_000 })]);
    runtime = await restart(runtime, clock);

    const delivered = await runtime.signal(definition, { id: run.id, name: 'payment.received', signalId: 'pay-1', payload: { amountCents: 500 }, actorId: 'billing' });
    expect(delivered).toMatchObject({ status: 'running', steps: { paid: { status: 'succeeded', signalId: 'pay-1', output: { amountCents: 500 }, receivedAtMs: 100 } } });
    expect((await runtime.scan({ limit: 128, maxShardReads: 256 })).candidates).toEqual([expect.objectContaining({ runId: run.id, status: 'running' })]);
    const done = await runtime.runUntilSettled(definition, run.id);
    expect(done).toMatchObject({ status: 'succeeded', output: { shipped: 500 } });
    expect(effects).toEqual([500]);
    const events = (await runtime.events(run.id)).map(event => event.type);
    expect(events).toContain('lifecycle.signal.waiting'); expect(events).toContain('lifecycle.signal.delivered');
    expect((await runtime.events(run.id)).find(event => event.type === 'lifecycle.signal.delivered')?.data).toMatchObject({ signalId: 'pay-1', actorId: 'billing' });
  });

  it('delivers a signal once per signal id and refuses a second, different signal', async () => {
    const clock = { value: 100 }; const runtime = await open(clock);
    const run = await runtime.submit(definition, { input: { order: 'o-2', payBy: 10_000 }, idempotencyKey: 'order-2' });
    await runtime.runUntilSettled(definition, run.id);
    const first = await runtime.signal(definition, { id: run.id, name: 'payment.received', signalId: 'pay-2', payload: { amountCents: 7 } });
    const again = await runtime.signal(definition, { id: run.id, name: 'payment.received', signalId: 'pay-2', payload: { amountCents: 7 } });
    expect(again.version).toBe(first.version);
    await expect(runtime.signal(definition, { id: run.id, name: 'payment.received', signalId: 'pay-2', payload: { amountCents: 8 } }))
      .rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/already delivered with a different payload/) });
    await expect(runtime.signal(definition, { id: run.id, name: 'payment.received', signalId: 'pay-3', payload: { amountCents: 7 } }))
      .rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/accepts one signal/) });
    expect((await runtime.runUntilSettled(definition, run.id)).status).toBe('succeeded');
    expect(effects).toEqual([7]);
    // After the run finished, the same signal is still recognised as delivered; a new one is refused.
    expect((await runtime.signal(definition, { id: run.id, name: 'payment.received', signalId: 'pay-2', payload: { amountCents: 7 } })).status).toBe('succeeded');
  });

  it('refuses a payload the schema rejects, an unknown signal name and a malformed signal id without changing the run', async () => {
    const clock = { value: 100 }; const runtime = await open(clock);
    const run = await runtime.submit(definition, { input: { order: 'o-3', payBy: 10_000 }, idempotencyKey: 'order-3' });
    const waiting = await runtime.runUntilSettled(definition, run.id);
    for (const payload of [{ amountCents: -1 }, { amountCents: 1, extra: true }, 'paid', null]) {
      const error = await runtime.signal(definition, { id: run.id, name: 'payment.received', signalId: 'pay-4', payload }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MayuraError); expect(error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/payment\.received/) });
    }
    await expect(runtime.signal(definition, { id: run.id, name: 'payment.refunded', signalId: 'pay-4', payload: { amountCents: 1 } })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(runtime.signal(definition, { id: run.id, name: 'payment.received', signalId: '../x', payload: { amountCents: 1 } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await runtime.inspect(run.id)).version).toBe(waiting.version);
    // The rejected payloads did not use up the step: a valid signal is still accepted.
    expect((await runtime.signal(definition, { id: run.id, name: 'payment.received', signalId: 'pay-4', payload: { amountCents: 1 } })).steps['paid']).toMatchObject({ status: 'succeeded' });
  });

  it('times out at its deadline, fails the run, skips dependents and refuses late signals', async () => {
    const clock = { value: 100 }; const runtime = await open(clock);
    const run = await runtime.submit(definition, { input: { order: 'o-5', payBy: 200 }, idempotencyKey: 'order-5' });
    expect((await runtime.runUntilSettled(definition, run.id)).nextWakeAtMs).toBe(200);
    clock.value = 199; expect((await runtime.runUntilSettled(definition, run.id)).status).toBe('waiting');
    clock.value = 200;
    const timedOut = await runtime.runUntilSettled(definition, run.id);
    expect(timedOut).toMatchObject({ status: 'failed', steps: { paid: { status: 'timed_out', deadlineAtMs: 200, signalId: null }, ship: { status: 'skipped' } } });
    await expect(runtime.signal(definition, { id: run.id, name: 'payment.received', signalId: 'late', payload: { amountCents: 1 } })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(effects).toEqual([]);
  });

  it('refuses a signal that arrives after the deadline even before the run noticed it', async () => {
    const clock = { value: 100 }; const runtime = await open(clock);
    const run = await runtime.submit(definition, { input: { order: 'o-6', payBy: 200 }, idempotencyKey: 'order-6' });
    await runtime.runUntilSettled(definition, run.id);
    clock.value = 250;
    await expect(runtime.signal(definition, { id: run.id, name: 'payment.received', signalId: 'late', payload: { amountCents: 1 } }))
      .rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/deadline/) });
  });

  it('keeps a signal that arrives before the step starts, and uses it only if it came before the deadline', async () => {
    const clock = { value: 100 }; const runtime = await open(clock);
    const gated = defineWorkflowLifecycle({ id: 'orders.gated', version: '1', input: any, output: any, nodes: [
      { kind: 'timer', id: 'hold', fireAtMs: { kind: 'input', path: ['holdUntil'] } },
      ...nodes(true).map(node => node.id === 'place' ? { ...node, dependsOn: ['hold'] } : node),
    ], result: { kind: 'step', stepId: 'ship', path: [] } });
    const early = await runtime.submit(gated, { input: { order: 'o-7', holdUntil: 150, payBy: 1_000 }, idempotencyKey: 'early' });
    const late = await runtime.submit(gated, { input: { order: 'o-8', holdUntil: 150, payBy: 120 }, idempotencyKey: 'late' });
    for (const run of [early, late]) expect((await runtime.runUntilSettled(gated, run.id)).steps['paid']).toMatchObject({ status: 'pending' });
    // Delivered while `paid` is still pending: kept on the step; a repeat is still a no-op.
    clock.value = 130;
    const kept = await runtime.signal(gated, { id: early.id, name: 'payment.received', signalId: 'early-pay', payload: { amountCents: 3 } });
    expect(kept.steps['paid']).toMatchObject({ status: 'pending', signalId: 'early-pay', receivedAtMs: 130 });
    expect((await runtime.signal(gated, { id: early.id, name: 'payment.received', signalId: 'early-pay', payload: { amountCents: 3 } })).version).toBe(kept.version);
    await runtime.signal(gated, { id: late.id, name: 'payment.received', signalId: 'late-pay', payload: { amountCents: 4 } });
    clock.value = 150;
    expect(await runtime.runUntilSettled(gated, early.id)).toMatchObject({ status: 'succeeded', output: { shipped: 3 }, steps: { paid: { status: 'succeeded', receivedAtMs: 130 } } });
    // The other signal arrived at 130, after that run's deadline of 120: it does not count.
    expect(await runtime.runUntilSettled(gated, late.id)).toMatchObject({ status: 'failed', steps: { paid: { status: 'timed_out', signalId: null, output: null } } });
    expect(effects).toEqual([3]);
  });

  it('drops a kept signal when the step is bypassed or the run is cancelled, and refuses signals to a finished run', async () => {
    const clock = { value: 100 }; const runtime = await open(clock);
    const optional = defineWorkflowLifecycle({ id: 'orders.optional', version: '1', input: any, output: any, nodes: [
      { kind: 'timer', id: 'hold', fireAtMs: { kind: 'input', path: ['holdUntil'] } },
      { kind: 'signal', id: 'paid', dependsOn: ['hold'], payload: payment, when: { kind: 'input', path: ['needsPayment'] } },
    ], result: { kind: 'step', stepId: 'paid', path: [] } });
    const bypassed = await runtime.submit(optional, { input: { holdUntil: 150, needsPayment: false }, idempotencyKey: 'bypassed' });
    await runtime.runUntilSettled(optional, bypassed.id);
    // No name given: the node id is the signal name.
    await runtime.signal(optional, { id: bypassed.id, name: 'paid', signalId: 's-1', payload: { amountCents: 1 } });
    clock.value = 150;
    expect(await runtime.runUntilSettled(optional, bypassed.id)).toMatchObject({ status: 'succeeded', output: null, steps: { paid: { status: 'bypassed', signalId: null } } });
    const cancelled = await runtime.submit(optional, { input: { holdUntil: 500, needsPayment: true }, idempotencyKey: 'cancelled' });
    await runtime.runUntilSettled(optional, cancelled.id);
    await runtime.signal(optional, { id: cancelled.id, name: 'paid', signalId: 's-2', payload: { amountCents: 1 } });
    expect((await runtime.cancel(cancelled.id)).steps['paid']).toMatchObject({ status: 'skipped', signalId: null });
    await expect(runtime.signal(optional, { id: cancelled.id, name: 'paid', signalId: 's-3', payload: { amountCents: 1 } })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('migrates a waiting signal step and keeps a signal an unstarted step already holds', async () => {
    const clock = { value: 100 }; const runtime = await open(clock);
    const v1 = defineWorkflowLifecycle({ id: 'orders.migrate', version: '1', input: any, output: any, nodes: [
      { kind: 'timer', id: 'hold', fireAtMs: { kind: 'input', path: ['holdUntil'] } },
      { kind: 'signal', id: 'paid', dependsOn: ['hold'], payload: payment },
    ], result: { kind: 'step', stepId: 'paid', path: [] } });
    const v2 = defineWorkflowLifecycle({ id: 'orders.migrate', version: '2', input: any, output: any, nodes: [
      { kind: 'timer', id: 'hold', fireAtMs: { kind: 'input', path: ['holdUntil'] } },
      { kind: 'signal', id: 'paid', dependsOn: ['hold'], payload: payment, deadlineAtMs: { kind: 'literal', value: 10_000 } },
    ], result: { kind: 'step', stepId: 'paid', path: [] } });
    const run = await runtime.submit(v1, { input: { holdUntil: 150 }, idempotencyKey: 'migrate' });
    await runtime.runUntilSettled(v1, run.id);
    await runtime.signal(v1, { id: run.id, name: 'paid', signalId: 'kept', payload: { amountCents: 9 } });
    await runtime.pause(run.id);
    const migration = defineWorkflowMigration({ id: 'orders-1-to-2', from: v1, to: v2 });
    const result = await runtime.migrate(migration, { id: run.id, actorId: 'operator', commandId: 'migrate-1' });
    expect(result.plan.entries).toContainEqual({ action: 'update', target: 'paid', source: 'paid', status: 'pending' });
    expect(result.snapshot?.steps['paid']).toMatchObject({ status: 'pending', signalId: 'kept' });
    await runtime.resume(run.id); clock.value = 150;
    expect(await runtime.runUntilSettled(v2, run.id)).toMatchObject({ status: 'succeeded', output: { amountCents: 9 } });
  });

  it('refuses stored signal steps whose fields contradict their status', async () => {
    const clock = { value: 100 }; const runtime = await open(clock);
    const run = await runtime.submit(definition, { input: { order: 'o-11', payBy: 10_000 }, idempotencyKey: 'order-11' });
    await runtime.runUntilSettled(definition, run.id);
    const hash = 'a'.repeat(64);
    const tampered = [
      { status: 'waiting', signalId: 'x', payloadDigest: hash, receivedAtMs: 1, output: { amountCents: 1 } },
      { status: 'succeeded', signalId: null, payloadDigest: null, receivedAtMs: null, output: { amountCents: 1 } },
      { status: 'succeeded', signalId: 'x', payloadDigest: null, receivedAtMs: 1, output: { amountCents: 1 } },
      { status: 'timed_out', deadlineAtMs: null },
      { status: 'pending', deadlineAtMs: 5 },
      { status: 'skipped', signalId: 'x', payloadDigest: hash, receivedAtMs: 1, deadlineAtMs: null },
      { status: 'waiting', signalId: '../x' },
    ];
    const current = await runtime.inspect(run.id);
    for (const change of tampered) {
      const stored = (await store!.read(digest('mayura:scope:v1', scope), run.id))!;
      const state = structuredClone(stored.state) as { steps: Record<string, Record<string, unknown>> };
      state.steps['paid'] = { ...state.steps['paid'], ...change };
      const updated = await store!.update({ scope: stored.scope, id: run.id, expectedVersion: stored.version, state: state as never, events: [] });
      await expect(runtime.inspect(run.id)).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringMatching(/integrity/) });
      await store!.update({ scope: stored.scope, id: run.id, expectedVersion: updated.version, state: stored.state, events: [] });
    }
    expect((await runtime.inspect(run.id)).steps['paid']).toMatchObject(current.steps['paid']!);
  });

  it('rejects definitions with duplicate or malformed signal names and keeps the payload schema out of the digest', () => {
    const base = { id: 'orders.bad', version: '1', input: any, output: any, result: { kind: 'step' as const, stepId: 'a', path: [] } };
    expect(() => defineWorkflowLifecycle({ ...base, nodes: [{ kind: 'signal', id: 'a', name: 'same', payload: payment }, { kind: 'signal', id: 'b', name: 'same', payload: payment }] }))
      .toThrow(MayuraError);
    expect(() => defineWorkflowLifecycle({ ...base, nodes: [{ kind: 'signal', id: 'a', name: '../x', payload: payment }] })).toThrow(MayuraError);
    expect(() => defineWorkflowLifecycle({ ...base, nodes: [{ kind: 'signal', id: 'a', payload: {} as Schema }] })).toThrow(MayuraError);
    const one = defineWorkflowLifecycle({ ...base, nodes: [{ kind: 'signal', id: 'a', payload: payment }] });
    const other = defineWorkflowLifecycle({ ...base, nodes: [{ kind: 'signal', id: 'a', payload: any }] });
    expect(one.digest).toBe(other.digest);
  });

  it('is delivered end to end through the operator transports, the server route and the client', async () => {
    const clock = { value: 100 }; const runtime = await open(clock);
    const run = await runtime.submit(definition, { input: { order: 'o-9', payBy: 10_000 }, idempotencyKey: 'order-9' });
    await runtime.runUntilSettled(definition, run.id);
    const journal = createWorkflowCommandJournal({ store: store!, scope });
    const transports = createWorkflowOperatorTransports({ store: store!, scope, journal,
      targets: [lifecycleOperatorTarget({ runtime, store: store!, scope, definitions: [definition] })] });
    const server = createAgentServer({ publicOrigin: 'https://mayura.test', agents: [], ...transports,
      authenticate: async ({ token }) => token === 'test-token' ? { scope, agentIds: [], capabilities: ['workflows:read', 'workflows:control'], expiresAtMs: Date.now() + 60_000 } : null });
    try {
      const client = createClient({ baseUrl: 'https://mayura.test', token: () => 'test-token', fetch: async (input, init) => server.fetch(new Request(input, init)) });
      const view = await client.workflow(run.id);
      expect(view.steps).toContainEqual({ id: 'paid', kind: 'signal', status: 'waiting' });
      const command = { revision: view.revision, signalId: 'pay-9', signalName: 'payment.received', value: { amountCents: 12 } };
      const delivered = await client.signalWorkflow(run.id, command, { commandId: 'signal-9' });
      expect(delivered.steps).toContainEqual({ id: 'paid', kind: 'signal', status: 'succeeded' });
      // A retried command returns the recorded outcome; the signal is not delivered twice.
      expect((await client.signalWorkflow(run.id, command, { commandId: 'signal-9' })).revision).toBe(delivered.revision);
      // A wrong payload or an unknown signal name is refused, never reported as unavailable.
      await expect(client.signalWorkflow(run.id, { ...command, revision: delivered.revision, signalId: 'pay-10', value: { amountCents: 'x' } }, { commandId: 'signal-10' }))
        .rejects.toMatchObject({ status: 409 });
      await expect(client.signalWorkflow(run.id, { ...command, revision: delivered.revision, signalName: 'nope' }, { commandId: 'signal-11' }))
        .rejects.toMatchObject({ status: 404 });
      expect((await runtime.runUntilSettled(definition, run.id)).output).toEqual({ shipped: 12 });
    } finally { await server.close(); }
  });
});
