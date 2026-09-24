import type { RunEvent } from '@mayura/core';
import { createOtlpHttpJsonLogExporter, type OtlpHttpJsonLogExporter, type OtlpLogExporterSnapshot } from '@mayura/exporter-otlp';

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
