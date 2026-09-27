import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { JsonValue, Schema } from '@mayura/core';
import { createSqliteStore, type AggregateStore } from '@mayura/storage';
import { defineTool } from '@mayura/tools';
import { createWorkflowTreeRuntime, defineWorkflowTree } from '../src/children.js';
import { digest } from '../src/definition.js';
import { createWorkflowGraphRuntime, defineWorkflowGraph } from '../src/graphs.js';
import { createWorkflowLifecycleRuntime, defineWorkflowLifecycle } from '../src/lifecycle.js';
import { createWorkflowRuntime, createWorkflowTraceExport, defineWorkflow, workflowStepTraceContext, workflowTraceContext, workflowTraceSpans,
  type WorkflowTraceSpan } from '../src/index.js';
import { sqliteFixture, type WorkflowFixture } from './fixtures.js';

// Everything a trace must never carry: inputs, outputs, prompts, human identities and responses.
const SECRETS = ['SECRET_INPUT', 'SECRET_OUTPUT', 'SECRET_PROMPT', 'SECRET_HUMAN', 'SECRET_ANSWER'];
const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'trace-test', validate: value => ({ value: value as JsonValue }) } };
const answer: Schema<string, { decision: string }> = { '~standard': { version: 1, vendor: 'trace-test',
  validate: value => typeof value === 'string' ? { value: { decision: value } } : { issues: [] } } };
const scope = { principalId: 'operator', projectId: 'project' };
const seenContexts: { runId: string; callId: string }[] = [];
const draft = defineTool({ id: 'fixture/draft', version: '3', description: 'Draft.', input: any, output: any, effects: 'none', capabilities: [], costMicros: 5,
  execute: (input, context) => { seenContexts.push({ runId: context.runId, callId: context.callId }); context.reportUsage({ knownCostMicros: 2, unknownCostMicros: 0 }); return { draft: input, note: 'SECRET_OUTPUT' }; } });
const lifecycle = defineWorkflowLifecycle({ id: 'trace.review', version: '2', input: any, output: any, nodes: [
  { kind: 'tool', id: 'draft', tool: draft, input: { kind: 'input', path: ['payload'] } },
  { kind: 'human', id: 'review', dependsOn: ['draft'], request: { kind: 'information', schemaId: 'fixture/review', schemaDigest: 'a'.repeat(64),
    prompt: 'SECRET_PROMPT', response: answer, context: { kind: 'step', stepId: 'draft', path: [] } } },
  { kind: 'timer', id: 'publishAt', dependsOn: ['review'], fireAtMs: { kind: 'input', path: ['publishAt'] } },
  { kind: 'join', id: 'done', dependsOn: ['publishAt', 'review'] },
], result: { kind: 'step', stepId: 'review', path: [] } });

const stores: AggregateStore[] = []; const fixtures: WorkflowFixture[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup())); seenContexts.splice(0); });
async function memory(): Promise<AggregateStore> { const store = createSqliteStore({ filename: ':memory:' }); stores.push(store); await store.initialize(); return store; }

/** A lifecycle run through a tool, a human answer, a timer and a join, settled. */
async function settledLifecycle(store: AggregateStore) {
  const clock = { value: 100 };
  const runtime = createWorkflowLifecycleRuntime({ store, scope, permissions: { allow: ['tool:fixture/draft'] }, policyVersion: '1', maxCostMicros: 50,
    now: () => clock.value, verifyHuman: async credential => ({ id: String(credential), projectId: 'project', canApprove: false }) });
  const submitted = await runtime.submit(lifecycle, { input: { payload: 'SECRET_INPUT', publishAt: 500 }, idempotencyKey: 'trace-1' });
  const waiting = await runtime.runUntilSettled(lifecycle, submitted.id);
  const requestDigest = waiting.steps['review']?.kind === 'human' ? waiting.steps['review'].requestDigest! : '';
  await runtime.respond(lifecycle, { id: submitted.id, nodeId: 'review', requestDigest, commandId: 'answer', credential: 'SECRET_HUMAN', value: 'SECRET_ANSWER' });
  await runtime.runUntilSettled(lifecycle, submitted.id); clock.value = 500;
  const settled = await runtime.runUntilSettled(lifecycle, submitted.id); expect(settled.status).toBe('succeeded');
  return { runtime, runId: submitted.id, events: await runtime.events(submitted.id), snapshot: settled };
}
const byName = (spans: readonly WorkflowTraceSpan[]) => Object.fromEntries(spans.map(span => [span.name, span]));

