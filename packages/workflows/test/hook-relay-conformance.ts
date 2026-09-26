import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JsonValue, Schema } from '@mayura/core';
import type { StoredEvent } from '@mayura/storage-contracts';
import { defineTool } from '@mayura/tools';
import { createWorkflowLifecycleRuntime, defineWorkflowLifecycle } from '../src/lifecycle.js';
import { createWorkflowHookRelay, workflowHookStages, type WorkflowHookEvent, type WorkflowHooks } from '../src/index.js';
import type { WorkflowFixture } from './fixtures.js';

const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'hook-relay-test', validate: value => ({ value: value as JsonValue }) } };
const response: Schema<string, { decision: string }> = { '~standard': { version: 1, vendor: 'hook-relay-test',
  validate: value => typeof value === 'string' ? { value: { decision: value } } : { issues: [] } } };
const tool = defineTool({ id: 'fixture/draft', version: '1', description: 'Create a draft.', input: any, output: any,
  effects: 'none', capabilities: [], costMicros: 0, execute: input => ({ draft: input }) });
const hash = 'a'.repeat(64);
const definition = defineWorkflowLifecycle({ id: 'relay-review', version: '1', input: any, output: any, nodes: [
  { kind: 'tool', id: 'draft', tool, input: { kind: 'input', path: ['payload'] } },
  { kind: 'human', id: 'review', dependsOn: ['draft'], request: { kind: 'information', schemaId: 'fixture/review',
    schemaDigest: hash, prompt: 'Review the draft.', response, context: { kind: 'step', stepId: 'draft', path: [] } } },
  { kind: 'timer', id: 'publishAt', dependsOn: ['review'], fireAtMs: { kind: 'input', path: ['publishAt'] } },
], result: { kind: 'step', stepId: 'review', path: [] } });
const scope = { principalId: 'operator', projectId: 'project' };

function page(types: readonly (string | [string, Record<string, JsonValue>])[]): StoredEvent[] {
  return types.map((entry, index) => ({ sequence: index + 1, createdAt: '2026-09-27T00:00:00.000Z',
    type: typeof entry === 'string' ? entry : entry[0], data: typeof entry === 'string' ? {} : entry[1] }));
}
function source(events: readonly StoredEvent[]) {
  return { events: vi.fn(async (_id: string, after = 0) => events.filter(event => event.sequence > after).slice(0, 1_000)) };
}

