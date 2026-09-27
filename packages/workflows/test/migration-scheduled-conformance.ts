import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { jsonValue } from '@mayura/core';
import type { ExecutionRef } from '@mayura/storage-contracts';
import { defineTool } from '@mayura/tools';
import { createScheduledWorkflowRuntime, defineWorkflow, defineWorkflowMigration, graphFleetTarget, inventoryWorkflowVersions } from '@mayura/workflows';
import { createWorkflowGraphCoordinator, createWorkflowGraphDiscovery, createWorkflowGraphRuntime, defineWorkflowGraph } from '@mayura/workflows/graphs';
import type { GraphFixture } from './graph-fixtures.js';

const scope = { principalId: 'migration-developer', projectId: 'migration-project' };
const literal = (value: unknown) => ({ kind: 'literal' as const, value: jsonValue(value) });
const step = (stepId: string) => ({ kind: 'step' as const, stepId, path: [] });
let executions: string[] = [];
const action = (name: string, costMicros = 1) => defineTool({ id: 'migration.effect', version: '1', description: 'Counted migration effect',
  input: z.unknown(), output: z.unknown(), effects: 'write', capabilities: [], costMicros, timeoutMs: 15_000,
  execute: () => { executions.push(name); return name; } });
const human = 'verified-migration-human';
const actor = { actorId: 'operator-1', commandId: 'migrate-1' };

// v1: draft -> publish (human-approved). v2 keeps both and adds an audit effect after publish.
const legacyV1 = defineWorkflow({ id: 'migration.scheduled', version: '1', input: z.unknown(), output: z.unknown(), nodes: [
  { kind: 'tool', id: 'draft', tool: action('draft'), input: literal(null) },
  { kind: 'tool', id: 'publish', dependsOn: ['draft'], tool: action('publish'), input: step('draft'), approval: true },
], result: step('publish') });
const legacyV2 = defineWorkflow({ id: 'migration.scheduled', version: '2', input: z.unknown(), output: z.unknown(), nodes: [
  { kind: 'tool', id: 'draft', tool: action('draft'), input: literal(null) },
  { kind: 'tool', id: 'publish', dependsOn: ['draft'], tool: action('publish'), input: step('draft'), approval: true },
  { kind: 'tool', id: 'audit', dependsOn: ['publish'], tool: action('audit'), input: step('publish') },
], result: step('audit') });
// A v2 that changes the already-executed draft effect: storage history makes this unmigratable.
const legacyChangedDraft = defineWorkflow({ id: 'migration.scheduled', version: '3', input: z.unknown(), output: z.unknown(), nodes: [
  { kind: 'tool', id: 'draft', tool: action('draft', 2), input: literal(null) },
  { kind: 'tool', id: 'publish', dependsOn: ['draft'], tool: action('publish'), input: step('draft'), approval: true },
], result: step('publish') });

