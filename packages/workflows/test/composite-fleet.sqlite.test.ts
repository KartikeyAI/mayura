import { afterEach, describe, expect, it } from 'vitest';
import type { JsonValue, Schema } from '@mayura/core';
import { createWorkflowCompositeFleetRuntime, createWorkflowCompositeHost, type WorkflowCompositeCursor } from '../src/composites.js';
import { defineWorkflowLifecycle } from '../src/lifecycle.js';
import { defineWorkflowLoop } from '../src/loops.js';
import { defineWorkflowSaga } from '../src/sagas.js';
import { sqliteFixture, type WorkflowFixture } from './fixtures.js';

const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'composite-fleet-test', validate: value => ({ value: value as JsonValue }) } };
const body = defineWorkflowLifecycle({ id: 'composite-body', version: '1', input: any, output: any,
  nodes: [{ kind: 'join', id: 'done', dependsOn: [] }], result: { kind: 'input', path: [] } });
const saga = defineWorkflowSaga({ id: 'composite-saga', version: '1', input: any, output: any,
  steps: [{ id: 'child', forward: body, input: { kind: 'input', path: [] } }], result: { kind: 'step', stepId: 'child', path: [] } });
const loop = defineWorkflowLoop({ id: 'composite-loop', version: '1', input: any, output: any, body, maxIterations: 2,
  initial: { kind: 'input', path: [] }, next: { kind: 'current', path: [] },
  continueWhen: { kind: 'current', path: ['continue'] }, result: { kind: 'current', path: ['value'] } });

describe('durable composite parent fleet on SQLite', () => {
  let fixture: WorkflowFixture | undefined; let store: WorkflowFixture['store'] | undefined;
  afterEach(async () => { await store?.close(); await fixture?.cleanup(); fixture = undefined; store = undefined; });
  const options = { scope: { principalId: 'composites', projectId: 'project' }, permissions: { allow: [] },
    policyVersion: '1', maxCostMicros: 0 } as const;
  const sweep = async (runtime: ReturnType<typeof createWorkflowCompositeFleetRuntime>) => {
    let cursor: WorkflowCompositeCursor | null = null; const outcomes = [];
    do { const report = await runtime.runPage({ sagas: [saga], loops: [loop] }, { cursor, maxShardReads: 32 });
      outcomes.push(...report.outcomes); cursor = report.page.nextCursor; } while (cursor);
    return outcomes;
  };

  it('rediscovers and completes saga and loop parents after adapter reopen', async () => {
    fixture = await sqliteFixture(); store = fixture.store; await store.initialize(); let runtime = createWorkflowCompositeFleetRuntime({ store, ...options });
    const sagaRun = await runtime.submitSaga(saga, { input: { value: 1 }, idempotencyKey: 'saga' });
    const loopRun = await runtime.submitLoop(loop, { input: { value: 2, continue: false }, idempotencyKey: 'loop' });
    runtime.close(); await store.close(); store = fixture.reopen(); await store.initialize(); runtime = createWorkflowCompositeFleetRuntime({ store, ...options });
    const outcomes = await sweep(runtime); expect(outcomes).toEqual(expect.arrayContaining([
      { kind: 'advanced', workflowKind: 'saga', runId: sagaRun.id, status: 'succeeded' },
      { kind: 'advanced', workflowKind: 'loop', runId: loopRun.id, status: 'succeeded' },
    ]));
    expect((await runtime.scan({ maxShardReads: 256 })).candidates).toEqual([]); runtime.close();
  });

  it('keeps unknown definitions indexed and rejects cross-scope cursors', async () => {
    fixture = await sqliteFixture(); store = fixture.store; await store.initialize(); const runtime = createWorkflowCompositeFleetRuntime({ store, ...options });
    const submitted = await runtime.submitSaga(saga, { input: null, idempotencyKey: 'unknown' });
    let cursor: WorkflowCompositeCursor | null = null; let skipped = false;
    do { const report = await runtime.runPage({}, { cursor, maxShardReads: 64 }); skipped ||= report.outcomes.some(outcome => outcome.kind === 'skipped' && outcome.runId === submitted.id); cursor = report.page.nextCursor; } while (cursor);
    expect(skipped).toBe(true); const page = await runtime.scan({ maxShardReads: 1 });
    await expect(runtime.scan({ cursor: { ...page.nextCursor!, scope: 'a'.repeat(64) } })).rejects.toMatchObject({ code: 'INVALID_INPUT' }); runtime.close();
  });

  it('hosts composite continuation with single-flight bounded sweeps', async () => {
    fixture = await sqliteFixture(); store = fixture.store; await store.initialize();
    const host = createWorkflowCompositeHost({ store, ...options, sagaDefinitions: [saga], loopDefinitions: [loop], intervalMs: 5, maxBackoffMs: 20 });
    const submitted = await host.runtime.submitSaga(saga, { input: { value: 1 }, idempotencyKey: 'hosted' });
    const first = host.runOnce(); expect(host.runOnce()).toBe(first); await first; host.start();
    for (let attempt = 0; attempt < 100 && (await host.runtime.sagas.inspect(submitted.id)).status !== 'succeeded'; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(await host.runtime.sagas.inspect(submitted.id)).toMatchObject({ status: 'succeeded' }); await host.close();
    expect(host.status().running).toBe(false); expect(await store.read('missing', 'missing')).toBeUndefined();
  });

  it('drives no composite parent while the durable fleet hold is set', async () => {
    fixture = await sqliteFixture(); store = fixture.store; await store.initialize(); let held = true;
    const host = createWorkflowCompositeHost({ store, ...options, sagaDefinitions: [saga], loopDefinitions: [loop], hold: { isHeld: async () => held } });
    const submitted = await host.runtime.submitSaga(saga, { input: { value: 1 }, idempotencyKey: 'held' });
    expect(await host.runOnce()).toEqual({ pages: 0, examined: 0, shardReads: 0, outcomes: [], completedSweep: false, held: true });
    expect((await host.runtime.sagas.inspect(submitted.id)).status).not.toBe('succeeded');
    held = false; expect((await host.runOnce()).held).toBe(false); await host.close();
    expect(() => createWorkflowCompositeHost({ store: store!, ...options, sagaDefinitions: [saga], hold: {} as never })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });
});
