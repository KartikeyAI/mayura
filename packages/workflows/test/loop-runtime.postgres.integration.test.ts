import { describe, expect, it } from 'vitest';
import type { JsonValue, Schema } from '@mayura/core';
import { defineTool } from '@mayura/tools';
import { defineWorkflowLifecycle } from '../src/lifecycle.js';
import { createWorkflowLoopRuntime, defineWorkflowLoop } from '../src/loops.js';
import { postgresFixture } from './fixtures.js';

const connectionString = process.env['MAYURA_TEST_POSTGRES_URL']; const suite = connectionString ? describe : describe.skip;
const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'loop-postgres-test', validate: value => ({ value: value as JsonValue }) } };
const number: Schema<number> = { '~standard': { version: 1, vendor: 'loop-postgres-test', validate: value => typeof value === 'number' ? { value } : { issues: [] } } };

suite('PostgreSQL workflow loop integration', () => {
  it('continues deterministic iteration children after adapter reopen', async () => {
    const fixture = await postgresFixture(connectionString!); const stores = [fixture.store]; let calls = 0;
    const tool = defineTool({ id: 'postgres-loop/increment', version: '1', description: 'increment', input: any, output: any,
      effects: 'none', capabilities: [], costMicros: 1, execute: input => { calls += 1; const value = Number((input as { value: number }).value) + 1;
        return { value, continue: value < 2 }; } });
    const body = defineWorkflowLifecycle({ id: 'postgres-loop-body', version: '1', input: any, output: any,
      nodes: [{ kind: 'tool', id: 'increment', tool, input: { kind: 'input', path: [] } }],
      result: { kind: 'step', stepId: 'increment', path: [] } });
    const definition = defineWorkflowLoop({ id: 'postgres-loop', version: '1', input: any, output: number,
      body, maxIterations: 3, initial: { kind: 'input', path: [] }, next: { kind: 'current', path: [] },
      continueWhen: { kind: 'current', path: ['continue'] }, result: { kind: 'current', path: ['value'] } });
    const options = { scope: { principalId: 'integration', projectId: 'project' },
      permissions: { allow: ['tool:postgres-loop/increment'] }, policyVersion: '1', maxCostMicros: 3 } as const;
    try {
      await stores[0]!.initialize(); let runtime = createWorkflowLoopRuntime({ store: stores[0]!, ...options });
      const submitted = await runtime.submit(definition, { input: { value: 0 }, idempotencyKey: 'loop' });
      runtime.close(); await stores[0]!.close(); stores.push(fixture.reopen()); await stores[1]!.initialize();
      runtime = createWorkflowLoopRuntime({ store: stores[1]!, ...options });
      expect(await runtime.runUntilSettled(definition, submitted.id)).toMatchObject({ status: 'succeeded', iteration: 2,
        output: 2, budget: { spentMicros: 2 } }); expect(calls).toBe(2); runtime.close();
    } finally { await Promise.allSettled(stores.map(store => store.close())); await fixture.cleanup(); }
  });
});
