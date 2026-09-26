import { afterEach, describe, expect, it } from 'vitest';
import { MayuraError, type JsonValue, type Schema } from '@mayura/core';
import { createWorkflowFleetControl, lifecycleFleetTarget, type WorkflowFleetSweepOutcome, type WorkflowFleetSweepReport,
  type WorkflowFleetTarget } from '../src/fleet-control.js';
import { createWorkflowLifecycleFleetRuntime, createWorkflowLifecycleHost, defineWorkflowLifecycle } from '../src/lifecycle.js';
import { sqliteFixture, type WorkflowFixture } from './fixtures.js';

const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'fleet-control-test', validate: value => ({ value: value as JsonValue }) } };
const timer = defineWorkflowLifecycle({ id: 'fleet-timer', version: '1', input: any, output: any,
  nodes: [{ kind: 'timer', id: 'wake', fireAtMs: { kind: 'input', path: ['fireAtMs'] } }], result: { kind: 'step', stepId: 'wake', path: [] } });
const scope = { principalId: 'operator', projectId: 'project' };

/** In-memory target whose runs and failures are fully controlled by the test. */
function fakeTarget(name: string, runs: Map<string, string>, behavior: { pause?: (runId: string) => void } = {}): WorkflowFleetTarget {
  const status = (runId: string) => { const value = runs.get(runId); if (!value) throw new MayuraError('NOT_FOUND', 'missing'); return { status: value }; };
  return { name,
    discover: async () => ({ runIds: [...runs.keys()].filter(runId => ['running', 'waiting'].includes(runs.get(runId)!)), nextCursor: null }),
    inspect: async runId => status(runId),
    pause: async runId => { behavior.pause?.(runId); if (runs.get(runId) === 'paused') throw new MayuraError('CONFLICT', 'paused'); runs.set(runId, 'paused'); return status(runId); },
    resume: async runId => { if (runs.get(runId) !== 'paused') throw new MayuraError('CONFLICT', 'not paused'); runs.set(runId, 'running'); return status(runId); } };
}
async function sweep(step: (cursor: WorkflowFleetSweepReport['nextCursor']) => Promise<WorkflowFleetSweepReport>): Promise<WorkflowFleetSweepOutcome[]> {
  const outcomes: WorkflowFleetSweepOutcome[] = []; let cursor: WorkflowFleetSweepReport['nextCursor'] = null;
  for (let page = 0; page < 600; page++) { const report = await step(cursor); outcomes.push(...report.outcomes); cursor = report.nextCursor; if (!cursor) return outcomes; }
  throw new Error('Fleet sweep did not finish within its bounded page budget.');
}

