import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineTool } from '@mayura/tools';
import { scriptedModel } from '@mayura/testing';
import type { ModelAdapter, ModelRequest, RunEvent, RunHandle } from '@mayura/core';
import { createRuntime, defineAgent, defineHook, type Runtime, type RuntimeOptions } from '../src/index.js';

const refundInput = z.object({ order: z.number(), amount: z.number() });
const refundOutput = z.object({ refunded: z.number() });
function refundTool(approval: 'required' | ((input: z.input<typeof refundInput>) => boolean) | null = 'required', costMicros = 0) {
  const execute = vi.fn((input: { amount: number }) => ({ refunded: input.amount }));
  const tool = defineTool({ id: 'orders.refund', version: '3', description: 'Refund an order', input: refundInput, output: refundOutput,
    effects: 'write', capabilities: [], costMicros, execute, ...(approval === null ? {} : { approval }) });
  return { tool, execute };
}
const call = (id: string, amount: number, toolId = 'orders.refund') => ({ type: 'tool_calls' as const, calls: [{ id, toolId, input: { order: 7, amount } }], usage: { costMicros: 0 } });
const done = (reply: string) => ({ type: 'final' as const, output: { reply }, usage: { costMicros: 0 } });
const agentWith = (model: ModelAdapter, tools: readonly ReturnType<typeof defineTool>[], extra: Partial<Parameters<typeof defineAgent>[0]> = {}) =>
  defineAgent({ id: 'support', version: '1', instructions: 'Handle refunds.', tools, model,
    input: z.object({ question: z.string() }), output: z.object({ reply: z.string() }), ...extra });
const grants = (model: ModelAdapter, ...more: string[]) => ({ allow: [`model:${model.id}`, 'tool:orders.refund', 'effect:write', ...more] });

let runtime: Runtime | undefined;
afterEach(async () => { await runtime?.close(); runtime = undefined; });
function start(options: Omit<RuntimeOptions, 'profile'>): Runtime { runtime = createRuntime({ profile: 'ephemeral', ...options }); return runtime; }

async function requested(run: RunHandle<unknown>): Promise<RunEvent> {
  for await (const event of run.observe()) if (event.type === 'approval.requested') return event;
  throw new Error('The run ended without asking for approval.');
}
async function eventsOf(run: RunHandle<unknown>): Promise<RunEvent[]> {
  const events: RunEvent[] = []; for await (const event of run.observe()) events.push(event); return events;
}
/** The tool result the model saw for a call, from the request after it. */
const resultFor = (request: ModelRequest, callId: string) =>
  (request.messages.find(message => message.role === 'tool' && message.callId === callId) as { result: unknown } | undefined)?.result;

