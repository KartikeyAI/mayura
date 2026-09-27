import { afterEach, describe, expect, it } from 'vitest';
import type { JsonValue, Schema } from '@mayura/core';
import { defineTool } from '@mayura/tools';
import { createWorkflowRuntime, defineWorkflow, defineWorkflowMigration } from '@mayura/workflows';
import { defineWorkflowLifecycle } from '../src/lifecycle.js';
import { createWorkflowSagaRuntime, defineWorkflowSaga } from '../src/sagas.js';
import { createWorkflowLoopRuntime, defineWorkflowLoop } from '../src/loops.js';
import type { WorkflowFixture } from './fixtures.js';

const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'migration-test', validate: value => ({ value: value as JsonValue }) } };
const hash = 'd'.repeat(64);
let executions: string[] = [];
const tool = (id: string, costMicros = 0, execute: (input: JsonValue) => JsonValue = input => input) => defineTool({ id: `migrate/${id}`, version: '1', description: id,
  input: any, output: any, effects: 'none', capabilities: [], costMicros, execute: input => { executions.push(id); return execute(input as JsonValue); } });
const child = (id: string, version = '1', prompt?: string) => defineWorkflowLifecycle({ id, version, input: any, output: any,
  nodes: prompt === undefined ? [{ kind: 'tool', id: 'execute', tool: tool(id), input: { kind: 'input', path: [] } }]
    : [{ kind: 'human', id: 'review', request: { kind: 'information', schemaId: 'migrate/review', schemaDigest: hash, prompt, response: any } }],
  result: { kind: 'step', stepId: prompt === undefined ? 'execute' : 'review', path: [] } });
const scope = { principalId: 'operator', projectId: 'project' };
const actor = { actorId: 'operator-1', commandId: 'migrate-1' };
const human = async (credential: unknown) => ({ id: String(credential), projectId: 'project', canApprove: true });
const actions = (plan: { readonly entries: readonly { readonly action: string; readonly target?: string; readonly source?: string }[] }) =>
  plan.entries.map(entry => `${entry.action}:${entry.target ?? entry.source}`);

