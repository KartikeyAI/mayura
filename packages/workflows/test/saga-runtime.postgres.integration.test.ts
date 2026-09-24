import { describe, expect, it } from 'vitest';
import type { JsonValue, Schema } from '@mayura/core';
import { defineTool } from '@mayura/tools';
import { defineWorkflowLifecycle } from '../src/lifecycle.js';
import { createWorkflowSagaRuntime, defineWorkflowSaga } from '../src/sagas.js';
import { postgresFixture } from './fixtures.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL'];
const suite = connectionString ? describe : describe.skip;
const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'saga-postgres-test',
  validate: value => ({ value: value as JsonValue }) } };

suite('PostgreSQL workflow saga integration', () => {
  it('repairs stable child identity after adapter reopen and completes compensation', async () => {
    const fixture = await postgresFixture(connectionString!); const stores = [fixture.store]; const effects: string[] = [];
    const workflow = (id: string, costMicros: number, execute: (input: JsonValue) => JsonValue | Promise<JsonValue>) => {
      const tool = defineTool({ id: `postgres-saga/${id}`, version: '1', description: id, input: any, output: any,
        effects: 'none', capabilities: [], costMicros, execute });
      return defineWorkflowLifecycle({ id, version: '1', input: any, output: any,
        nodes: [{ kind: 'tool', id: 'execute', tool, input: { kind: 'input', path: [] } }],
        result: { kind: 'step', stepId: 'execute', path: [] } });
    };
    const reserve = workflow('reserve', 1, input => { effects.push('reserve'); return input; });
    const release = workflow('release', 1, input => { effects.push('release'); return input; });
    const fail = workflow('fail', 1, async () => { throw new Error('private'); });
    const definition = defineWorkflowSaga({ id: 'postgres-saga', version: '1', input: any, output: any, steps: [
      { id: 'reserve', forward: reserve, input: { kind: 'input', path: [] },
        compensation: { workflow: release, input: { kind: 'step', stepId: 'reserve', path: [] } } },
      { id: 'fail', forward: fail, input: { kind: 'step', stepId: 'reserve', path: [] } },
    ], result: { kind: 'step', stepId: 'fail', path: [] } });
    const options = { scope: { principalId: 'integration', projectId: 'project' }, permissions: { allow: [
      'tool:postgres-saga/reserve', 'tool:postgres-saga/release', 'tool:postgres-saga/fail'] },
      policyVersion: '1', maxCostMicros: 3 } as const;
    try {
      await stores[0]!.initialize(); let runtime = createWorkflowSagaRuntime({ store: stores[0]!, ...options });
      const submitted = await runtime.submit(definition, { input: { order: 1 }, idempotencyKey: 'order' });
      runtime.close(); await stores[0]!.close(); stores.push(fixture.reopen()); await stores[1]!.initialize();
      runtime = createWorkflowSagaRuntime({ store: stores[1]!, ...options });
      expect(await runtime.runUntilSettled(definition, submitted.id)).toMatchObject({ status: 'compensated',
        budget: { spentMicros: 3 }, steps: { reserve: { status: 'compensated' }, fail: { status: 'failed' } } });
      expect(effects).toEqual(['reserve', 'release']); runtime.close();
    } finally { await Promise.allSettled(stores.map(store => store.close())); await fixture.cleanup(); }
  });
});
