import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Attributes, type Context, type Meter, type Span, type SpanOptions, type Tracer } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@mayura/core';
import { agentRunTraceSpans, type OtlpTraceSpan } from '../src/index.js';
import { createOpenTelemetryRunMetrics, createOpenTelemetryTraceBridge } from '../src/opentelemetry.js';

interface Started { readonly name: string; readonly options: SpanOptions; readonly parent?: string; readonly spanId: string; status?: unknown; end?: unknown }
/** A tracer that records what it is asked to start; span ids count up, and parents are read from the context. */
function fakeTracer(fail: { start?: boolean; status?: boolean } = {}): { tracer: Tracer; started: Started[] } {
  const started: Started[] = []; let next = 0;
  const tracer = {
    startSpan(name: string, options: SpanOptions = {}, context: Context = ROOT_CONTEXT): Span {
      if (fail.start) throw new Error('SECRET tracer failure');
      const spanId = (++next).toString(16).padStart(16, '0'); const parent = trace.getSpanContext(context)?.spanId;
      const record: Started = { name, options, spanId, ...(parent === undefined ? {} : { parent }) }; started.push(record);
      const span = { spanContext: () => ({ traceId: 'a'.repeat(32), spanId, traceFlags: 1 }),
        setStatus: (status: unknown) => { if (fail.status) throw new Error('SECRET status failure'); record.status = status; return span; }, end: (time: unknown) => { record.end = time; } };
      return span as unknown as Span;
    },
    startActiveSpan: () => { throw new Error('unused'); },
  };
  return { tracer: tracer as unknown as Tracer, started };
}
const signal = () => new AbortController().signal;
const at = (second: number) => `2026-09-27T00:00:0${second}.000Z`;
const event = (sequence: number, type: RunEvent['type'], metadata: RunEvent['metadata'], runId = 'agent-run-1'): RunEvent => ({ runId, sequence, timestamp: at(sequence), type, metadata });
const run: RunEvent[] = [
  event(1, 'run.started', { profile: 'ephemeral', agentId: 'planner' }), event(2, 'model.started', { step: 0, modelCall: 1, modelId: 'anthropic/claude-test' }),
  event(4, 'model.completed', { step: 0, response: 'tool_calls', costMicros: 42, inputTokens: 1_200, outputTokens: 80 }), event(5, 'tool.started', { callId: 'c-1', toolId: 'library.search' }),
  event(6, 'tool.completed', { callId: 'c-1', toolId: 'library.search', status: 'failed', execution: 'failed', disclosure: 'withheld' }),
  event(7, 'run.completed', { status: 'failed', spentMicros: 42, reservedMicros: 0, calls: 1 }),
];

