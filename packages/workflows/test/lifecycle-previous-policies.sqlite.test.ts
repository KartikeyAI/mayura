import { afterEach, describe, expect, it } from 'vitest';
import type { JsonValue, Schema } from '@mayura/core';
import { defineTool } from '@mayura/tools';
import { createWorkflowLifecycleRuntime, defineWorkflowLifecycle, defineWorkflowMigration,
  type WorkflowLifecyclePolicy, type WorkflowLifecycleRuntimeOptions } from '../src/lifecycle.js';
import { createWorkflowSagaRuntime, defineWorkflowSaga } from '../src/sagas.js';
import { createWorkflowLoopRuntime, defineWorkflowLoop } from '../src/loops.js';
import { sqliteFixture, type WorkflowFixture } from './fixtures.js';

const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'previous-policies-test', validate: value => ({ value: value as JsonValue }) } };
const tool = (id: string, costMicros = 1) => defineTool({ id: `upgrade/${id}`, version: '1', description: id, input: any, output: any,
  effects: 'none', capabilities: [], costMicros, execute: input => ({ [id]: input }) });
const draft = tool('draft'); const extra = tool('extra');
const review = { kind: 'human' as const, id: 'review', request: { kind: 'information' as const, schemaId: 'upgrade/review',
  schemaDigest: 'd'.repeat(64), prompt: 'Review.', response: any } };
/** Waits for a person, then runs `next`: the run is in flight when the application upgrades. */
const reviewed = (id: string, next: typeof draft, version = '1') => defineWorkflowLifecycle({ id, version, input: any, output: any, nodes: [
  review, { kind: 'tool', id: 'act', dependsOn: ['review'], tool: next, input: { kind: 'step', stepId: 'review', path: [] } },
], result: { kind: 'step', stepId: 'act', path: [] } });
const scope = { principalId: 'operator', projectId: 'project' };
const actor = { id: 'reviewer', projectId: 'project' };
// v1 shipped without the extra tool; v2 adds a grant for it and changes every limit.
const v1: WorkflowLifecyclePolicy = { permissions: { allow: ['tool:upgrade/draft'] }, policyVersion: '1', maxCostMicros: 2, approvalTtlMs: 50 };
const v2: WorkflowLifecyclePolicy = { permissions: { allow: ['tool:upgrade/draft', 'tool:upgrade/extra'] }, policyVersion: '2', maxCostMicros: 9, approvalTtlMs: 1_000 };
const stranded = 'This run was started under different runtime settings (permissions, policyVersion or limits). '
  + 'List those settings in previousPolicies to let it continue, or migrate it.';

