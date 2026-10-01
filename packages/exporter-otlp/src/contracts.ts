import type { RunEvent } from '@mayura/core';

export type ExactCount = number | string;

export interface OtlpHttpJsonLogExporterOptions {
  /** Complete signal endpoint, normally `https://collector.example/v1/logs`. */
  readonly endpoint: string;
  readonly serviceName: string;
  readonly serviceVersion?: string;
  /** Explicit secrets are copied once and are never exposed by inspection or errors. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Allows only literal loopback HTTP endpoints for local collector development. */
  readonly allowInsecureLoopback?: boolean;
  readonly timeoutMs?: number;
  readonly maxBatchSize?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  /** Trusted transport injection. Construction and import never invoke it. */
  readonly fetch?: typeof globalThis.fetch;
}

export interface OtlpLogExporterMetrics {
  readonly batchesAttempted: ExactCount;
  readonly recordsAttempted: ExactCount;
  readonly recordsAccepted: ExactCount;
  readonly recordsDropped: ExactCount;
  readonly partialResponses: ExactCount;
  readonly failedRequests: ExactCount;
  readonly timedOutRequests: ExactCount;
  readonly cancelledRequests: ExactCount;
  readonly requestBytes: ExactCount;
  readonly responseBytes: ExactCount;
}

export interface OtlpLogExporterSnapshot {
  readonly state: 'active' | 'closed';
  readonly inFlight: boolean;
  readonly metrics: OtlpLogExporterMetrics;
}

export interface OtlpHttpJsonLogExporter {
  /** Use directly as an `@mayura/observability` sink. Calls are single-flight. */
  readonly sink: (events: readonly RunEvent[], context: { readonly signal: AbortSignal }) => Promise<void>;
  inspect(): OtlpLogExporterSnapshot;
  /** Aborts the active export and rejects future calls. */
  close(): void;
}

/**
 * Attributes a provider adds beyond Mayura's own: at most 16, with lowercase dotted keys (`openinference.span.kind`,
 * `sentry.op`) outside the span-attribute catalog, `mayura.*` and `service.*`, and values that are bounded stable
 * identifiers or non-negative safe integers, like the catalog's. They cannot carry free text.
 */
export type OtlpExtraAttributes = Readonly<Record<string, string | number>>;

export interface OtlpHttpJsonSignalExporterOptions {
  /** Complete signal-specific endpoint ending in `/v1/traces` or `/v1/metrics`. */
  readonly endpoint: string;
  readonly serviceName: string;
  readonly serviceVersion?: string;
  /** More resource attributes beside `service.name` and `service.version`, such as a provider's project name. */
  readonly resourceAttributes?: OtlpExtraAttributes;
  readonly headers?: Readonly<Record<string, string>>;
  readonly allowInsecureLoopback?: boolean;
  readonly timeoutMs?: number;
  readonly maxBatchSize?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly fetch?: typeof globalThis.fetch;
}
export interface OtlpHttpJsonTraceExporterOptions extends OtlpHttpJsonSignalExporterOptions {
  /**
   * Derives a provider's own attributes from each checked span, such as the span kind a provider reads instead of
   * `gen_ai.operation.name`. A batch is refused whole when it throws or returns attributes outside the rules.
   */
  readonly spanAttributes?: (span: OtlpTraceSpan) => OtlpExtraAttributes | undefined;
}
export type OtlpHttpJsonMetricExporterOptions = OtlpHttpJsonSignalExporterOptions;

/**
 * The closed span-attribute catalog. Every value is a bounded stable identifier (`[A-Za-z0-9][A-Za-z0-9._:/-]*`, at
 * most 256 characters: ids, versions, statuses, codes) or a non-negative safe integer (micros, counts). There is no
 * free-form key and no text value, so prompts, inputs, outputs, arguments and error messages cannot be attached.
 */
export type OtlpSpanAttributeName =
  | 'mayura.workflow.definition.id' | 'mayura.workflow.definition.version' | 'mayura.workflow.definition.digest'
  | 'mayura.workflow.status' | 'mayura.workflow.events'
  | 'mayura.workflow.node.id' | 'mayura.workflow.node.kind' | 'mayura.workflow.step.status' | 'mayura.workflow.step.code'
  | 'mayura.workflow.receipt.execution' | 'mayura.workflow.child.run.id'
  | 'mayura.agent.id' | 'mayura.run.status' | 'mayura.model.call' | 'mayura.tool.id' | 'mayura.tool.version' | 'mayura.tool.status'
  | 'mayura.budget.spent_micros' | 'mayura.budget.reserved_micros' | 'mayura.budget.max_micros' | 'mayura.budget.step_cost_micros'
  | 'mayura.model.id' | 'mayura.cost.micros'
  // OpenTelemetry GenAI semantic conventions (development status): operation, provider, model, agent and tool.
  | 'gen_ai.operation.name' | 'gen_ai.provider.name' | 'gen_ai.request.model' | 'gen_ai.agent.id' | 'gen_ai.agent.name'
  | 'gen_ai.tool.name' | 'gen_ai.tool.call.id' | 'gen_ai.tool.type' | 'gen_ai.usage.input_tokens' | 'gen_ai.usage.output_tokens';
export type OtlpSpanAttributes = Readonly<Partial<Record<OtlpSpanAttributeName, string | number>>>;

/** Completed metadata-only span. IDs use the OTLP JSON hexadecimal representation. */
export interface OtlpTraceSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly status: 'unset' | 'ok' | 'error';
  readonly runId?: string;
  readonly attributes?: OtlpSpanAttributes;
}

/** Where a projected span tree hangs: an existing trace and the span that becomes its parent. */
export interface OtlpTraceParent { readonly traceId: string; readonly spanId: string }

export type OtlpMetricName = 'mayura.runs' | 'mayura.events' | 'mayura.model.calls' | 'mayura.tool.calls' | 'mayura.cost.micros' | 'mayura.export.dropped';
export interface OtlpMetricPoint {
  readonly name: OtlpMetricName;
  readonly kind: 'gauge' | 'sum';
  readonly value: number;
  readonly timeUnixNano: string;
  readonly startTimeUnixNano?: string;
  readonly monotonic?: boolean;
  readonly runId?: string;
  readonly profile?: 'ephemeral' | 'scheduled' | 'workflow-tree';
  readonly status?: 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'outcome_unknown';
}

export type OtlpSignalExporterMetrics = OtlpLogExporterMetrics;
export type OtlpSignalExporterSnapshot = OtlpLogExporterSnapshot;
export interface OtlpHttpJsonTraceExporter {
  readonly sink: (spans: readonly OtlpTraceSpan[], context: { readonly signal: AbortSignal }) => Promise<void>;
  inspect(): OtlpSignalExporterSnapshot;
  close(): void;
}
export interface OtlpHttpJsonMetricExporter {
  readonly sink: (points: readonly OtlpMetricPoint[], context: { readonly signal: AbortSignal }) => Promise<void>;
  inspect(): OtlpSignalExporterSnapshot;
  close(): void;
}