describe('workflow trace projection', () => {
  it('projects a lifecycle run into one root and one span per step with deterministic ids and metadata only', async () => {
    const store = await memory(); const { runtime, runId, events, snapshot } = await settledLifecycle(store);
    const spans = workflowTraceSpans({ runId, snapshot, events, definition: lifecycle });
    const root = workflowTraceContext(runId);
    expect(spans.map(span => span.name)).toEqual(['workflow:trace.review', 'tool:draft', 'human:review', 'timer:publishAt', 'join:done']);
    expect(new Set(spans.map(span => span.traceId))).toEqual(new Set([root.traceId]));
    expect(spans[0]).toMatchObject({ spanId: root.spanId, status: 'ok', runId, attributes: { 'mayura.workflow.definition.id': 'trace.review',
      'mayura.workflow.definition.version': '2', 'mayura.workflow.definition.digest': lifecycle.digest, 'mayura.workflow.status': 'succeeded',
      'mayura.workflow.events': events.length, 'mayura.budget.spent_micros': 2, 'mayura.budget.reserved_micros': 0, 'mayura.budget.max_micros': 50 } });
    expect(spans[0]!.parentSpanId).toBeUndefined();
    for (const span of spans.slice(1)) {
      expect(span.parentSpanId).toBe(root.spanId);
      expect(span.spanId).toBe(workflowTraceContext(runId, span.attributes!['mayura.workflow.node.id'] as string).spanId);
      expect(BigInt(span.startTimeUnixNano) >= BigInt(spans[0]!.startTimeUnixNano)).toBe(true);
      expect(BigInt(span.endTimeUnixNano) <= BigInt(spans[0]!.endTimeUnixNano)).toBe(true);
      expect(BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano)).toBe(true);
    }
    expect(byName(spans)['tool:draft']).toMatchObject({ status: 'ok', attributes: { 'mayura.workflow.node.kind': 'tool', 'mayura.workflow.step.status': 'succeeded',
      'mayura.workflow.receipt.execution': 'succeeded', 'mayura.tool.id': 'fixture/draft', 'mayura.tool.version': '3', 'mayura.budget.step_cost_micros': 5 } });
    expect(byName(spans)['human:review']!.attributes).toEqual({ 'mayura.workflow.node.id': 'review', 'mayura.workflow.node.kind': 'human', 'mayura.workflow.step.status': 'succeeded' });
    // Same log, same spans: re-export after a restart deduplicates at the collector.
    expect(workflowTraceSpans({ runId, snapshot: await runtime.inspect(runId), events: await runtime.events(runId), definition: lifecycle })).toEqual(spans);
    // The tool's execution context names its step span, so work inside the step can nest under it.
    expect(workflowStepTraceContext(seenContexts[0]!)).toEqual({ traceId: root.traceId, spanId: byName(spans)['tool:draft']!.spanId });
    const exported = JSON.stringify(spans); for (const secret of SECRETS) expect(exported).not.toContain(secret);
    expect(JSON.stringify(events)).toContain('SECRET_HUMAN'); // The log does carry them; the projection leaves them behind.
    runtime.close();
  });

  it('projects a format-2 run that stops on its budget, with fixed failure codes and skipped steps', async () => {
    const store = await memory();
    const expensive = defineTool({ id: 'fixture/expensive', version: '1', description: 'Costly.', input: any, output: any, effects: 'none', capabilities: [], costMicros: 40,
      execute: () => 'SECRET_OUTPUT' });
    const definition = defineWorkflow({ id: 'trace.budget', version: '1', input: any, output: any, nodes: [
      { kind: 'tool', id: 'first', tool: draft, input: { kind: 'input', path: [] } },
      { kind: 'tool', id: 'second', tool: expensive, input: { kind: 'input', path: [] }, dependsOn: ['first'] },
      { kind: 'join', id: 'after', dependsOn: ['second'] },
    ], result: { kind: 'step', stepId: 'after', path: [] } });
    const runtime = createWorkflowRuntime({ store, scope, permissions: { allow: ['tool:fixture/draft', 'tool:fixture/expensive'] }, policyVersion: '1', maxCostMicros: 20 });
    const submitted = await runtime.submit(definition, { input: 'SECRET_INPUT', idempotencyKey: 'budget-1' });
    const settled = await runtime.runUntilSettled(definition, submitted.id); expect(settled.status).toBe('blocked');
    const spans = byName(workflowTraceSpans({ runId: submitted.id, snapshot: settled, events: await runtime.events(submitted.id), definition }));
    expect(spans['workflow:trace.budget']).toMatchObject({ status: 'error', attributes: { 'mayura.workflow.status': 'blocked', 'mayura.budget.max_micros': 20 } });
    expect(spans['tool:first']).toMatchObject({ status: 'ok', attributes: { 'mayura.workflow.receipt.execution': 'succeeded' } });
    expect(spans['tool:second']).toMatchObject({ status: 'error', attributes: { 'mayura.workflow.step.status': 'blocked', 'mayura.workflow.step.code': 'BUDGET_EXCEEDED', 'mayura.budget.step_cost_micros': 40 } });
    expect(spans['join:after']).toMatchObject({ status: 'unset', attributes: { 'mayura.workflow.step.status': 'skipped' } });
    expect(JSON.stringify(spans)).not.toContain('SECRET');
    runtime.close();
  });

  it('projects format-3 graphs and workflow-tree roots, naming each child run', async () => {
    const store = await memory();
    const increment = defineTool({ id: 'increment', version: '1', description: 'Increment.', input: z.number(), output: z.number(), effects: 'none', capabilities: [], costMicros: 1, execute: value => value + 1 });
    const graph = defineWorkflowGraph({ id: 'trace.graph', version: '1', input: z.number(), output: z.array(z.number()), nodes: [
      { kind: 'tool', id: 'work', tool: increment, input: { kind: 'input', path: [] } }, { kind: 'join', id: 'done', dependsOn: ['work'] },
    ], result: { kind: 'step', stepId: 'done', path: [] } });
    const graphs = createWorkflowGraphRuntime({ store: store as never, scope, permissions: { allow: ['tool:increment'] }, policyVersion: '1', maxCostMicros: 5, workerId: 'worker' });
    const run = await graphs.submit(graph, { input: 1, idempotencyKey: 'graph-1' });
    const graphSnapshot = await graphs.runUntilSettled(graph, run.id); expect(graphSnapshot.status).toBe('succeeded');
    const graphSpans = byName(workflowTraceSpans({ runId: run.id, snapshot: graphSnapshot, events: await graphs.events(run.id), definition: graph }));
    expect(Object.keys(graphSpans)).toEqual(['workflow:trace.graph', 'tool:work', 'join:done']);
    expect(graphSpans['tool:work']).toMatchObject({ status: 'ok', attributes: { 'mayura.workflow.receipt.execution': 'succeeded', 'mayura.tool.id': 'increment' } });
    // The export resolves each run's pinned definition digest from the store, whatever the format.
    const exported = async (source: Parameters<typeof createWorkflowTraceExport>[0]['source'], runId: string, definitions: Parameters<typeof createWorkflowTraceExport>[0]['definitions']) => {
      const sent: WorkflowTraceSpan[] = [];
      await createWorkflowTraceExport({ source, store, scope, exportId: `check-${runId.slice(0, 8)}`, definitions, sink: async spans => { sent.push(...spans); } }).exportRun(runId);
      return sent;
    };
    expect(await exported(graphs, run.id, [lifecycle, graph])).toEqual(Object.values(graphSpans));
    await graphs.close();

    const leaf = defineWorkflow({ id: 'leaf', version: '1', input: z.number(), output: z.number(), nodes: [{ kind: 'tool', id: 'work', tool: increment, input: { kind: 'input', path: [] } }],
      result: { kind: 'step', stepId: 'work', path: [] } });
    const tree = defineWorkflowTree({ id: 'trace.tree', version: '1', input: z.number(), output: z.array(z.number()), nodes: [
      { kind: 'tool', id: 'rootWork', tool: increment, input: { kind: 'input', path: [] } },
      { kind: 'child', id: 'child', workflow: leaf, input: { kind: 'input', path: [] }, policy: { permissions: ['tool:increment'], maxCostMicros: 1, maxCalls: 1, maxOutputBytes: 1_024, approvalTtlMs: 1_000 }, resources: { work: [] } },
      { kind: 'join', id: 'joined', dependsOn: ['rootWork', 'child'] },
    ], result: { kind: 'step', stepId: 'joined', path: [] } });
    const trees = createWorkflowTreeRuntime({ store: store as never, scope, permissions: { allow: ['tool:increment'] }, policyVersion: '1', maxCostMicros: 2, maxCalls: 2, maxOutputBytes: 1_024, workerId: 'worker' });
    const root = await trees.submit(tree, { input: 1, idempotencyKey: 'tree-1' });
    const treeSnapshot = await trees.runUntilSettled(tree, root.id); expect(treeSnapshot.status).toBe('succeeded');
    const childRun = treeSnapshot.steps['child']?.child?.runId; expect(childRun).toMatch(/^[a-f0-9]{64}$/);
    const treeSpans = byName(workflowTraceSpans({ runId: root.id, snapshot: treeSnapshot, events: await trees.events(root.id), definition: tree }));
    expect(Object.keys(treeSpans)).toEqual(['workflow:trace.tree', 'tool:rootWork', 'child:child', 'join:joined']);
    expect(treeSpans['child:child']).toMatchObject({ status: 'ok', attributes: { 'mayura.workflow.node.kind': 'child', 'mayura.workflow.child.run.id': childRun } });
    expect(BigInt(treeSpans['child:child']!.endTimeUnixNano) >= BigInt(treeSpans['child:child']!.startTimeUnixNano)).toBe(true);
    expect(await exported(trees, root.id, [tree])).toEqual(Object.values(treeSpans));
    await trees.close();
  });

  it('refuses partial or disordered logs and contexts outside a workflow step', () => {
    const snapshot = { status: 'succeeded', steps: {} };
    const event = (sequence: number) => ({ sequence, type: 'run.created', data: {}, createdAt: '2026-09-27T00:00:00.000Z' });
    expect(() => workflowTraceSpans({ runId: 'r'.repeat(8), snapshot, events: [] })).toThrow();
    expect(() => workflowTraceSpans({ runId: 'r'.repeat(8), snapshot, events: [event(2)] })).toThrow();
    expect(() => workflowTraceSpans({ runId: 'r'.repeat(8), snapshot, events: [event(1), event(3)] })).toThrow();
    expect(() => workflowTraceSpans({ runId: 'not a run', snapshot, events: [event(1)] })).toThrow();
    expect(() => workflowStepTraceContext({ runId: 'run-1', callId: 'run-2/step:plan' })).toThrow();
    expect(() => workflowStepTraceContext({ runId: 'run-1', callId: 'agent-call-1' })).toThrow();
    // Store clocks may step backwards between processes; spans never end before they start.
    const skewed = workflowTraceSpans({ runId: 'run-1', snapshot: { status: 'failed', steps: { a: { kind: 'tool', status: 'failed' } } }, events: [
      { sequence: 1, type: 'run.created', data: {}, createdAt: '2026-09-27T00:00:05.000Z' },
      { sequence: 2, type: 'step.dispatching', data: { nodeId: 'a' }, createdAt: '2026-09-27T00:00:01.000Z' },
      { sequence: 3, type: 'step.completed', data: { nodeId: 'a', outcome: 'failed', message: 'SECRET_OUTPUT' }, createdAt: '2026-09-27T00:00:00.000Z' },
    ] });
    for (const span of skewed) expect(BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano)).toBe(true);
    expect(skewed.map(span => span.name)).toEqual(['workflow.run', 'tool:a']); expect(JSON.stringify(skewed)).not.toContain('SECRET');
  });
});

