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