export function compositeMigrationConformance(name: string, open: () => Promise<WorkflowFixture>): void {
  describe(`aggregate, saga and loop in-place migration on ${name}`, () => {
    let fixture: WorkflowFixture | undefined;
    afterEach(async () => { await fixture?.store.close(); await fixture?.cleanup(); fixture = undefined; executions = []; });
    const store = async () => { fixture = await open(); await fixture.store.initialize(); return fixture.store; };

    it('migrates a paused format-2 run waiting on approval and completes on the new version', async () => {
      const v1 = defineWorkflow({ id: 'aggregate', version: '1', input: any, output: any, nodes: [
        { kind: 'tool', id: 'draft', tool: tool('draft'), input: { kind: 'input', path: [] } },
        { kind: 'tool', id: 'publish', dependsOn: ['draft'], tool: tool('publish'), input: { kind: 'step', stepId: 'draft', path: [] }, approval: true },
      ], result: { kind: 'step', stepId: 'publish', path: [] } });
      const v2 = defineWorkflow({ id: 'aggregate', version: '2', input: any, output: any, nodes: [
        { kind: 'tool', id: 'draft', tool: tool('draft'), input: { kind: 'input', path: [] } },
        { kind: 'tool', id: 'lint', dependsOn: ['draft'], tool: tool('lint'), input: { kind: 'step', stepId: 'draft', path: [] } },
        { kind: 'tool', id: 'publish', dependsOn: ['draft', 'lint'], tool: tool('publish'), input: { kind: 'step', stepId: 'draft', path: [] }, approval: true },
      ], result: { kind: 'step', stepId: 'publish', path: [] } });
      const runtime = createWorkflowRuntime({ store: await store(), scope, permissions: { allow: ['tool:migrate/draft', 'tool:migrate/lint', 'tool:migrate/publish'] },
        policyVersion: '1', maxCostMicros: 10, verifyHuman: human });
      const run = await runtime.submit(v1, { input: 'text', idempotencyKey: 'aggregate' });
      expect((await runtime.runUntilSettled(v1, run.id)).steps['publish']!.status).toBe('waiting');
      await runtime.pause(run.id);
      const migration = defineWorkflowMigration({ id: 'aggregate-1-to-2', from: v1, to: v2 });
      const { plan, snapshot } = await runtime.migrate(migration, { id: run.id, ...actor });
      // publish now depends on lint, so the parked approval is re-issued under the new definition.
      expect(actions(plan)).toEqual(['keep:draft', 'add:lint', 'reset:publish']);
      expect(snapshot).toMatchObject({ status: 'paused', steps: { draft: { status: 'succeeded' }, lint: { status: 'pending' }, publish: { status: 'pending' } } });
      await expect(runtime.runUntilSettled(v1, run.id)).rejects.toMatchObject({ code: 'CONFLICT' });
      await runtime.resume(run.id);
      const waiting = await runtime.runUntilSettled(v2, run.id);
      expect(waiting.steps['publish']!.status).toBe('waiting');
      await runtime.approve({ id: run.id, nodeId: 'publish', digest: waiting.steps['publish']!.approval!.digest, credential: 'reviewer' });
      expect((await runtime.runUntilSettled(v2, run.id)).status).toBe('succeeded');
      expect(executions).toEqual(['draft', 'lint', 'publish']);
    });

    it('migrates a paused saga forward, and a running child only after the child itself was migrated', async () => {
      const reviewV1 = child('review', '1', 'Review the order.'); const reviewV2 = child('review', '2', 'Review the order and its invoice.');
      const saga = (version: string, review: typeof reviewV1, notify: boolean) => defineWorkflowSaga({ id: 'order', version, input: any, output: any, steps: [
        { id: 'reserve', forward: child('reserve'), input: { kind: 'input', path: [] } },
        { id: 'review', forward: review, input: { kind: 'step', stepId: 'reserve', path: [] } },
        ...(notify ? [{ id: 'notify', forward: child('notify'), input: { kind: 'step' as const, stepId: 'review', path: [] } }] : []),
      ], result: { kind: 'step', stepId: 'review', path: [] } });
      const v1 = saga('1', reviewV1, false); const v2 = saga('2', reviewV2, true);
      const runtime = createWorkflowSagaRuntime({ store: await store(), scope, permissions: { allow: ['tool:migrate/reserve', 'tool:migrate/notify'] },
        policyVersion: '1', maxCostMicros: 10, verifyHuman: human });
      const run = await runtime.submit(v1, { input: { order: 1 }, idempotencyKey: 'saga' });
      const waiting = await runtime.runUntilSettled(v1, run.id);
      expect(waiting).toMatchObject({ status: 'waiting', steps: { reserve: { status: 'succeeded' }, review: { status: 'forward_waiting' } } });
      await runtime.pause(run.id);
      const migration = defineWorkflowMigration({ id: 'order-1-to-2', from: v1, to: v2 });
      // The review child still runs v1 of its definition: the saga cannot swap it underneath.
      const refused = (await runtime.migrate(migration, { id: run.id, ...actor, dryRun: true })).plan;
      expect(refused.allowed).toBe(false);
      expect(refused.blockers.map(blocker => blocker.node)).toContain('review');
      const childId = waiting.steps['review']!.forwardRunId!;
      await runtime.lifecycle.pause(childId);
      await runtime.lifecycle.migrate(defineWorkflowMigration({ id: 'review-1-to-2', from: reviewV1, to: reviewV2 }), { id: childId, ...actor, commandId: 'migrate-child' });
      await runtime.lifecycle.resume(childId);
      const applied = await runtime.migrate(migration, { id: run.id, ...actor });
      expect(actions(applied.plan)).toEqual(['keep:reserve', 'keep:review', 'add:notify']);
      expect(applied.snapshot).toMatchObject({ status: 'paused', steps: { review: { status: 'forward_waiting', forwardRunId: childId }, notify: { status: 'pending' } } });
      await runtime.resume(run.id);
      // The child's changed request was reset; driving the saga re-issues it under the child's new definition.
      expect((await runtime.runUntilSettled(v2, run.id)).status).toBe('waiting');
      const request = (await runtime.lifecycle.humanRequest(reviewV2, childId, 'review'))!;
      await runtime.lifecycle.respond(reviewV2, { id: childId, nodeId: 'review', requestDigest: request.digest, commandId: 'answer', credential: 'reviewer', value: 'approved' });
      expect(await runtime.runUntilSettled(v2, run.id)).toMatchObject({ status: 'succeeded', output: 'approved', steps: { notify: { status: 'succeeded' } } });
      expect(executions).toEqual(['reserve', 'notify']);
    });

    it('migrates a paused loop to a larger iteration bound and refuses a bound below the iterations already run', async () => {
      const step = tool('increment', 0, input => { const value = Number((input as { value: number }).value) + 1; return { value, continue: value < 3 }; });
      const body = defineWorkflowLifecycle({ id: 'loop-body', version: '1', input: any, output: any,
        nodes: [{ kind: 'tool', id: 'increment', tool: step, input: { kind: 'input', path: [] } }], result: { kind: 'step', stepId: 'increment', path: [] } });
      const loop = (version: string, maxIterations: number) => defineWorkflowLoop({ id: 'counter', version, input: any, output: any, body, maxIterations,
        initial: { kind: 'input', path: [] }, next: { kind: 'current', path: [] }, continueWhen: { kind: 'current', path: ['continue'] }, result: { kind: 'current', path: ['value'] } });
      const v1 = loop('1', 2); const v2 = loop('2', 5);
      const runtime = createWorkflowLoopRuntime({ store: await store(), scope, permissions: { allow: ['tool:migrate/increment'] }, policyVersion: '1', maxCostMicros: 0 });
      const run = await runtime.submit(v1, { input: { value: 0 }, idempotencyKey: 'loop' });
      await runtime.pause(run.id);
      expect((await runtime.runUntilSettled(v1, run.id)).status).toBe('paused');
      const applied = await runtime.migrate(defineWorkflowMigration({ id: 'counter-1-to-2', from: v1, to: v2 }), { id: run.id, ...actor });
      expect(actions(applied.plan)).toEqual(['keep:body', 'update:control']);
      await runtime.resume(run.id);
      expect(await runtime.runUntilSettled(v2, run.id)).toMatchObject({ status: 'succeeded', iteration: 3, output: 3 });
      // A second run that already iterated three times cannot shrink its bound below that.
      const other = await runtime.submit(v2, { input: { value: 0 }, idempotencyKey: 'loop-2' });
      await runtime.runUntilSettled(v2, other.id);
      const shrink = defineWorkflowMigration({ id: 'counter-2-to-1', from: v2, to: v1 });
      const { plan } = await runtime.migrate(shrink, { id: other.id, ...actor, dryRun: true });
      expect(plan.allowed).toBe(false);
      runtime.close();
    });
  });
}
