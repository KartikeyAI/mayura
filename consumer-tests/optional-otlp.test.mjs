import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOtlpHttpJsonLogExporter } from '@mayura/exporter-otlp';

const root = await realpath(process.cwd());
for (const name of ['@mayura/core', '@mayura/exporter-otlp']) {
  const path = relative(root, await realpath(fileURLToPath(import.meta.resolve(name))));
  assert(!isAbsolute(path) && !path.startsWith('..'), 'Runtime import escaped the packed consumer installation.');
}
await assert.rejects(import('@mayura/exporter-otlp/src/index.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
await assert.rejects(import('@mayura/exporter-otlp/dist/index.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });

let calls = 0; let body;
const transport = async (_url, init) => {
  calls++; body = JSON.parse(init.body);
  assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
  return new Response('{"partialSuccess":{"rejectedLogRecords":"1"}}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const exporter = createOtlpHttpJsonLogExporter({
  endpoint: 'https://collector.example/v1/logs', serviceName: 'packed-consumer', headers: { Authorization: 'PRIVATE' }, fetch: transport,
});
assert.equal(calls, 0);
await exporter.sink([
  { runId: 'consumer-run', sequence: 1, timestamp: '2026-09-24T00:00:00.000Z', type: 'run.started', metadata: { profile: 'ephemeral' } },
  { runId: 'consumer-run', sequence: 2, timestamp: '2026-09-24T00:00:01.000Z', type: 'run.completed', metadata: { status: 'succeeded', spentMicros: 0, reservedMicros: 0, calls: 0 } },
], { signal: new AbortController().signal });
assert.equal(calls, 1); assert.equal(body.resourceLogs[0].scopeLogs[0].logRecords.length, 2);
assert(!JSON.stringify(body).includes('PRIVATE'));
assert.deepEqual(exporter.inspect().metrics, {
  batchesAttempted: 1, recordsAttempted: 2, recordsAccepted: 1, recordsDropped: 1, partialResponses: 1,
  failedRequests: 0, timedOutRequests: 0, cancelledRequests: 0,
  requestBytes: exporter.inspect().metrics.requestBytes, responseBytes: exporter.inspect().metrics.responseBytes,
});
assert(exporter.inspect().metrics.requestBytes > 0); assert(exporter.inspect().metrics.responseBytes > 0);
exporter.close(); assert.equal(exporter.inspect().state, 'closed');
console.log(JSON.stringify({ status: 'passed', explicitDestination: true, noConstructionNetwork: true, metadataOnly: true, partialAccounting: true }));
