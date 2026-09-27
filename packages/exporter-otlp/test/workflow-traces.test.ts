import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { JsonValue, ModelResponse, RunEvent, Schema } from '@mayura/core';
import { createObserver } from '@mayura/observability';
import { createRuntime, defineAgent } from '@mayura/runtime';
import { createSqliteStore, type AggregateStore } from '@mayura/storage';
import { defineTool } from '@mayura/tools';
import { createWorkflowTraceExport, workflowStepTraceContext, workflowTraceContext } from '@mayura/workflows';
import { createWorkflowLifecycleRuntime, defineWorkflowLifecycle } from '@mayura/workflows/lifecycle';
import { agentRunTraceSpans, createOtlpHttpJsonTraceExporter, type OtlpTraceSpan } from '../src/index.js';

interface Received { readonly traceId: string; readonly spanId: string; readonly parentSpanId?: string; readonly name: string;
  readonly startTimeUnixNano: string; readonly endTimeUnixNano: string; readonly status: { code: number };
  readonly attributes: readonly { key: string; value: { stringValue?: string; intValue?: string } }[] }
const any: Schema<JsonValue> = { '~standard': { version: 1, vendor: 'workflow-trace-test', validate: value => ({ value: value as JsonValue }) } };
const scope = { principalId: 'operator', projectId: 'project' };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

