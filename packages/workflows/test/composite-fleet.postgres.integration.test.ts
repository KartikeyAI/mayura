import { describe, expect, it } from 'vitest';
import type { JsonValue, Schema } from '@mayura/core';
import { createWorkflowCompositeFleetRuntime, type WorkflowCompositeCursor } from '../src/composites.js';
import { defineWorkflowLifecycle } from '../src/lifecycle.js';
import { defineWorkflowSaga } from '../src/sagas.js';
import { postgresFixture } from './fixtures.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL']; const suite = connectionString ? describe : describe.skip;
const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'composite-postgres-test', validate: value => ({ value: value as JsonValue }) } };

suite('PostgreSQL composite workflow fleet', () => {
  it('rediscovers a saga parent after reopening the adapter', async () => {
    const fixture = await postgresFixture(connectionString!); const stores = [fixture.store];
    const child = defineWorkflowLifecycle({ id: 'postgres-composite-child', version: '1', input: any, output: any,
      nodes: [{ kind: 'join', id: 'done', dependsOn: [] }], result: { kind: 'input', path: [] } });
    const saga = defineWorkflowSaga({ id: 'postgres-composite', version: '1', input: any, output: any,
      steps: [{ id: 'child', forward: child, input: { kind: 'input', path: [] } }], result: { kind: 'step', stepId: 'child', path: [] } });
    const options = { scope: { principalId: 'integration', projectId: 'project' }, permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0 } as const;
    try {
      await stores[0]!.initialize(); let runtime = createWorkflowCompositeFleetRuntime({ store: stores[0]!, ...options });
      const submitted = await runtime.submitSaga(saga, { input: { value: 1 }, idempotencyKey: 'saga' });
      runtime.close(); await stores[0]!.close(); stores.push(fixture.reopen()); await stores[1]!.initialize(); runtime = createWorkflowCompositeFleetRuntime({ store: stores[1]!, ...options });
      let cursor: WorkflowCompositeCursor | null = null; let completed = false;
      do { const report = await runtime.runPage({ sagas: [saga] }, { cursor, maxShardReads: 64 });
        completed ||= report.outcomes.some(outcome => outcome.kind === 'advanced' && outcome.runId === submitted.id && outcome.status === 'succeeded'); cursor = report.page.nextCursor; } while (cursor);
      expect(completed).toBe(true); runtime.close();
    } finally { await Promise.allSettled(stores.map(store => store.close())); await fixture.cleanup(); }
  });
});