describe('lifecycle runs continue under the settings they were started with', () => {
  let fixture: WorkflowFixture | undefined; const clock = { value: 100 };
  afterEach(async () => { await fixture?.store.close(); await fixture?.cleanup(); fixture = undefined; clock.value = 100; });
  const store = async () => { fixture = await sqliteFixture(); await fixture.store.initialize(); return fixture.store; };
  const lifecycle = (policy: WorkflowLifecyclePolicy, extraOptions: Partial<WorkflowLifecycleRuntimeOptions> = {}) =>
    createWorkflowLifecycleRuntime({ store: fixture!.store, scope, ...policy, now: () => clock.value,
      verifyHuman: async credential => ({ id: String(credential), projectId: 'project', canApprove: credential === 'approver' }), ...extraOptions });
  const answer = async (runtime: ReturnType<typeof lifecycle>, definition: ReturnType<typeof reviewed>, id: string, value: JsonValue) => {
    const request = (await runtime.humanRequest(definition, id, 'review'))!;
    return runtime.respondVerified(definition, { id, nodeId: 'review', requestDigest: request.digest, commandId: `answer-${id}`, actor, value });
  };

  it('finishes a v1 run after a v2 deploy only when v1 is listed in previousPolicies', async () => {
    await store(); const workflow = reviewed('publish', draft);
    const before = lifecycle(v1);
    const run = await before.submit(workflow, { input: null, idempotencyKey: 'in-flight' });
    expect((await before.runUntilSettled(workflow, run.id)).status).toBe('waiting'); before.close();

    const upgraded = lifecycle(v2);
    await expect(upgraded.runUntilSettled(workflow, run.id)).rejects.toMatchObject({ code: 'CONFLICT', message: stranded });
    await expect(answer(upgraded, workflow, run.id, 'ok')).rejects.toMatchObject({ code: 'CONFLICT', message: stranded });
    upgraded.close();

    const compatible = lifecycle(v2, { previousPolicies: [v1] });
    await answer(compatible, workflow, run.id, 'ok');
    expect(await compatible.runUntilSettled(workflow, run.id)).toMatchObject({ status: 'succeeded', output: { draft: 'ok' },
      budget: { spentMicros: 1, maxCostMicros: 2 } });
  });

  it('never grants a pinned run the grants or limits added later', async () => {
    await store(); const workflow = reviewed('extend', extra);
    const old = await lifecycle(v1).submit(workflow, { input: null, idempotencyKey: 'old' });
    const runtime = lifecycle(v2, { previousPolicies: [v1] });
    const fresh = await runtime.submit(workflow, { input: null, idempotencyKey: 'new' });
    for (const id of [old.id, fresh.id]) { await runtime.runUntilSettled(workflow, id); await answer(runtime, workflow, id, 'go'); }
    // tool:upgrade/extra exists only in v2: the v1 run is blocked, the v2 run gets it.
    expect(await runtime.runUntilSettled(workflow, old.id)).toMatchObject({ status: 'blocked', steps: { act: { status: 'blocked' } },
      budget: { maxCostMicros: 2, spentMicros: 0 } });
    expect(await runtime.runUntilSettled(workflow, fresh.id)).toMatchObject({ status: 'succeeded', budget: { maxCostMicros: 9, spentMicros: 1 } });
  });

  it('keeps an approval issued before the upgrade valid, and re-issues one under the run\'s own TTL', async () => {
    await store();
    const workflow = defineWorkflowLifecycle({ id: 'approved', version: '1', input: any, output: any,
      nodes: [{ kind: 'tool', id: 'draft', tool: draft, approval: true, input: { kind: 'input', path: [] } }],
      result: { kind: 'step', stepId: 'draft', path: [] } });
    const before = lifecycle(v1);
    const pending = await before.submit(workflow, { input: 'a', idempotencyKey: 'pending' });
    const expiring = await before.submit(workflow, { input: 'b', idempotencyKey: 'expiring' });
    const waiting = await before.runUntilSettled(workflow, pending.id); await before.runUntilSettled(workflow, expiring.id);
    const digest = waiting.steps['draft']?.kind === 'tool' ? waiting.steps['draft'].approval!.digest : '';
    before.close();

    await expect(lifecycle(v2).approve({ id: pending.id, nodeId: 'draft', digest, credential: 'approver' })).rejects.toMatchObject({ code: 'CONFLICT' });
    const runtime = lifecycle(v2, { previousPolicies: [v1] });
    expect(await runtime.approvalRequest(workflow, pending.id, 'draft')).toMatchObject({ status: 'waiting', digest, expiresAtMs: 150 });
    await runtime.approve({ id: pending.id, nodeId: 'draft', digest, credential: 'approver' });
    expect(await runtime.runUntilSettled(workflow, pending.id)).toMatchObject({ status: 'succeeded', output: { draft: 'a' } });
    // The expired request is re-issued with v1's 50 ms TTL, not v2's 1 s.
    clock.value = 150;
    expect(await runtime.runUntilSettled(workflow, expiring.id)).toMatchObject({ status: 'waiting', nextWakeAtMs: 200 });
  });

  it('moves a run onto the current settings through a reviewed migration, even when its settings are not listed', async () => {
    await store(); const workflow = reviewed('migrated', extra);
    const next = reviewed('migrated', extra, '2');
    const run = await lifecycle(v1).submit(workflow, { input: null, idempotencyKey: 'migrate' });
    const runtime = lifecycle(v2);
    await runtime.pause(run.id);
    const migration = defineWorkflowMigration({ id: 'migrated-1-to-2', from: workflow, to: next });
    const applied = await runtime.migrate(migration, { id: run.id, actorId: 'operator', commandId: 'migrate-1' });
    expect(applied.snapshot).toMatchObject({ status: 'paused', budget: { maxCostMicros: 9 } });
    await runtime.resume(run.id); await runtime.runUntilSettled(next, run.id); await answer(runtime, next, run.id, 'go');
    expect(await runtime.runUntilSettled(next, run.id)).toMatchObject({ status: 'succeeded', output: { extra: 'go' } });
  });

  it('validates previous policies like the runtime\'s own settings', async () => {
    await store();
    const invalid: unknown[] = [Array.from({ length: 17 }, () => v1), 'v1', [null], [{ ...v1, policyVersion: '' }], [{ ...v1, maxCostMicros: -1 }],
      [{ ...v1, permissions: { allow: [''] } }], [{ ...v1, permissions: {} }], [{ ...v1, approvalTtlMs: 0 }], [{ ...v1, maxOutputBytes: 1.5 }]];
    for (const previousPolicies of invalid) {
      expect(() => lifecycle(v2, { previousPolicies: previousPolicies as WorkflowLifecyclePolicy[] })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
      expect(() => createWorkflowSagaRuntime({ store: fixture!.store, scope, ...v2, previousPolicies: previousPolicies as WorkflowLifecyclePolicy[] }))
        .toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    }
    expect(() => lifecycle(v2, { previousPolicies: Array.from({ length: 16 }, () => v1) })).not.toThrow();
  });

  it('lets a saga started under v1 finish under v1, submitting its later children under v1', async () => {
    await store();
    const wait = defineWorkflowLifecycle({ id: 'saga-review', version: '1', input: any, output: any, nodes: [review],
      result: { kind: 'step', stepId: 'review', path: [] } });
    const saga = (id: string, next: typeof draft) => defineWorkflowSaga({ id, version: '1', input: any, output: any, steps: [
      { id: 'review', forward: wait, input: { kind: 'input', path: [] } },
      { id: 'act', forward: defineWorkflowLifecycle({ id: `${id}-act`, version: '1', input: any, output: any,
        nodes: [{ kind: 'tool', id: 'act', tool: next, input: { kind: 'input', path: [] } }], result: { kind: 'step', stepId: 'act', path: [] } }),
      input: { kind: 'step', stepId: 'review', path: [] } },
    ], result: { kind: 'step', stepId: 'act', path: [] } });
    const allowed = saga('saga-draft', draft); const denied = saga('saga-extra', extra);
    const before = createWorkflowSagaRuntime({ store: fixture!.store, scope, ...v1 });
    const runs = [await before.submit(allowed, { input: null, idempotencyKey: 'allowed' }), await before.submit(denied, { input: null, idempotencyKey: 'denied' })];
    for (const [index, definition] of [allowed, denied].entries()) await before.runUntilSettled(definition, runs[index]!.id);
    before.close();

    const upgraded = createWorkflowSagaRuntime({ store: fixture!.store, scope, ...v2 });
    await expect(upgraded.runUntilSettled(allowed, runs[0]!.id)).rejects.toMatchObject({ code: 'CONFLICT', message: stranded });
    upgraded.close();
    const runtime = createWorkflowSagaRuntime({ store: fixture!.store, scope, ...v2, previousPolicies: [v1] });
    for (const index of [0, 1]) {
      const childId = (await runtime.inspect(runs[index]!.id)).steps['review']!.forwardRunId!;
      const request = (await runtime.lifecycle.humanRequest(wait, childId, 'review'))!;
      await runtime.lifecycle.respondVerified(wait, { id: childId, nodeId: 'review', requestDigest: request.digest, commandId: `answer-${index}`, actor, value: 'go' });
    }
    const finished = await runtime.runUntilSettled(allowed, runs[0]!.id);
    expect(finished).toMatchObject({ status: 'succeeded', output: { draft: 'go' }, budget: { maxCostMicros: 2 } });
    // The child submitted after the upgrade still carries v1's limits.
    expect((await runtime.lifecycle.inspect(finished.steps['act']!.forwardRunId!)).budget.maxCostMicros).toBe(2);
    // And v1's grants: the extra tool, granted only in v2, stays out of reach of the v1 saga.
    const blocked = await runtime.runUntilSettled(denied, runs[1]!.id);
    expect(blocked).toMatchObject({ status: 'failed', steps: { act: { status: 'failed' } } });
    expect(await runtime.lifecycle.inspect(blocked.steps['act']!.forwardRunId!)).toMatchObject({ status: 'blocked' });
    runtime.close();
  });

  it('lets a loop started under v1 run its later iterations under v1', async () => {
    await store();
    const body = defineWorkflowLifecycle({ id: 'loop-review', version: '1', input: any, output: any, nodes: [review],
      result: { kind: 'step', stepId: 'review', path: [] } });
    const loop = defineWorkflowLoop({ id: 'reviewed-loop', version: '1', input: any, output: any, body, maxIterations: 3,
      initial: { kind: 'input', path: [] }, next: { kind: 'current', path: [] }, continueWhen: { kind: 'current', path: ['again'] },
      result: { kind: 'current', path: [] } });
    const before = createWorkflowLoopRuntime({ store: fixture!.store, scope, ...v1 });
    const run = await before.submit(loop, { input: null, idempotencyKey: 'loop' });
    expect((await before.runUntilSettled(loop, run.id)).status).toBe('waiting'); before.close();

    const upgraded = createWorkflowLoopRuntime({ store: fixture!.store, scope, ...v2 });
    await expect(upgraded.runUntilSettled(loop, run.id)).rejects.toMatchObject({ code: 'CONFLICT', message: stranded });
    upgraded.close();
    const runtime = createWorkflowLoopRuntime({ store: fixture!.store, scope, ...v2, previousPolicies: [v1] });
    const respond = async (value: JsonValue) => {
      const childId = (await runtime.inspect(run.id)).childRunId!;
      const request = (await runtime.lifecycle.humanRequest(body, childId, 'review'))!;
      await runtime.lifecycle.respondVerified(body, { id: childId, nodeId: 'review', requestDigest: request.digest, commandId: childId, actor, value });
      return childId;
    };
    await respond({ again: true });
    const second = await runtime.runUntilSettled(loop, run.id);
    expect(second).toMatchObject({ status: 'waiting', iteration: 1, budget: { maxCostMicros: 2 } });
    // The iteration submitted after the upgrade carries v1's limits.
    expect((await runtime.lifecycle.inspect(second.childRunId!)).budget.maxCostMicros).toBe(2);
    await respond({ again: false });
    expect(await runtime.runUntilSettled(loop, run.id)).toMatchObject({ status: 'succeeded', iteration: 2, output: { again: false } });
    runtime.close();
  });
});
