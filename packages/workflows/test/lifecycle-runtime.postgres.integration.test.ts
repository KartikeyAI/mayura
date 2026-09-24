import { describe, expect, it } from 'vitest';
import type { JsonValue, Schema } from '@mayura/core';
import { createWorkflowLifecycleFleetRuntime, createWorkflowLifecycleRuntime, defineWorkflowLifecycle,
  type WorkflowLifecycleFleetCursor } from '../src/lifecycle.js';
import { postgresFixture } from './fixtures.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];
const suite = connectionString ? describe : describe.skip;
const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'lifecycle-postgres-test',
  validate: value => ({ value: value as JsonValue }) } };

suite('PostgreSQL format-5 lifecycle integration', () => {
  it('resumes a human request and absolute timer across reopened adapters', async () => {
    const fixture = await postgresFixture(connectionString!); const stores = [fixture.store]; let clock = 100;
    const definition = defineWorkflowLifecycle({ id: 'postgres-lifecycle', version: '1', input: any, output: any, nodes: [
      { kind: 'human', id: 'review', request: { kind: 'information', schemaId: 'fixture/answer', schemaDigest: 'a'.repeat(64),
        prompt: 'Review.', response: any } },
      { kind: 'timer', id: 'wake', dependsOn: ['review'], fireAtMs: { kind: 'input', path: ['fireAtMs'] } },
    ], result: { kind: 'step', stepId: 'review', path: [] } });
    const open = async () => {
      const store = stores.at(-1)!; await store.initialize();
      return createWorkflowLifecycleRuntime({ store, scope: { principalId: 'integration', projectId: 'project' },
        permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0, now: () => clock,
        verifyHuman: async () => ({ id: 'reviewer', projectId: 'project', canApprove: false }) });
    };
    try {
      let runtime = await open(); const submitted = await runtime.submit(definition, { input: { fireAtMs: 500 }, idempotencyKey: 'run' });
      const waiting = await runtime.runUntilSettled(definition, submitted.id);
      const requestDigest = waiting.steps['review']?.kind === 'human' ? waiting.steps['review'].requestDigest! : '';
      runtime.close(); await stores.at(-1)!.close(); stores.push(fixture.reopen()); runtime = await open();
      await runtime.respond(definition, { id: submitted.id, nodeId: 'review', requestDigest, commandId: 'answer', credential: 'opaque', value: { accepted: true } });
      expect(await runtime.runUntilSettled(definition, submitted.id)).toMatchObject({ status: 'waiting', nextWakeAtMs: 500 });
      runtime.close(); await stores.at(-1)!.close(); stores.push(fixture.reopen()); clock = 500; runtime = await open();
      expect(await runtime.runUntilSettled(definition, submitted.id)).toMatchObject({ status: 'succeeded', output: { accepted: true }, nextWakeAtMs: null });
      runtime.close();
    } finally { await Promise.allSettled(stores.map(store => store.close())); await fixture.cleanup(); }
  });

  it('rediscovers and advances a due fleet run after reopening PostgreSQL', async () => {
    const fixture = await postgresFixture(connectionString!); const stores = [fixture.store]; let clock = 100;
    const timer = defineWorkflowLifecycle({ id: 'postgres-fleet', version: '1', input: any, output: any,
      nodes: [{ kind: 'timer', id: 'wake', fireAtMs: { kind: 'input', path: ['fireAtMs'] } }],
      result: { kind: 'step', stepId: 'wake', path: [] } });
    const open = async () => { const store = stores.at(-1)!; await store.initialize(); return createWorkflowLifecycleFleetRuntime({
      store, scope: { principalId: 'fleet', projectId: 'project' }, permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0, now: () => clock,
    }); };
    const advance = async (runtime: ReturnType<typeof createWorkflowLifecycleFleetRuntime>) => {
      let cursor: WorkflowLifecycleFleetCursor | null = null;
      for (let page = 0; page < 9; page++) {
        const report = await runtime.runPage([timer], { cursor, maxShardReads: 32 });
        if (report.outcomes.length) return report.outcomes[0]!;
        cursor = report.page.nextCursor; if (!cursor) break;
      }
      throw new Error('fixture');
    };
    try {
      let runtime = await open(); const submitted = await runtime.submit(timer, { input: { fireAtMs: 500 }, idempotencyKey: 'run' });
      expect(await advance(runtime)).toEqual({ kind: 'advanced', runId: submitted.id, status: 'waiting' });
      runtime.close(); await stores.at(-1)!.close(); stores.push(fixture.reopen()); clock = 500; runtime = await open();
      expect(await advance(runtime)).toEqual({ kind: 'advanced', runId: submitted.id, status: 'succeeded' }); runtime.close();
    } finally { await Promise.allSettled(stores.map(store => store.close())); await fixture.cleanup(); }
  });
});
