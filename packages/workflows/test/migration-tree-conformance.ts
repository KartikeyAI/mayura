import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '@mayura/tools';
import type { WorkflowTreeAggregateStore, WorkflowTreeDiscoveryAggregateStore } from '@mayura/storage-contracts';
import { createWorkflowTreeCoordinator, createWorkflowTreeDiscovery, createWorkflowTreeRuntime, defineWorkflowMigration, defineWorkflowTree } from '../src/children.js';
import { inventoryWorkflowVersions, treeFleetTarget } from '../src/index.js';
import { defineWorkflow } from '../src/definition.js';

const scope = { principalId: 'tree-migration', projectId: 'project' };
const actor = { actorId: 'operator-1', commandId: 'migrate-1' };
let executions: string[] = [];
const tool = (id: string) => defineTool({ id, version: '1', description: id, input: z.number(), output: z.number(), effects: 'none', capabilities: [], costMicros: 1,
  execute: async (value: number) => { executions.push(id); return value + 1; } });
const prepare = tool('prepare'); const work = tool('work'); const audit = tool('audit');
const leaf = (approval: boolean, version = '1') => defineWorkflow({ id: 'leaf', version, input: z.number(), output: z.number(),
  nodes: [{ kind: 'tool', id: 'work', tool: work, input: { kind: 'input', path: [] }, approval }], result: { kind: 'step', stepId: 'work', path: [] } });
const policy = { permissions: ['tool:work'], maxCostMicros: 1, maxCalls: 1, maxOutputBytes: 1_024, approvalTtlMs: 60_000 };
const childNode = (workflow: ReturnType<typeof leaf>, dependsOn: readonly string[] = []) => ({ kind: 'child' as const, id: 'leaf', dependsOn: [...dependsOn], workflow,
  input: dependsOn.length ? { kind: 'step' as const, stepId: dependsOn[0]!, path: [] } : { kind: 'input' as const, path: [] }, policy, resources: { work: [] } });
const auditNode = { kind: 'tool' as const, id: 'audit', dependsOn: ['leaf'], tool: audit, input: { kind: 'step' as const, stepId: 'leaf', path: [] } };
const human = async () => ({ id: 'reviewer', projectId: 'project', canApprove: true });
const actions = (plan: { readonly entries: readonly { readonly action: string; readonly target?: string; readonly source?: string }[] }) =>
  plan.entries.map(entry => `${entry.action}:${entry.target ?? entry.source}`);

