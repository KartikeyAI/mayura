import { describe, expect, it } from 'vitest';
import { createSqliteStore } from '@mayura/storage-sqlite';
import { createPostgresStore } from '@mayura/storage-postgres';
import { createSqliteStore as compatibleSqlite, createPostgresStore as compatiblePostgres } from '@mayura/storage';
import { StorageError, type ExecutionRef, type ExecutionWaitAggregateStore } from '@mayura/storage-contracts';
import type { ExecutionWaitFixture } from './execution-waits-fixtures.js';

/** Verify persisted aggregate, scheduler and completion-wait formats across both import paths. */
export function selectedAdapterCompatibility(name: string, fixtureFactory: () => Promise<ExecutionWaitFixture>): void {
  describe(`${name} selected/compatibility factory reopen`, () => {
    it.each(['compatibility', 'selected'] as const)('preserves data written first through %s, including semantic retries and histories', async firstKind => {
      const fixture = await fixtureFactory();
      const stores: ExecutionWaitAggregateStore[] = [fixture.store];
      const open = (kind: 'compatibility' | 'selected'): ExecutionWaitAggregateStore => {
        const options = fixture.childOptions;
        const store = options.adapter === 'sqlite'
          ? (kind === 'compatibility' ? compatibleSqlite : createSqliteStore)({ filename: options.filename })
          : (kind === 'compatibility' ? compatiblePostgres : createPostgresStore)({ connectionString: options.connectionString, schema: options.schema });
        stores.push(store); return store;
      };
      const initialize = async (store: ExecutionWaitAggregateStore): Promise<void> => {
        await store.initialize(); await store.scheduler.initialize(); await store.workflows.initialize(); await store.executionWaits.initialize();
      };
      try {
        await fixture.store.close();
        const first = open(firstKind); await initialize(first);
        const aggregate = { scope: 'compatibility-scope', id: 'record', idempotencyKey: 'record-key', definitionHash: 'record-definition',
          state: { before: true }, events: [{ type: 'record.created', data: {} }] };
        const record = await first.create(aggregate);
        const jobInput = { scope: 'compatibility-scope', jobId: 'job', reservationKey: 'reservation', runId: 'standalone-run',
          nodeId: 'work', invocationId: 'invocation', definitionHash: 'a'.repeat(64), candidateHash: 'b'.repeat(64),
          intent: { callId: 'call', toolId: 'tool' }, resourceKeys: ['resource'], delayMs: 0 };
        const reserved = await first.scheduler.reserve(jobInput);
        const submission = { manifest: { id: 'compatibility-workflow', version: '1', graph: [{ id: 'join', kind: 'join' as const, dependsOn: [] }],
          result: { kind: 'literal' as const, value: null } },
          policy: { scope: { principalId: 'compatibility', projectId: 'selected-adapters' }, permissions: [], policyVersion: '1',
            maxCostMicros: 0, maxOutputBytes: 65_536, approvalTtlMs: 60_000 }, resources: {}, input: null, idempotencyKey: 'workflow-key' };
        const submitted = await first.workflows.submit(submission);
        const run = submitted.snapshot;
        const workflowKey = { scope: run.record.scope, id: run.record.id, policyHash: run.policyHash };
        const reference: ExecutionRef = { kind: 'scheduled-workflow', runId: run.record.id, definitionHash: run.manifestHash, policyHash: run.policyHash };
        const stream = { scope: run.record.scope, streamId: 'join-stream', policyHash: run.policyHash };
        const waitInput = { ...stream, id: 'completion', targets: [reference] };
        await first.executionWaits.open(stream);
        const pending = await first.executionWaits.register(waitInput);
        const aggregateEvents = await first.events(aggregate.scope, aggregate.id);
        const workflowEvents = await first.events(workflowKey.scope, workflowKey.id);
        const schedulerEvents = await first.scheduler.events({ scope: jobInput.scope, runId: jobInput.runId });
        const waitEvents = await first.executionWaits.events({ ...stream, after: 0 });
        await first.close();

        const second = open(firstKind === 'compatibility' ? 'selected' : 'compatibility'); await initialize(second);
        expect(await second.read(aggregate.scope, aggregate.id)).toEqual(record.record);
        expect(await second.create(aggregate)).toEqual({ ...record, created: false });
        expect(await second.scheduler.reserve(jobInput)).toEqual({ ...reserved, created: false });
        expect((await second.workflows.submit(submission)).snapshot).toEqual(run);
        expect(await second.executionWaits.register(waitInput)).toEqual(pending);
        expect(await second.events(aggregate.scope, aggregate.id)).toEqual(aggregateEvents);
        expect(await second.events(workflowKey.scope, workflowKey.id)).toEqual(workflowEvents);
        expect(await second.scheduler.events({ scope: jobInput.scope, runId: jobInput.runId })).toEqual(schedulerEvents);
        expect(await second.executionWaits.events({ ...stream, after: 0 })).toEqual(waitEvents);
        await expect(second.update({ scope: aggregate.scope, id: aggregate.id, expectedVersion: 2, state: {}, events: [] })).rejects.toBeInstanceOf(StorageError);

        const updated = await second.update({ scope: aggregate.scope, id: aggregate.id, expectedVersion: 1,
          state: { after: true }, events: [{ type: 'record.updated', data: {} }] });
        const cancelledJob = await second.scheduler.cancel({ scope: jobInput.scope, jobId: jobInput.jobId, commandId: 'cancel-job' });
        const cancelledRun = await second.workflows.cancel({ ...workflowKey, expectedVersion: run.record.version, commandId: 'cancel-workflow' });
        expect(await second.executionWaits.drainReady({ ...stream, limit: 1 })).toMatchObject([
          { id: 'completion', status: 'resolved', observations: [{ reference, outcome: 'cancelled' }] },
        ]);
        const resolved = await second.executionWaits.inspect({ ...stream, id: 'completion' });
        const resolvedEvents = await second.executionWaits.events({ ...stream, after: 0 });
        await second.close();

        const third = open(firstKind); await initialize(third);
        expect(await third.read(aggregate.scope, aggregate.id)).toEqual(updated);
        expect(await third.scheduler.read({ scope: jobInput.scope, jobId: jobInput.jobId })).toEqual(cancelledJob);
        expect(await third.workflows.inspect(workflowKey)).toEqual(cancelledRun);
        expect(await third.executionWaits.register(waitInput)).toEqual(resolved);
        expect(await third.executionWaits.drainReady({ ...stream, limit: 1 })).toEqual([]);
        expect(await third.executionWaits.events({ ...stream, after: 0 })).toEqual(resolvedEvents);
      } finally {
        await Promise.all(stores.map(store => store.close()));
        await fixture.cleanup();
      }
    });
  });
}
