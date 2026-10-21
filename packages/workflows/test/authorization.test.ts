import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createAuthorizer, type AuthorizationAuditEvent, type AuthorizationRequest } from '@mayura/core';
import { defineTool } from '@mayura/tools';
import { createSqliteStore } from '@mayura/storage';
import { createWorkflowRuntime } from '../src/runtime.js';
import { createScheduledWorkflowRuntime } from '../src/scheduled.js';
import { defineWorkflow } from '../src/definition.js';
import { createWorkflowTreeRuntime } from '../src/children-runtime.js';
import { defineWorkflowTree } from '../src/children-definition.js';
import { createWorkflowLifecycleRuntime } from '../src/lifecycle-runtime.js';
import { defineWorkflowLifecycle } from '../src/lifecycle-definition.js';

const scope = { principalId: 'worker', projectId: 'project' };
const shared = { scope, permissions: { allow: ['tool:write', 'effect:write'] }, policyVersion: '1', maxCostMicros: 3 };
const close: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of close.splice(0).reverse()) await cleanup(); });
async function fixture(deny: (request: AuthorizationRequest) => boolean) {
  const store = createSqliteStore({ filename: ':memory:' });
  await store.initialize(); close.push(() => store.close());
  const events: AuthorizationAuditEvent[] = [];
  const authorization = createAuthorizer({ permissions: { allow: ['authz:evaluate', 'authz:audit'] },
    audit: { sink: event => { events.push(event); } }, policy: { version: 'live', authorize: request => deny(request)
      ? { effect: 'deny', reason: 'explicit_deny', policyVersion: 'live', ruleId: null }
      : { effect: 'allow', reason: 'allowed', policyVersion: 'live', ruleId: null } } });
  close.push(() => authorization.close());
  return { store, authorization, events };
}
function definition(execute = vi.fn(async (value: number) => value + 1)) {
  const tool = defineTool({ id: 'write', version: '1', description: 'Controlled write.', input: z.number(), output: z.number(),
    effects: 'write', capabilities: [], costMicros: 3, execute });
  const options = { id: 'flow', version: '1', input: z.number(), output: z.number(),
    nodes: [{ kind: 'tool' as const, id: 'work', tool, input: { kind: 'input' as const, path: [] } }],
    result: { kind: 'step' as const, stepId: 'work', path: [] } };
  return { execute, options, workflow: defineWorkflow(options) };
}

