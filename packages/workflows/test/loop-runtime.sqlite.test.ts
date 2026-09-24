import { afterEach, describe, expect, it } from 'vitest';
import type { JsonValue, Schema } from '@mayura/core';
import { defineTool } from '@mayura/tools';
import { defineWorkflowLifecycle } from '../src/lifecycle.js';
import { createWorkflowLoopRuntime, defineWorkflowLoop } from '../src/loops.js';
import { sqliteFixture, type WorkflowFixture } from './fixtures.js';

const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'loop-test', validate: value => ({ value: value as JsonValue }) } };
const number: Schema<number> = { '~standard': { version: 1, vendor: 'loop-test',
  validate: value => typeof value === 'number' ? { value } : { issues: [] } } };

describe('durable bounded workflow loops on SQLite', () => {
  let fixture: WorkflowFixture | undefined; let store: WorkflowFixture['store'] | undefined;
  afterEach(async () => { await store?.close(); await fixture?.cleanup(); fixture = undefined; store = undefined; });

  it('resumes after adapter reopen and terminates from admitted child output', async () => {
    fixture = await sqliteFixture(); store = fixture.store; await store.initialize(); let calls = 0;
    const increment = defineTool({ id: 'loop/increment', version: '1', description: 'increment', input: any, output: any,
      effects: 'none', capabilities: [], costMicros: 2, execute: input => { calls += 1; const value = Number((input as { value: number }).value) + 1;
        return { value, continue: value < 3 }; } });
    const body = defineWorkflowLifecycle({ id: 'loop-body', version: '1', input: any, output: any,
      nodes: [{ kind: 'tool', id: 'increment', tool: increment, input: { kind: 'input', path: [] } }],
      result: { kind: 'step', stepId: 'increment', path: [] } });
    const definition = defineWorkflowLoop({ id: 'bounded-loop', version: '1', input: any, output: number,
      body, maxIterations: 4, initial: { kind: 'input', path: [] }, next: { kind: 'current', path: [] },
      continueWhen: { kind: 'current', path: ['continue'] }, result: { kind: 'current', path: ['value'] } });
    const options = { scope: { principalId: 'operator', projectId: 'project' },
      permissions: { allow: ['tool:loop/increment'] }, policyVersion: '1', maxCostMicros: 8 } as const;
    let runtime = createWorkflowLoopRuntime({ store, ...options });
    const submitted = await runtime.submit(definition, { input: { value: 0 }, idempotencyKey: 'loop' });
    runtime.close(); await store.close(); store = fixture.reopen(); await store.initialize();
    runtime = createWorkflowLoopRuntime({ store, ...options }); const finished = await runtime.runUntilSettled(definition, submitted.id);
    expect(finished).toMatchObject({ status: 'succeeded', iteration: 3, current: { value: 3, continue: false },
      output: 3, childRunId: null, budget: { spentMicros: 6, maxCostMicros: 8 } });
    expect(calls).toBe(3); expect((await runtime.runUntilSettled(definition, submitted.id)).version).toBe(finished.version); runtime.close();
  });

  it('stops at the declared iteration limit instead of running unbounded', async () => {
    fixture = await sqliteFixture(); store = fixture.store; await store.initialize();
    const repeat = defineTool({ id: 'loop/repeat', version: '1', description: 'repeat', input: any, output: any,
      effects: 'none', capabilities: [], costMicros: 0, execute: () => ({ continue: true }) });
    const body = defineWorkflowLifecycle({ id: 'repeat-body', version: '1', input: any, output: any,
      nodes: [{ kind: 'tool', id: 'repeat', tool: repeat, input: { kind: 'input', path: [] } }],
      result: { kind: 'step', stepId: 'repeat', path: [] } });
    const definition = defineWorkflowLoop({ id: 'limited-loop', version: '1', input: any, output: any,
      body, maxIterations: 2, initial: { kind: 'input', path: [] }, next: { kind: 'current', path: [] },
      continueWhen: { kind: 'current', path: ['continue'] }, result: { kind: 'current', path: [] } });
    const runtime = createWorkflowLoopRuntime({ store, scope: { principalId: 'operator', projectId: 'project' },
      permissions: { allow: ['tool:loop/repeat'] }, policyVersion: '1', maxCostMicros: 0 });
    const submitted = await runtime.submit(definition, { input: null, idempotencyKey: 'limited' });
    expect(await runtime.runUntilSettled(definition, submitted.id)).toMatchObject({ status: 'limit_exceeded', iteration: 2 });
    runtime.close();
  });
});