describe('in-run approvals', () => {
  it('waits before the call, holding nothing, shows what will run, and runs it once approved', async () => {
    const { tool, execute } = refundTool('required', 5);
    const seen: ModelRequest[] = [];
    const model = scriptedModel([call('c1', 40), request => { seen.push(request); return done('Refunded.'); }]);
    const engine = start({ permissions: grants(model), limits: { maxCostMicros: 10 } });
    const run = engine.submit(agentWith(model, [tool]), { input: { question: 'Refund order 7' } });
    const event = await requested(run);
    expect(execute).not.toHaveBeenCalled();
    const view = engine.inspect(run);
    expect(view.status).toBe('waiting');
    expect(view.runs[0]!.status).toBe('waiting');
    expect(view.approval).toEqual({ callId: 'c1', toolId: 'orders.refund', toolVersion: '3', input: { order: 7, amount: 40 },
      digest: event.metadata['digest'], expiresAtMs: event.metadata['expiresAtMs'] });
    expect(event.metadata['digest']).toMatch(/^[0-9a-f]{64}$/u);
    expect(view.budget.reservedMicros).toBe(0);
    await engine.approve(run, { callId: 'c1', digest: view.approval!.digest, decision: 'approved', actorId: 'manager-2' });
    expect(await run.result()).toEqual({ status: 'succeeded', output: { reply: 'Refunded.' } });
    expect(execute).toHaveBeenCalledOnce();
    expect(resultFor(seen[0]!, 'c1')).toEqual({ refunded: 40 });
    const events = await eventsOf(run);
    expect(events.find(item => item.type === 'approval.resolved')!.metadata).toEqual({ callId: 'c1', toolId: 'orders.refund', decision: 'approved', actorId: 'manager-2' });
    const order = events.map(item => item.type).filter(type => type.startsWith('approval.') || type.startsWith('tool.'));
    expect(order).toEqual(['approval.requested', 'approval.resolved', 'tool.started', 'tool.completed']);
    expect(engine.inspect(run).approval).toBeUndefined();
    expect(engine.inspect(run).budget).toMatchObject({ spentMicros: 5, reservedMicros: 0 });
  });

  it('refuses an answer after the request expired, even before the expiry has been handled', async () => {
    const { tool, execute } = refundTool();
    const model = scriptedModel([call('c1', 40), done('ok')]);
    const engine = start({ permissions: grants(model) });
    const run = engine.submit(agentWith(model, [tool]), { input: { question: 'Refund' } });
    const digest = (await requested(run)).metadata['digest'] as string;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 900_001);
      await expect(engine.approve(run, { callId: 'c1', digest, decision: 'approved', actorId: 'm' })).rejects.toMatchObject({ code: 'CONFLICT' });
    } finally { vi.useRealTimers(); }
    expect(execute).not.toHaveBeenCalled();
    run.cancel();
  });

  it('tells the model a rejected call did not run, with the reason, and carries on', async () => {
    const { tool, execute } = refundTool();
    const seen: ModelRequest[] = [];
    const model = scriptedModel([call('c1', 4_000), request => { seen.push(request); return done('I cannot refund that much.'); }]);
    const engine = start({ permissions: grants(model) });
    const run = engine.submit(agentWith(model, [tool]), { input: { question: 'Refund' } });
    const { metadata } = await requested(run);
    await engine.approve(run.id, { callId: 'c1', digest: metadata['digest'] as string, decision: 'rejected', actorId: 'manager-2', reason: 'Over the refund limit.' });
    expect((await run.result()).status).toBe('succeeded');
    expect(execute).not.toHaveBeenCalled();
    expect(resultFor(seen[0]!, 'c1')).toEqual({ error: 'APPROVAL_REJECTED', message: expect.stringContaining('did not run'), reason: 'Over the refund limit.' });
    expect((await eventsOf(run)).some(item => item.type === 'tool.started')).toBe(false);
  });

  it('refuses an answer for another call, with another digest, or that is malformed, and answers only once', async () => {
    const { tool, execute } = refundTool();
    const model = scriptedModel([call('c1', 40), done('ok')]);
    const engine = start({ permissions: grants(model) });
    const run = engine.submit(agentWith(model, [tool]), { input: { question: 'Refund' } });
    const digest = (await requested(run)).metadata['digest'] as string;
    const answer = { callId: 'c1', digest, decision: 'approved' as const, actorId: 'manager-2' };
    await expect(engine.approve(run, { ...answer, callId: 'c2' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(engine.approve(run, { ...answer, digest: digest.replace(/^./u, digest[0] === 'a' ? 'b' : 'a') })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(engine.approve('00000000-0000-4000-8000-000000000000', answer)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    for (const bad of [{ ...answer, decision: 'maybe' }, { ...answer, actorId: '' }, { ...answer, reason: 'x'.repeat(1_001) }, null]) {
      await expect(engine.approve(run, bad as never), JSON.stringify(bad)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(engine.inspect(run).status).toBe('waiting');
    await engine.approve(run, answer);
    await expect(engine.approve(run, answer)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await run.result()).status).toBe('succeeded');
    expect(execute).toHaveBeenCalledOnce();
    await expect(engine.approve(run, answer)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('binds the digest to its run', async () => {
    const { tool } = refundTool();
    const model = scriptedModel([call('c1', 40), done('ok')]);
    const again = scriptedModel([call('c1', 40), done('ok')]);
    const engine = start({ permissions: grants(model) });
    const first = engine.submit(agentWith(model, [tool]), { input: { question: 'Refund' } });
    const one = (await requested(first)).metadata['digest'] as string;
    const second = engine.submit(agentWith(again, [tool]), { input: { question: 'Refund' } });
    const two = (await requested(second)).metadata['digest'] as string;
    expect(one).not.toBe(two);
    // An approval for one run cannot answer another, even for a call with the same id.
    await expect(engine.approve(second, { callId: 'c1', digest: one, decision: 'approved', actorId: 'm' })).rejects.toMatchObject({ code: 'CONFLICT' });
    first.cancel(); second.cancel();
  });

  it('tells the model an unanswered request expired, by default', async () => {
    const { tool, execute } = refundTool();
    const seen: ModelRequest[] = [];
    const model = scriptedModel([call('c1', 40), request => { seen.push(request); return done('Nobody approved it.'); }]);
    const engine = start({ permissions: grants(model), approvals: { expiresInMs: 30 } });
    const run = engine.submit(agentWith(model, [tool]), { input: { question: 'Refund' } });
    const digest = (await requested(run)).metadata['digest'] as string;
    expect((await run.result()).status).toBe('succeeded');
    expect(execute).not.toHaveBeenCalled();
    expect(resultFor(seen[0]!, 'c1')).toEqual({ error: 'APPROVAL_EXPIRED', message: expect.stringContaining('in time') });
    expect((await eventsOf(run)).find(item => item.type === 'approval.resolved')!.metadata).toEqual({ callId: 'c1', toolId: 'orders.refund', decision: 'expired' });
    await expect(engine.approve(run, { callId: 'c1', digest, decision: 'approved', actorId: 'm' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('cancels the run when an unanswered request expires, if told to', async () => {
    const { tool, execute } = refundTool();
    const model = scriptedModel([call('c1', 40), done('never')]);
    const engine = start({ permissions: grants(model), approvals: { expiresInMs: 30, onExpired: 'cancel' } });
    const run = engine.submit(agentWith(model, [tool]), { input: { question: 'Refund' } });
    expect(await run.result()).toMatchObject({ status: 'cancelled', error: { code: 'CANCELLED' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('ends cancelled when cancelled while waiting, and the call never runs', async () => {
    const { tool, execute } = refundTool();
    const model = scriptedModel([call('c1', 40), done('never')]);
    const engine = start({ permissions: grants(model) });
    const run = engine.submit(agentWith(model, [tool]), { input: { question: 'Refund' } });
    const digest = (await requested(run)).metadata['digest'] as string;
    run.cancel();
    expect((await run.result()).status).toBe('cancelled');
    expect(execute).not.toHaveBeenCalled();
    expect(engine.inspect(run).status).toBe('cancelled');
    await expect(engine.approve(run, { callId: 'c1', digest, decision: 'approved', actorId: 'm' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('does not count waiting against maxDurationMs', async () => {
    const { tool, execute } = refundTool();
    const model = scriptedModel([call('c1', 40), done('ok')]);
    const engine = start({ permissions: grants(model), limits: { maxDurationMs: 150 } });
    const run = engine.submit(agentWith(model, [tool]), { input: { question: 'Refund' } });
    const digest = (await requested(run)).metadata['digest'] as string;
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(engine.inspect(run).status).toBe('waiting');
    await engine.approve(run, { callId: 'c1', digest, decision: 'approved', actorId: 'm' });
    expect((await run.result()).status).toBe('succeeded');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('asks only for the calls its rule picks, and fails closed when the rule throws', async () => {
    const { tool, execute } = refundTool(input => { if (input.amount < 0) throw new Error('bad policy'); return input.amount > 100; });
    const model = scriptedModel([call('small', 5), call('large', 500), done('ok')]);
    const engine = start({ permissions: grants(model) });
    const run = engine.submit(agentWith(model, [tool]), { input: { question: 'Refund' } });
    const event = await requested(run);
    expect(event.metadata['callId']).toBe('large');
    expect(execute).toHaveBeenCalledOnce();
    await engine.approve(run, { callId: 'large', digest: event.metadata['digest'] as string, decision: 'approved', actorId: 'm' });
    expect((await run.result()).status).toBe('succeeded');
    expect(execute).toHaveBeenCalledTimes(2);

    const throwing = scriptedModel([call('negative', -1), done('ok')]);
    const other = createRuntime({ profile: 'ephemeral', permissions: grants(throwing) });
    try {
      const second = other.submit(agentWith(throwing, [tool]), { input: { question: 'Refund' } });
      expect((await requested(second)).metadata['callId']).toBe('negative');
      second.cancel();
    } finally { await other.close(); }
  });

  it('applies the runtime\'s approvals.tools to a tool that declares nothing', async () => {
    const { tool, execute } = refundTool(null);
    const model = scriptedModel([call('c1', 1), done('ok')]);
    const engine = start({ permissions: grants(model), approvals: { tools: ['orders.refund'] } });
    const run = engine.submit(agentWith(model, [tool]), { input: { question: 'Refund' } });
    expect((await requested(run)).metadata['toolId']).toBe('orders.refund');
    expect(execute).not.toHaveBeenCalled();
    run.cancel();
  });

  it('runs earlier calls of the batch first, then waits for the one that needs approval', async () => {
    const { tool: refund, execute: refundExecute } = refundTool();
    const lookup = vi.fn(() => ({ status: 'paid' }));
    const status = defineTool({ id: 'orders.get', version: '1', description: 'Look up', input: z.object({ order: z.number() }), output: z.object({ status: z.string() }),
      effects: 'read', capabilities: [], execute: lookup });
    const model = scriptedModel([{ type: 'tool_calls', calls: [{ id: 'a', toolId: 'orders.get', input: { order: 7 } }, { id: 'b', toolId: 'orders.refund', input: { order: 7, amount: 3 } }], usage: { costMicros: 0 } }, done('ok')]);
    const engine = start({ permissions: grants(model, 'tool:orders.get', 'effect:read') });
    const run = engine.submit(agentWith(model, [status, refund]), { input: { question: 'Refund' } });
    expect((await requested(run)).metadata['callId']).toBe('b');
    expect(lookup).toHaveBeenCalledOnce(); expect(refundExecute).not.toHaveBeenCalled();
    run.cancel();
  });

  it('never asks about a call the run is not allowed to make', async () => {
    const { tool, execute } = refundTool();
    const model = scriptedModel([call('c1', 40), done('never')]);
    const engine = start({ permissions: { allow: [`model:${model.id}`, 'tool:orders.refund'] } }); // no effect:write
    const run = engine.submit(agentWith(model, [tool]), { input: { question: 'Refund' } });
    expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'PERMISSION_DENIED' } });
    expect((await eventsOf(run)).some(item => item.type === 'approval.requested')).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('never asks about a call a proposal hook blocked', async () => {
    const { tool } = refundTool();
    const deny = defineHook({ id: 'deny', version: '1', stage: 'beforeToolCall', tools: [], handler: () => ({ decision: 'block' }) });
    const model = scriptedModel([call('c1', 40), done('never')]);
    const engine = start({ permissions: grants(model) });
    const run = engine.submit(agentWith(model, [tool], { hooks: [deny] }), { input: { question: 'Refund' } });
    expect((await run.result()).status).toBe('blocked');
    expect((await eventsOf(run)).some(item => item.type === 'approval.requested')).toBe(false);
  });

  it('fails a child run that reaches a call needing approval: only a root run can wait', async () => {
    const { tool, execute } = refundTool();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const parentModel = scriptedModel([async () => { await gate; return done('parent'); }], { id: 'parent-model' });
    const childModel = scriptedModel([call('c1', 40), done('never')], { id: 'child-model' });
    const parent = defineAgent({ id: 'parent', version: '1', instructions: 'x', tools: [], model: parentModel, input: z.object({ question: z.string() }), output: z.object({ reply: z.string() }) });
    const permissions = { allow: ['model:parent-model', 'model:child-model', 'agent:delegate', 'tool:orders.refund', 'effect:write'] };
    const engine = start({ permissions });
    const root = engine.submit(parent, { input: { question: 'x' } });
    const child = engine.spawn(root, agentWith(childModel, [tool]), { input: { question: 'Refund' }, permissions });
    expect(await child.result()).toMatchObject({ status: 'failed', error: { code: 'APPROVAL_UNAVAILABLE' } });
    expect(execute).not.toHaveBeenCalled();
    release();
    await root.result();
  });

  it('refuses a hook action that calls a tool needing approval', async () => {
    const lookup = vi.fn(() => ({ status: 'paid' }));
    const guarded = defineTool({ id: 'orders.get', version: '1', description: 'Look up', input: z.object({ order: z.number() }), output: z.object({ status: z.string() }),
      effects: 'read', capabilities: [], approval: 'required', execute: lookup });
    const hook = defineHook({ id: 'prefetch', version: '1', stage: 'beforeExecution', tools: [guarded], handler: () => ({ decision: 'continue', actions: [{ toolId: 'orders.get', input: { order: 7 } }] }) });
    const model = scriptedModel([done('never')]);
    const engine = start({ permissions: { allow: [`model:${model.id}`, 'tool:orders.get', 'effect:read'] } });
    const run = engine.submit(agentWith(model, [], { hooks: [hook] }), { input: { question: 'x' } });
    // A hook whose action cannot complete is unavailable, and the run is blocked, as for any failed action.
    expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'GUARD_UNAVAILABLE' } });
    expect(lookup).not.toHaveBeenCalled();
    expect((await eventsOf(run)).some(item => item.type === 'approval.requested')).toBe(false);
  });

  it('refuses invalid approval options', () => {
    for (const approvals of [{ expiresInMs: 0 }, { expiresInMs: 604_800_001 }, { onExpired: 'ignore' }, { tools: ['bad id!'] }, { tools: 'orders.refund' }, { extra: true }]) {
      expect(() => createRuntime({ profile: 'ephemeral', approvals: approvals as never }), JSON.stringify(approvals)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    }
  });
});


it('notifies the approval observer with frozen metadata before publishing, without granting execution', async () => {
  const seen: unknown[] = [];
  const hook = defineHook({ id: 'notify', version: '1', stage: 'onApprovalRequested', handler: (event, context) => {
    expect(Object.isFrozen(event)).toBe(true); expect(Object.isFrozen(context)).toBe(true);
    expect(event).not.toHaveProperty('input'); expect(context).not.toHaveProperty('approve'); seen.push(event);
  } });
  const { tool, execute } = refundTool(); const model = scriptedModel([call('notify', 40), done('ok')]);
  const engine = start({ permissions: grants(model) });
  const run = engine.submit(agentWith(model, [tool], { hooks: [hook] }), { input: { question: 'Refund' } });
  const pending = await requested(run); expect(execute).not.toHaveBeenCalled();
  expect(seen).toEqual([{ stage: 'onApprovalRequested', callId: 'notify', toolId: tool.id, toolVersion: tool.version,
    digest: pending.metadata['digest'], expiresAtMs: pending.metadata['expiresAtMs'] }]);
  await engine.approve(run, { callId: 'notify', digest: String(pending.metadata['digest']), decision: 'approved', actorId: 'reviewer' });
  expect((await run.result()).status).toBe('succeeded'); expect(execute).toHaveBeenCalledTimes(1);
  const events = await eventsOf(run); const notified = events.findIndex(event => event.type === 'hook.completed' && event.metadata['stage'] === 'onApprovalRequested');
  expect(notified).toBeLessThan(events.findIndex(event => event.type === 'approval.requested'));
});

it('blocks mandatory observer failure before creating a pending approval or writing a tool', async () => {
  const hook = defineHook({ id: 'required-notification', version: '1', stage: 'onApprovalRequested', mandatory: true,
    handler: () => { throw new Error('PRIVATE notification credential'); } });
  const { tool, execute } = refundTool(); const model = scriptedModel([call('mandatory', 40)]);
  const engine = start({ permissions: grants(model) });
  const run = engine.submit(agentWith(model, [tool], { hooks: [hook] }), { input: { question: 'Refund' } });
  expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'GUARD_UNAVAILABLE' } });
  expect(execute).not.toHaveBeenCalled(); expect(engine.inspect(run).approval).toBeUndefined();
  const events = await eventsOf(run); expect(events.some(event => event.type === 'approval.requested')).toBe(false);
  expect(JSON.stringify(events)).not.toContain('PRIVATE');
});

it('reports an optional observer failure and continues to require a human answer', async () => {
  const hook = defineHook({ id: 'optional-notification', version: '1', stage: 'onApprovalRequested', handler: () => { throw new Error('PRIVATE'); } });
  const { tool, execute } = refundTool(); const model = scriptedModel([call('optional', 40), done('declined')]);
  const engine = start({ permissions: grants(model) });
  const run = engine.submit(agentWith(model, [tool], { hooks: [hook] }), { input: { question: 'Refund' } });
  const pending = await requested(run); expect(execute).not.toHaveBeenCalled();
  await engine.approve(run, { callId: 'optional', digest: String(pending.metadata['digest']), decision: 'rejected', actorId: 'reviewer' });
  expect((await run.result()).status).toBe('succeeded'); expect(execute).not.toHaveBeenCalled();
  expect((await eventsOf(run)).some(event => event.type === 'hook.completed' && event.metadata['stage'] === 'onApprovalRequested' && event.metadata['status'] === 'failed')).toBe(true);
});

it('cancels an approval observer without publishing a pending request', async () => {
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const hook = defineHook({ id: 'cancel-notification', version: '1', stage: 'onApprovalRequested', mandatory: true,
    handler: async (_event, { signal }) => { entered(); await new Promise<void>(resolve => {
      if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true });
    }); } });
  const { tool, execute } = refundTool(); const model = scriptedModel([call('cancel-notification', 40)]);
  const engine = start({ permissions: grants(model) });
  const run = engine.submit(agentWith(model, [tool], { hooks: [hook] }), { input: { question: 'Refund' } });
  await started; run.cancel(); expect((await run.result()).status).toBe('cancelled'); expect(execute).not.toHaveBeenCalled();
  expect((await eventsOf(run)).some(event => event.type === 'approval.requested')).toBe(false);
});

it('does not notify an approval observer for a statically denied tool proposal', async () => {
  const notified = vi.fn(); const hook = defineHook({ id: 'denied', version: '1', stage: 'onApprovalRequested', handler: notified });
  const { tool, execute } = refundTool(); const model = scriptedModel([call('denied', 40)]);
  const engine = start({ permissions: { allow: ['model:scripted'] } });
  const run = engine.submit(agentWith(model, [tool], { hooks: [hook] }), { input: { question: 'Refund' } });
  expect((await run.result()).status).toBe('blocked'); expect(notified).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
});


it('bounds mandatory approval notification by its hook timeout before publishing', async () => {
  vi.useFakeTimers();
  try {
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    const hook = defineHook({ id: 'notification-timeout', version: '1', stage: 'onApprovalRequested', mandatory: true, timeoutMs: 20,
      handler: async (_event, { signal }) => { entered(); await new Promise<void>(resolve => {
        if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true });
      }); } });
    const { tool, execute } = refundTool(); const model = scriptedModel([call('timeout-notification', 40)]);
    const engine = start({ permissions: grants(model) });
    const run = engine.submit(agentWith(model, [tool], { hooks: [hook] }), { input: { question: 'Refund' } });
    await started; await vi.advanceTimersByTimeAsync(21);
    expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'GUARD_UNAVAILABLE' } });
    expect(execute).not.toHaveBeenCalled(); expect((await eventsOf(run)).some(event => event.type === 'approval.requested')).toBe(false);
  } finally { vi.useRealTimers(); }
});


it('uses the candidate absolute expiry after observer time instead of granting another full waiting interval', async () => {
  vi.useFakeTimers();
  try {
    const hook = defineHook({ id: 'delayed-notification', version: '1', stage: 'onApprovalRequested', handler: async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    } });
    const { tool, execute } = refundTool(); const model = scriptedModel([call('absolute-expiry', 40), done('expired')]);
    const engine = start({ permissions: grants(model), approvals: { expiresInMs: 20 } });
    const run = engine.submit(agentWith(model, [tool], { hooks: [hook] }), { input: { question: 'Refund' } });
    await vi.advanceTimersByTimeAsync(21);
    expect((await run.result()).status).toBe('succeeded'); expect(execute).not.toHaveBeenCalled();
    expect((await eventsOf(run)).some(event => event.type === 'approval.resolved' && event.metadata['decision'] === 'expired')).toBe(true);
  } finally { vi.useRealTimers(); }
});


it('applies the continuing hook-call allowance to approval observers', async () => {
  const before = defineHook({ id: 'use-allowance', version: '1', stage: 'beforeExecution', tools: [], handler: () => ({ decision: 'continue' }) });
  const notified = vi.fn(); const hook = defineHook({ id: 'limited-notification', version: '1', stage: 'onApprovalRequested', mandatory: true, handler: notified });
  const { tool, execute } = refundTool(); const model = scriptedModel([call('limited-notification', 40)]);
  const engine = start({ permissions: grants(model), limits: { maxHookCalls: 1 } });
  const run = engine.submit(agentWith(model, [tool], { hooks: [before, hook] }), { input: { question: 'Refund' } });
  expect(await run.result()).toMatchObject({ status: 'blocked', error: { code: 'GUARD_UNAVAILABLE' } });
  expect(notified).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
});
