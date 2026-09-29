import { afterEach, describe, expect, it } from 'vitest';
import { MayuraError, type JsonValue, type Schema } from '@mayura/core';
import { createWorkflowLeadership, createWorkflowWorker, type WorkflowLeadership, type WorkflowWorkerUnit } from '../src/index.js';
import { createWorkflowLifecycleHost, defineWorkflowLifecycle } from '../src/lifecycle.js';
import { createSweepPosition } from '../src/sweep-position.js';
import { sqliteFixture, type WorkflowFixture } from './fixtures.js';

const scope = { principalId: 'ops', projectId: 'workers' };
const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'worker-once-test', validate: value => ({ value: value as JsonValue }) } };
const timer = defineWorkflowLifecycle({ id: 'once-timer', version: '1', input: any, output: any,
  nodes: [{ kind: 'timer', id: 'wake', fireAtMs: { kind: 'input', path: ['fireAtMs'] } }],
  result: { kind: 'step', stepId: 'wake', path: [] } });
const hostOptions = { scope, permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0 };

/** A unit that reports what the test tells it to, and counts its passes. */
function scriptedUnit(passes: () => { readonly completedSweep: boolean; readonly held?: boolean }, onPass: () => void = () => {}) {
  const counter = { passes: 0 };
  const unit: WorkflowWorkerUnit = { start: () => {}, stop: async () => {}, drain: async () => ({ drained: true, interrupted: 0 }),
    runOnce: async () => { counter.passes++; onPass(); return passes(); } };
  return { unit, counter };
}

