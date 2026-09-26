import { afterEach, describe, expect, it } from 'vitest';
import type { JsonValue, Schema } from '@mayura/core';
import { createWorkflowLifecycleFleetRuntime, defineWorkflowLifecycle,
  type WorkflowLifecycleFleetCursor, type WorkflowLifecycleFleetReport } from '../src/lifecycle.js';
import { sqliteFixture, type WorkflowFixture } from './fixtures.js';

const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'lifecycle-fleet-test',
  validate: value => ({ value: value as JsonValue }) } };
const definition = defineWorkflowLifecycle({ id: 'fleet-timer', version: '1', input: any, output: any,
  nodes: [{ kind: 'timer', id: 'wake', fireAtMs: { kind: 'input', path: ['fireAtMs'] } }],
  result: { kind: 'step', stepId: 'wake', path: [] } });

describe('durable lifecycle fleet index on SQLite', () => {
  let fixture: WorkflowFixture | undefined; let store: WorkflowFixture['store'] | undefined;
  afterEach(async () => { await store?.close(); await fixture?.cleanup(); fixture = undefined; store = undefined; });
  const open = async (clock: { value: number }, reopen = false) => {
    if (!fixture) fixture = await sqliteFixture(); store = reopen ? fixture.reopen() : fixture.store; await store.initialize();
    return createWorkflowLifecycleFleetRuntime({ store, scope: { principalId: 'fleet', projectId: 'project' },
      permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0, now: () => clock.value });
  };
  const find = async (runtime: ReturnType<typeof createWorkflowLifecycleFleetRuntime>, definitions = [definition]) => {
    let cursor: WorkflowLifecycleFleetCursor | null = null;
    for (let page = 0; page < 9; page++) {
      const report: WorkflowLifecycleFleetReport = await runtime.runPage(definitions, { cursor, maxShardReads: 32, limit: 32 });
      if (report.outcomes.length > 0) return report;
      cursor = report.page.nextCursor; if (!cursor) return report;
    }
    throw new Error('Fleet scan did not finish its bounded hash-space sweep.');
  };

  it('discovers, defers and resumes a due timer after reopening storage', async () => {
    const clock = { value: 100 }; let runtime = await open(clock);
    const submitted = await runtime.submit(definition, { input: { fireAtMs: 500 }, idempotencyKey: 'timer' });
    const first = await find(runtime, []);
    expect(first.outcomes).toEqual([{ kind: 'skipped', runId: submitted.id, reason: 'unregistered_definition' }]);
    const scheduled = await find(runtime);
    expect(scheduled.outcomes).toEqual([{ kind: 'advanced', runId: submitted.id, status: 'waiting' }]);
    const deferred = await find(runtime);
    expect(deferred.outcomes).toEqual([{ kind: 'deferred', runId: submitted.id, nextWakeAtMs: 500 }]);
    runtime.close(); await store!.close(); store = undefined;

    clock.value = 500; runtime = await open(clock, true);
    const resumed = await find(runtime);
    expect(resumed.outcomes).toEqual([{ kind: 'advanced', runId: submitted.id, status: 'succeeded' }]);
    let cursor: WorkflowLifecycleFleetCursor | null = null; const candidates: string[] = [];
    do {
      const page = await runtime.scan({ cursor, maxShardReads: 64 }); candidates.push(...page.candidates.map(item => item.runId)); cursor = page.nextCursor;
    } while (cursor);
    expect(candidates).not.toContain(submitted.id); expect(await runtime.inspect(submitted.id)).toMatchObject({ status: 'succeeded' });
    runtime.close();
  });

  it('indexes and defers a paused run until it is resumed', async () => {
    const clock = { value: 500 }; let runtime = await open(clock);
    const submitted = await runtime.submit(definition, { input: { fireAtMs: 500 }, idempotencyKey: 'paused' });
    expect((await runtime.pause(submitted.id)).status).toBe('paused');
    runtime.close(); await store!.close(); store = undefined;

    runtime = await open(clock, true);
    expect((await find(runtime)).outcomes).toEqual([{ kind: 'deferred', runId: submitted.id, nextWakeAtMs: null }]);
    expect(await runtime.inspect(submitted.id)).toMatchObject({ status: 'paused', steps: { wake: { status: 'pending' } } });
    expect((await runtime.resume(submitted.id)).status).toBe('running');
    expect((await find(runtime)).outcomes).toEqual([{ kind: 'advanced', runId: submitted.id, status: 'succeeded' }]);
    runtime.close();
  });

  it('rejects cross-scope cursors and keeps caller-owned storage open', async () => {
    const clock = { value: 100 }; const runtime = await open(clock);
    await runtime.submit(definition, { input: { fireAtMs: 500 }, idempotencyKey: 'timer' });
    const page = await runtime.scan({ maxShardReads: 1 }); expect(page.nextCursor).not.toBeNull();
    await expect(runtime.scan({ cursor: { ...page.nextCursor!, scope: 'a'.repeat(64) } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    runtime.close();
    expect(await store!.read('missing', 'missing')).toBeUndefined();
  });
});
