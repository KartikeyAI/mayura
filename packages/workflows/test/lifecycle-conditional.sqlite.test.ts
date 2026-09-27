import { afterEach, describe, expect, it } from 'vitest';
import type { JsonValue, Schema } from '@mayura/core';
import { defineTool } from '@mayura/tools';
import { createWorkflowLifecycleRuntime, defineWorkflowLifecycle, fanOut, type AnyWorkflowLifecycle } from '../src/lifecycle.js';
import { defineWorkflowMigration } from '../src/index.js';
import { sqliteFixture, type WorkflowFixture } from './fixtures.js';

const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'lifecycle-conditional-test',
  validate: value => ({ value: value as JsonValue }) } };
const calls: string[] = [];
const plan = defineTool({ id: 'fixture/plan', version: '1', description: 'Plan.', input: any, output: any,
  effects: 'none', capabilities: [], costMicros: 10, execute: input => ({ questions: input }) });
const investigate = defineTool({ id: 'fixture/investigate', version: '1', description: 'Investigate.', input: any, output: any,
  effects: 'none', capabilities: [], costMicros: 100, execute: input => { calls.push(String(input)); return `answer to ${String(input)}`; } });
const write = defineTool({ id: 'fixture/write', version: '1', description: 'Write.', input: any, output: any,
  effects: 'none', capabilities: [], costMicros: 10, execute: input => ({ report: input }) });

const research = defineWorkflowLifecycle({ id: 'research', version: '1', input: any, output: any, nodes: [
  { kind: 'tool', id: 'plan', tool: plan, input: { kind: 'input', path: ['questions'] } },
  ...fanOut({ id: 'investigate', items: { stepId: 'plan', path: ['questions'] }, max: 4, tool: investigate }),
  { kind: 'tool', id: 'write', tool: write, dependsOn: ['investigate'], input: { kind: 'step', stepId: 'investigate', path: [] } },
], result: { kind: 'step', stepId: 'write', path: ['report'] } });

