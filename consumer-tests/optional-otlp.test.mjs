import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOtlpHttpJsonLogExporter, createOtlpHttpJsonMetricExporter, createOtlpHttpJsonTraceExporter } from '@mayura/exporter-otlp';

const root = await realpath(process.cwd());
for (const name of ['@mayura/core', '@mayura/exporter-otlp']) {
  const path = relative(root, await realpath(fileURLToPath(import.meta.resolve(name))));
  assert(!isAbsolute(path) && !path.startsWith('..'), 'Runtime import escaped the packed consumer installation.');
}
await assert.rejects(import('@mayura/exporter-otlp/src/index.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
await assert.rejects(import('@mayura/exporter-otlp/dist/index.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });

let calls = 0; const bodies = new Map();
const transport = async (url, init) => {
  calls++; bodies.set(url, JSON.parse(init.body));
  assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
  const body = String(url).endsWith('/v1/logs') ? '{"partialSuccess":{"rejectedLogRecords":"1"}}' : '{}';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const exporter = createOtlpHttpJsonLogExporter({
  endpoint: 'https://collector.example/v1/logs', serviceName: 'packed-consumer', headers: { Authorization: 'PRIVATE' }, fetch: transport,
});
assert.equal(calls, 0);
await exporter.sink([
  { runId: 'consumer-run', sequence: 1, timestamp: '2026-09-24T00:00:00.000Z', type: 'run.started', metadata: { profile: 'ephemeral' } },
  { runId: 'consumer-run', sequence: 2, timestamp: '2026-09-24T00:00:01.000Z', type: 'run.completed', metadata: { status: 'succeeded', spentMicros: 0, reservedMicros: 0, calls: 0 } },
], { signal: new AbortController().signal });
assert.equal(calls, 1); assert.equal(bodies.get('https://collector.example/v1/logs').resourceLogs[0].scopeLogs[0].logRecords.length, 2);
assert(!JSON.stringify(bodies).includes('PRIVATE'));
assert.deepEqual(exporter.inspect().metrics, {
  batchesAttempted: 1, recordsAttempted: 2, recordsAccepted: 1, recordsDropped: 1, partialResponses: 1,
  failedRequests: 0, timedOutRequests: 0, cancelledRequests: 0,
  requestBytes: exporter.inspect().metrics.requestBytes, responseBytes: exporter.inspect().metrics.responseBytes,
});
assert(exporter.inspect().metrics.requestBytes > 0); assert(exporter.inspect().metrics.responseBytes > 0);
exporter.close(); assert.equal(exporter.inspect().state, 'closed');
const traces = createOtlpHttpJsonTraceExporter({ endpoint: 'https://collector.example/v1/traces', serviceName: 'packed-consumer', fetch: transport });
await traces.sink([{ traceId: '1'.repeat(32), spanId: '2'.repeat(16), name: 'mayura.run', startTimeUnixNano: '1', endTimeUnixNano: '2', status: 'ok' }], { signal: new AbortController().signal });
const points = createOtlpHttpJsonMetricExporter({ endpoint: 'https://collector.example/v1/metrics', serviceName: 'packed-consumer', fetch: transport });
await points.sink([{ name: 'mayura.events', kind: 'sum', value: 1, startTimeUnixNano: '1', timeUnixNano: '2', monotonic: true }], { signal: new AbortController().signal });
assert.equal(calls, 3); assert.equal(bodies.get('https://collector.example/v1/traces').resourceSpans[0].scopeSpans[0].spans.length, 1);
assert.equal(bodies.get('https://collector.example/v1/metrics').resourceMetrics[0].scopeMetrics[0].metrics.length, 1);
console.log(JSON.stringify({ status: 'passed', explicitDestination: true, noConstructionNetwork: true, metadataOnly: true, partialAccounting: true, traces: true, metrics: true }));
