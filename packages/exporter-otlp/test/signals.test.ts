import { describe, expect, it, vi } from 'vitest';
import { MayuraError } from '@mayura/core';
import {
  createOtlpHttpJsonMetricExporter, createOtlpHttpJsonTraceExporter,
  type OtlpHttpJsonMetricExporterOptions, type OtlpHttpJsonTraceExporterOptions, type OtlpMetricPoint, type OtlpTraceSpan,
} from '../src/index.js';

const trace: OtlpTraceSpan = { traceId: '1'.repeat(32), spanId: '2'.repeat(16), name: 'mayura.run', startTimeUnixNano: '1000000', endTimeUnixNano: '2000000', status: 'ok', runId: 'run-1' };
const gauge: OtlpMetricPoint = { name: 'mayura.runs', kind: 'gauge', value: 1, timeUnixNano: '2000000', profile: 'scheduled', status: 'running' };
const sum: OtlpMetricPoint = { name: 'mayura.tool.calls', kind: 'sum', value: 4, startTimeUnixNano: '1000000', timeUnixNano: '2000000', monotonic: true, runId: 'run-1' };
const response = (body = '{}', status = 200): Response => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
const traceOptions = (fetch: typeof globalThis.fetch, extra: Partial<OtlpHttpJsonTraceExporterOptions> = {}): OtlpHttpJsonTraceExporterOptions => ({ endpoint: 'https://collector.example/v1/traces', serviceName: 'agent', fetch, ...extra });
const metricOptions = (fetch: typeof globalThis.fetch, extra: Partial<OtlpHttpJsonMetricExporterOptions> = {}): OtlpHttpJsonMetricExporterOptions => ({ endpoint: 'https://collector.example/v1/metrics', serviceName: 'agent', fetch, ...extra });

