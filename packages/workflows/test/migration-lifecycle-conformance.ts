import { afterEach, describe, expect, it } from 'vitest';
import type { JsonValue, Schema } from '@mayura/core';
import { defineTool } from '@mayura/tools';
import { createWorkflowLifecycleFleetRuntime, createWorkflowLifecycleRuntime, defineWorkflowLifecycle, defineWorkflowMigration } from '../src/lifecycle.js';
import { inventoryWorkflowVersions, lifecycleFleetTarget } from '../src/index.js';
import type { WorkflowFixture } from './fixtures.js';

const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'migration-test', validate: value => ({ value: value as JsonValue }) } };
const text: Schema<string, { decision: string }> = { '~standard': { version: 1, vendor: 'migration-test',
  validate: value => typeof value === 'string' ? { value: { decision: value } } : { issues: [] } } };
let executions: string[] = [];
const tool = (id: string, cost = 0) => defineTool({ id: `migrate/${id}`, version: '1', description: id, input: any, output: any, effects: 'none', capabilities: [], costMicros: cost,
  execute: input => { executions.push(id); return { [id]: input }; } });
const draft = tool('draft'); const notify = tool('notify'); const audit = tool('audit');
const hash = 'c'.repeat(64);
const review = (prompt: string) => ({ kind: 'human' as const, id: 'review', dependsOn: ['draft'], request: { kind: 'information' as const, schemaId: 'migrate/review', schemaDigest: hash,
  prompt, response: text, context: { kind: 'step' as const, stepId: 'draft', path: [] } } });
const v1 = defineWorkflowLifecycle({ id: 'migrating', version: '1', input: any, output: any, nodes: [
  { kind: 'tool', id: 'draft', tool: draft, input: { kind: 'input', path: [] } },
  review('Review the draft.'),
  { kind: 'timer', id: 'publishAt', dependsOn: ['review'], fireAtMs: { kind: 'input', path: ['publishAt'] } },
  { kind: 'tool', id: 'notify', dependsOn: ['publishAt'], tool: notify, input: { kind: 'input', path: [] } },
], result: { kind: 'step', stepId: 'review', path: [] } });
// v2: adds an audit step after review, renames notify -> announce, and changes nothing that already ran.
const v2 = defineWorkflowLifecycle({ id: 'migrating', version: '2', input: any, output: any, nodes: [
  { kind: 'tool', id: 'draft', tool: draft, input: { kind: 'input', path: [] } },
  review('Review the draft.'),
  { kind: 'tool', id: 'audit', dependsOn: ['review'], tool: audit, input: { kind: 'step', stepId: 'review', path: [] } },
  { kind: 'timer', id: 'publishAt', dependsOn: ['audit'], fireAtMs: { kind: 'input', path: ['publishAt'] } },
  { kind: 'tool', id: 'announce', dependsOn: ['publishAt'], tool: notify, input: { kind: 'input', path: [] } },
], result: { kind: 'step', stepId: 'review', path: [] } });
const scope = { principalId: 'operator', projectId: 'project' };
const grants = ['tool:migrate/draft', 'tool:migrate/notify', 'tool:migrate/audit'];

