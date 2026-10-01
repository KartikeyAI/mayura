import { context as contexts, SpanKind, SpanStatusCode, trace, type Attributes, type Context, type Counter, type Histogram, type HrTime, type Meter, type SpanContext, type Tracer } from '@opentelemetry/api';
import { assertPositiveInteger, MayuraError, type RunEvent } from '@mayura/core';
import { snapshotRunEventMetadata } from '@mayura/observability';
import type { OtlpTraceSpan } from './contracts.js';
import { modelAttributes } from './run-traces.js';
import { checkedSpan } from './signals.js';

export interface OpenTelemetryTraceBridgeOptions {
  /** Your application's tracer, for example `trace.getTracer('orders-agent')`. Mayura's spans become spans of your SDK. */
  readonly tracer: Tracer;
  /**
   * The context a span starts in when its parent is not known to the bridge. Called once per batch; default: the
   * active context, so spans exported inside a request hang under its span.
   */
  readonly context?: () => Context;
  /** Span ids remembered so later batches can hang under spans exported earlier; the oldest are forgotten first. Default 4,096. */
  readonly maxRememberedSpans?: number;
  /** Spans per batch. Default 1,024. */
  readonly maxBatchSize?: number;
}

export interface OpenTelemetryTraceBridge {
  /** Takes the same spans as an OTLP trace exporter: `agentRunTraceSpans`, or `sink` of `createWorkflowTraceExport`. */
  readonly sink: (spans: readonly OtlpTraceSpan[], context: { readonly signal: AbortSignal }) => Promise<void>;
  /** Rejects future batches and forgets the remembered span ids. */
  close(): void;
}

export interface OpenTelemetryRunMetricsOptions {
  /** Your application's meter, for example `metrics.getMeter('orders-agent')`. */
  readonly meter: Meter;
  /** Runs followed at once, to pair each model call's start and completion; the oldest are forgotten first. Default 1,024. */
  readonly maxRuns?: number;
}

export interface OpenTelemetryRunMetrics {
  /** An observer sink: `createRunObserver({ sink: metrics.sink })`. */
  readonly sink: (events: readonly RunEvent[], context: { readonly signal: AbortSignal }) => Promise<void>;
  /** Stops recording and forgets the runs it follows. */
  close(): void;
}

const failed = (): never => { throw new MayuraError('TOOL_FAILED', 'The telemetry export failed. Inspect authorized local diagnostics.'); };
function bound(value: number | undefined, fallback: number, max: number, name: string): number {
  const result = value ?? fallback; assertPositiveInteger(result, name);
  if (result > max) throw new MayuraError('INVALID_CONFIG', `${name} must be at most ${max}.`);
  return result;
}
function hrTime(nanos: string): HrTime { const value = BigInt(nanos); return [Number(value / 1_000_000_000n), Number(value % 1_000_000_000n)]; }

/**
 * Re-create Mayura's metadata-only spans through your application's OpenTelemetry tracer, so they reach whatever your
 * SDK exports to, with its resource, sampler and processors. Your SDK assigns the trace and span ids; parents follow
 * Mayura's tree within a batch and across batches while the parent's id is remembered. Attributes come from the same
 * closed catalog the OTLP exporter checks, and a batch with any invalid span is refused whole.
 */