describe('one-shot worker', () => {
  let fixture: WorkflowFixture | undefined;
  afterEach(async () => { await fixture?.store.close(); await fixture?.cleanup(); fixture = undefined; });
  const open = async () => { fixture = await sqliteFixture(); await fixture.store.initialize(); return fixture.store; };

  it('advances everything due once, under the lease, then releases it', async () => {
    const store = await open(); const clock = { value: 1_000 };
    const host = createWorkflowLifecycleHost({ store, definitions: [timer], ...hostOptions, now: () => clock.value });
    const due = await host.runtime.submit(timer, { input: { fireAtMs: 500 }, idempotencyKey: 'due' });
    const lease = (holderId: string) => createWorkflowLeadership({ store, scope, role: 'workflows', holderId, now: () => clock.value });
    const worker = createWorkflowWorker({ units: [host], leadership: lease('function-1'), now: () => clock.value });
    const report = await worker.runOnce({ budgetMs: 10_000 });
    expect(report).toMatchObject({ leader: true, completedSweep: true, held: false, failures: [] });
    expect(report.passes).toBeGreaterThanOrEqual(1);
    expect(await host.runtime.inspect(due.id)).toMatchObject({ status: 'succeeded' });
    // Released at the end, so the next invocation, anywhere, takes over at once.
    expect(await lease('function-2').acquire()).toMatchObject({ leader: true });
    expect(worker.status()).toMatchObject({ running: false, leader: false });
    await host.close();
  });

  it('does nothing and returns at once while another replica holds the lease', async () => {
    const store = await open(); const clock = { value: 1_000 };
    const host = createWorkflowLifecycleHost({ store, definitions: [timer], ...hostOptions, now: () => clock.value });
    const due = await host.runtime.submit(timer, { input: { fireAtMs: 500 }, idempotencyKey: 'due' });
    const lease = (holderId: string) => createWorkflowLeadership({ store, scope, role: 'workflows', holderId, now: () => clock.value });
    expect(await lease('long-running').acquire()).toMatchObject({ leader: true });
    const report = await createWorkflowWorker({ units: [host], leadership: lease('function'), now: () => clock.value }).runOnce();
    expect(report).toMatchObject({ leader: false, passes: 0, completedSweep: false });
    expect(await host.runtime.inspect(due.id)).toMatchObject({ status: 'running' });
    await host.close();
  });

  it('stops starting passes when the budget runs out, and says the sweep is incomplete', async () => {
    const clock = { value: 0 };
    const { unit, counter } = scriptedUnit(() => ({ completedSweep: false }), () => { clock.value += 400; });
    const report = await createWorkflowWorker({ units: [unit], now: () => clock.value }).runOnce({ budgetMs: 1_000 });
    expect(report).toMatchObject({ leader: true, completedSweep: false, failures: [] });
    expect(counter.passes).toBe(3);
  });

  it('reports a failed pass and a held fleet without looping on them', async () => {
    const failing = scriptedUnit(() => { throw new MayuraError('STORAGE_UNAVAILABLE', 'down'); });
    const held = scriptedUnit(() => ({ completedSweep: false, held: true }));
    const done = scriptedUnit(() => ({ completedSweep: true }));
    const report = await createWorkflowWorker({ units: [failing.unit, held.unit, done.unit] }).runOnce();
    expect(report).toMatchObject({ completedSweep: false, held: true, failures: ['STORAGE_UNAVAILABLE'], passes: 3 });
    expect([failing.counter.passes, held.counter.passes, done.counter.passes]).toEqual([1, 1, 1]);
  });

  it('stops at once when the lease is lost between passes', async () => {
    const clock = { value: 0 }; let acquisitions = 0; let released = 0;
    const leadership: WorkflowLeadership = {
      acquire: async () => ({ leader: ++acquisitions === 1, fence: 1, holderId: 'x', expiresAtMs: 0 }) as never,
      release: async () => { released++; }, isLeader: () => false,
    } as unknown as WorkflowLeadership;
    const { unit, counter } = scriptedUnit(() => ({ completedSweep: false }), () => { clock.value += 5_000; });
    const report = await createWorkflowWorker({ units: [unit], leadership, now: () => clock.value, renewIntervalMs: 4_000 }).runOnce({ budgetMs: 60_000 });
    expect(counter.passes).toBe(1); expect(acquisitions).toBe(2); expect(report.completedSweep).toBe(false);
    expect(released).toBe(0); // it no longer holds the lease, so it must not release another holder's
  });

  it('refuses units that cannot run once, and a worker that is already running', async () => {
    const plain: WorkflowWorkerUnit = { start: () => {}, stop: async () => {}, drain: async () => ({ drained: true, interrupted: 0 }) };
    await expect(createWorkflowWorker({ units: [plain] }).runOnce()).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    const { unit } = scriptedUnit(() => ({ completedSweep: true }));
    await expect(createWorkflowWorker({ units: [unit] }).runOnce({ budgetMs: 10 })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    const started = createWorkflowWorker({ units: [unit], renewIntervalMs: 100 }); started.start();
    await expect(started.runOnce()).rejects.toMatchObject({ code: 'CONFLICT' });
    await started.drain({ timeoutMs: 1_000 });
  });
});

describe('stored sweep positions', () => {
  let fixture: WorkflowFixture | undefined;
  afterEach(async () => { await fixture?.store.close(); await fixture?.cleanup(); fixture = undefined; });

  it('lets each new process continue the sweep where the last one stopped', async () => {
    fixture = await sqliteFixture(); await fixture.store.initialize(); const store = fixture.store; const clock = { value: 1_000 };
    // One run per cycle, and runs that stay active (their timers are far off), so only a stored position moves on.
    const host = () => createWorkflowLifecycleHost({ store, definitions: [timer], ...hostOptions, now: () => clock.value, pageLimit: 1, maxPagesPerCycle: 1 });
    const setup = host();
    for (const key of ['a', 'b', 'c']) {
      const run = await setup.runtime.submit(timer, { input: { fireAtMs: 10_000_000 }, idempotencyKey: key });
      expect(await setup.runtime.runUntilSettled(timer, run.id)).toMatchObject({ status: 'waiting' });
    }
    // The sweep order: the index read to its end (one scan reads a bounded number of shards).
    const order: string[] = []; let cursor: Parameters<typeof setup.runtime.scan>[0] extends infer C ? C extends { cursor?: infer K } ? K : never : never = null;
    do { const page = await setup.runtime.scan({ cursor, limit: 3 }); order.push(...page.candidates.map(candidate => candidate.runId)); cursor = page.nextCursor; } while (cursor);
    expect(order).toHaveLength(3);
    await setup.close();
    const seen: string[] = [];
    for (let process = 0; process < 3; process++) {
      // Each process cycles until it reaches a run (a cycle may read only empty index shards), then stops.
      const fresh = host(); let first: string | undefined;
      for (let cycle = 0; cycle < 64 && first === undefined; cycle++) first = (await fresh.runOnce()).outcomes[0]?.runId;
      seen.push(first!); await fresh.close();
    }
    expect(seen).toEqual(order);
  });

  it('starts the sweep over when the stored position cannot be used', async () => {
    fixture = await sqliteFixture(); await fixture.store.initialize(); const store = fixture.store;
    await createSweepPosition(store, { kind: 'lifecycle', scope, catalog: [timer.digest] })
      .save({ format: 1, scope: 'not-this-scope', shard: 0, afterId: '' });
    const host = createWorkflowLifecycleHost({ store, definitions: [timer], ...hostOptions });
    const due = await host.runtime.submit(timer, { input: { fireAtMs: 0 }, idempotencyKey: 'due' });
    expect(await host.runOnce()).toMatchObject({ completedSweep: true });
    expect(await host.runtime.inspect(due.id)).toMatchObject({ status: 'succeeded' });
    await host.close();
  });
});
