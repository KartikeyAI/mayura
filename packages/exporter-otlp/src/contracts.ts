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

export interface OtlpHttpJsonSignalExporterOptions {
  /** Complete signal-specific endpoint ending in `/v1/traces` or `/v1/metrics`. */
  readonly endpoint: string;
  readonly serviceName: string;
  readonly serviceVersion?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly allowInsecureLoopback?: boolean;
  readonly timeoutMs?: number;
  readonly maxBatchSize?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly fetch?: typeof globalThis.fetch;
}
export type OtlpHttpJsonTraceExporterOptions = OtlpHttpJsonSignalExporterOptions;
export type OtlpHttpJsonMetricExporterOptions = OtlpHttpJsonSignalExporterOptions;

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
}

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