export function createOpenTelemetryTraceBridge(options: OpenTelemetryTraceBridgeOptions): OpenTelemetryTraceBridge {
  const tracer = options?.tracer;
  if (!tracer || typeof tracer.startSpan !== 'function') throw new MayuraError('INVALID_CONFIG', 'The OpenTelemetry trace bridge requires a tracer.');
  if (options.context !== undefined && typeof options.context !== 'function') throw new MayuraError('INVALID_CONFIG', 'The bridge context must be a function.');
  const remember = bound(options.maxRememberedSpans, 4_096, 1_048_576, 'maxRememberedSpans'); const maxBatch = bound(options.maxBatchSize, 1_024, 65_536, 'maxBatchSize');
  const base = options.context ?? ((): Context => contexts.active());
  const known = new Map<string, SpanContext>(); let closed = false;
  const sink = async (spans: readonly OtlpTraceSpan[], context: { readonly signal: AbortSignal }): Promise<void> => {
    if (closed) throw new MayuraError('CONFLICT', 'The OpenTelemetry trace bridge is closed.');
    if (!Array.isArray(spans) || spans.length > maxBatch || !(context?.signal instanceof AbortSignal)) throw new MayuraError('INVALID_INPUT', 'Telemetry batches require admitted records, a signal and supported bounds.');
    if (context.signal.aborted) throw new MayuraError('CANCELLED', 'The telemetry export was cancelled.');
    const checked = spans.map(checkedSpan); const byId = new Map(checked.map(span => [span.spanId, span]));
    // Parents start before their children, so a child can name its parent's new span context.
    const ordered: OtlpTraceSpan[] = []; const placed = new Set<string>();
    for (const span of checked) {
      const chain: OtlpTraceSpan[] = []; let next: OtlpTraceSpan | undefined = span;
      while (next && !placed.has(next.spanId) && !chain.includes(next)) { chain.push(next); next = next.parentSpanId === undefined ? undefined : byId.get(next.parentSpanId); }
      for (const item of chain.reverse()) if (!placed.has(item.spanId)) { placed.add(item.spanId); ordered.push(item); }
    }
    let root: Context;
    try { root = base(); } catch { return failed(); }
    for (const span of ordered) {
      const parent = span.parentSpanId === undefined ? undefined : known.get(span.parentSpanId);
      const attributes: Attributes = { ...span.attributes, ...(span.runId === undefined ? {} : { 'mayura.run.id': span.runId }) };
      const kind = span.attributes?.['gen_ai.operation.name'] === 'chat' ? SpanKind.CLIENT : SpanKind.INTERNAL;
      let created;
      try { created = tracer.startSpan(span.name, { kind, startTime: hrTime(span.startTimeUnixNano), attributes }, parent ? trace.setSpanContext(root, parent) : root); } catch { return failed(); }
      try {
        if (span.status !== 'unset') created.setStatus({ code: span.status === 'ok' ? SpanStatusCode.OK : SpanStatusCode.ERROR });
        known.delete(span.spanId); known.set(span.spanId, created.spanContext());
        while (known.size > remember) known.delete(known.keys().next().value!);
      } catch { return failed(); } finally { try { created.end(hrTime(span.endTimeUnixNano)); } catch { /* The SDK's own failure; the span is ended or abandoned by it. */ } }
    }
  };
  return Object.freeze({ sink, close: (): void => { closed = true; known.clear(); } });
}

/** OpenTelemetry's recommended bucket boundaries for the GenAI client metrics. */
const durationBuckets = [0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48, 40.96, 81.92];
const tokenBuckets = [1, 4, 16, 64, 256, 1_024, 4_096, 16_384, 65_536, 262_144, 1_048_576, 4_194_304, 16_777_216, 67_108_864];

interface FollowedRun { agentId?: string; model?: RunEvent | undefined; readonly guardrails: Map<string, RunEvent> }

/**
 * Record run metrics through your application's OpenTelemetry meter, from the same metadata events an observer sees:
 * OpenTelemetry's GenAI client metrics `gen_ai.client.operation.duration` (seconds) and `gen_ai.client.token.usage`
 * (by `gen_ai.token.type`) for each completed model call, and Mayura's `mayura.cost.micros`, `mayura.runs` (by status)
 * and `mayura.tool.calls` (by tool and status) counters. Events that fail the observability allowlist are skipped.
 */