describe('workflow execution authorization (offline)', () => {
  for (const profile of ['conservative', 'scheduled'] as const) {
    it(`${profile}: denied admission creates no durable run and emits no input`, async () => {
      const { store, authorization, events } = await fixture(request => request.resource.kind === 'workflow');
      const { workflow, execute } = definition(); const create = vi.spyOn(store, 'create');
      const runtime = profile === 'conservative' ? createWorkflowRuntime({ ...shared, store, authorization })
        : createScheduledWorkflowRuntime({ ...shared, store, authorization, workerId: 'worker' });
      close.push(() => runtime.close());
      await expect((runtime.submit as (candidate: typeof workflow, command: { input: number; idempotencyKey: string }) => Promise<{ id: string }>)(workflow, { input: 712345, idempotencyKey: 'denied' })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      expect(create).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
      await authorization.flushAudit(); expect(events).toHaveLength(1);
      expect(events[0]?.request?.resource.id).toBe(workflow.digest);
      expect(JSON.stringify(events)).not.toContain('712345');
    });

    it(`${profile}: resumed tool denial leaves a pending step unclaimed and retry executes once`, async () => {
      let denied = false;
      const { store, authorization } = await fixture(request => denied && request.resource.kind === 'tool');
      const { workflow, execute } = definition();
      const runtime = profile === 'conservative' ? createWorkflowRuntime({ ...shared, store, authorization })
        : createScheduledWorkflowRuntime({ ...shared, store, authorization, workerId: 'worker' });
      close.push(() => runtime.close());
      const run = await (runtime.submit as (candidate: typeof workflow, command: { input: number; idempotencyKey: string }) => Promise<{ id: string }>)(workflow, { input: 1, idempotencyKey: 'resume' }); denied = true;
      await expect(runtime.runUntilSettled(workflow, run.id)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      expect((await runtime.inspect(run.id)).steps['work']?.status).toBe('pending');
      expect(execute).not.toHaveBeenCalled(); denied = false;
      expect(await runtime.runUntilSettled(workflow, run.id)).toMatchObject({ status: 'succeeded', output: 2 });
      await runtime.runUntilSettled(workflow, run.id); expect(execute).toHaveBeenCalledTimes(1);
    });

    it(`${profile}: revocation after a write retains evidence and cost without replay`, async () => {
      let revoked = false;
      const { store, authorization } = await fixture(request => revoked && request.resource.kind === 'workflow');
      const execute = vi.fn(async (value: number) => { revoked = true; return value + 1; });
      const { workflow } = definition(execute);
      const runtime = profile === 'conservative' ? createWorkflowRuntime({ ...shared, store, authorization })
        : createScheduledWorkflowRuntime({ ...shared, store, authorization, workerId: 'worker' });
      close.push(() => runtime.close());
      const run = await (runtime.submit as (candidate: typeof workflow, command: { input: number; idempotencyKey: string }) => Promise<{ id: string }>)(workflow, { input: 1, idempotencyKey: 'revoked' });
      await expect(runtime.runUntilSettled(workflow, run.id)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      const state = await runtime.inspect(run.id);
      expect(state.steps['work']).toMatchObject({ status: 'blocked', output: null, receipt: { execution: 'succeeded', disclosure: 'withheld' } });
      expect(state.budget.spentMicros).toBe(3); revoked = false;
      await runtime.runUntilSettled(workflow, run.id); expect(execute).toHaveBeenCalledTimes(1);
    });
  }

  it('policy failures deny with fixed diagnostics before any workflow write', async () => {
    const { store, authorization } = await fixture(() => { throw new Error('PRIVATE policy credential'); });
    const { workflow, execute } = definition();
    const runtime = createWorkflowRuntime({ ...shared, store, authorization }); close.push(() => runtime.close());
    await expect((runtime.submit as (candidate: typeof workflow, command: { input: number; idempotencyKey: string }) => Promise<{ id: string }>)(workflow, { input: 1, idempotencyKey: 'failed-policy' })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED', message: 'Workflow operation is not authorized.',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('closing an engine cancels its pending admission without closing the shared authorizer', async () => {
    const store = createSqliteStore({ filename: ':memory:' }); await store.initialize(); close.push(() => store.close());
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    let wait = true;
    const authorization = createAuthorizer({ permissions: { allow: ['authz:evaluate'] }, policy: {
      version: 'cancel', authorize: async (_request, { signal }) => {
        if (wait) { entered(); await new Promise<void>(resolve => {
          if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true });
        }); }
        return { effect: 'allow', reason: 'allowed', policyVersion: 'cancel', ruleId: null };
      },
    } }); close.push(() => authorization.close());
    const { workflow, execute } = definition();
    const runtime = createWorkflowRuntime({ ...shared, store, authorization }); close.push(() => runtime.close());
    const admission = (runtime.submit as (candidate: typeof workflow, command: { input: number; idempotencyKey: string }) => Promise<{ id: string }>)(workflow, { input: 1, idempotencyKey: 'cancel' });
    const denied = expect(admission).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await started; runtime.close(); await denied; expect(execute).not.toHaveBeenCalled(); wait = false;
    await expect(authorization.authorize(scope, 'execute', { kind: 'workflow', id: workflow.digest, scope })).resolves.toMatchObject({ effect: 'allow' });
  });

  it('lifecycle execution uses the same core contract before human or tool scheduling', async () => {
    let denied = false;
    const { store, authorization } = await fixture(request => denied && request.resource.kind === 'run');
    const { options, execute } = definition(); const workflow = defineWorkflowLifecycle(options);
    const runtime = createWorkflowLifecycleRuntime({ ...shared, store, authorization }); close.push(() => runtime.close());
    const run = await (runtime.submit as (candidate: typeof workflow, command: { input: number; idempotencyKey: string }) => Promise<{ id: string }>)(workflow, { input: 1, idempotencyKey: 'lifecycle' }); denied = true;
    await expect(runtime.runUntilSettled(workflow, run.id)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(execute).not.toHaveBeenCalled();
    expect((await runtime.inspect(run.id)).steps['work']?.status).toBe('pending');
  });

  it('child delegation denies before admission; independent child grants and budget remain intact', async () => {
    let denied = true;
    const { store, authorization } = await fixture(request => denied && request.action === 'delegate');
    const { workflow: leaf, execute } = definition();
    const tree = defineWorkflowTree({ id: 'tree', version: '1', input: z.number(), output: z.number(),
      nodes: [{ kind: 'child', id: 'child', workflow: leaf, input: { kind: 'input', path: [] },
        policy: { permissions: shared.permissions.allow, maxCostMicros: 3, maxCalls: 1, maxOutputBytes: 1024, approvalTtlMs: 5000 } }],
      result: { kind: 'step', stepId: 'child', path: [] } });
    const runtime = createWorkflowTreeRuntime({ ...shared, store, authorization, maxCalls: 1, workerId: 'worker' });
    close.push(() => runtime.close()); const run = await runtime.submit(tree, { input: 1, idempotencyKey: 'tree' });
    await expect(runtime.runUntilSettled(tree, run.id)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect((await runtime.inspect(run.id)).steps['child']?.child).toBeNull(); expect(execute).not.toHaveBeenCalled();
    denied = false; expect(await runtime.runUntilSettled(tree, run.id)).toMatchObject({ status: 'succeeded', output: 2 });
    await runtime.runUntilSettled(tree, run.id); expect(execute).toHaveBeenCalledTimes(1);
    await runtime.close();
    await expect(authorization.authorize(scope, 'execute', { kind: 'workflow', id: leaf.digest, scope })).resolves.toMatchObject({ effect: 'allow' });
  });
  it('child disclosure rechecks the parent after a completed write and never replays it', async () => {
    let rootDigest = ''; let revoked = false;
    const { store, authorization } = await fixture(request => revoked && request.resource.kind === 'workflow' && request.resource.id === rootDigest);
    const execute = vi.fn(async (value: number) => { revoked = true; return value + 1; });
    const { workflow: leaf } = definition(execute);
    const tree = defineWorkflowTree({ id: 'parent', version: '1', input: z.number(), output: z.number(),
      nodes: [{ kind: 'child', id: 'child', workflow: leaf, input: { kind: 'input', path: [] },
        policy: { permissions: shared.permissions.allow, maxCostMicros: 3, maxCalls: 1, maxOutputBytes: 1024, approvalTtlMs: 5000 } }],
      result: { kind: 'step', stepId: 'child', path: [] } }); rootDigest = tree.digest;
    const runtime = createWorkflowTreeRuntime({ ...shared, store, authorization, maxCalls: 1, workerId: 'worker' });
    close.push(() => runtime.close()); const run = await runtime.submit(tree, { input: 1, idempotencyKey: 'parent-revoke' });
    await expect(runtime.runUntilSettled(tree, run.id)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const root = await runtime.inspect(run.id); const childId = root.steps['child']?.child?.runId;
    expect(childId).toBeDefined();
    const child = await runtime.inspectChild(run.id, childId!);
    expect(child.steps['work']).toMatchObject({ output: null, receipt: { execution: 'succeeded', disclosure: 'withheld' } });
    revoked = false; await runtime.runUntilSettled(tree, run.id); expect(execute).toHaveBeenCalledTimes(1);
  });

});
