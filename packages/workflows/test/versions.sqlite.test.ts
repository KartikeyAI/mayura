import { afterEach, describe, expect, it } from 'vitest';
import type { JsonValue, Schema } from '@mayura/core';
import { lifecycleFleetTarget } from '../src/fleet-control.js';
import { createWorkflowLifecycleFleetRuntime, defineWorkflowLifecycle } from '../src/lifecycle.js';
import { assertWorkflowVersionsRetained, inventoryWorkflowVersions, type WorkflowVersionTarget } from '../src/index.js';
import { sqliteFixture, type WorkflowFixture } from './fixtures.js';

const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'versions-test', validate: value => ({ value: value as JsonValue }) } };
const timer = (version: string) => defineWorkflowLifecycle({ id: 'versioned-timer', version, input: any, output: any,
  nodes: [{ kind: 'timer', id: 'wake', fireAtMs: { kind: 'input', path: ['fireAtMs'] } }], result: { kind: 'step', stepId: 'wake', path: [] } });
const scope = { principalId: 'operator', projectId: 'project' };

describe('workflow definition version inventory', () => {
  let fixture: WorkflowFixture | undefined;
  afterEach(async () => { await fixture?.store.close(); await fixture?.cleanup(); fixture = undefined; });

  it('counts active runs per pinned version, including paused runs, and gates a deployment that would strand them', async () => {
    fixture = await sqliteFixture(); await fixture.store.initialize(); const clock = { value: 100 };
    const runtime = createWorkflowLifecycleFleetRuntime({ store: fixture.store, scope, permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0, now: () => clock.value });
    const v1 = timer('1'); const v2 = timer('2');
    const waiting = await runtime.submit(v1, { input: { fireAtMs: 500 }, idempotencyKey: 'a' }); await runtime.runUntilSettled(v1, waiting.id);
    const paused = await runtime.submit(v1, { input: { fireAtMs: 500 }, idempotencyKey: 'b' }); await runtime.pause(paused.id);
    const finished = await runtime.submit(v2, { input: { fireAtMs: 50 }, idempotencyKey: 'c' }); await runtime.runUntilSettled(v2, finished.id);
    const targets = [lifecycleFleetTarget(runtime, 'lifecycle', { includePaused: true })];

    const onlyNew = await inventoryWorkflowVersions({ store: fixture.store, scope, targets, registered: [v2] });
    expect(onlyNew).toMatchObject({ complete: true, unregistered: [v1.digest], retirable: [v2.digest],
      versions: [{ definitionHash: v1.digest, activeRuns: 2, registered: false, targets: ['lifecycle'] }] });
    expect(() => assertWorkflowVersionsRetained(onlyNew)).toThrow(/pinned to 1 definition version/);

    const both = await inventoryWorkflowVersions({ store: fixture.store, scope, targets, registered: [v1, v2.digest] });
    expect(both.unregistered).toEqual([]); expect(() => assertWorkflowVersionsRetained(both)).not.toThrow();

    // The default pause-sweep target skips paused runs, so it undercounts.
    const sweepTarget = await inventoryWorkflowVersions({ store: fixture.store, scope, targets: [lifecycleFleetTarget(runtime)], registered: [v1] });
    expect(sweepTarget.versions[0]!.activeRuns).toBe(1);

    // Once the old runs finish, the old version becomes retirable.
    await runtime.resume(paused.id); clock.value = 500;
    await runtime.runUntilSettled(v1, waiting.id); await runtime.runUntilSettled(v1, paused.id);
    expect(await inventoryWorkflowVersions({ store: fixture.store, scope, targets, registered: [v1, v2] })).toMatchObject({ versions: [], unregistered: [], retirable: [v1.digest, v2.digest].sort() });
    runtime.close();
  });

  it('reports an incomplete inventory at its bound and refuses it as a gate', async () => {
    fixture = await sqliteFixture(); await fixture.store.initialize();
    const endless: WorkflowVersionTarget = { name: 'fake', discover: async cursor => ({ runIds: [`${'a'.repeat(63)}${String(cursor ?? 0)}`], nextCursor: Number(cursor ?? 0) + 1 }),
      inspect: async () => ({ status: 'succeeded' }) };
    const inventory = await inventoryWorkflowVersions({ store: fixture.store, scope, targets: [endless], registered: [], maxRuns: 5 });
    expect(inventory).toMatchObject({ complete: false, scanned: 5 });
    expect(() => assertWorkflowVersionsRetained(inventory)).toThrow(/incomplete/);
    await expect(inventoryWorkflowVersions({ store: fixture.store, scope, targets: [], registered: ['not-a-digest'] })).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });
});
