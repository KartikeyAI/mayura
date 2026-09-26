import { describe, expect, it } from 'vitest';
import type { JsonValue, Schema } from '@mayura/core';
import { createWorkflowFleetControl, lifecycleFleetTarget, type WorkflowFleetSweepCursor, type WorkflowFleetSweepOutcome } from '../src/fleet-control.js';
import { createWorkflowLifecycleFleetRuntime, defineWorkflowLifecycle } from '../src/lifecycle.js';
import { postgresFixture } from './fixtures.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];
const suite = connectionString ? describe : describe.skip;
const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'fleet-postgres-test', validate: value => ({ value: value as JsonValue }) } };
const timer = defineWorkflowLifecycle({ id: 'fleet-postgres', version: '1', input: any, output: any,
  nodes: [{ kind: 'timer', id: 'wake', fireAtMs: { kind: 'input', path: ['fireAtMs'] } }], result: { kind: 'step', stepId: 'wake', path: [] } });
const scope = { principalId: 'operator', projectId: 'project' };

suite('PostgreSQL fleet hold and sweep', () => {
  it('keeps the hold and ledger durable across reopened adapters', async () => {
    const fixture = await postgresFixture(connectionString!); const stores = [fixture.store];
    const open = async () => { const store = stores.at(-1)!; await store.initialize();
      return { store, runtime: createWorkflowLifecycleFleetRuntime({ store, scope, permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0, now: () => 100 }) }; };
    const sweep = async (step: (cursor: WorkflowFleetSweepCursor | null) => Promise<{ outcomes: readonly WorkflowFleetSweepOutcome[]; nextCursor: WorkflowFleetSweepCursor | null }>) => {
      const outcomes: WorkflowFleetSweepOutcome[] = []; let cursor: WorkflowFleetSweepCursor | null = null;
      do { const page = await step(cursor); outcomes.push(...page.outcomes); cursor = page.nextCursor; } while (cursor); return outcomes;
    };
    try {
      let { store, runtime } = await open(); const run = await runtime.submit(timer, { input: { fireAtMs: 500 }, idempotencyKey: 'run' });
      await runtime.runUntilSettled(timer, run.id); let control = createWorkflowFleetControl({ store, scope });
      await control.hold(); expect(await sweep(cursor => control.sweepPause([lifecycleFleetTarget(runtime)], { cursor })))
        .toEqual([{ target: 'lifecycle', runId: run.id, outcome: 'paused' }]);
      runtime.close(); await store.close(); stores.push(fixture.reopen()); ({ store, runtime } = await open());
      control = createWorkflowFleetControl({ store, scope }); expect(await control.inspect()).toMatchObject({ held: true, generation: 1 });
      await control.release();
      expect(await sweep(cursor => control.sweepResume([lifecycleFleetTarget(runtime)], { cursor }))).toEqual([{ target: 'lifecycle', runId: run.id, outcome: 'resumed' }]);
      expect((await runtime.inspect(run.id)).status).toBe('waiting'); runtime.close();
    } finally { await Promise.allSettled(stores.map(store => store.close())); await fixture.cleanup(); }
  });
});