export function createOpenTelemetryRunMetrics(options: OpenTelemetryRunMetricsOptions): OpenTelemetryRunMetrics {
  const meter = options?.meter;
  if (!meter || typeof meter.createHistogram !== 'function' || typeof meter.createCounter !== 'function') throw new MayuraError('INVALID_CONFIG', 'OpenTelemetry run metrics require a meter.');
  const maxRuns = bound(options.maxRuns, 1_024, 1_048_576, 'maxRuns');
  let duration: Histogram; let tokens: Histogram; let cost: Counter; let runs: Counter; let tools: Counter;
  try {
    duration = meter.createHistogram('gen_ai.client.operation.duration', { unit: 's', description: 'GenAI operation duration.', advice: { explicitBucketBoundaries: durationBuckets } });
    tokens = meter.createHistogram('gen_ai.client.token.usage', { unit: '{token}', description: 'Number of input and output tokens used.', advice: { explicitBucketBoundaries: tokenBuckets } });
    cost = meter.createCounter('mayura.cost.micros', { unit: '{micro}', description: 'Model spending, in budget micros.' });
    runs = meter.createCounter('mayura.runs', { unit: '{run}', description: 'Completed agent runs.' });
    tools = meter.createCounter('mayura.tool.calls', { unit: '{call}', description: 'Completed tool calls.' });
  } catch { throw new MayuraError('INVALID_CONFIG', 'OpenTelemetry run metrics require a working meter.'); }
  const followed = new Map<string, FollowedRun>(); let closed = false;
  const follow = (runId: string): FollowedRun => {
    let run = followed.get(runId);
    if (!run) { run = { guardrails: new Map() }; followed.set(runId, run); while (followed.size > maxRuns) followed.delete(followed.keys().next().value!); }
    return run;
  };
  const completed = (start: RunEvent, end: RunEvent): void => {
    const attributes: Attributes = { 'gen_ai.operation.name': 'chat', ...modelAttributes(start.metadata['modelId']) };
    duration.record(Math.max(0, Date.parse(end.timestamp) - Date.parse(start.timestamp)) / 1_000, attributes);
    const input = end.metadata['inputTokens']; const output = end.metadata['outputTokens']; const spent = end.metadata['costMicros'];
    if (typeof input === 'number') tokens.record(input, { ...attributes, 'gen_ai.token.type': 'input' });
    if (typeof output === 'number') tokens.record(output, { ...attributes, 'gen_ai.token.type': 'output' });
    if (typeof spent === 'number' && spent > 0) cost.add(spent, attributes);
  };
  const sink = async (events: readonly RunEvent[], context: { readonly signal: AbortSignal }): Promise<void> => {
    if (closed) throw new MayuraError('CONFLICT', 'OpenTelemetry run metrics are closed.');
    if (!Array.isArray(events) || !(context?.signal instanceof AbortSignal)) throw new MayuraError('INVALID_INPUT', 'Telemetry batches require admitted records, a signal and supported bounds.');
    if (context.signal.aborted) throw new MayuraError('CANCELLED', 'The telemetry export was cancelled.');
    try {
      for (const raw of events) {
        let event: RunEvent; try { event = snapshotRunEventMetadata(raw); } catch { continue; }
        const metadata = event.metadata; const callId = typeof metadata['callId'] === 'string' ? metadata['callId'] : undefined;
        if (event.type === 'run.started') { const agentId = metadata['agentId']; if (typeof agentId === 'string') follow(event.runId).agentId = agentId; }
        else if (event.type === 'model.started') { const run = follow(event.runId); if (callId === undefined) run.model = event; else run.guardrails.set(callId, event); }
        else if (event.type === 'model.completed') {
          const run = followed.get(event.runId); if (!run) continue;
          const start = callId === undefined ? run.model : run.guardrails.get(callId); if (!start) continue;
          if (callId === undefined) run.model = undefined; else run.guardrails.delete(callId);
          completed(start, event);
        } else if (event.type === 'tool.completed') {
          tools.add(1, { 'gen_ai.tool.name': metadata['toolId'] as string, 'mayura.tool.status': metadata['status'] as string });
        } else if (event.type === 'run.completed') {
          const agentId = followed.get(event.runId)?.agentId; followed.delete(event.runId);
          runs.add(1, { 'mayura.run.status': metadata['status'] as string, ...(agentId === undefined ? {} : { 'gen_ai.agent.id': agentId }) });
        }
      }
    } catch { return failed(); }
  };
  return Object.freeze({ sink, close: (): void => { closed = true; followed.clear(); } });
}