describe('durable fleet hold and sweep on SQLite', () => {
  let fixture: WorkflowFixture | undefined; let store: WorkflowFixture['store'] | undefined;
  afterEach(async () => { await store?.close(); await fixture?.cleanup(); fixture = undefined; store = undefined; });
  const open = async (reopen = false) => {
    if (!fixture) fixture = await sqliteFixture(); store = reopen ? fixture.reopen() : fixture.store; await store.initialize(); return store;
  };

  it('persists an idempotent hold and generation across reopen', async () => {
    let control = createWorkflowFleetControl({ store: await open(), scope, now: () => 7 });
    expect(await control.inspect()).toEqual({ held: false, generation: 0, changedAtMs: null });
    expect(await control.hold()).toEqual({ held: true, generation: 1, changedAtMs: 7 }); expect((await control.hold()).generation).toBe(1);
    await store!.close(); control = createWorkflowFleetControl({ store: await open(true), scope });
    expect(await control.isHeld()).toBe(true);
    expect(await control.release()).toMatchObject({ held: false, generation: 1 }); expect((await control.release()).held).toBe(false);
    expect((await control.hold()).generation).toBe(2);
    expect(await createWorkflowFleetControl({ store: store!, scope: { principalId: 'other', projectId: 'project' } }).isHeld()).toBe(false);
  });

  it('pauses only the runs it swept and resumes only those after release', async () => {
    const runtime = createWorkflowLifecycleFleetRuntime({ store: await open(), scope, permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0, now: () => 100 });
    const swept = await runtime.submit(timer, { input: { fireAtMs: 500 }, idempotencyKey: 'swept' });
    const individual = await runtime.submit(timer, { input: { fireAtMs: 500 }, idempotencyKey: 'individual' });
    await runtime.runUntilSettled(timer, swept.id); await runtime.pause(individual.id);
    const control = createWorkflowFleetControl({ store: store!, scope }); const targets = [lifecycleFleetTarget(runtime)];
    await expect(control.sweepPause(targets)).rejects.toMatchObject({ code: 'CONFLICT' });
    await control.hold();
    expect(await sweep(cursor => control.sweepPause(targets, { cursor }))).toEqual([{ target: 'lifecycle', runId: swept.id, outcome: 'paused' }]);
    expect((await runtime.inspect(swept.id)).status).toBe('paused');
    await expect(control.sweepResume(targets)).rejects.toMatchObject({ code: 'CONFLICT' });
    await control.release();
    expect(await sweep(cursor => control.sweepResume(targets, { cursor }))).toEqual([{ target: 'lifecycle', runId: swept.id, outcome: 'resumed' }]);
    expect((await runtime.inspect(swept.id)).status).toBe('waiting'); expect((await runtime.inspect(individual.id)).status).toBe('paused');
    expect(await sweep(cursor => control.sweepResume(targets, { cursor }))).toEqual([]);
    runtime.close();
  });

  it('stops a lifecycle host while held and resumes fleet-paused work after release', async () => {
    const clock = { value: 100 };
    const host = createWorkflowLifecycleHost({ store: await open(), definitions: [timer], scope, permissions: { allow: [] }, policyVersion: '1',
      maxCostMicros: 0, now: () => clock.value, hold: createWorkflowFleetControl({ store: store!, scope }) });
    const control = createWorkflowFleetControl({ store: store!, scope }); const targets = [lifecycleFleetTarget(host.runtime)];
    const run = await host.runtime.submit(timer, { input: { fireAtMs: 500 }, idempotencyKey: 'hosted' });
    expect(await host.runOnce()).toMatchObject({ held: false, completedSweep: true });
    await control.hold(); await sweep(cursor => control.sweepPause(targets, { cursor })); clock.value = 500;
    expect(await host.runOnce()).toEqual({ pages: 0, examined: 0, shardReads: 0, outcomes: [], completedSweep: false, held: true });
    expect((await host.runtime.inspect(run.id)).status).toBe('paused');
    await control.release(); await sweep(cursor => control.sweepResume(targets, { cursor }));
    expect((await host.runOnce()).held).toBe(false); expect((await host.runtime.inspect(run.id)).status).toBe('succeeded');
    await host.close();
    const failing = createWorkflowLifecycleHost({ store: store!, definitions: [timer], scope, permissions: { allow: [] }, policyVersion: '1',
      maxCostMicros: 0, hold: { isHeld: async () => { throw new Error('PRIVATE'); } } });
    await expect(failing.runOnce()).rejects.toBeDefined(); await failing.close();
  });

  it('drops busy runs from the ledger and keeps a pause whose confirmation failed resumable', async () => {
    const control = createWorkflowFleetControl({ store: await open(), scope }); await control.hold();
    const busy = 'a'.repeat(64); const crashed = 'b'.repeat(64);
    const runs = new Map([[busy, 'running'], [crashed, 'running']]); let failConfirm = true;
    const target = fakeTarget('alpha', runs, { pause: runId => { if (runId === busy) throw new MayuraError('CONFLICT', 'in flight'); } });
    const failing: WorkflowFleetTarget = { ...target, pause: async runId => {
      const result = await target.pause(runId); if (runId === crashed && failConfirm) { failConfirm = false; throw new MayuraError('TIMEOUT', 'lost acknowledgement'); } return result; } };
    expect(await sweep(cursor => control.sweepPause([failing], { cursor }))).toEqual([
      { target: 'alpha', runId: busy, outcome: 'busy' }, { target: 'alpha', runId: crashed, outcome: 'failed', code: 'TIMEOUT' }]);
    await control.release();
    expect(await sweep(cursor => control.sweepResume([target], { cursor }))).toEqual([{ target: 'alpha', runId: crashed, outcome: 'resumed' }]);
    expect(runs.get(crashed)).toBe('running'); expect(runs.get(busy)).toBe('running');
  });

  it('pages through retained ledger entries without revisiting them', async () => {
    const control = createWorkflowFleetControl({ store: await open(), scope }); await control.hold();
    const ids = ['1', '2', '3'].map(suffix => `${'c'.repeat(63)}${suffix}`); /* one ledger shard */ const runs = new Map(ids.map(id => [id, 'running']));
    await sweep(cursor => control.sweepPause([fakeTarget('alpha', runs)], { cursor })); await control.release();
    const reports: WorkflowFleetSweepReport[] = []; let cursor: WorkflowFleetSweepReport['nextCursor'] = null;
    do { const report = await control.sweepResume([fakeTarget('beta', new Map())], { cursor, limit: 1 }); reports.push(report); cursor = report.nextCursor; } while (cursor && reports.length < 300);
    expect(reports.flatMap(report => report.outcomes)).toEqual(ids.map(runId => ({ target: 'alpha', runId, outcome: 'unregistered' })));
    expect(await sweep(cursor => control.sweepResume([fakeTarget('alpha', runs)], { cursor }))).toEqual(ids.map(runId => ({ target: 'alpha', runId, outcome: 'resumed' })));
    await expect(control.sweepResume([fakeTarget('alpha', runs)], { cursor: { format: 1, scope: 'f'.repeat(64), phase: 'resume', position: 0, inner: null } }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
