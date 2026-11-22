import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { workflowNodeLimitsFromEnv } from '@mayura/core/host';
import { defineTool } from '@mayura/tools';
import type { ScheduledWorkflowAggregateStore } from '@mayura/storage-contracts';
import { createWorkflowRuntime, createScheduledWorkflowRuntime, defineWorkflow } from '../src/index.js';
import { createWorkflowLifecycleRuntime, defineWorkflowLifecycle, defineWorkflowMigration } from '../src/lifecycle.js';
import { createWorkflowGraphRuntime, defineWorkflowGraph } from '../src/graphs.js';
import { createWorkflowTreeRuntime, defineWorkflowTree } from '../src/children.js';
import { digest } from '../src/definition.js';
import { sqliteFixture } from './fixtures.js';

const scope = { principalId: 'large-graph', projectId: 'node-limits' };
const largeGraphTimeout = process.env['CI'] === 'true' && process.platform === 'win32' ? 180_000 : 60_000;
const joins = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ kind: 'join' as const, id: `n${index}`, dependsOn: [] }));

describe('larger workflow graphs on durable SQLite storage', () => {
  it.each([256, false] as const)('persists reviewed migrations from the legacy bound to a larger graph and back (%s)', async (maxNodes) => {
    const fixture = await sqliteFixture(); const store = fixture.store;
    const runtime = createWorkflowLifecycleRuntime({ store,scope,permissions:{allow:[]},policyVersion:'1',maxCostMicros:0 });
    try {
      await store.initialize();
      const base = { id:'migrate-bound',input:z.null(),output:z.null(),result:{kind:'input' as const,path:[]} };
      const from = defineWorkflowLifecycle({ ...base,version:'1',nodes:joins(1) });
      const wide = defineWorkflowLifecycle({ ...base,version:'2',maxNodes,nodes:joins(129) });
      const small = defineWorkflowLifecycle({ ...base,version:'3',nodes:joins(1) });
      const run = await runtime.submit(from,{input:null,idempotencyKey:'migration'});await runtime.pause(run.id);
      await runtime.migrate(defineWorkflowMigration({id:'expand',from,to:wide}),{id:run.id,actorId:'operator',commandId:'expand'});
      const key=digest('mayura:scope:v1',scope);expect((await store.read(key,run.id))!.state.maxNodes).toBe(maxNodes);
      await runtime.migrate(defineWorkflowMigration({id:'shrink',from:wide,to:small}),{id:run.id,actorId:'operator',commandId:'shrink'});
      expect((await store.read(key,run.id))!.state.maxNodes).toBe(128);
      await runtime.resume(run.id);expect((await runtime.runUntilSettled(small,run.id)).status).toBe('succeeded');
    } finally {runtime.close();await store.close();await fixture.cleanup();}
  });
  it('runs 512-node plain, scheduled and wait-capable graphs and a 256-node tree', async () => {
    const fixture = await sqliteFixture();
    const store = fixture.store as ScheduledWorkflowAggregateStore;
    const runtimes: { close(): void | Promise<void> }[] = [];
    try {
      await store.initialize();
      const common = { scope, permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0 };
      const options = {
        id: 'large-joins',
        version: '1',
        input: z.null(),
        output: z.null(),
        maxNodes: 512,
        nodes: joins(512),
        result: { kind: 'input' as const, path: [] },
      };
      const plain = defineWorkflow(options);
      const direct = createWorkflowRuntime({ store, ...common });
      runtimes.push(direct);
      const run = await direct.submit(plain, { input: null, idempotencyKey: 'direct' });
      expect((await direct.runUntilSettled(plain, run.id)).status).toBe('succeeded');
      const scheduled = createScheduledWorkflowRuntime({ store, ...common, workerId: 'scheduled' });
      runtimes.push(scheduled);
      const submitted = await scheduled.submit(plain, { input: null, idempotencyKey: 'scheduled' });
      expect((await scheduled.runUntilSettled(plain, submitted.id)).status).toBe('succeeded');
      const graph = defineWorkflowGraph({ ...options, id: 'large-wait-graph' });
      const graphRuntime = createWorkflowGraphRuntime({ store: store as never, ...common, workerId: 'graph' });
      runtimes.push(graphRuntime);
      const graphRun = await graphRuntime.submit(graph, { input: null, idempotencyKey: 'graph' });
      expect((await graphRuntime.runUntilSettled(graph, graphRun.id)).status).toBe('succeeded');
      const tree = defineWorkflowTree({ ...options, id: 'large-tree', maxNodes: 256, nodes: joins(256) });
      const treeRuntime = createWorkflowTreeRuntime({
        store: store as never,
        ...common,
        maxCalls: 1,
        workerId: 'tree',
      });
      runtimes.push(treeRuntime);
      const treeRun = await treeRuntime.submit(tree, { input: null, idempotencyKey: 'tree' });
      expect((await treeRuntime.runUntilSettled(tree, treeRun.id)).status).toBe('succeeded');
    } finally {
      for (const runtime of runtimes) await runtime.close();
      await store.close();
      await fixture.cleanup();
    }
  }, largeGraphTimeout);

  it('reopens an environment-opted-in 513-node lifecycle and executes its dependent write exactly once', async () => {
    const fixture = await sqliteFixture();
    let store = fixture.store;
    let runtime: ReturnType<typeof createWorkflowLifecycleRuntime> | undefined;
    const execute = vi.fn((value: number) => value);
    const tool = defineTool({
      id: 'large.write',
      version: '1',
      description: 'Controlled offline write',
      input: z.number(),
      output: z.number(),
      effects: 'write',
      capabilities: [],
      costMicros: 1,
      execute,
    });
    const definition = defineWorkflowLifecycle({
      id: 'large-lifecycle',
      version: '1',
      input: z.number(),
      output: z.number(),
      ...workflowNodeLimitsFromEnv({MAYURA_WORKFLOW_DISABLE_MAX_NODES:'true'}),
      nodes: [
        ...joins(511),
        {
          kind: 'signal',
          id: 'gate',
          name: 'continue',
          payload: z.number(),
          dependsOn: joins(511).map((node) => node.id),
        },
        { kind: 'tool', id: 'write', tool, dependsOn: ['gate'], input: { kind: 'step', stepId: 'gate', path: [] } },
      ],
      result: { kind: 'step', stepId: 'write', path: [] },
    });
    const open = () =>
      createWorkflowLifecycleRuntime({
        store,
        scope,
        permissions: { allow: ['tool:large.write', 'effect:write'] },
        policyVersion: '1',
        maxCostMicros: 1,
      });
    try {
      await store.initialize();
      runtime = open();
      const run = await runtime.submit(definition, { input: 0, idempotencyKey: 'restart' });
      expect((await runtime.runUntilSettled(definition, run.id)).status).toBe('waiting');
      expect(execute).not.toHaveBeenCalled();
      runtime.close();
      await store.close();
      store = fixture.reopen();
      await store.initialize();
      runtime = open();
      await runtime.signal(definition, { id: run.id, name: 'continue', signalId: 'signal-1', payload: 7 });
      expect(await runtime.runUntilSettled(definition, run.id)).toMatchObject({
        status: 'succeeded',
        output: 7,
        budget: { spentMicros: 1 },
      });
      await runtime.runUntilSettled(definition, run.id);
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      runtime?.close();
      await store.close();
      await fixture.cleanup();
    }
  }, largeGraphTimeout);

  it('recovers more than 128 prepared jobs without replaying an uncertain write after restart', async () => {
    const fixture = await sqliteFixture();
    let store = fixture.store as ScheduledWorkflowAggregateStore;
    let runtime: ReturnType<typeof createScheduledWorkflowRuntime> | undefined;
    const execute = vi.fn((value: number) => value);
    const tool = defineTool({
      id: 'large.effect',
      version: '1',
      description: 'Controlled offline effect',
      input: z.number(),
      output: z.number(),
      effects: 'write',
      capabilities: [],
      costMicros: 1,
      execute,
    });
    const definition = defineWorkflow({
      id: 'large-effects',
      version: '1',
      input: z.number(),
      output: z.number(),
      maxNodes: 256,
      nodes: Array.from({ length: 129 }, (_, index) => ({
        kind: 'tool' as const,
        id: `n${index}`,
        tool,
        input: { kind: 'input' as const, path: [] },
      })),
      result: { kind: 'step', stepId: 'n128', path: [] },
    });
    const open = (allow = ['tool:large.effect', 'effect:write']) =>
      createScheduledWorkflowRuntime({
        store,
        scope,
        permissions: { allow },
        policyVersion: '1',
        maxCostMicros: 129,
        workerId: 'large-worker',
        maxConcurrentJobs: 1,
        leaseMs: 300_000,
        verifyHuman: async () => ({ id: 'reviewer', projectId: scope.projectId, canApprove: true }),
      });
    try {
      await store.initialize();
      runtime = open();
      const run = await runtime.submit(definition, { input: 3, idempotencyKey: 'effects' });
      const access = { scope: digest('mayura:scope:v1', scope), id: run.id };
      const record = await store.read(access.scope, run.id);
      expect(record?.state.maxNodes).toBe(256);
      const authority = { ...access, policyHash: record!.state.policy as string };
      let owned = await store.workflows.inspect(authority);
      for (const node of definition.nodes)
        owned = await store.workflows.prepare({
          ...authority,
          expectedVersion: owned.record.version,
          commandId: `prepare-${node.id}`,
          nodeId: node.id,
          input: 3,
        });
      expect(owned.jobs).toHaveLength(129);
      const [claimed] = await store.workflows.claim({
        ...authority,
        workerId: 'lost-worker',
        limit: 1,
        leaseMs: 1_000,
      });
      owned = await store.workflows.inspect(authority);
      await store.workflows.start({
        ...authority,
        expectedVersion: owned.record.version,
        commandId: 'start',
        claim: claimed!.claim,
        input: 3,
      });
      execute(3); // The external write happened, but the worker died before recording its receipt.
      await runtime.close();
      await store.close();
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      store = fixture.reopen() as ScheduledWorkflowAggregateStore;
      await store.initialize();
      runtime = open();
      const recovered = await runtime.recoverExpired(run.id);
      expect(recovered.steps[claimed!.job.nodeId]).toMatchObject({ status: 'unknown' });
      // Explicitly cancel the independent, unstarted siblings; recovery must not replay the uncertain node.
      await runtime.cancel(run.id);
      const stopped = await runtime.runUntilSettled(definition, run.id);
      expect(stopped.status).toBe('cancelled');
      expect(stopped.steps[claimed!.job.nodeId]).toMatchObject({ status: 'unknown' });
      expect(execute).toHaveBeenCalledOnce();
      const cancelled = await runtime.submit(definition, { input: 4, idempotencyKey: 'cancel' });
      await runtime.cancel(cancelled.id);
      expect((await runtime.runUntilSettled(definition, cancelled.id)).status).toBe('cancelled');
      expect(execute).toHaveBeenCalledOnce();
      await runtime.close();
      runtime = open([]);
      const denied = await runtime.submit(definition, { input: 5, idempotencyKey: 'denied' });
      expect((await runtime.runUntilSettled(definition, denied.id)).status).toBe('blocked');
      expect(execute).toHaveBeenCalledOnce();
      await runtime.close();
      runtime = open(['tool:large.failure', 'effect:write']);
      const failure = defineTool({
        id: 'large.failure',
        version: '1',
        description: 'Controlled failure',
        input: z.number(),
        output: z.number(),
        effects: 'none',
        capabilities: [],
        costMicros: 1,
        execute: () => {
          throw new Error('offline failure');
        },
      });
      const failing = defineWorkflow({
        id: 'large-failure',
        version: '1',
        input: z.number(),
        output: z.number(),
        maxNodes: 256,
        nodes: [...joins(128), { kind: 'tool', id: 'fail', tool: failure, input: { kind: 'input', path: [] } }],
        result: { kind: 'step', stepId: 'fail', path: [] },
      });
      const failed = await runtime.submit(failing, { input: 0, idempotencyKey: 'failure' });
      expect(await runtime.runUntilSettled(failing, failed.id)).toMatchObject({
        status: 'failed',
        steps: { fail: { receipt: { execution: 'failed' } } },
      });
    } finally {
      await runtime?.close();
      await store.close();
      await fixture.cleanup();
    }
  }, largeGraphTimeout * 1.5);
});