export function lifecycleMigrationConformance(name: string, open: () => Promise<WorkflowFixture>): void {
  describe(`lifecycle in-place migration on ${name}`, () => {
    let fixture: WorkflowFixture | undefined;
    afterEach(async () => { await fixture?.store.close(); await fixture?.cleanup(); fixture = undefined; executions = []; });
    const setup = async (clock = { value: 100 }) => {
      fixture = await open(); await fixture.store.initialize();
      const runtime = createWorkflowLifecycleRuntime({ store: fixture.store, scope, permissions: { allow: grants }, policyVersion: '1', maxCostMicros: 10,
        now: () => clock.value, verifyHuman: async credential => ({ id: String(credential), projectId: 'project', canApprove: false }) });
      return { runtime, clock };
    };
    const waitingOnReview = async (runtime: Awaited<ReturnType<typeof setup>>['runtime'], key = 'run') => {
      const run = await runtime.submit(v1, { input: { payload: 'x', publishAt: 500 }, idempotencyKey: key });
      expect((await runtime.runUntilSettled(v1, run.id)).status).toBe('waiting');
      return run.id;
    };
    const actor = { actorId: 'operator-1', commandId: 'migrate-1' };

    it('migrates a paused run waiting on a person, re-issues the request and completes on the new definition', async () => {
      const { runtime, clock } = await setup();
      const id = await waitingOnReview(runtime);
      const oldRequest = (await runtime.humanRequest(v1, id, 'review'))!;
      const migration = defineWorkflowMigration({ id: 'migrating-1-to-2', from: v1, to: v2, renames: { announce: 'notify' } });
      const preview = await runtime.migrate(migration, { id, ...actor, dryRun: true });
      expect(preview.plan).toMatchObject({ allowed: false, blockers: [{ node: '*', reason: expect.stringContaining('pause it') }] });
      await runtime.pause(id);
      const plan = (await runtime.migrate(migration, { id, ...actor, dryRun: true })).plan;
      expect(plan.allowed).toBe(true);
      expect(plan.entries.map(entry => `${entry.action}:${entry.target ?? entry.source}`)).toEqual(['keep:draft', 'keep:review', 'add:audit', 'update:publishAt', 'update:announce']);
      const beforeVersion = (await runtime.inspect(id)).version;
      expect((await runtime.inspect(id)).version).toBe(beforeVersion); // a dry run writes nothing
      const applied = await runtime.migrate(migration, { id, ...actor });
      expect(applied.snapshot).toMatchObject({ status: 'paused', steps: { draft: { status: 'succeeded' }, review: { status: 'waiting' }, audit: { status: 'pending' }, announce: { status: 'pending' } } });
      // The old definition can no longer drive the run; the old request digest is stale.
      await expect(runtime.runUntilSettled(v1, id)).rejects.toMatchObject({ code: 'CONFLICT' });
      // Resubmitting the original key with the old definition is refused rather than returning the migrated run.
      await expect(runtime.submit(v1, { input: { payload: 'x', publishAt: 500 }, idempotencyKey: 'run' })).rejects.toMatchObject({ code: 'CONFLICT' });
      const request = (await runtime.humanRequest(v2, id, 'review'))!;
      expect(request.digest).not.toBe(oldRequest.digest);
      await runtime.resume(id);
      await expect(runtime.respond(v2, { id, nodeId: 'review', requestDigest: oldRequest.digest, commandId: 'late', credential: 'reviewer', value: 'ok' })).rejects.toMatchObject({ code: 'CONFLICT' });
      await runtime.respond(v2, { id, nodeId: 'review', requestDigest: request.digest, commandId: 'answer', credential: 'reviewer', value: 'ok' });
      expect((await runtime.runUntilSettled(v2, id)).status).toBe('waiting');
      clock.value = 500;
      expect(await runtime.runUntilSettled(v2, id)).toMatchObject({ status: 'succeeded', steps: { audit: { status: 'succeeded' }, announce: { status: 'succeeded' } } });
      expect(executions).toEqual(['draft', 'audit', 'notify']); // draft ran exactly once, before the migration
      const events = await runtime.events(id);
      expect(events.find(event => event.type === 'run.migrated')?.data).toMatchObject({ migrationId: 'migrating-1-to-2', from: v1.digest, to: v2.digest, actorId: 'operator-1', commandId: 'migrate-1' });
      runtime.close();
    });

    it('refuses to change or drop settled steps unless the reviewer explicitly accepts their results', async () => {
      const { runtime } = await setup();
      const id = await waitingOnReview(runtime); await runtime.pause(id);
      const changedDraft = defineWorkflowLifecycle({ ...v1Options(), version: '3', nodes: [{ kind: 'tool', id: 'draft', tool: draft, input: { kind: 'input', path: ['payload'] } }, ...v1Options().nodes.slice(1)] });
      const refused = await runtime.migrate(defineWorkflowMigration({ id: 'draft-change', from: v1, to: changedDraft }), { id, ...actor, dryRun: true });
      expect(refused.plan.blockers).toEqual([expect.objectContaining({ node: 'draft', reason: expect.stringContaining('acceptCompleted') })]);
      await expect(runtime.migrate(defineWorkflowMigration({ id: 'draft-change', from: v1, to: changedDraft }), { id, ...actor })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect((await runtime.inspect(id)).steps['draft']).toMatchObject({ status: 'succeeded' });
      const accepted = await runtime.migrate(defineWorkflowMigration({ id: 'draft-change', from: v1, to: changedDraft, acceptCompleted: ['draft'] }), { id, ...actor });
      expect(accepted.plan.entries[0]).toMatchObject({ action: 'accept', target: 'draft', status: 'succeeded' });
      // Removing the settled draft step also needs explicit acceptance, and its dependents cannot keep a started state.
      const withoutDraft = defineWorkflowLifecycle({ id: 'migrating', version: '4', input: any, output: any, nodes: [
        (({ context: _context, ...request }) => ({ ...review('Review the draft.'), dependsOn: [], request }))(review('Review the draft.').request),
      ], result: { kind: 'step', stepId: 'review', path: [] } });
      const removal = await runtime.migrate(defineWorkflowMigration({ id: 'drop', from: changedDraft, to: withoutDraft }), { id, actorId: 'operator-1', commandId: 'drop', dryRun: true });
      expect(removal.plan.blockers.map(blocker => blocker.node)).toContain('draft');
      runtime.close();
    });

    it('moves the fleet index entry to the new definition so hosts and inventories follow the run', async () => {
      fixture = await open(); await fixture.store.initialize();
      const fleet = createWorkflowLifecycleFleetRuntime({ store: fixture.store, scope, permissions: { allow: grants }, policyVersion: '1', maxCostMicros: 10, now: () => 100,
        verifyHuman: async credential => ({ id: String(credential), projectId: 'project', canApprove: false }) });
      const run = await fleet.submit(v1, { input: { payload: 'x', publishAt: 500 }, idempotencyKey: 'fleet' });
      await fleet.runUntilSettled(v1, run.id); await fleet.pause(run.id);
      await fleet.migrate(defineWorkflowMigration({ id: 'fleet', from: v1, to: v2, renames: { announce: 'notify' } }), { id: run.id, ...actor });
      const candidates = []; let cursor = null as Parameters<typeof fleet.scan>[0] extends infer C ? C extends { cursor?: infer X } ? X : never : never;
      do { const page = await fleet.scan({ cursor, limit: 128, maxShardReads: 256 }); candidates.push(...page.candidates); cursor = page.nextCursor; } while (cursor);
      expect(candidates).toEqual([expect.objectContaining({ runId: run.id, definitionHash: v2.digest, status: 'paused' })]);
      const inventory = await inventoryWorkflowVersions({ store: fixture.store, scope, targets: [lifecycleFleetTarget(fleet, 'lifecycle', { includePaused: true })], registered: [v2] });
      expect(inventory).toMatchObject({ unregistered: [], versions: [{ definitionHash: v2.digest, activeRuns: 1 }] });
      fleet.close();
    });
  });
}

function v1Options() {
  return { id: 'migrating', version: '1', input: any, output: any, nodes: [
    { kind: 'tool' as const, id: 'draft', tool: draft, input: { kind: 'input' as const, path: [] } },
    review('Review the draft.'),
    { kind: 'timer' as const, id: 'publishAt', dependsOn: ['review'], fireAtMs: { kind: 'input' as const, path: ['publishAt'] } },
    { kind: 'tool' as const, id: 'notify', dependsOn: ['publishAt'], tool: notify, input: { kind: 'input' as const, path: [] } },
  ], result: { kind: 'step' as const, stepId: 'review', path: [] } };
}
