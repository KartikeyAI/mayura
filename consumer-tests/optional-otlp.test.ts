import type { RunEvent } from '@mayura/core';
import { createOtlpHttpJsonLogExporter, createOtlpHttpJsonMetricExporter, createOtlpHttpJsonTraceExporter,
  type OtlpHttpJsonLogExporter, type OtlpLogExporterSnapshot, type OtlpMetricPoint, type OtlpTraceSpan } from '@mayura/exporter-otlp';

const transport: typeof globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
const exporter: OtlpHttpJsonLogExporter = createOtlpHttpJsonLogExporter({
  endpoint: 'https://collector.example/v1/logs', serviceName: 'packed-consumer', fetch: transport,
});
const metadata: RunEvent = { runId: 'consumer-run', sequence: 1, timestamp: '2026-09-24T00:00:00.000Z', type: 'run.started', metadata: { profile: 'ephemeral' } };
await exporter.sink([metadata], { signal: new AbortController().signal });
const snapshot: OtlpLogExporterSnapshot = exporter.inspect();
const accepted: number | string = snapshot.metrics.recordsAccepted;
// @ts-expect-error Export metrics preserve exact count representation.
const invalid: boolean = snapshot.metrics.recordsAccepted;
// @ts-expect-error OTLP destinations are explicit and mandatory.
createOtlpHttpJsonLogExporter({ serviceName: 'invalid' });
void accepted; void invalid;

const span: OtlpTraceSpan = { traceId: '1'.repeat(32), spanId: '2'.repeat(16), name: 'mayura.run', startTimeUnixNano: '1', endTimeUnixNano: '2', status: 'ok' };
const point: OtlpMetricPoint = { name: 'mayura.events', kind: 'sum', value: 1, startTimeUnixNano: '1', timeUnixNano: '2', monotonic: true };
await createOtlpHttpJsonTraceExporter({ endpoint: 'https://collector.example/v1/traces', serviceName: 'packed-consumer', fetch: transport }).sink([span], { signal: new AbortController().signal });
await createOtlpHttpJsonMetricExporter({ endpoint: 'https://collector.example/v1/metrics', serviceName: 'packed-consumer', fetch: transport }).sink([point], { signal: new AbortController().signal });
// @ts-expect-error Trace IDs must remain strings at the public boundary.
const badSpan: OtlpTraceSpan = { ...span, traceId: 1 };
void badSpan;
