import { describe, expect, it, vi } from 'vitest';
import { MayuraError, type RunEvent } from '@mayura/core';
import { createOtlpHttpJsonLogExporter, type OtlpHttpJsonLogExporterOptions } from '../src/index.js';

const timestamp = '2026-09-24T00:00:00.000Z';
function event(sequence = 1, type: RunEvent['type'] = 'run.started', metadata: RunEvent['metadata'] = { profile: 'ephemeral' }): RunEvent {
  return { runId: 'run-1', sequence, timestamp, type, metadata };
}
function response(body = '{}', init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers); headers.set('Content-Type', 'application/json');
  return new Response(body, { ...init, headers });
}
function options(fetch: typeof globalThis.fetch, extra: Partial<OtlpHttpJsonLogExporterOptions> = {}): OtlpHttpJsonLogExporterOptions {
  return { endpoint: 'https://collector.example/v1/logs', serviceName: 'orders-agent', fetch, ...extra };
}

describe('OTLP HTTP JSON log exporter', () => {
  it('performs no transport work until its explicit sink is called', () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const exporter = createOtlpHttpJsonLogExporter(options(fetch));
    expect(fetch).not.toHaveBeenCalled();
    expect(exporter.inspect()).toEqual({ state: 'active', inFlight: false, metrics: {
      batchesAttempted: 0, recordsAttempted: 0, recordsAccepted: 0, recordsDropped: 0, partialResponses: 0,
      failedRequests: 0, timedOutRequests: 0, cancelledRequests: 0, requestBytes: 0, responseBytes: 0,
    } });
  });

  it('emits a spec-shaped metadata-only request with fixed fetch controls', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    const exporter = createOtlpHttpJsonLogExporter(options(fetch, {
      serviceVersion: '1.2.3', headers: { Authorization: 'Bearer PRIVATE' },
    }));
    await exporter.sink([
      event(),
      event(2, 'tool.completed', { callId: 'call-1', toolId: 'lookup', status: 'failed', execution: 'failed', disclosure: 'withheld' }),
    ], { signal: new AbortController().signal });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://collector.example/v1/logs');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store' });
    expect(init?.headers).toEqual({ Authorization: 'Bearer PRIVATE', 'Content-Type': 'application/json' });
    const body = JSON.parse(init?.body as string);
    expect(body.resourceLogs[0].resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'orders-agent' } },
      { key: 'service.version', value: { stringValue: '1.2.3' } },
    ]);
    const records = body.resourceLogs[0].scopeLogs[0].logRecords;
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ timeUnixNano: '1790208000000000000', severityNumber: 9, severityText: 'INFO', body: { stringValue: 'run.started' } });
    expect(records[1]).toMatchObject({ severityNumber: 17, severityText: 'ERROR', body: { stringValue: 'tool.completed' } });
    expect(JSON.stringify(body)).not.toContain('PRIVATE');
    expect(exporter.inspect().metrics).toMatchObject({ batchesAttempted: 1, recordsAttempted: 2, recordsAccepted: 2, recordsDropped: 0 });
  });

  it('accepts empty success bodies and counts a bounded partial response exactly', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(response('{"partialSuccess":{"rejectedLogRecords":"1","errorMessage":"PRIVATE backend details"}}'));
    const exporter = createOtlpHttpJsonLogExporter(options(fetch));
    await exporter.sink([event()], { signal: new AbortController().signal });
    await exporter.sink([event(), event(2, 'events.gap', { from: 2, to: 2 })], { signal: new AbortController().signal });
    expect(exporter.inspect().metrics).toMatchObject({
      batchesAttempted: 2, recordsAttempted: 3, recordsAccepted: 2, recordsDropped: 1, partialResponses: 1,
      failedRequests: 0,
    });
    expect(JSON.stringify(exporter.inspect())).not.toContain('PRIVATE');
  });

  it('rejects invalid or excessive partial-success counts as a whole-batch failure', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response('{"partialSuccess":{"rejectedLogRecords":"2"}}'));
    const exporter = createOtlpHttpJsonLogExporter(options(fetch));
    await expect(exporter.sink([event()], { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'TOOL_FAILED' });
    expect(exporter.inspect().metrics).toMatchObject({ recordsAccepted: 0, recordsDropped: 1, failedRequests: 1 });
  });

  it.each([
    { endpoint: 'http://collector.example/v1/logs' },
    { endpoint: 'https://user:secret@collector.example/v1/logs' },
    { endpoint: 'https://collector.example/v1/logs?token=secret' },
    { endpoint: 'https://collector.example/v1/traces' },
    { headers: { 'Content-Type': 'text/plain' } },
    { headers: { Cookie: 'secret' } },
    { headers: { Authorization: 'secret\r\nInjected: true' } },
    { serviceName: 'not valid' },
    { maxBatchSize: 257 },
    { maxRequestBytes: 16_777_217 },
  ] satisfies readonly Partial<OtlpHttpJsonLogExporterOptions>[])('rejects unsafe configuration without transport access (%#)', override => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(() => createOtlpHttpJsonLogExporter(options(fetch, override))).toThrow(MayuraError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('permits only explicitly enabled literal-loopback HTTP development endpoints', () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(() => createOtlpHttpJsonLogExporter(options(fetch, { endpoint: 'http://127.0.0.1:4318/v1/logs', allowInsecureLoopback: true }))).not.toThrow();
    expect(() => createOtlpHttpJsonLogExporter(options(fetch, { endpoint: 'http://localhost:4318/v1/logs', allowInsecureLoopback: true }))).toThrow(MayuraError);
  });

  it('revalidates the privacy envelope and never sends unknown metadata or fields', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    const exporter = createOtlpHttpJsonLogExporter(options(fetch));
    const unknownMetadata = event(1, 'run.started', { profile: 'ephemeral', prompt: 'PRIVATE' });
    await expect(exporter.sink([unknownMetadata], { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(exporter.sink([{ ...event(), secret: 'PRIVATE' } as RunEvent], { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(exporter.sink([event(1, 'run.started', {})], { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetch).not.toHaveBeenCalled();
    expect(exporter.inspect().metrics).toMatchObject({ batchesAttempted: 3, recordsAttempted: 3, recordsDropped: 3 });
    expect(JSON.stringify(exporter.inspect())).not.toContain('PRIVATE');
  });

  it('fails before transport when the encoded request exceeds its explicit bound', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    const exporter = createOtlpHttpJsonLogExporter(options(fetch, { maxRequestBytes: 128 }));
    await expect(exporter.sink([event()], { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetch).not.toHaveBeenCalled();
    expect(exporter.inspect().metrics).toMatchObject({ recordsDropped: 1, requestBytes: 0 });
  });

  it('bounds response reads and never reflects rejected HTTP content', async () => {
    const oversized = new Response('PRIVATE'.repeat(100), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const rejected = new Response('PRIVATE backend token', { status: 503 });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(oversized).mockResolvedValueOnce(rejected);
    const exporter = createOtlpHttpJsonLogExporter(options(fetch, { maxResponseBytes: 64 }));
    for (let index = 0; index < 2; index++) {
      await expect(exporter.sink([event()], { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'TOOL_FAILED', message: 'The telemetry export failed. Inspect authorized local diagnostics.' });
    }
    expect(exporter.inspect().metrics).toMatchObject({ recordsDropped: 2, failedRequests: 2 });
    expect(JSON.stringify(exporter.inspect())).not.toContain('PRIVATE');
  });

  it('settles an uncooperative transport at the exporter deadline', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
      const exporter = createOtlpHttpJsonLogExporter(options(fetch, { timeoutMs: 25 }));
      const pending = exporter.sink([event()], { signal: new AbortController().signal });
      const rejected = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      expect(exporter.inspect()).toMatchObject({ inFlight: false, metrics: { recordsDropped: 1, timedOutRequests: 1, failedRequests: 0 } });
    } finally { vi.useRealTimers(); }
  });

  it('does not call transport for a pre-cancelled batch and counts cancellation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response()); const controller = new AbortController(); controller.abort();
    const exporter = createOtlpHttpJsonLogExporter(options(fetch));
    await expect(exporter.sink([event()], { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fetch).not.toHaveBeenCalled();
    expect(exporter.inspect().metrics).toMatchObject({ recordsDropped: 1, cancelledRequests: 1 });
  });

  it('enforces single-flight delivery and close aborts active work permanently', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
    const exporter = createOtlpHttpJsonLogExporter(options(fetch)); const controller = new AbortController();
    const first = exporter.sink([event()], { signal: controller.signal });
    await expect(exporter.sink([event()], { signal: controller.signal })).rejects.toMatchObject({ code: 'CONFLICT' });
    exporter.close();
    await expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(exporter.inspect()).toMatchObject({ state: 'closed', inFlight: false, metrics: { recordsDropped: 1, cancelledRequests: 1 } });
    await expect(exporter.sink([event()], { signal: controller.signal })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('does not double-count accepted records when inspection snapshots are retained', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    const exporter = createOtlpHttpJsonLogExporter(options(fetch)); const before = exporter.inspect();
    await exporter.sink([event()], { signal: new AbortController().signal }); const after = exporter.inspect();
    expect(before.metrics.recordsAccepted).toBe(0); expect(after.metrics.recordsAccepted).toBe(1);
    expect(Object.isFrozen(after)).toBe(true); expect(Object.isFrozen(after.metrics)).toBe(true);
  });
});