/** A literal-loopback OTLP collector that records every request body it accepts. */
async function collector(): Promise<{ readonly endpoint: string; readonly bodies: string[]; spans(): Received[] }> {
  const bodies: string[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => { if (request.url === '/v1/traces') bodies.push(Buffer.concat(chunks).toString('utf8')); response.writeHead(200, { 'content-type': 'application/json' }).end('{}'); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); cleanup.push(() => new Promise(resolve => server.close(() => resolve())));
  const { port } = server.address() as { port: number };
  return { endpoint: `http://127.0.0.1:${port}/v1/traces`, bodies,
    spans: () => bodies.flatMap(body => (JSON.parse(body) as { resourceSpans: { scopeSpans: { spans: Received[] }[] }[] }).resourceSpans.flatMap(item => item.scopeSpans.flatMap(scopeSpans => scopeSpans.spans))) };
}
const attribute = (span: Received, key: string): string | undefined => { const value = span.attributes.find(item => item.key === key)?.value; return value?.stringValue ?? value?.intValue; };

describe('workflow traces through the OTLP/HTTP JSON trace exporter', () => {
  it('delivers a lifecycle run with its step agent nested under the step, metadata only and idempotently', async () => {
    const otlp = await collector();
    const store: AggregateStore = createSqliteStore({ filename: ':memory:' }); await store.initialize(); cleanup.push(() => store.close());
    const agentSpans: OtlpTraceSpan[] = [];
    // The agent's model asks for one lookup, then answers. Every string here is content and must stay local.
    const responses: ModelResponse[] = [{ type: 'tool_calls', calls: [{ id: 'call-1', toolId: 'lookup', input: 'SECRET_QUERY' }], usage: { costMicros: 0 } },
      { type: 'final', output: 'SECRET_ANSWER', usage: { costMicros: 0 } }];
    let index = 0; const model = { id: 'primary', capabilities: { tools: true, structuredOutput: true }, maxCostMicros: 0, generate: async () => responses[index++]! };
    const lookup = defineTool({ id: 'lookup', version: '1', description: 'Look up.', input: any, output: any, effects: 'none', capabilities: [], execute: () => 'SECRET_SOURCE' });
    const researcher = defineAgent({ id: 'researcher', version: '1', instructions: 'SECRET_PROMPT', input: any, output: any, tools: [lookup], model });
    const ask = defineTool({ id: 'research.ask', version: '1', description: 'Run the researcher.', input: any, output: any, effects: 'none', capabilities: [], costMicros: 0,
      execute: async (input, context) => {
        const agents = createRuntime({ profile: 'ephemeral', scope, permissions: { allow: ['model:primary', 'tool:lookup'] }, limits: { maxDurationMs: 5_000 } });
        const observer = createObserver();
        try {
          const handle = agents.submit(researcher, { input }); const observation = observer.observe(handle);
          const outcome = await handle.result(); await observation.done();
          agentSpans.push(...agentRunTraceSpans(observer.inspect(handle.id)?.recent ?? [], { parent: workflowStepTraceContext(context) }));
          return outcome.status === 'succeeded' ? outcome.output : null;
        } finally { await observer.close(); await agents.close(); }
      } });
    const definition = defineWorkflowLifecycle({ id: 'research.run', version: '1', input: any, output: any, nodes: [
      { kind: 'tool', id: 'ask', tool: ask, input: { kind: 'input', path: [] } }, { kind: 'join', id: 'done', dependsOn: ['ask'] },
    ], result: { kind: 'step', stepId: 'ask', path: [] } });
    const runtime = createWorkflowLifecycleRuntime({ store, scope, permissions: { allow: ['tool:research.ask'] }, policyVersion: '1', maxCostMicros: 0 });
    cleanup.push(async () => runtime.close());
    const submitted = await runtime.submit(definition, { input: 'SECRET_QUESTION', idempotencyKey: 'loopback-1' });
    expect(await runtime.runUntilSettled(definition, submitted.id)).toMatchObject({ status: 'succeeded' });

    // Two exporters: the OTLP exporter is single-flight, and the workflow export serializes only its own batches.
    const options = { endpoint: otlp.endpoint, serviceName: 'research', allowInsecureLoopback: true } as const;
    const workflowExporter = createOtlpHttpJsonTraceExporter(options); const agentExporter = createOtlpHttpJsonTraceExporter(options);
    const traces = createWorkflowTraceExport({ source: runtime, store, scope, exportId: 'collector', definitions: [definition], sink: workflowExporter.sink });
    await traces.track(submitted.id);
    expect(await traces.flush()).toMatchObject({ exported: 1, failed: 0 });
    await agentExporter.sink(agentSpans, { signal: new AbortController().signal });

    const spans = otlp.spans(); const named = (name: string) => spans.find(span => span.name === name)!;
    expect(spans.map(span => span.name).sort()).toEqual(['agent:researcher', 'join:done', 'model.call', 'model.call', 'tool:ask', 'tool:lookup', 'workflow:research.run']);
    const root = workflowTraceContext(submitted.id);
    expect(new Set(spans.map(span => span.traceId))).toEqual(new Set([root.traceId]));
    expect(named('workflow:research.run')).toMatchObject({ spanId: root.spanId, status: { code: 1 } }); expect(named('workflow:research.run').parentSpanId).toBeUndefined();
    expect(named('tool:ask').parentSpanId).toBe(root.spanId); expect(named('join:done').parentSpanId).toBe(root.spanId);
    expect(named('agent:researcher').parentSpanId).toBe(named('tool:ask').spanId);
    for (const span of spans.filter(item => ['model.call', 'tool:lookup'].includes(item.name))) expect(span.parentSpanId).toBe(named('agent:researcher').spanId);
    expect(attribute(named('workflow:research.run'), 'mayura.workflow.definition.id')).toBe('research.run');
    expect(attribute(named('workflow:research.run'), 'mayura.budget.max_micros')).toBe('0');
    expect(attribute(named('tool:ask'), 'mayura.workflow.receipt.execution')).toBe('succeeded');
    expect(attribute(named('tool:lookup'), 'mayura.tool.status')).toBe('succeeded');
    expect(attribute(named('agent:researcher'), 'mayura.run.id')).toMatch(/.+/);
    const exported = otlp.bodies.join('\n');
    for (const secret of ['SECRET_QUESTION', 'SECRET_QUERY', 'SECRET_ANSWER', 'SECRET_SOURCE', 'SECRET_PROMPT']) expect(exported).not.toContain(secret);

    // A second export of the same run (a restarted worker without its marker) sends the identical span ids.
    const before = spans.filter(span => !span.name.startsWith('agent') && !['model.call', 'tool:lookup'].includes(span.name));
    const again = createWorkflowTraceExport({ source: runtime, store, scope, exportId: 'fresh', definitions: [definition], sink: workflowExporter.sink });
    expect(await again.exportRun(submitted.id)).toMatchObject({ status: 'exported', spans: 3 });
    const after = otlp.spans().slice(spans.length);
    expect(after.map(span => [span.spanId, span.parentSpanId ?? null, span.startTimeUnixNano, span.endTimeUnixNano]).sort())
      .toEqual(before.map(span => [span.spanId, span.parentSpanId ?? null, span.startTimeUnixNano, span.endTimeUnixNano]).sort());
    expect(workflowExporter.inspect().metrics).toMatchObject({ recordsAccepted: 6, recordsDropped: 0 });
    workflowExporter.close(); agentExporter.close();
  });
});

describe('agent run span projection', () => {
  const at = (second: number) => `2026-09-27T00:00:0${second}.000Z`;
  const event = (sequence: number, type: RunEvent['type'], metadata: RunEvent['metadata'], runId = 'agent-run-1'): RunEvent => ({ runId, sequence, timestamp: at(sequence), type, metadata });
  const run: RunEvent[] = [
    event(1, 'run.started', { profile: 'ephemeral', agentId: 'planner' }), event(2, 'model.started', { step: 0, modelCall: 1 }),
    event(3, 'model.completed', { step: 0, response: 'tool_calls' }), event(4, 'tool.started', { callId: 'c-1', toolId: 'library.search' }),
    event(5, 'tool.completed', { callId: 'c-1', toolId: 'library.search', status: 'failed', execution: 'failed', disclosure: 'withheld' }),
    event(6, 'run.completed', { status: 'failed', spentMicros: 7, reservedMicros: 0, calls: 1 }),
  ];

  it('pairs calls into deterministic child spans of the run span and of an optional parent', () => {
    const spans = agentRunTraceSpans(run);
    expect(spans.map(span => [span.name, span.status])).toEqual([['agent:planner', 'error'], ['model.call', 'ok'], ['tool:library.search', 'error']]);
    expect(spans[0]!.parentSpanId).toBeUndefined(); for (const span of spans.slice(1)) expect(span.parentSpanId).toBe(spans[0]!.spanId);
    expect(spans[0]!.attributes).toEqual({ 'mayura.agent.id': 'planner', 'mayura.run.status': 'failed', 'mayura.budget.spent_micros': 7, 'mayura.budget.reserved_micros': 0 });
    expect(spans[2]).toMatchObject({ startTimeUnixNano: String(Date.parse(at(4)) * 1_000_000), endTimeUnixNano: String(Date.parse(at(5)) * 1_000_000) });
    expect(agentRunTraceSpans(run)).toEqual(spans);
    const parent = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) };
    const nested = agentRunTraceSpans(run, { parent });
    expect(nested[0]).toMatchObject({ traceId: parent.traceId, parentSpanId: parent.spanId });
    expect(new Set(nested.map(span => span.spanId)).size).toBe(3); expect(nested[0]!.spanId).not.toBe(spans[0]!.spanId);
    for (const span of [...spans, ...nested]) { expect(span.traceId).toMatch(/^(?!0{32})[a-f0-9]{32}$/); expect(span.spanId).toMatch(/^(?!0{16})[a-f0-9]{16}$/); }
  });

  it('skips events outside the metadata allowlist, unpaired starts and other runs, and rejects malformed parents', () => {
    const spans = agentRunTraceSpans([
      ...run.slice(0, 4), event(5, 'tool.completed', { callId: 'c-1', toolId: 'library.search', status: 'succeeded', arguments: 'SECRET' }),
      event(6, 'model.started', { step: 1, modelCall: 2 }), event(1, 'run.started', { profile: 'ephemeral' }, 'other-run'),
    ]);
    expect(spans.map(span => span.name)).toEqual(['agent:planner', 'model.call']); expect(JSON.stringify(spans)).not.toContain('SECRET');
    expect(agentRunTraceSpans([])).toEqual([]);
    expect(() => agentRunTraceSpans(run, { parent: { traceId: '0'.repeat(32), spanId: 'b'.repeat(16) } })).toThrow();
    expect(() => agentRunTraceSpans(run, { parent: { traceId: 'a'.repeat(32), spanId: 'SECRET' } })).toThrow();
  });
});