export function scheduledMigrationConformance(name: string, open: () => Promise<GraphFixture>): void {
  describe(`scheduled and graph in-place migration on ${name}`, () => {
    let fixture: GraphFixture | undefined;
    let closers: { close(): unknown }[] = [];
    let worker = 0;
    afterEach(async () => {
      for (const runtime of closers) await runtime.close();
      await fixture?.store.close(); await fixture?.cleanup(); fixture = undefined; closers = []; executions = [];
    });
    const options = () => ({ store: fixture!.store, scope, permissions: { allow: ['tool:migration.effect', 'effect:write'] },
      policyVersion: 'migration-policy-1', maxCostMicros: 20, maxOutputBytes: 65_536, approvalTtlMs: 60_000, workerId: `migration-worker-${++worker}`,
      verifyHuman: async (credential: unknown) => {
        if (credential !== human) throw new Error('unverified');
        return { id: 'migration-human', projectId: scope.projectId, canApprove: true };
      } });
    const legacy = async () => {
      fixture ??= await open(); await fixture.store.initialize();
      const runtime = createScheduledWorkflowRuntime(options()); closers.push(runtime); return runtime;
    };
    const graphs = async () => {
      fixture ??= await open(); await fixture.store.initialize();
      const runtime = createWorkflowGraphRuntime(options()); closers.push(runtime); return runtime;
    };

    it('migrates a paused scheduled run waiting on approval, keeps executed history and completes on v2', async () => {
      const runtime = await legacy();
      const run = await runtime.submit(legacyV1, { input: null, idempotencyKey: 'legacy-run' });
      const waiting = await runtime.runUntilSettled(legacyV1, run.id);
      expect(waiting).toMatchObject({ status: 'waiting', steps: { draft: { status: 'succeeded' }, publish: { status: 'waiting' } } });
      const migration = defineWorkflowMigration({ id: 'scheduled-1-to-2', from: legacyV1, to: legacyV2 });
      expect((await runtime.migrate(migration, { id: run.id, ...actor, dryRun: true })).plan).toMatchObject({ allowed: false, blockers: [{ node: '*', reason: expect.stringContaining('pause it') }] });
      await runtime.pause(run.id);
      const before = (await runtime.inspect(run.id)).version;
      const plan = (await runtime.migrate(migration, { id: run.id, ...actor, dryRun: true })).plan;
      expect(plan.entries.map(entry => `${entry.action}:${entry.target ?? entry.source}`)).toEqual(['keep:draft', 'keep:publish', 'add:audit']);
      expect((await runtime.inspect(run.id)).version).toBe(before);
      const applied = await runtime.migrate(migration, { id: run.id, ...actor });
      expect((await runtime.reference(run.id)).definitionHash).toBe(legacyV2.digest);
      expect(applied.snapshot).toMatchObject({ status: 'paused', steps: { draft: { status: 'succeeded' }, publish: { status: 'waiting' }, audit: { status: 'pending' } } });
      // Retrying the same command is idempotent; the old definition can no longer drive the run.
      await expect(runtime.runUntilSettled(legacyV1, run.id)).rejects.toMatchObject({ code: 'CONFLICT' });
      await runtime.resume(run.id);
      const review = (await runtime.inspect(run.id)).steps['publish']!.approval!.digest;
      await runtime.approve({ id: run.id, nodeId: 'publish', digest: review, credential: human });
      expect(await runtime.runUntilSettled(legacyV2, run.id)).toMatchObject({ status: 'succeeded', output: 'audit' });
      expect(executions).toEqual(['draft', 'publish', 'audit']);
      const events = await runtime.events(run.id);
      expect(events.find(event => event.type === 'run.migrated')?.data).toMatchObject({ migrationId: 'scheduled-1-to-2', from: legacyV1.digest, to: legacyV2.digest, actorId: 'operator-1' });
    });

    it('refuses to change a step with scheduler history and leaves the run untouched', async () => {
      const runtime = await legacy();
      const run = await runtime.submit(legacyV1, { input: null, idempotencyKey: 'legacy-refused' });
      await runtime.runUntilSettled(legacyV1, run.id); await runtime.pause(run.id);
      const migration = defineWorkflowMigration({ id: 'scheduled-changed-draft', from: legacyV1, to: legacyChangedDraft, acceptCompleted: ['draft'] });
      const { plan } = await runtime.migrate(migration, { id: run.id, ...actor, dryRun: true });
      expect(plan.allowed).toBe(false);
      expect(plan.blockers).toContainEqual({ node: 'draft', reason: expect.stringContaining('scheduler history') });
      const version = (await runtime.inspect(run.id)).version;
      await expect(runtime.migrate(migration, { id: run.id, ...actor })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(await runtime.inspect(run.id)).toMatchObject({ version, status: 'paused' });
      expect((await runtime.reference(run.id)).definitionHash).toBe(legacyV1.digest);
    });

    it('migrates a paused graph run onto a new wait node and re-projects its targets', async () => {
      const legacyEngine = await legacy();
      const source = await legacyEngine.submit(legacyV1, { input: null, idempotencyKey: 'wait-target' });
      const reference: ExecutionRef = await legacyEngine.reference(source.id);
      const graphV1 = defineWorkflowGraph({ id: 'migration.graph', version: '1', input: z.unknown(), output: z.unknown(), nodes: [
        { kind: 'tool', id: 'prepare', tool: action('prepare'), input: literal(null) },
        { kind: 'tool', id: 'ship', dependsOn: ['prepare'], tool: action('ship'), input: step('prepare'), approval: true },
      ], result: step('ship') });
      const graphV2 = defineWorkflowGraph({ id: 'migration.graph', version: '2', input: z.unknown(), output: z.unknown(), nodes: [
        { kind: 'tool', id: 'prepare', tool: action('prepare'), input: literal(null) },
        { kind: 'wait', id: 'upstream', targets: { kind: 'literal', value: [reference] } },
        { kind: 'tool', id: 'ship', dependsOn: ['prepare', 'upstream'], tool: action('ship'), input: step('prepare'), approval: true },
      ], result: step('ship') });
      const runtime = await graphs();
      const run = await runtime.submit(graphV1, { input: null, idempotencyKey: 'graph-run' });
      expect((await runtime.runUntilSettled(graphV1, run.id)).steps['ship']!.status).toBe('waiting');
      await runtime.pause(run.id);
      const migration = defineWorkflowMigration({ id: 'graph-1-to-2', from: graphV1, to: graphV2 });
      const applied = await runtime.migrate(migration, { id: run.id, ...actor });
      expect(applied.plan.entries.map(entry => `${entry.action}:${entry.target ?? entry.source}`)).toEqual(['keep:prepare', 'add:upstream', 'reset:ship']);
      expect(applied.snapshot).toMatchObject({ status: 'paused', steps: { prepare: { status: 'succeeded' }, upstream: { status: 'pending' }, ship: { status: 'pending' } } });
      const targets = await fixture!.query(`SELECT run_id FROM ${fixture!.prefix}mayura_workflow_wait_targets WHERE aggregate_id = ${fixture!.dialect === 'postgres' ? '$1' : '?'}`, [run.id]);
      expect(targets.map(row => row['run_id'])).toEqual([source.id]);
      // The upstream run is now a wait target: it cannot itself be migrated underneath its waiter.
      await legacyEngine.pause(source.id);
      await expect(legacyEngine.migrate(defineWorkflowMigration({ id: 'target-1-to-2', from: legacyV1, to: legacyV2 }), { id: source.id, ...actor }))
        .rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('waits on this run') });
      await legacyEngine.resume(source.id);
      await runtime.resume(run.id);
      expect((await runtime.runUntilSettled(graphV2, run.id)).steps['upstream']!.status).toBe('waiting');
      await legacyEngine.runUntilSettled(legacyV1, source.id);
      await legacyEngine.approve({ id: source.id, nodeId: 'publish', digest: (await legacyEngine.inspect(source.id)).steps['publish']!.approval!.digest, credential: human });
      expect((await legacyEngine.runUntilSettled(legacyV1, source.id)).status).toBe('succeeded');
      const ready = await runtime.runUntilSettled(graphV2, run.id);
      expect(ready.steps['upstream']!.status).toBe('succeeded');
      await runtime.approve({ id: run.id, nodeId: 'ship', digest: ready.steps['ship']!.approval!.digest, credential: human });
      expect(await runtime.runUntilSettled(graphV2, run.id)).toMatchObject({ status: 'succeeded', output: 'ship' });
      expect(executions.filter(name => name === 'prepare')).toHaveLength(1);
    });

    it('lists paused graph runs for operators and inventories while coordinators skip them', async () => {
      const runtime = await graphs();
      const definition = defineWorkflowGraph({ id: 'migration.paused', version: '1', input: z.unknown(), output: z.unknown(), nodes: [
        { kind: 'tool', id: 'ship', tool: action('ship'), input: literal(null), approval: true },
      ], result: step('ship') });
      const run = await runtime.submit(definition, { input: null, idempotencyKey: 'paused-graph' });
      await runtime.runUntilSettled(definition, run.id); await runtime.pause(run.id);
      const authority = { store: fixture!.store, scope, permissions: { allow: ['tool:migration.effect', 'effect:write'] }, policyVersion: 'migration-policy-1',
        maxCostMicros: 20, maxOutputBytes: 65_536, approvalTtlMs: 60_000 };
      const discovery = createWorkflowGraphDiscovery(authority); closers.push(discovery);
      expect((await discovery.scan({ limit: 16 })).candidates).toMatchObject([{ reference: { runId: run.id }, status: 'paused' }]);
      expect((await graphFleetTarget(discovery, runtime).discover(null, 16)).runIds).toEqual([]);
      expect((await graphFleetTarget(discovery, runtime, 'graphs', { includePaused: true }).discover(null, 16)).runIds).toEqual([run.id]);
      const inventory = await inventoryWorkflowVersions({ store: fixture!.store, scope, registered: [definition],
        targets: [graphFleetTarget(discovery, runtime, 'graphs', { includePaused: true })] });
      expect(inventory.versions).toMatchObject([{ definitionHash: definition.digest, activeRuns: 1 }]);
      const coordinator = createWorkflowGraphCoordinator({ ...authority, workerId: 'migration-coordinator', definitions: [{ definition }] }); closers.push(coordinator);
      expect((await coordinator.runPage()).outcomes).toMatchObject([{ kind: 'skipped', reason: 'paused' }]);
      expect(executions).toEqual([]);
    });
  });
}