describe('conditional and variable-width lifecycle steps on SQLite', () => {
  let fixture: WorkflowFixture | undefined; let store: WorkflowFixture['store'] | undefined;
  afterEach(async () => { await store?.close(); await fixture?.cleanup(); fixture = undefined; store = undefined; calls.length = 0; });
  const open = async (maxCostMicros: number, reopen = false) => {
    if (!fixture) fixture = await sqliteFixture(); store = reopen ? fixture.reopen() : fixture.store; await store.initialize();
    return createWorkflowLifecycleRuntime({ store, scope: { principalId: 'operator', projectId: 'project' },
      permissions: { allow: ['tool:fixture/plan', 'tool:fixture/investigate', 'tool:fixture/write'] }, policyVersion: '1', maxCostMicros, now: () => 1_000 });
  };

  it('runs one slot per item, bypasses the rest without charging them, and joins the outputs in order', async () => {
    // Four slots at 100 each would need 420; two items need only 220.
    const runtime = await open(220);
    const submitted = await runtime.submit(research, { input: { questions: ['a', 'b'] }, idempotencyKey: 'two' });
    const settled = await runtime.runUntilSettled(research, submitted.id);
    expect(settled.status).toBe('succeeded');
    expect(calls.sort()).toEqual(['a', 'b']);
    expect(settled.steps).toMatchObject({ 'investigate.1': { status: 'succeeded' }, 'investigate.2': { status: 'succeeded' },
      'investigate.3': { status: 'bypassed', costReserved: 0 }, 'investigate.4': { status: 'bypassed' }, investigate: { status: 'succeeded' } });
    expect(settled.output).toEqual(['answer to a', 'answer to b', null, null]);
    expect(settled.budget).toEqual({ spentMicros: 220, reservedMicros: 0, maxCostMicros: 220 });
    runtime.close();
  });

  it('bypasses every slot when there are no items and still finishes', async () => {
    const runtime = await open(20);
    const submitted = await runtime.submit(research, { input: { questions: [] }, idempotencyKey: 'none' });
    const settled = await runtime.runUntilSettled(research, submitted.id);
    expect(settled).toMatchObject({ status: 'succeeded', output: [null, null, null, null], budget: { spentMicros: 20 } });
    expect(calls).toEqual([]);
    runtime.close();
  });

  it('decides a condition from a dependency and keeps it across a restart', async () => {
    const approve = defineTool({ id: 'fixture/plan', version: '1', description: 'Plan.', input: any, output: any,
      effects: 'none', capabilities: [], costMicros: 10, execute: input => ({ needsReview: input }) });
    const optional = defineWorkflowLifecycle({ id: 'optional', version: '1', input: any, output: any, nodes: [
      { kind: 'tool', id: 'check', tool: approve, input: { kind: 'input', path: ['review'] } },
      { kind: 'tool', id: 'review', tool: investigate, dependsOn: ['check'], input: { kind: 'literal', value: 'review' },
        when: { kind: 'step', stepId: 'check', path: ['needsReview'] } },
      { kind: 'join', id: 'done', dependsOn: ['review'] },
    ], result: { kind: 'step', stepId: 'done', path: [] } });
    let runtime = await open(1_000);
    const skipped = await runtime.submit(optional, { input: { review: false }, idempotencyKey: 'no-review' });
    const reviewed = await runtime.submit(optional, { input: { review: true }, idempotencyKey: 'review' });
    expect(await runtime.runUntilSettled(optional, skipped.id)).toMatchObject({ status: 'succeeded', output: [null], steps: { review: { status: 'bypassed' } } });
    runtime.close(); await store!.close(); store = undefined;
    runtime = await open(1_000, true);
    expect(await runtime.inspect(skipped.id)).toMatchObject({ status: 'succeeded', steps: { review: { status: 'bypassed' } } });
    expect(await runtime.runUntilSettled(optional, reviewed.id)).toMatchObject({ status: 'succeeded', output: ['answer to review'] });
    expect(calls).toEqual(['review']);
    runtime.close();
  });

  it('blocks siblings that cannot fit while one holds the budget, even when a bypass write races them', async () => {
    let release: () => void = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
    const held = defineTool({ id: 'fixture/investigate', version: '1', description: 'Investigate.', input: any, output: any,
      effects: 'none', capabilities: [], costMicros: 100, execute: async input => { await gate; return input; } });
    const wide = defineWorkflowLifecycle({ id: 'wide', version: '1', input: any, output: any, nodes: [
      { kind: 'tool', id: 'plan', tool: plan, input: { kind: 'input', path: ['questions'] } },
      ...fanOut({ id: 'slots', items: { stepId: 'plan', path: ['questions'] }, max: 4, tool: held }),
    ], result: { kind: 'step', stepId: 'slots', path: [] } });
    const runtime = await open(150);
    const submitted = await runtime.submit(wide, { input: { questions: ['a', 'b', 'c'] }, idempotencyKey: 'wide' });
    const settling = runtime.runUntilSettled(wide, submitted.id);
    let statuses: string[] = [];
    for (let poll = 0; poll < 400; poll++) {
      const view = await runtime.inspect(submitted.id);
      statuses = ['slots.1', 'slots.2', 'slots.3', 'slots.4'].map(id => view.steps[id]!.status);
      if (statuses.filter(status => status === 'blocked').length === 2) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    release();
    expect(statuses.filter(status => status === 'dispatching')).toHaveLength(1);
    expect(statuses.filter(status => status === 'blocked')).toHaveLength(2);
    expect(statuses[3]).toBe('bypassed');
    expect((await settling).status).toBe('blocked');
    runtime.close();
  });

  it('keeps definitions without conditions on their existing digest, and rejects conditions on non-dependencies', () => {
    const plain = (extra: Record<string, unknown> = {}) => defineWorkflowLifecycle({ id: 'plain', version: '1', input: any, output: any, nodes: [
      { kind: 'tool', id: 'a', tool: plan, input: { kind: 'input', path: [] }, ...extra },
      { kind: 'tool', id: 'b', tool: plan, input: { kind: 'input', path: [] } },
    ], result: { kind: 'step', stepId: 'a', path: [] } } as never) as AnyWorkflowLifecycle;
    expect(plain().digest).toBe(plain({ when: undefined }).digest);
    expect(plain({ when: { kind: 'input', path: ['go'] } }).digest).not.toBe(plain().digest);
    expect(() => plain({ when: { kind: 'step', stepId: 'b', path: [] } })).toThrow();
    expect(() => fanOut({ id: 'x', items: { input: [] }, max: 0, tool: plan })).toThrow();
  });

  it('plans to decide a bypassed step again when a migration changes its condition', async () => {
    const versioned = (version: string, path: string) => defineWorkflowLifecycle({ id: 'gate', version, input: any, output: any, nodes: [
      { kind: 'tool', id: 'first', tool: plan, input: { kind: 'input', path: [] } },
      { kind: 'tool', id: 'optional', tool: investigate, dependsOn: ['first'], input: { kind: 'literal', value: 'late' }, when: { kind: 'input', path: [path] } },
      { kind: 'tool', id: 'last', tool: write, dependsOn: ['optional'], input: { kind: 'literal', value: 'x' } },
    ], result: { kind: 'step', stepId: 'last', path: [] } });
    const v1 = versioned('1', 'never'); const v2 = versioned('2', 'go');
    const runtime = await open(1_000);
    const submitted = await runtime.submit(v1, { input: { go: true }, idempotencyKey: 'migrate' });
    const done = await runtime.runUntilSettled(v1, submitted.id);
    expect(done.steps).toMatchObject({ optional: { status: 'bypassed' }, last: { status: 'succeeded' } });
    const plan2 = await runtime.migrate(defineWorkflowMigration({ id: 'gate-1-to-2', from: v1, to: v2 }),
      { id: submitted.id, actorId: 'operator', commandId: 'plan', dryRun: true });
    expect(plan2.plan.entries).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'reset', target: 'optional', status: 'bypassed' })]));
    runtime.close();
  });
});