export function treeMigrationConformance(name: string, open: () => Promise<WorkflowTreeAggregateStore & WorkflowTreeDiscoveryAggregateStore & { close(): Promise<void> }>): void {
  describe(`workflow-tree in-place migration on ${name}`, () => {
    const closers: { close(): Promise<void> }[] = [];
    afterEach(async () => { for (const item of closers.splice(0).reverse()) await item.close(); executions = []; });
    let current: (WorkflowTreeAggregateStore & WorkflowTreeDiscoveryAggregateStore & { close(): Promise<void> }) | undefined;
    const authority = () => ({ store: current!, scope, permissions: { allow: ['tool:prepare', 'tool:work', 'tool:audit'] }, policyVersion: '1',
      maxCostMicros: 3, maxCalls: 3, maxOutputBytes: 1_024 });
    const setup = async () => {
      current = await open(); closers.push(current); await current.initialize();
      const runtime = createWorkflowTreeRuntime({ ...authority(), workerId: 'tree-worker', verifyHuman: human });
      closers.push(runtime); return runtime;
    };

    it('migrates a paused tree waiting on a root approval, adds a root step and completes once', async () => {
      const runtime = await setup();
      const v1 = defineWorkflowTree({ id: 'tree', version: '1', input: z.number(), output: z.number(), nodes: [
        { kind: 'tool', id: 'prepare', tool: prepare, input: { kind: 'input', path: [] }, approval: true }, childNode(leaf(false), ['prepare']),
      ], result: { kind: 'step', stepId: 'leaf', path: [] } });
      const v2 = defineWorkflowTree({ id: 'tree', version: '2', input: z.number(), output: z.number(), nodes: [
        { kind: 'tool', id: 'prepare', tool: prepare, input: { kind: 'input', path: [] }, approval: true }, childNode(leaf(false), ['prepare']), auditNode,
      ], result: { kind: 'step', stepId: 'audit', path: [] } });
      const run = await runtime.submit(v1, { input: 1, idempotencyKey: 'root-approval' });
      expect((await runtime.runUntilSettled(v1, run.id)).steps['prepare']!.status).toBe('waiting');
      const migration = defineWorkflowMigration({ id: 'tree-1-to-2', from: v1, to: v2 });
      expect((await runtime.migrate(migration, { id: run.id, ...actor, dryRun: true })).plan.allowed).toBe(false);
      await runtime.pause(run.id);
      const applied = await runtime.migrate(migration, { id: run.id, ...actor });
      expect(actions(applied.plan)).toEqual(['keep:prepare', 'keep:leaf', 'add:audit']);
      expect(applied.snapshot).toMatchObject({ status: 'paused', steps: { prepare: { status: 'waiting' }, audit: { status: 'pending' } } });
      await expect(runtime.runUntilSettled(v1, run.id)).rejects.toMatchObject({ code: 'CONFLICT' });
      await runtime.resume(run.id);
      const waiting = await runtime.inspect(run.id);
      await runtime.approve({ id: run.id, nodeId: 'prepare', digest: (waiting.steps['prepare']!.approval as { digest: string }).digest, credential: 'reviewer' });
      expect(await runtime.runUntilSettled(v2, run.id)).toMatchObject({ status: 'succeeded', output: 4 });
      expect(executions).toEqual(['prepare', 'work', 'audit']);
      expect((await runtime.events(run.id)).find(event => event.type === 'run.migrated')?.data).toMatchObject({ migrationId: 'tree-1-to-2', from: v1.digest, to: v2.digest });
    });

    it('keeps an admitted child exactly and refuses to change it', async () => {
      const runtime = await setup();
      const v1 = defineWorkflowTree({ id: 'tree', version: '1', input: z.number(), output: z.number(), nodes: [childNode(leaf(true))], result: { kind: 'step', stepId: 'leaf', path: [] } });
      const changed = defineWorkflowTree({ id: 'tree', version: '3', input: z.number(), output: z.number(), nodes: [childNode(leaf(true, '2'))], result: { kind: 'step', stepId: 'leaf', path: [] } });
      const v2 = defineWorkflowTree({ id: 'tree', version: '2', input: z.number(), output: z.number(), nodes: [childNode(leaf(true)), auditNode], result: { kind: 'step', stepId: 'audit', path: [] } });
      const run = await runtime.submit(v1, { input: 1, idempotencyKey: 'admitted-child' });
      const waiting = await runtime.runUntilSettled(v1, run.id);
      const childId = waiting.steps['leaf']!.child!.runId;
      await runtime.pause(run.id);
      const refused = (await runtime.migrate(defineWorkflowMigration({ id: 'tree-change-child', from: v1, to: changed }), { id: run.id, ...actor, dryRun: true })).plan;
      expect(refused.allowed).toBe(false);
      expect(refused.blockers).toContainEqual({ node: 'leaf', reason: expect.stringContaining('execution history') });
      const applied = await runtime.migrate(defineWorkflowMigration({ id: 'tree-add-audit', from: v1, to: v2 }), { id: run.id, ...actor });
      expect(actions(applied.plan)).toEqual(['keep:leaf', 'add:audit']);
      expect(applied.snapshot!.steps['leaf']!.child!.runId).toBe(childId);
      await runtime.resume(run.id);
      const child = await runtime.inspectChild(run.id, childId);
      await runtime.approve({ id: run.id, childId, nodeId: 'work', digest: (child.steps['work']!.approval as { digest: string }).digest, credential: 'reviewer' });
      expect(await runtime.runUntilSettled(v2, run.id)).toMatchObject({ status: 'succeeded', output: 3 });
      expect(executions).toEqual(['work', 'audit']);
    });

    it('lists paused trees for operators and inventories while coordinators skip them', async () => {
      const runtime = await setup();
      const v1 = defineWorkflowTree({ id: 'tree', version: '1', input: z.number(), output: z.number(), nodes: [childNode(leaf(true))], result: { kind: 'step', stepId: 'leaf', path: [] } });
      const run = await runtime.submit(v1, { input: 1, idempotencyKey: 'paused-tree' });
      await runtime.runUntilSettled(v1, run.id); await runtime.pause(run.id);
      const discovery = createWorkflowTreeDiscovery({ ...authority() }); closers.push(discovery);
      expect((await discovery.scan({ limit: 16 })).candidates).toMatchObject([{ rootId: run.id, status: 'paused' }]);
      expect((await treeFleetTarget(discovery, runtime).discover(null, 128)).runIds).toEqual([]);
      const inventory = await inventoryWorkflowVersions({ store: current!, scope, registered: [v1], targets: [treeFleetTarget(discovery, runtime, 'trees', { includePaused: true })] });
      expect(inventory.versions).toMatchObject([{ definitionHash: v1.digest, activeRuns: 1 }]);
      const coordinator = createWorkflowTreeCoordinator({ ...authority(), workerId: 'tree-coordinator', definitions: [v1] }); closers.push(coordinator);
      expect((await coordinator.runPage({ limit: 32 })).outcomes).toMatchObject([{ kind: 'skipped', rootId: run.id, reason: 'paused' }]);
      expect(executions).toEqual([]);
    });
  });
}
