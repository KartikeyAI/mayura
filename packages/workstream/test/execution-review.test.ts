import { describe, expect, it } from 'vitest';
import type { JsonValue, Schema } from '@mayura/core';
import { createSqliteStore } from '@mayura/storage';
import type { ExecutionWaitAggregateStore, ExecutionWaitStore, StoredEvent } from '@mayura/storage-contracts';
import { createScheduledWorkflowRuntime, defineWorkflow } from '../../workflows/src/index.js';
import { createExecutionWorkStream, type ExecutionWorkStream } from '../src/executions.js';

const schema: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'execution-review', validate: value => ({ value: value as JsonValue }) } };

const timestamp = '2026-09-20T00:00:00.000Z';
function event(sequence: number, type: string, createdAt = timestamp): StoredEvent {
  return { sequence, type, createdAt, data: type === 'stream.created' ? {} : { waitId: 'join' } };
}
/** Deliberately untrusted custom responses exercise the public facade, not SQL checks. */
function eventStream(page: readonly StoredEvent[]): ExecutionWorkStream {
  const unused = async (): Promise<never> => { throw new Error('Unexpected adapter command'); };
  const executionWaits: ExecutionWaitStore = {
    initialize: async () => undefined, open: async () => undefined, materialize: unused,
    register: unused, inspect: unused, cancel: unused, drainReady: unused, events: async () => page,
  };
  return createExecutionWorkStream({ store: { executionWaits } as ExecutionWaitAggregateStore,
    scope: { principalId: 'principal', projectId: 'project' }, policyHash: 'a'.repeat(64), streamId: 'event-review' });
}

describe('execution wait independent integrity review', () => {
  it.each([
    { principalId: 'tenant:operator@example.org', projectId: 'production project' },
    { principalId: '操作员', projectId: 'प्रोजेक्ट/工程' },
  ])('accepts the exact verified scope already accepted by scheduled workflow reference: %j', async scope => {
    const store = createSqliteStore({ filename: ':memory:' });
    const worker = createScheduledWorkflowRuntime({ store, scope, workerId: 'review-worker', policyVersion: 'review-v1',
      permissions: { allow: [] }, maxCostMicros: 0 });
    let stream: ExecutionWorkStream | undefined;
    try {
      await store.initialize();
      const definition = defineWorkflow({ id: 'scope-review', version: '1', input: schema, output: schema,
        nodes: [{ id: 'ready', kind: 'join', dependsOn: [] }], result: { kind: 'literal', value: true } });
      const submitted = await worker.submit(definition, { input: null, idempotencyKey: 'scope-review' });
      const before = await worker.inspect(submitted.id); const history = await worker.events(submitted.id);
      const reference = await worker.reference(submitted.id);
      expect(Object.isFrozen(reference)).toBe(true);
      expect(await worker.inspect(submitted.id)).toEqual(before);
      expect(await worker.events(submitted.id)).toEqual(history);
      stream = createExecutionWorkStream({ store, scope, policyHash: reference.policyHash, streamId: 'scope-review' });
      await stream.initialize();
      expect(await stream.register({ id: 'join', targets: [reference] })).toMatchObject({ status: 'waiting', targets: [reference] });
      expect((await worker.runUntilSettled(definition, submitted.id)).status).toBe('succeeded');
      expect(await stream.drainReady()).toMatchObject([{ status: 'resolved', observations: [{ reference, outcome: 'succeeded' }] }]);
    } finally { await stream?.close(); await worker.close(); await store.close(); }
  });

  it.each(['wait.resolved', 'wait.cancelled'])('rejects a full-prefix %s event without any registration', async type => {
    const stream = eventStream([event(1, 'stream.created'), event(2, type)]);
    try {
      await stream.initialize();
      await expect(stream.events()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    } finally { await stream.close(); }
  });

  it.each([
    ['wait.registered', 'wait.registered'],
    ['wait.resolved', 'wait.resolved'],
    ['wait.resolved', 'wait.cancelled'],
    ['wait.cancelled', 'wait.resolved'],
    ['wait.resolved', 'wait.registered'],
  ])('rejects impossible same-page transitions %s then %s even after an earlier cursor', async (first, second) => {
    const stream = eventStream([event(5, first!), event(6, second!)]);
    try {
      await stream.initialize();
      await expect(stream.events(4)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    } finally { await stream.close(); }
  });

  it('rejects decreasing canonical event timestamps without guessing events before the cursor', async () => {
    const stream = eventStream([event(5, 'wait.registered', '2026-09-20T00:00:01.000Z'), event(6, 'wait.resolved')]);
    try {
      await stream.initialize();
      await expect(stream.events(4)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    } finally { await stream.close(); }
  });

  it.each(['wait.resolved', 'wait.cancelled'])('accepts %s after a cursor whose registration was on an earlier page', async type => {
    const page = [event(5, type)]; const stream = eventStream(page);
    try {
      await stream.initialize(); expect(await stream.events(4)).toEqual(page);
    } finally { await stream.close(); }
  });

  it('accepts a complete valid lifecycle whose events share one storage-clock timestamp', async () => {
    const page = [event(1, 'stream.created'), event(2, 'wait.registered'), event(3, 'wait.resolved')];
    const stream = eventStream(page);
    try {
      await stream.initialize(); expect(await stream.events()).toEqual(page);
    } finally { await stream.close(); }
  });
});