describe('restart-safe workflow trace export', () => {
  let fixture: WorkflowFixture;
  const open = async () => { fixture = await sqliteFixture(); fixtures.push(fixture); await fixture.store.initialize(); stores.push(fixture.store); return fixture.store; };

  it('exports a tracked run once it settles, never twice, and forgets it', async () => {
    const store = await open(); const clock = { value: 100 };
    const runtime = createWorkflowLifecycleRuntime({ store, scope, permissions: { allow: ['tool:fixture/draft'] }, policyVersion: '1', maxCostMicros: 50,
      now: () => clock.value, verifyHuman: async credential => ({ id: String(credential), projectId: 'project', canApprove: false }) });
    const sent: WorkflowTraceSpan[][] = []; const sink = vi.fn(async (spans: readonly WorkflowTraceSpan[]) => { sent.push([...spans]); });
    const traces = createWorkflowTraceExport({ source: runtime, store, scope, exportId: 'collector-a', definitions: [lifecycle], sink, maxBatchSize: 2 });
    const submitted = await runtime.submit(lifecycle, { input: { payload: 'SECRET_INPUT', publishAt: 500 }, idempotencyKey: 'export-1' });
    await traces.track(submitted.id); await traces.track(submitted.id);
    expect(await traces.pending()).toEqual([submitted.id]);
    await runtime.runUntilSettled(lifecycle, submitted.id);
    expect(await traces.flush()).toMatchObject({ examined: 1, unsettled: 1, exported: 0 }); expect(sink).not.toHaveBeenCalled();
    expect(await traces.pending()).toEqual([submitted.id]);
    const waiting = await runtime.inspect(submitted.id); const requestDigest = waiting.steps['review']?.kind === 'human' ? waiting.steps['review'].requestDigest! : '';
    await runtime.respond(lifecycle, { id: submitted.id, nodeId: 'review', requestDigest, commandId: 'answer', credential: 'SECRET_HUMAN', value: 'SECRET_ANSWER' });
    await runtime.runUntilSettled(lifecycle, submitted.id); clock.value = 500; await runtime.runUntilSettled(lifecycle, submitted.id);
    expect(await traces.flush()).toMatchObject({ examined: 1, exported: 1, failed: 0 });
    // Five spans in batches of two: three sink calls, one run.
    expect(sent.map(batch => batch.length)).toEqual([2, 2, 1]); expect(await traces.pending()).toEqual([]);
    expect(await traces.exportRun(submitted.id)).toMatchObject({ status: 'unchanged' }); expect(sink).toHaveBeenCalledTimes(3);
    for (const secret of SECRETS) expect(JSON.stringify(sent)).not.toContain(secret);
    // A second, independent export of the same runs keeps its own markers.
    const other = createWorkflowTraceExport({ source: runtime, store, scope, exportId: 'collector-b', definitions: [lifecycle], sink });
    expect(await other.exportRun(submitted.id)).toMatchObject({ status: 'exported', spans: 5 });
    runtime.close();
  });

  it('survives a crash between delivery and marking: the restarted worker re-sends identical spans once', async () => {
    const store = await open(); const { runtime, runId } = await settledLifecycle(store);
    const first: WorkflowTraceSpan[] = []; let failMarker = true;
    // The marker write fails once, as if the process died right after the collector accepted the spans.
    const crashing = new Proxy(store, { get(target, key) {
      const value = Reflect.get(target, key) as unknown;
      if ((key === 'create' || key === 'update') && typeof value === 'function') return async (command: { state: Record<string, unknown> }) => {
        if (failMarker && 'sequence' in command.state) { failMarker = false; throw new Error('process died'); }
        return (value as (input: unknown) => Promise<unknown>).call(target, command);
      };
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    } });
    const before = createWorkflowTraceExport({ source: runtime, store: crashing, scope, exportId: 'collector', definitions: [lifecycle], sink: async spans => { first.push(...spans); } });
    await before.track(runId);
    expect(await before.flush()).toMatchObject({ exported: 0, failed: 1, lastError: 'STORAGE_UNAVAILABLE' });
    expect(first).toHaveLength(5); expect(await before.pending()).toEqual([runId]);
    runtime.close(); await store.close(); stores.splice(stores.indexOf(store), 1);

    // Restart: a new process opens the same database.
    const reopened = fixture.reopen(); stores.push(reopened); await reopened.initialize();
    const restartedRuntime = createWorkflowLifecycleRuntime({ store: reopened, scope, permissions: { allow: ['tool:fixture/draft'] }, policyVersion: '1', maxCostMicros: 50 });
    const second: WorkflowTraceSpan[] = [];
    const after = createWorkflowTraceExport({ source: restartedRuntime, store: reopened, scope, exportId: 'collector', definitions: [lifecycle], sink: async spans => { second.push(...spans); } });
    expect(await after.pending()).toEqual([runId]);
    expect(await after.flush()).toMatchObject({ exported: 1, failed: 0 });
    expect(second).toEqual(first); expect(await after.pending()).toEqual([]);
    expect(await after.exportRun(runId)).toMatchObject({ status: 'unchanged' }); expect(second).toHaveLength(5);
    restartedRuntime.close();
  });

  it('keeps a run whose delivery failed, retries it, and drops runs the source no longer knows', async () => {
    const store = await open(); const { runtime, runId } = await settledLifecycle(store);
    let fail = true; const sent: WorkflowTraceSpan[] = [];
    const traces = createWorkflowTraceExport({ source: runtime, store, scope, exportId: 'collector', definitions: [lifecycle],
      sink: async spans => { if (fail) { fail = false; throw new Error('collector down'); } sent.push(...spans); } });
    await traces.track(runId); await traces.track('f'.repeat(64));
    const report = await traces.flush();
    expect(report).toMatchObject({ examined: 2, exported: 0, missing: 1, failed: 1 });
    expect(await traces.pending()).toEqual([runId]);
    expect(await traces.flush()).toMatchObject({ exported: 1 }); expect(sent).toHaveLength(5); expect(await traces.pending()).toEqual([]);
    await expect(traces.track('not a run id')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const small = createWorkflowTraceExport({ source: runtime, store, scope, exportId: 'small', definitions: [lifecycle], sink: async () => {}, maxPending: 1 });
    await small.track('a'.repeat(64)); await expect(small.track('b'.repeat(64))).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    runtime.close();
  });

  it('runs as a worker unit that discovers active runs and exports them after they settle, concurrently with another replica', async () => {
    const store = await open(); const clock = { value: 100 };
    const runtime = createWorkflowLifecycleRuntime({ store, scope, permissions: { allow: ['tool:fixture/draft'] }, policyVersion: '1', maxCostMicros: 50,
      now: () => clock.value, verifyHuman: async credential => ({ id: String(credential), projectId: 'project', canApprove: false }) });
    const submitted = await runtime.submit(lifecycle, { input: { payload: 'SECRET_INPUT', publishAt: 500 }, idempotencyKey: 'unit-1' });
    const spans: WorkflowTraceSpan[] = []; const sink = async (batch: readonly WorkflowTraceSpan[]) => { spans.push(...batch); };
    const traces = createWorkflowTraceExport({ source: runtime, store, scope, exportId: 'collector', definitions: [lifecycle], sink });
    const replica = createWorkflowTraceExport({ source: runtime, store, scope, exportId: 'collector', definitions: [lifecycle], sink });
    const target = { discover: vi.fn(async () => ({ runIds: [submitted.id], nextCursor: null })) };
    const unit = traces.unit({ intervalMs: 10, targets: [target] }); const other = replica.unit({ intervalMs: 10 });
    unit.start(); other.start();
    await vi.waitFor(async () => expect(await traces.pending()).toEqual([submitted.id]));
    await runtime.runUntilSettled(lifecycle, submitted.id);
    const waiting = await runtime.inspect(submitted.id); const requestDigest = waiting.steps['review']?.kind === 'human' ? waiting.steps['review'].requestDigest! : '';
    await runtime.respond(lifecycle, { id: submitted.id, nodeId: 'review', requestDigest, commandId: 'answer', credential: 'SECRET_HUMAN', value: 'SECRET_ANSWER' });
    await runtime.runUntilSettled(lifecycle, submitted.id); clock.value = 500; await runtime.runUntilSettled(lifecycle, submitted.id);
    target.discover.mockResolvedValue({ runIds: [], nextCursor: null });
    await vi.waitFor(async () => { expect(await traces.pending()).toEqual([]); expect(spans.length).toBeGreaterThanOrEqual(5); });
    expect(await unit.drain()).toEqual({ drained: true, interrupted: 0 }); await other.stop();
    // Both replicas may have exported the run; every copy carries the same ids.
    expect(new Set(spans.map(span => span.spanId)).size).toBe(5); expect(spans.length % 5).toBe(0);
    runtime.close();
  });

  it('validates its configuration and storage integrity', async () => {
    const store = await memory(); const runtime = createWorkflowRuntime({ store, scope, permissions: { allow: [] }, policyVersion: '1', maxCostMicros: 0 });
    const base = { source: runtime, store, scope, exportId: 'collector', definitions: [], sink: async () => {} };
    expect(() => createWorkflowTraceExport({ ...base, exportId: 'bad id' })).toThrow();
    expect(() => createWorkflowTraceExport({ ...base, maxBatchSize: 257 })).toThrow();
    expect(() => createWorkflowTraceExport({ ...base, sink: undefined as never })).toThrow();
    const traces = createWorkflowTraceExport(base); await traces.track('a'.repeat(64));
    // A tampered outbox fails closed instead of exporting or dropping runs it cannot read.
    const scopeKey = digest('mayura:scope:v1', scope); const outboxId = digest('mayura:workflow-trace-outbox:v1', { exportId: 'collector' });
    const record = await store.read(scopeKey, outboxId);
    await store.update({ scope: scopeKey, id: outboxId, expectedVersion: record!.version, state: { format: 1, exportId: 'collector', pending: ['b'.repeat(64), 'a'.repeat(64)] }, events: [] });
    await expect(traces.pending()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await expect(traces.flush()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    await expect(traces.track('c'.repeat(64))).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    runtime.close();
  });
});