describe('OTLP HTTP JSON trace and metric exporters', () => {
  it('does no construction network work and emits strict completed spans', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response()); const exporter = createOtlpHttpJsonTraceExporter(traceOptions(fetch, { serviceVersion: '1.0.0' }));
    expect(fetch).not.toHaveBeenCalled(); await exporter.sink([trace], { signal: new AbortController().signal });
    const [url, init] = fetch.mock.calls[0]!; expect(url).toBe('https://collector.example/v1/traces');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store' });
    const body = JSON.parse(init?.body as string); const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span).toMatchObject({ traceId: trace.traceId, spanId: trace.spanId, kind: 1, status: { code: 1 }, attributes: [{ key: 'mayura.run.id', value: { stringValue: 'run-1' } }] });
    expect(body.resourceSpans[0].resource.attributes).toMatchObject([{ key: 'service.name' }, { key: 'service.version' }]);
    expect(exporter.inspect().metrics).toMatchObject({ recordsAttempted: 1, recordsAccepted: 1, recordsDropped: 0 });
  });

  it('encodes catalog span attributes in key order as string and integer values', async () => {
    let body: any; const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => { body = JSON.parse(init?.body as string); return response(); });
    const exporter = createOtlpHttpJsonTraceExporter(traceOptions(fetch));
    await exporter.sink([{ ...trace, attributes: { 'mayura.workflow.node.id': 'plan', 'mayura.budget.spent_micros': 12, 'mayura.workflow.definition.id': 'research.run' } }], { signal: new AbortController().signal });
    expect(body.resourceSpans[0].scopeSpans[0].spans[0].attributes).toEqual([
      { key: 'mayura.run.id', value: { stringValue: 'run-1' } }, { key: 'mayura.budget.spent_micros', value: { intValue: '12' } },
      { key: 'mayura.workflow.definition.id', value: { stringValue: 'research.run' } }, { key: 'mayura.workflow.node.id', value: { stringValue: 'plan' } }]);
  });

  it.each([
    { 'mayura.prompt': 'plan' }, { 'mayura.workflow.node.id': 'free text is content' }, { 'mayura.workflow.node.id': '' },
    { 'mayura.budget.spent_micros': -1 }, { 'mayura.budget.spent_micros': 1.5 }, { 'mayura.workflow.node.id': { nested: 'PRIVATE' } }, { 'mayura.tool.id': true },
  ])('rejects attributes outside the closed catalog or its value rules before transport (%#)', async attributes => {
    const fetch = vi.fn<typeof globalThis.fetch>(); const exporter = createOtlpHttpJsonTraceExporter(traceOptions(fetch));
    await expect(exporter.sink([{ ...trace, attributes } as unknown as OtlpTraceSpan], { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('adds a provider\'s span attributes after the catalog\'s, and its resource attributes to traces and metrics', async () => {
    const bodies: any[] = []; const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => { bodies.push(JSON.parse(init?.body as string)); return response(); });
    const seen: OtlpTraceSpan[] = [];
    const exporter = createOtlpHttpJsonTraceExporter(traceOptions(fetch, { resourceAttributes: { 'openinference.project.name': 'support' },
      spanAttributes: span => { seen.push(span); return span.attributes?.['gen_ai.operation.name'] === 'chat' ? { 'openinference.span.kind': 'LLM', 'llm.token_count.prompt': 5 } : undefined; } }));
    await exporter.sink([{ ...trace, attributes: { 'gen_ai.operation.name': 'chat' } }, { ...trace, spanId: '3'.repeat(16) }], { signal: new AbortController().signal });
    const [chat, plain] = bodies[0].resourceSpans[0].scopeSpans[0].spans;
    expect(chat.attributes).toEqual([{ key: 'mayura.run.id', value: { stringValue: 'run-1' } }, { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
      { key: 'llm.token_count.prompt', value: { intValue: '5' } }, { key: 'openinference.span.kind', value: { stringValue: 'LLM' } }]);
    expect(plain.attributes).toEqual([{ key: 'mayura.run.id', value: { stringValue: 'run-1' } }]);
    expect(Object.isFrozen(seen[0]) && Object.isFrozen(seen[0]!.attributes)).toBe(true);
    expect(bodies[0].resourceSpans[0].resource.attributes).toEqual([{ key: 'service.name', value: { stringValue: 'agent' } }, { key: 'openinference.project.name', value: { stringValue: 'support' } }]);
    await createOtlpHttpJsonMetricExporter(metricOptions(fetch, { resourceAttributes: { 'posthog.distinct_id': 'user-1' } })).sink([gauge], { signal: new AbortController().signal });
    expect(bodies[1].resourceMetrics[0].resource.attributes).toContainEqual({ key: 'posthog.distinct_id', value: { stringValue: 'user-1' } });
  });

  it.each([
    { 'mayura.extra': 'x' }, { 'service.instance.id': 'x' }, { 'gen_ai.operation.name': 'chat' }, { 'Sentry.op': 'x' }, { sentry: 'x' }, { 'sentry.op': 'free text' },
    { 'sentry.op': -1 }, { 'sentry.op': { nested: 'x' } }, Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`vendor.key_${index}`, 1])), ['sentry.op'],
  ])('refuses the whole batch when a provider\'s span attributes break the rules (%#)', async derived => {
    const fetch = vi.fn<typeof globalThis.fetch>(); const exporter = createOtlpHttpJsonTraceExporter(traceOptions(fetch, { spanAttributes: () => derived as never }));
    await expect(exporter.sink([trace], { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetch).not.toHaveBeenCalled(); expect(exporter.inspect().metrics).toMatchObject({ recordsDropped: 1 });
  });

  it('refuses a batch when the provider\'s mapping throws, without its text, and bad attribute options at construction', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const exporter = createOtlpHttpJsonTraceExporter(traceOptions(fetch, { spanAttributes: () => { throw new MayuraError('INVALID_INPUT', 'SECRET mapping failure'); } }));
    const caught = await exporter.sink([trace], { signal: new AbortController().signal }).catch((error: unknown) => error);
    expect(caught).toMatchObject({ code: 'INVALID_INPUT' }); expect(`${String(caught)} ${JSON.stringify(caught)}`).not.toContain('SECRET');
    for (const extra of [{ resourceAttributes: { 'service.name': 'other' } }, { resourceAttributes: { 'project.name': 'has spaces' } }, { spanAttributes: 'sentry.op' as never }]) {
      expect(() => createOtlpHttpJsonTraceExporter(traceOptions(fetch, extra))).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    }
    expect(() => createOtlpHttpJsonMetricExporter({ ...metricOptions(fetch), spanAttributes: () => undefined } as never)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('takes a provider\'s exact endpoint only with standardPath: false, still HTTPS and explicit', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response());
    const endpoint = 'https://ingest.example/i/v0/ai/otel';
    expect(() => createOtlpHttpJsonTraceExporter(traceOptions(fetch, { endpoint }))).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    await createOtlpHttpJsonTraceExporter(traceOptions(fetch, { endpoint, standardPath: false })).sink([trace], { signal: new AbortController().signal });
    expect(fetch.mock.calls[0]![0]).toBe(endpoint);
    for (const refused of ['http://ingest.example/i/v0/ai/otel', 'https://user:pass@ingest.example/otel', 'https://ingest.example/otel?token=1', 'https://ingest.example/otel#x']) {
      expect(() => createOtlpHttpJsonTraceExporter(traceOptions(fetch, { endpoint: refused, standardPath: false }))).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    }
    expect(() => createOtlpHttpJsonTraceExporter(traceOptions(fetch, { standardPath: 'no' as never }))).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it('groups compatible metric points and encodes gauge and cumulative sum data', async () => {
    let body: any; const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => { body = JSON.parse(init?.body as string); return response(); });
    const exporter = createOtlpHttpJsonMetricExporter(metricOptions(fetch));
    await exporter.sink([gauge, { ...gauge, value: 2, runId: 'run-2' }, sum], { signal: new AbortController().signal });
    const values = body.resourceMetrics[0].scopeMetrics[0].metrics;
    expect(values).toHaveLength(2); expect(values[0].gauge.dataPoints).toHaveLength(2);
    expect(values[1]).toMatchObject({ name: 'mayura.tool.calls', sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: [{ asDouble: 4 }] } });
    expect(exporter.inspect().metrics.recordsAccepted).toBe(3);
  });

  it('accounts for trace and metric partial success without retrying', async () => {
    const traceFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response('{"partialSuccess":{"rejectedSpans":"1","errorMessage":"PRIVATE"}}'));
    const metricFetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response('{"partialSuccess":{"rejectedDataPoints":"1"}}'));
    const traces = createOtlpHttpJsonTraceExporter(traceOptions(traceFetch)); const points = createOtlpHttpJsonMetricExporter(metricOptions(metricFetch));
    await traces.sink([trace, { ...trace, spanId: '3'.repeat(16) }], { signal: new AbortController().signal });
    await points.sink([gauge, sum], { signal: new AbortController().signal });
    for (const exporter of [traces, points]) expect(exporter.inspect().metrics).toMatchObject({ recordsAccepted: 1, recordsDropped: 1, partialResponses: 1 });
    expect(JSON.stringify(traces.inspect())).not.toContain('PRIVATE'); expect(traceFetch).toHaveBeenCalledOnce(); expect(metricFetch).toHaveBeenCalledOnce();
  });

  it.each([
    { ...trace, traceId: '0'.repeat(32) }, { ...trace, spanId: 'x'.repeat(16) }, { ...trace, parentSpanId: trace.spanId },
    { ...trace, endTimeUnixNano: '1' }, { ...trace, startTimeUnixNano: '18446744073709551616' }, { ...trace, secret: 'PRIVATE' },
  ])('rejects invalid trace metadata before transport (%#)', async invalid => {
    const fetch = vi.fn<typeof globalThis.fetch>(); const exporter = createOtlpHttpJsonTraceExporter(traceOptions(fetch));
    await expect(exporter.sink([invalid as OtlpTraceSpan], { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'INVALID_INPUT' }); expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { ...gauge, value: -1 }, { ...gauge, name: 'custom.secret' }, { ...gauge, startTimeUnixNano: '1' },
    { ...sum, monotonic: undefined }, { ...sum, timeUnixNano: '1' }, { ...sum, secret: 'PRIVATE' },
  ])('rejects invalid metric metadata before transport (%#)', async invalid => {
    const fetch = vi.fn<typeof globalThis.fetch>(); const exporter = createOtlpHttpJsonMetricExporter(metricOptions(fetch));
    await expect(exporter.sink([invalid as OtlpMetricPoint], { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'INVALID_INPUT' }); expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects aggregation identity changes in one metric batch', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(); const exporter = createOtlpHttpJsonMetricExporter(metricOptions(fetch));
    await expect(exporter.sink([sum, { ...sum, monotonic: false }], { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'INVALID_INPUT' }); expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['trace', { endpoint: 'https://collector.example/v1/metrics' }], ['trace', { endpoint: 'http://collector.example/v1/traces' }],
    ['metric', { endpoint: 'https://user:secret@collector.example/v1/metrics' }], ['metric', { headers: { Cookie: 'PRIVATE' } }],
  ] as const)('rejects unsafe %s configuration without network access', (kind, override) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const create = () => kind === 'trace' ? createOtlpHttpJsonTraceExporter(traceOptions(fetch, override)) : createOtlpHttpJsonMetricExporter(metricOptions(fetch, override));
    expect(create).toThrow(MayuraError); expect(fetch).not.toHaveBeenCalled();
  });

  it('bounds partial counts and hostile responses', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response('{"partialSuccess":{"rejectedSpans":"2"}}')).mockResolvedValueOnce(response('PRIVATE', 503));
    const exporter = createOtlpHttpJsonTraceExporter(traceOptions(fetch));
    for (let index = 0; index < 2; index++) await expect(exporter.sink([trace], { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'TOOL_FAILED' });
    expect(exporter.inspect().metrics).toMatchObject({ recordsDropped: 2, failedRequests: 2 });
  });

  it('bounds streamed response bytes without reflecting collector content', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(`{"partialSuccess":{"errorMessage":"${'PRIVATE'.repeat(30)}"}}`));
    const exporter = createOtlpHttpJsonMetricExporter(metricOptions(fetch, { maxResponseBytes: 64 }));
    const error: unknown = await exporter.sink([gauge], { signal: new AbortController().signal }).catch(caught => caught);
    expect(error).toMatchObject({ code: 'TOOL_FAILED' }); expect(JSON.stringify(error)).not.toContain('PRIVATE');
    expect(exporter.inspect().metrics).toMatchObject({ recordsDropped: 1, failedRequests: 1 });
  });

  it('settles an uncooperative trace transport at the configured deadline', async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => undefined));
      const exporter = createOtlpHttpJsonTraceExporter(traceOptions(fetch, { timeoutMs: 25 }));
      const pending = expect(exporter.sink([trace], { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(25); await pending;
      expect(exporter.inspect().metrics).toMatchObject({ recordsDropped: 1, timedOutRequests: 1 });
    } finally { vi.useRealTimers(); }
  });

  it('supports cancellation, single flight and permanent close', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => undefined)); const exporter = createOtlpHttpJsonTraceExporter(traceOptions(fetch));
    const controller = new AbortController(); const active = exporter.sink([trace], { signal: controller.signal });
    await expect(exporter.sink([trace], { signal: controller.signal })).rejects.toMatchObject({ code: 'CONFLICT' });
    exporter.close(); await expect(active).rejects.toMatchObject({ code: 'CANCELLED' }); expect(exporter.inspect().state).toBe('closed');
  });
});
