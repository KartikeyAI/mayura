import type { RunHandle } from '@mayura/core';
import { agentRunTraceSpans, createOtlpHttpJsonTraceExporter, type OtlpTraceSpan } from '@mayura/exporter-otlp';
import { createObserver } from '@mayura/observability';
import type { AggregateStore } from '@mayura/storage-contracts';
import { createWorkflowTraceExport, workflowStepTraceContext, type WorkflowFleetTarget, type WorkflowTraceDefinition, type WorkflowTraceExport,
  type WorkflowTraceSource, type WorkflowWorkerUnit } from '@mayura/workflows';
import type { TelemetrySettings } from './config.js';

/**
 * Metadata-only OpenTelemetry traces for research runs. Each research run is one trace:
 *
 *   workflow:research.run                     the run, from submission to its last event
 *   ├─ tool:plan, tool:research.1..4, join:research, tool:write, tool:store  one span per step
 *   │  └─ agent:research.planner (…researcher, …writer)                        the agent a step ran
 *   │     ├─ model.call                                                         each model call
 *   │     └─ tool:library.search, tool:library.read                             each tool call
 *
 * The workflow spans come from the run's durable event log once the run settles (`@mayura/workflows` trace export):
 * a worker that restarts exports them later, and exporting twice sends identical ids. Agent spans are projected when
 * the agent finishes and nested under their step. What is exported: names, times, ok/error, run and node ids, step
 * statuses and budget integers. Never questions, prompts, sources, findings, reports, tool inputs or outputs.
 */
export interface Telemetry {
  readonly enabled: boolean;
  /** Nest one agent run's spans under the workflow step (`context`: the step tool's execution context) running it. */
  watch(context: { readonly runId: string; readonly callId: string }, handle: RunHandle<unknown>): AgentWatch;
  /** Export settled research runs from the durable event log. Call once, after the workflow definitions exist. */
  exportWorkflows(options: { readonly source: WorkflowTraceSource; readonly store: AggregateStore;
    readonly scope: { readonly principalId: string; readonly projectId: string }; readonly definitions: readonly WorkflowTraceDefinition[] }): void;
  /** Durably remember a submitted run so its trace is exported once it settles. Never throws: the worker also discovers runs. */
  track(runId: string): Promise<void>;
  /** The worker unit that exports settled runs, discovering active ones through `targets`. Undefined when disabled. */
  unit(targets: readonly WorkflowFleetTarget[]): WorkflowWorkerUnit | undefined;
  /** Deliver queued agent spans and export settled tracked runs (tests and shutdown). Never throws. */
  flush(): Promise<void>;
  close(): Promise<void>;
}
export interface AgentWatch { end(): Promise<void> }

const idle: AgentWatch = { async end() {} };
export const disabledTelemetry: Telemetry = { enabled: false, watch: () => idle, exportWorkflows() {}, track: async () => {}, unit: () => undefined,
  flush: async () => {}, close: async () => {} };

export function createTelemetry(settings: TelemetrySettings | undefined): Telemetry {
  if (!settings) return disabledTelemetry;
  // One exporter per producer: an exporter sends one request at a time, and the workflow export serializes only its own.
  const exporter = () => createOtlpHttpJsonTraceExporter({ endpoint: settings.tracesEndpoint, serviceName: settings.serviceName,
    headers: settings.headers, allowInsecureLoopback: settings.allowInsecureLoopback, timeoutMs: 5_000 });
  const agentExporter = exporter(); const workflowExporter = exporter();
  let workflows: WorkflowTraceExport | undefined;
  // Researchers finish in parallel: queue their spans (bounded) and ship them from one loop. Telemetry is best effort
  // and never blocks or fails a research step.
  const queue: OtlpTraceSpan[] = []; const maxQueued = 2_048;
  let shipping: Promise<void> | undefined; let closed = false;
  const ship = (): Promise<void> => shipping ??= (async () => {
    try {
      while (queue.length > 0) {
        const batch = queue.splice(0, 64);
        try { await agentExporter.sink(batch, { signal: AbortSignal.timeout(10_000) }); } catch { /* Counted by the exporter; dropped. */ }
      }
    } finally { shipping = undefined; }
  })();
  const emit = (spans: readonly OtlpTraceSpan[]): void => {
    if (closed || spans.length === 0 || queue.length + spans.length > maxQueued) return;
    queue.push(...spans); void ship();
  };

  return {
    enabled: true,
    watch(context, handle) {
      // An observer per agent run: it admits only allow-listed metadata and never cancels the run it watches.
      const observer = createObserver({ maxRuns: 1, maxRecentEventsPerRun: 256, maxObservationMs: 600_000 });
      const done = observer.observe(handle).done();
      return {
        async end() {
          try {
            // The run has settled by now; give its final events a moment to arrive, then project what was observed.
            await Promise.race([done, new Promise(resolve => setTimeout(resolve, 1_000).unref())]);
            emit(agentRunTraceSpans(observer.inspect(handle.id)?.recent ?? [], { parent: workflowStepTraceContext(context) }));
          } catch { /* Telemetry never fails the step. */ } finally { await observer.close(); }
        },
      };
    },
    exportWorkflows(options) {
      workflows = createWorkflowTraceExport({ ...options, exportId: 'research-traces', sink: workflowExporter.sink });
    },
    async track(runId) { try { await workflows?.track(runId); } catch { /* The worker's discovery tracks it instead. */ } },
    unit: targets => workflows?.unit({ intervalMs: 2_000, targets }),
    flush: async () => {
      while (shipping) await shipping;
      try { await workflows?.flush(); } catch { /* Unexported runs stay in the durable outbox. */ }
    },
    close: async () => { if (closed) return; while (shipping) await shipping; closed = true; agentExporter.close(); workflowExporter.close(); },
  };
}