describe('OpenTelemetry trace bridge', () => {
  it('starts each span through the application tracer, parents first, with its times, kind, status and catalog attributes', async () => {
    const { tracer, started } = fakeTracer(); const bridge = createOpenTelemetryTraceBridge({ tracer });
    // Children first: the bridge still starts the run span before them.
    await bridge.sink([...agentRunTraceSpans(run)].reverse(), { signal: signal() });
    expect(started.map(span => span.name)).toEqual(['agent:planner', 'tool:library.search', 'model.call']);
    const [root, tool, model] = started as [Started, Started, Started];
    expect(root.parent).toBeUndefined(); expect([tool.parent, model.parent]).toEqual([root.spanId, root.spanId]);
    expect(model.options).toEqual({ kind: SpanKind.CLIENT, startTime: [Date.parse(at(2)) / 1_000, 0], attributes: expect.objectContaining({
      'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'anthropic', 'gen_ai.request.model': 'claude-test', 'gen_ai.usage.input_tokens': 1_200, 'gen_ai.usage.output_tokens': 80,
      'mayura.cost.micros': 42, 'mayura.run.id': 'agent-run-1' }) });
    expect(model.end).toEqual([Date.parse(at(4)) / 1_000, 0]); expect(model.status).toEqual({ code: SpanStatusCode.OK });
    expect([root.options.kind, tool.options.kind, tool.status, root.status]).toEqual([SpanKind.INTERNAL, SpanKind.INTERNAL, { code: SpanStatusCode.ERROR }, { code: SpanStatusCode.ERROR }]);
  });

  it('hangs a later batch under a span it remembers, and under the given context once it has forgotten it', async () => {
    const { tracer, started } = fakeTracer(); const outer = trace.setSpanContext(ROOT_CONTEXT, { traceId: 'b'.repeat(32), spanId: 'c'.repeat(16), traceFlags: 1 });
    const spans = agentRunTraceSpans(run); const [first, ...rest] = spans as [OtlpTraceSpan, ...OtlpTraceSpan[]];
    const bridge = createOpenTelemetryTraceBridge({ tracer, context: () => outer });
    await bridge.sink([first], { signal: signal() }); await bridge.sink(rest, { signal: signal() });
    expect(started.map(span => span.parent)).toEqual(['c'.repeat(16), started[0]!.spanId, started[0]!.spanId]);
    const forgetful = fakeTracer(); const small = createOpenTelemetryTraceBridge({ tracer: forgetful.tracer, context: () => outer, maxRememberedSpans: 1 });
    await small.sink([first], { signal: signal() }); await small.sink([rest[0]!], { signal: signal() }); await small.sink([rest[1]!], { signal: signal() });
    expect(forgetful.started.map(span => span.parent)).toEqual(['c'.repeat(16), forgetful.started[0]!.spanId, 'c'.repeat(16)]);
  });

  it('refuses a whole batch with a span outside the catalog, an aborted signal, an oversized batch or a closed bridge, starting nothing', async () => {
    const { tracer, started } = fakeTracer(); const bridge = createOpenTelemetryTraceBridge({ tracer, maxBatchSize: 2 }); const spans = agentRunTraceSpans(run);
    const leaking = { ...spans[0]!, attributes: { ...spans[0]!.attributes, 'gen_ai.prompt': 'SECRET prompt' } } as unknown as OtlpTraceSpan;
    await expect(bridge.sink([spans[1]!, leaking], { signal: signal() })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(bridge.sink([{ ...spans[1]!, name: 'SECRET\nprompt' }], { signal: signal() })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(bridge.sink(spans, { signal: signal() })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const controller = new AbortController(); controller.abort();
    await expect(bridge.sink([spans[0]!], { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    bridge.close(); await expect(bridge.sink([spans[0]!], { signal: signal() })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(started).toEqual([]);
  });

  it('reports a failing tracer without its text, and still ends a span whose status failed', async () => {
    const spans = agentRunTraceSpans(run);
    for (const fail of [{ start: true }, { status: true }]) {
      const { tracer, started } = fakeTracer(fail);
      const caught = await createOpenTelemetryTraceBridge({ tracer }).sink(spans, { signal: signal() }).catch((error: unknown) => error);
      expect(caught).toMatchObject({ code: 'TOOL_FAILED' }); expect(JSON.stringify(caught) + String(caught)).not.toContain('SECRET');
      expect(started.every(span => span.end !== undefined)).toBe(true);
    }
  });

  it('needs a tracer and bounded options', () => {
    expect(() => createOpenTelemetryTraceBridge({} as never)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => createOpenTelemetryTraceBridge({ tracer: fakeTracer().tracer, maxRememberedSpans: 0 })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => createOpenTelemetryTraceBridge({ tracer: fakeTracer().tracer, maxBatchSize: 1e9 })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => createOpenTelemetryTraceBridge({ tracer: fakeTracer().tracer, context: 'active' as never })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });
});

interface Recorded { readonly instrument: string; readonly value: number; readonly attributes?: Attributes }
function fakeMeter(): { meter: Meter; recorded: Recorded[]; created: { name: string; options: unknown }[] } {
  const recorded: Recorded[] = []; const created: { name: string; options: unknown }[] = [];
  const instrument = (name: string, options: unknown) => { created.push({ name, options }); const write = (value: number, attributes?: Attributes) => { recorded.push({ instrument: name, value, ...(attributes ? { attributes } : {}) }); }; return { record: write, add: write }; };
  return { meter: { createHistogram: instrument, createCounter: instrument } as unknown as Meter, recorded, created };
}

describe('OpenTelemetry run metrics', () => {
  it('records the GenAI client metrics for each completed model call, and Mayura\'s run, tool and cost counters', async () => {
    const { meter, recorded, created } = fakeMeter(); const metrics = createOpenTelemetryRunMetrics({ meter });
    // Events arrive in observer batches; a model call may start in one and complete in the next.
    await metrics.sink(run.slice(0, 2), { signal: signal() }); await metrics.sink(run.slice(2), { signal: signal() });
    expect(created.map(item => item.name)).toEqual(['gen_ai.client.operation.duration', 'gen_ai.client.token.usage', 'mayura.cost.micros', 'mayura.runs', 'mayura.tool.calls']);
    const model = { 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'anthropic', 'gen_ai.request.model': 'claude-test', 'mayura.model.id': 'anthropic/claude-test' };
    expect(recorded).toEqual([
      { instrument: 'gen_ai.client.operation.duration', value: 2, attributes: model },
      { instrument: 'gen_ai.client.token.usage', value: 1_200, attributes: { ...model, 'gen_ai.token.type': 'input' } },
      { instrument: 'gen_ai.client.token.usage', value: 80, attributes: { ...model, 'gen_ai.token.type': 'output' } },
      { instrument: 'mayura.cost.micros', value: 42, attributes: model },
      { instrument: 'mayura.tool.calls', value: 1, attributes: { 'gen_ai.tool.name': 'library.search', 'mayura.tool.status': 'failed' } },
      { instrument: 'mayura.runs', value: 1, attributes: { 'mayura.run.status': 'failed', 'gen_ai.agent.id': 'planner' } },
    ]);
  });

  it('skips events outside the allowlist and completions without their start, and forgets the oldest runs past its bound', async () => {
    const { meter, recorded } = fakeMeter(); const metrics = createOpenTelemetryRunMetrics({ meter, maxRuns: 1 });
    await metrics.sink([
      event(1, 'model.started', { step: 0, modelCall: 1, modelId: 'SECRET prompt text' }), event(2, 'model.completed', { step: 0, response: 'final', inputTokens: -1 }),
      event(3, 'model.completed', { step: 0, response: 'final', inputTokens: 5 }, 'other-run'),
      event(4, 'model.started', { step: 0, modelCall: 1 }, 'run-a'), event(5, 'model.started', { step: 0, modelCall: 1 }, 'run-b'),
      event(6, 'model.completed', { step: 0, response: 'final', inputTokens: 7 }, 'run-a'),
    ], { signal: signal() });
    expect(recorded).toEqual([]);
    expect(JSON.stringify(recorded)).not.toContain('SECRET');
  });

  it('refuses batches once closed or cancelled, and reports a failing meter without its text', async () => {
    const metrics = createOpenTelemetryRunMetrics({ meter: fakeMeter().meter });
    const controller = new AbortController(); controller.abort();
    await expect(metrics.sink(run, { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    metrics.close(); await expect(metrics.sink(run, { signal: signal() })).rejects.toMatchObject({ code: 'CONFLICT' });
    const throwing = { createHistogram: () => ({ record: () => { throw new Error('SECRET meter'); } }), createCounter: () => ({ add: () => undefined }) } as unknown as Meter;
    const caught = await createOpenTelemetryRunMetrics({ meter: throwing }).sink(run, { signal: signal() }).catch((error: unknown) => error);
    expect(caught).toMatchObject({ code: 'TOOL_FAILED' }); expect(JSON.stringify(caught) + String(caught)).not.toContain('SECRET');
    expect(() => createOpenTelemetryRunMetrics({} as never)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => createOpenTelemetryRunMetrics({ meter: { createHistogram: () => { throw new Error('SECRET'); }, createCounter: () => undefined } as unknown as Meter })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });
});
