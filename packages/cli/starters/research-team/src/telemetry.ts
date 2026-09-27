import { createHash, randomBytes } from 'node:crypto';
import type { RunEvent, RunHandle } from '@mayura/core';
import { createOtlpHttpJsonTraceExporter, type OtlpTraceSpan } from '@mayura/exporter-otlp';
import { createObserver } from '@mayura/observability';
import type { TelemetrySettings } from './config.js';

/**
 * Metadata-only OpenTelemetry traces for research runs. One trace per research run (its id is derived from the run
 * id); each workflow step is a span, and each model call and tool call inside an agent step is a child span.
 *
 * What is exported: span names (`research.plan`, `model.call`, `tool.library.search`, ...), start and end times, ok or
 * error, and the research run id. What is never exported: questions, prompts, sources, findings, reports, tool
 * inputs or outputs. The exporter accepts no free-form attributes, and the observer admits only allow-listed metadata.
 */
export interface Telemetry {
  /** Time one workflow step. For agent steps, pass each agent run to `watch` so its calls become child spans. */
  step(runId: string, name: string): StepSpan;
  /** Deliver queued spans (tests and shutdown). Never throws; failed deliveries are counted and dropped. */
  flush(): Promise<void>;
  close(): Promise<void>;
  readonly enabled: boolean;
}
export interface StepSpan {
  watch(handle: RunHandle<unknown>): void;
  end(status: 'ok' | 'error'): Promise<void>;
}

const disabledStep: StepSpan = { watch() {}, async end() {} };
export const disabledTelemetry: Telemetry = { enabled: false, step: () => disabledStep, flush: async () => {}, close: async () => {} };

const nanos = (milliseconds: number): string => (BigInt(Math.trunc(milliseconds)) * 1_000_000n).toString();
const hex = (value: string, length: number): string => createHash('sha256').update(value).digest('hex').slice(0, length);
const spanId = (): string => { let id = '0'.repeat(16); while (/^0+$/u.test(id)) id = randomBytes(8).toString('hex'); return id; };

export function createTelemetry(settings: TelemetrySettings | undefined): Telemetry {
  if (!settings) return disabledTelemetry;
  const exporter = createOtlpHttpJsonTraceExporter({ endpoint: settings.tracesEndpoint, serviceName: settings.serviceName,
    headers: settings.headers, allowInsecureLoopback: settings.allowInsecureLoopback, timeoutMs: 5_000 });
  // The exporter sends one request at a time, while researchers finish in parallel: queue spans (bounded) and ship
  // them from one loop. Telemetry is best-effort and never blocks or fails a research step.
  const queue: OtlpTraceSpan[] = []; const maxQueued = 2_048;
  let shipping: Promise<void> | undefined; let closed = false;
  const ship = (): Promise<void> => shipping ??= (async () => {
    try {
      while (queue.length > 0) {
        const batch = queue.splice(0, 64);
        try { await exporter.sink(batch, { signal: AbortSignal.timeout(10_000) }); } catch { /* Counted by exporter.inspect(); dropped. */ }
      }
    } finally { shipping = undefined; }
  })();
  const emit = (spans: readonly OtlpTraceSpan[]): void => {
    if (closed || queue.length + spans.length > maxQueued) return;
    queue.push(...spans); void ship();
  };

  return {
    enabled: true,
    step(runId, name) {
      const traceId = hex(`research-trace:${runId}`, 32); const id = spanId(); const startedAt = Date.now();
      const watched: { observer: ReturnType<typeof createObserver>; runId: string; done: Promise<unknown> }[] = [];
      return {
        watch(handle) {
          // An observer per agent run: it admits only allow-listed metadata and never cancels the run it watches.
          const observer = createObserver({ maxRuns: 1, maxRecentEventsPerRun: 256, maxObservationMs: 600_000 });
          watched.push({ observer, runId: handle.id, done: observer.observe(handle).done() });
        },
        async end(status) {
          const endedAt = Date.now(); const spans: OtlpTraceSpan[] = [{ traceId, spanId: id, name, runId, status,
            startTimeUnixNano: nanos(startedAt), endTimeUnixNano: nanos(Math.max(endedAt, startedAt)) }];
          for (const item of watched) {
            // The run has settled by now; give its final events a moment to arrive, then read what was observed.
            await Promise.race([item.done, new Promise(resolve => setTimeout(resolve, 1_000).unref())]);
            spans.push(...childSpans(item.observer.inspect(item.runId)?.recent ?? [], { traceId, parentSpanId: id, runId }));
            await item.observer.close();
          }
          emit(spans);
        },
      };
    },
    flush: async () => { while (shipping) await shipping; },
    close: async () => { if (closed) return; while (shipping) await shipping; closed = true; exporter.close(); },
  };
}

/** Pair start and completion events into spans. Only event types and timing are used; metadata stays behind. */
function childSpans(events: readonly RunEvent[], parent: { readonly traceId: string; readonly parentSpanId: string; readonly runId: string }): OtlpTraceSpan[] {
  const spans: OtlpTraceSpan[] = []; let model: RunEvent | undefined; const tools = new Map<string, RunEvent>();
  const span = (name: string, start: RunEvent, end: RunEvent, ok: boolean): OtlpTraceSpan => {
    const from = Date.parse(start.timestamp); const to = Math.max(from, Date.parse(end.timestamp));
    return { traceId: parent.traceId, spanId: spanId(), parentSpanId: parent.parentSpanId, name, runId: parent.runId,
      status: ok ? 'ok' : 'error', startTimeUnixNano: nanos(from), endTimeUnixNano: nanos(to) };
  };
  for (const event of events) {
    const callId = String(event.metadata['callId'] ?? '');
    if (event.type === 'model.started') model = event;
    else if (event.type === 'model.completed' && model) { spans.push(span('model.call', model, event, true)); model = undefined; }
    else if (event.type === 'tool.started') tools.set(callId, event);
    else if (event.type === 'tool.completed' && tools.has(callId)) {
      // Tool ids are identifiers from this code (`library.search`), never model- or user-supplied text.
      const toolId = String(event.metadata['toolId'] ?? 'tool');
      spans.push(span(/^[a-z][a-z0-9.]{0,63}$/u.test(toolId) ? `tool.${toolId}` : 'tool.call', tools.get(callId)!, event, event.metadata['status'] === 'succeeded'));
      tools.delete(callId);
    }
  }
  return spans;
}
