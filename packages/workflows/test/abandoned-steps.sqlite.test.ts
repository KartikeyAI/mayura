import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JsonValue, Schema } from '@mayura/core';
import { defineTool } from '@mayura/tools';
import { ABANDONED_STEP_MARGIN_MS } from '../src/abandoned.js';
import { createWorkflowRuntime, defineWorkflow } from '../src/index.js';
import { createWorkflowLifecycleRuntime, defineWorkflowLifecycle } from '../src/lifecycle.js';
import { sqliteFixture, type WorkflowFixture } from './fixtures.js';

const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'abandoned-test', validate: value => ({ value: value as JsonValue }) } };
const TIMEOUT_MS = 60_000;
const pastDeadline = TIMEOUT_MS + ABANDONED_STEP_MARGIN_MS + 1_000;

/** A write tool that enters, counts its effects, then waits until released (or forever), like a process that stopped. */
function blockingTool(options: { receiptThenHang?: boolean } = {}) {
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void; const released = new Promise<void>(resolve => { release = resolve; });
  const counter = { effects: 0 };
  const tool = defineTool({
    id: 'orders.charge', version: '1', description: 'Charge an order.', input: any, output: any,
    effects: 'write', capabilities: [], costMicros: 1, timeoutMs: TIMEOUT_MS,
    execute: async input => {
      counter.effects++; entered();
      if (!options.receiptThenHang) await released;
      return input;
    },
    // The durable receipt is recorded before output guards run; a guard that never returns leaves the step dispatching.
    ...(options.receiptThenHang ? { guards: { output: [{ id: 'hang', check: async () => { entered(); await released; return { decision: 'allow' as const }; } }] } } : {}),
  });
  return { tool, started, release, counter };
}

const settings = { scope: { principalId: 'worker', projectId: 'orders' }, permissions: { allow: ['tool:orders.charge', 'effect:write'] },
  policyVersion: '1', maxCostMicros: 10 };

