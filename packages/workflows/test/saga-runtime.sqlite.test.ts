import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JsonValue, Schema } from '@mayura/core';
import { defineTool } from '@mayura/tools';
import { defineWorkflowLifecycle } from '../src/lifecycle.js';
import { createWorkflowSagaRuntime, defineWorkflowSaga } from '../src/sagas.js';
import { sqliteFixture, type WorkflowFixture } from './fixtures.js';

const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'saga-test', validate: value => ({ value: value as JsonValue }) } };
const successful = (id: string, costMicros: number, execute: (input: JsonValue) => JsonValue | Promise<JsonValue>) => {
  const tool = defineTool({ id: `saga/${id}`, version: '1', description: id, input: any, output: any,
    effects: 'none', capabilities: [], costMicros, execute });
  return defineWorkflowLifecycle({ id, version: '1', input: any, output: any,
    nodes: [{ kind: 'tool', id: 'execute', tool, input: { kind: 'input', path: [] } }],
    result: { kind: 'step', stepId: 'execute', path: [] } });
};

describe('durable workflow sagas on SQLite', () => {
  let fixture: WorkflowFixture | undefined; let store: WorkflowFixture['store'] | undefined;
  afterEach(async () => { await store?.close(); await fixture?.cleanup(); fixture = undefined; store = undefined; });

  it('recovers across restart and compensates successful children in reverse order', async () => {
    fixture = await sqliteFixture(); store = fixture.store; await store.initialize(); const effects: string[] = [];
    const reserve = successful('reserve', 2, input => { effects.push('reserve'); return { reserved: input }; });
    const release = successful('release', 1, input => { effects.push(`release:${JSON.stringify(input)}`); return null; });
    const failTool = defineTool({ id: 'saga/fail', version: '1', description: 'fail', input: any, output: any,
      effects: 'none', capabilities: [], costMicros: 3, execute: vi.fn(async () => { throw new Error('private'); }) });
    const publish = defineWorkflowLifecycle({ id: 'publish', version: '1', input: any, output: any,
      nodes: [{ kind: 'tool', id: 'execute', tool: failTool, input: { kind: 'input', path: [] } }],
      result: { kind: 'step', stepId: 'execute', path: [] } });
    const saga = defineWorkflowSaga({ id: 'order', version: '1', input: any, output: any, steps: [
      { id: 'reserve', forward: reserve, input: { kind: 'input', path: [] },
        compensation: { workflow: release, input: { kind: 'step', stepId: 'reserve', path: [] } } },
      { id: 'publish', forward: publish, input: { kind: 'step', stepId: 'reserve', path: [] } },
    ], result: { kind: 'step', stepId: 'publish', path: [] } });
    const options = { scope: { principalId: 'operator', projectId: 'project' },
      permissions: { allow: ['tool:saga/reserve', 'tool:saga/release', 'tool:saga/fail'] },
      policyVersion: '1', maxCostMicros: 6 } as const;
    let runtime = createWorkflowSagaRuntime({ store, ...options });
    const submitted = await runtime.submit(saga, { input: { order: 1 }, idempotencyKey: 'order-1' });
    runtime.close(); await store.close(); store = fixture.reopen(); await store.initialize();
    runtime = createWorkflowSagaRuntime({ store, ...options });
    const finished = await runtime.runUntilSettled(saga, submitted.id);
    expect(finished).toMatchObject({ status: 'compensated', output: null, budget: { spentMicros: 6, maxCostMicros: 6 }, steps: {
      reserve: { status: 'compensated', forwardRunId: expect.stringMatching(/^[a-f0-9]{64}$/), compensationRunId: expect.stringMatching(/^[a-f0-9]{64}$/) },
      publish: { status: 'failed', forwardRunId: expect.stringMatching(/^[a-f0-9]{64}$/) },
    } });
    expect(effects).toEqual(['reserve', 'release:{"reserved":{"order":1}}']);
    expect((await runtime.runUntilSettled(saga, submitted.id)).version).toBe(finished.version);
    runtime.close();
  });

  it('exposes waiting lifecycle children and cancels them durably', async () => {
    fixture = await sqliteFixture(); store = fixture.store; await store.initialize();
    const wait = defineWorkflowLifecycle({ id: 'wait-review', version: '1', input: any, output: any,
      nodes: [{ kind: 'human', id: 'review', request: { kind: 'information', schemaId: 'review',
        schemaDigest: 'a'.repeat(64), prompt: 'Review.', response: any } }],
      result: { kind: 'step', stepId: 'review', path: [] } });
    const saga = defineWorkflowSaga({ id: 'review-saga', version: '1', input: any, output: any,
      steps: [{ id: 'review', forward: wait, input: { kind: 'input', path: [] } }],
      result: { kind: 'step', stepId: 'review', path: [] } });
    const runtime = createWorkflowSagaRuntime({ store, scope: { principalId: 'operator', projectId: 'project' },
      permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0 });
    const submitted = await runtime.submit(saga, { input: { draft: 1 }, idempotencyKey: 'review' });
    const waiting = await runtime.runUntilSettled(saga, submitted.id);
    expect(waiting).toMatchObject({ status: 'waiting', steps: { review: { status: 'forward_waiting' } } });
    const childId = waiting.steps['review']!.forwardRunId!;
    expect(await runtime.cancel(submitted.id)).toMatchObject({ status: 'cancelled' });
    expect(await runtime.lifecycle.inspect(childId)).toMatchObject({ status: 'cancelled' });
    runtime.close();
  });
});