export function hookRelayConformance(name: string, open: () => Promise<WorkflowFixture>): void {
  describe(`durable workflow hook relay on ${name}`, () => {
    let fixture: WorkflowFixture | undefined;
    afterEach(async () => { await fixture?.store.close(); await fixture?.cleanup(); fixture = undefined; });
    const store = async () => { fixture = await open(); await fixture.store.initialize(); return fixture.store; };

    it('delivers wait, resume and terminal callbacks for a real lifecycle run exactly once per successful delivery', async () => {
      const aggregate = await store(); const clock = { value: 100 };
      const runtime = createWorkflowLifecycleRuntime({ store: aggregate, scope, permissions: { allow: ['tool:fixture/draft'] }, policyVersion: '1',
        maxCostMicros: 0, now: () => clock.value, verifyHuman: async credential => ({ id: String(credential), projectId: 'project', canApprove: false }) });
      const seen: WorkflowHookEvent[] = [];
      const record = (event: WorkflowHookEvent) => { expect(Object.isFrozen(event)).toBe(true); seen.push(event); };
      const hooks: WorkflowHooks = { onWait: record, onResume: record, afterExecution: record, onError: record, onFinally: record };
      const relay = createWorkflowHookRelay({ source: runtime, store: aggregate, scope, relayId: 'audit', hooks });
      const submitted = await runtime.submit(definition, { input: { payload: 'draft', publishAt: 500 }, idempotencyKey: 'relay-1' });
      const waiting = await runtime.runUntilSettled(definition, submitted.id);
      await relay.deliver(submitted.id);
      expect(seen.map(event => event.stage)).toContain('onWait');
      expect(seen.every(event => event.stage === 'onWait')).toBe(true);
      const requestDigest = waiting.steps['review']?.kind === 'human' ? waiting.steps['review'].requestDigest! : '';
      await runtime.respond(definition, { id: submitted.id, nodeId: 'review', requestDigest, commandId: 'answer', credential: 'reviewer', value: 'ok' });
      await runtime.runUntilSettled(definition, submitted.id);
      clock.value = 500; expect(await runtime.runUntilSettled(definition, submitted.id)).toMatchObject({ status: 'succeeded' });
      const before = seen.length;
      const delivery = await relay.deliver(submitted.id);
      expect(delivery.failure).toBeUndefined(); expect(delivery.delivered).toBe(seen.length - before);
      const later = seen.slice(before);
      expect(later.map(event => event.stage)).toEqual(expect.arrayContaining(['onResume', 'afterExecution', 'onFinally']));
      expect(later.slice(-2).map(event => [event.stage, event.status])).toEqual([['afterExecution', 'succeeded'], ['onFinally', 'succeeded']]);
      expect(later.some(event => event.type === 'lifecycle.human.responded')).toBe(true);
      expect(later.some(event => event.type === 'lifecycle.timer.fired')).toBe(true);
      expect(new Set(seen.map(event => event.eventId)).size).toBe(seen.length);
      // Nothing is redelivered once the cursor passed it.
      expect(await relay.deliver(submitted.id)).toMatchObject({ delivered: 0 });
      expect(await relay.cursor(submitted.id)).toBe(delivery.sequence);
      runtime.close();
    });

    it('stops at a failing callback, keeps the durable cursor before it and redelivers the same eventId after a restart', async () => {
      const aggregate = await store();
      const events = page(['run.created', ['approval.requested', { nodeId: 'gate', digest: hash }], ['approval.resolved', { nodeId: 'gate', humanId: 'SECRET_HUMAN' }],
        'step.completed', ['run.completed', { status: 'failed' }]]);
      let failFinally = true; const seen: WorkflowHookEvent[] = [];
      const hooks: WorkflowHooks = {
        onApprovalRequested: event => { seen.push(event); }, onApprovalResolved: event => { seen.push(event); }, onError: event => { seen.push(event); },
        onFinally: event => { seen.push(event); if (failFinally) throw new Error('sink unavailable'); },
      };
      const first = createWorkflowHookRelay({ source: source(events), store: aggregate, scope, relayId: 'audit', hooks });
      expect(await first.deliver('run-1')).toEqual({ delivered: 3, sequence: 4, failure: { sequence: 5, stage: 'onFinally', code: 'GUARD_UNAVAILABLE' } });
      expect(seen.map(event => [event.stage, event.sequence, event.nodeId ?? null, event.status ?? null])).toEqual([
        ['onApprovalRequested', 2, 'gate', null], ['onApprovalResolved', 3, 'gate', null], ['onError', 5, null, 'failed'], ['onFinally', 5, null, 'failed']]);
      expect(JSON.stringify(seen)).not.toContain('SECRET_HUMAN');

      // A fresh relay (process restart) resumes from the durable cursor; the terminal event is redelivered with the same identity.
      failFinally = false; seen.length = 0;
      const reopened = fixture!.reopen(); await reopened.initialize();
      const second = createWorkflowHookRelay({ source: source(events), store: reopened, scope, relayId: 'audit', hooks });
      try { expect(await second.deliver('run-1')).toEqual({ delivered: 2, sequence: 5 }); } finally { await reopened.close(); }
      expect(seen.map(event => event.eventId)).toEqual(['audit:run-1:5:onError', 'audit:run-1:5:onFinally']);
      // Independent relays keep independent cursors.
      const other = createWorkflowHookRelay({ source: source(events), store: aggregate, scope, relayId: 'notify', hooks: { onFinally: () => {} } });
      expect(await other.deliver('run-1')).toEqual({ delivered: 1, sequence: 5 });
    });

    it('persists progress after each callback-bearing event, so a crash mid-page repeats no earlier callback', async () => {
      const aggregate = await store();
      const events = page([['approval.requested', { nodeId: 'a' }], ['approval.requested', { nodeId: 'b' }], ['run.completed', { status: 'succeeded' }]]);
      const seen: string[] = []; const crashed = new AbortController();
      const first = createWorkflowHookRelay({ source: source(events), store: aggregate, scope, relayId: 'audit', hooks: {
        timeoutMs: 30_000, onApprovalRequested: event => { seen.push(`first:${event.sequence}`); if (event.sequence === 2) return new Promise<void>(() => {}); } } });
      // The first process hangs on event 2 and is abandoned, as if it had been killed.
      const abandoned = first.deliver('run-4', { signal: crashed.signal }).catch(error => error as Error);
      await vi.waitFor(() => expect(seen).toEqual(['first:1', 'first:2']));
      const second = createWorkflowHookRelay({ source: source(events), store: aggregate, scope, relayId: 'audit', hooks: {
        onApprovalRequested: event => { seen.push(`second:${event.sequence}`); } } });
      expect(await second.deliver('run-4')).toEqual({ delivered: 1, sequence: 3 });
      expect(seen).toEqual(['first:1', 'first:2', 'second:2']);
      crashed.abort(); expect(await abandoned).toMatchObject({ code: 'CANCELLED' });
    });

    it('advances past events without callbacks, bounds work per call and rejects out-of-order sources', async () => {
      const aggregate = await store();
      const events = page(Array.from({ length: 30 }, (_, index) => index === 29 ? 'run.cancelled' : 'step.completed'));
      const onCancel = vi.fn();
      const relay = createWorkflowHookRelay({ source: source(events), store: aggregate, scope, relayId: 'audit', hooks: { onCancel } });
      expect(await relay.deliver('run-2', { limit: 10 })).toEqual({ delivered: 0, sequence: 10 });
      expect(await relay.deliver('run-2')).toEqual({ delivered: 1, sequence: 30 });
      expect(onCancel.mock.calls[0]![0]).toMatchObject({ stage: 'onCancel', status: 'cancelled', type: 'run.cancelled' });
      const broken = createWorkflowHookRelay({ source: { events: async () => page(['a', 'b']).reverse() }, store: aggregate, scope, relayId: 'broken', hooks: {} });
      await expect(broken.deliver('run-3')).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
      await expect(relay.deliver('bad id!')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });
  });
}

export function hookRelayMappingTests(): void { describe('workflow hook stage mapping', () => {
  it('maps every format terminal and wait event', () => {
    expect(workflowHookStages('lifecycle.timer.scheduled', {})).toEqual([{ stage: 'onWait' }]);
    expect(workflowHookStages('run.resumed', {})).toEqual([{ stage: 'onResume' }]);
    expect(workflowHookStages('lifecycle.approval.expired', {})).toEqual([{ stage: 'onApprovalResolved' }]);
    expect(workflowHookStages('saga.run.compensated', {})).toEqual([{ stage: 'onError', status: 'compensated' }, { stage: 'onFinally', status: 'compensated' }]);
    expect(workflowHookStages('loop.run.succeeded', {})).toEqual([{ stage: 'afterExecution', status: 'succeeded' }, { stage: 'onFinally', status: 'succeeded' }]);
    expect(workflowHookStages('workflow.terminated', { status: 'blocked' })[0]).toEqual({ stage: 'onBlocked', status: 'blocked' });
    expect(workflowHookStages('run.completed', { status: '<script>' })[0]).toEqual({ stage: 'onError', status: 'unknown' });
    expect(workflowHookStages('budget.reserved', {})).toEqual([]);
  });

  it('rejects malformed relay configuration', () => {
    const store = { read: vi.fn(), create: vi.fn(), update: vi.fn() } as never;
    expect(() => createWorkflowHookRelay({ source: { events: vi.fn() }, store, scope, relayId: 'x', hooks: { onUnknown: () => {} } as never })).toThrow(/Workflow hooks/);
    expect(() => createWorkflowHookRelay({ source: { events: vi.fn() }, store, scope, relayId: 'bad id', hooks: {} })).toThrow(/relay/);
  });
}); }