describe('abandoned dispatching steps, lifecycle workflows', () => {
  let fixture: WorkflowFixture | undefined;
  afterEach(async () => { await fixture?.store.close(); await fixture?.cleanup(); fixture = undefined; });

  const definitionFor = (tool: ReturnType<typeof blockingTool>['tool']) => defineWorkflowLifecycle({ id: 'orders.charge-flow', version: '1',
    input: any, output: any, nodes: [{ kind: 'tool', id: 'charge', tool, input: { kind: 'input', path: [] } }],
    result: { kind: 'step', stepId: 'charge', path: [] } });

  it('settles a step abandoned by another process as unknown after its deadline, and never runs it again', async () => {
    fixture = await sqliteFixture(); await fixture.store.initialize(); const store = fixture.store;
    const clock = { value: Date.now() }; const blocking = blockingTool(); const definition = definitionFor(blocking.tool);
    const stopped = createWorkflowLifecycleRuntime({ store, ...settings, now: () => clock.value });
    const survivor = createWorkflowLifecycleRuntime({ store, ...settings, now: () => clock.value });
    const run = await stopped.submit(definition, { input: { orderId: 'o-1' }, idempotencyKey: 'o-1' });
    const inFlight = stopped.runUntilSettled(definition, run.id); await blocking.started;

    // Before the deadline, another process leaves it alone: the first process may still be working.
    const early = await survivor.runUntilSettled(definition, run.id);
    expect(early.status).toBe('running'); expect(early.steps['charge']).toMatchObject({ status: 'dispatching' });

    clock.value += pastDeadline;
    const settled = await survivor.runUntilSettled(definition, run.id);
    expect(settled.status).toBe('outcome_unknown'); expect(settled.steps['charge']).toMatchObject({ status: 'unknown' });
    expect(blocking.counter.effects).toBe(1);
    const events = (await survivor.events(run.id)).map(event => event.type);
    expect(events).toContain('lifecycle.step.abandoned');

    // If the first process comes back, its late result is dropped: the step stays unknown for an operator to reconcile.
    blocking.release(); await inFlight;
    expect(await survivor.inspect(run.id)).toMatchObject({ status: 'outcome_unknown', steps: { charge: { status: 'unknown' } } });
    expect(blocking.counter.effects).toBe(1);
    stopped.close(); survivor.close();
  });

  it('never settles a step this process is still running, however late it is', async () => {
    fixture = await sqliteFixture(); await fixture.store.initialize(); const store = fixture.store;
    const clock = { value: Date.now() }; const blocking = blockingTool(); const definition = definitionFor(blocking.tool);
    const runtime = createWorkflowLifecycleRuntime({ store, ...settings, now: () => clock.value });
    const run = await runtime.submit(definition, { input: { orderId: 'o-2' }, idempotencyKey: 'o-2' });
    const inFlight = runtime.runUntilSettled(definition, run.id); await blocking.started;
    clock.value += pastDeadline;
    const again = await runtime.runUntilSettled(definition, run.id);
    expect(again.steps['charge']).toMatchObject({ status: 'dispatching' });
    blocking.release();
    expect(await inFlight).toMatchObject({ status: 'succeeded', steps: { charge: { status: 'succeeded' } } });
    expect(blocking.counter.effects).toBe(1);
    runtime.close();
  });

  it('settles as blocked when the receipt shows the effect succeeded', async () => {
    fixture = await sqliteFixture(); await fixture.store.initialize(); const store = fixture.store;
    const clock = { value: Date.now() }; const blocking = blockingTool({ receiptThenHang: true }); const definition = definitionFor(blocking.tool);
    const stopped = createWorkflowLifecycleRuntime({ store, ...settings, now: () => clock.value });
    const survivor = createWorkflowLifecycleRuntime({ store, ...settings, now: () => clock.value });
    const run = await stopped.submit(definition, { input: { orderId: 'o-3' }, idempotencyKey: 'o-3' });
    const inFlight = stopped.runUntilSettled(definition, run.id); await blocking.started;
    const receiptOf = async () => { const step = (await survivor.inspect(run.id)).steps['charge']; return step?.kind === 'tool' ? step.receipt?.execution : undefined; };
    for (let attempt = 0; attempt < 200 && await receiptOf() !== 'succeeded'; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    clock.value += pastDeadline;
    expect(await survivor.runUntilSettled(definition, run.id)).toMatchObject({ status: 'blocked', steps: { charge: { status: 'blocked' } } });
    blocking.release(); await inFlight; stopped.close(); survivor.close();
  });
});

describe('abandoned dispatching steps, format-2 workflows', () => {
  let fixture: WorkflowFixture | undefined;
  afterEach(async () => { vi.restoreAllMocks(); await fixture?.store.close(); await fixture?.cleanup(); fixture = undefined; });

  it('settles a step abandoned by another process after its deadline, and never runs it again', async () => {
    fixture = await sqliteFixture(); await fixture.store.initialize(); const store = fixture.store;
    const blocking = blockingTool();
    const definition = defineWorkflow({ id: 'orders.charge-v2', version: '1', input: any, output: any,
      nodes: [{ kind: 'tool', id: 'charge', tool: blocking.tool, input: { kind: 'input', path: [] } }],
      result: { kind: 'step', stepId: 'charge', path: [] } });
    const stopped = createWorkflowRuntime({ store, ...settings }); const survivor = createWorkflowRuntime({ store, ...settings });
    const run = await stopped.submit(definition, { input: { orderId: 'o-4' }, idempotencyKey: 'o-4' });
    const inFlight = stopped.runUntilSettled(definition, run.id); await blocking.started;
    expect((await survivor.runUntilSettled(definition, run.id)).steps['charge']).toMatchObject({ status: 'dispatching' });

    const real = Date.now.bind(Date); vi.spyOn(Date, 'now').mockImplementation(() => real() + pastDeadline);
    const settled = await survivor.runUntilSettled(definition, run.id);
    expect(settled).toMatchObject({ status: 'outcome_unknown', steps: { charge: { status: 'unknown' } } });
    expect(blocking.counter.effects).toBe(1);
    vi.restoreAllMocks(); blocking.release(); await inFlight;
    expect(await survivor.inspect(run.id)).toMatchObject({ status: 'outcome_unknown', steps: { charge: { status: 'unknown' } } });
    stopped.close(); survivor.close();
  });
});
