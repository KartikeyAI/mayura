import { assertPositiveInteger, jsonValue, MayuraError, type JsonObject, type JsonValue } from '@mayura/core';
import type {
  ExactCount, OtlpHttpJsonMetricExporter, OtlpHttpJsonMetricExporterOptions, OtlpHttpJsonSignalExporterOptions,
  OtlpHttpJsonTraceExporter, OtlpHttpJsonTraceExporterOptions, OtlpLogExporterMetrics, OtlpMetricPoint,
  OtlpSignalExporterSnapshot, OtlpSpanAttributeName, OtlpTraceSpan,
} from './contracts.js';

const defaults = Object.freeze({ timeoutMs: 5_000, maxBatchSize: 256, maxRequestBytes: 1_048_576, maxResponseBytes: 65_536 });
const metrics = ['batchesAttempted', 'recordsAttempted', 'recordsAccepted', 'recordsDropped', 'partialResponses', 'failedRequests', 'timedOutRequests', 'cancelledRequests', 'requestBytes', 'responseBytes'] as const;
type Metric = typeof metrics[number];
const stablePattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const headerPattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const blockedHeaders = new Set(['connection', 'content-length', 'content-type', 'cookie', 'host', 'set-cookie', 'transfer-encoding']);
const decimal = /^(?:0|[1-9]\d{0,19})$/;
const traceId = /^(?!0{32}$)[a-f0-9]{32}$/;
const spanId = /^(?!0{16}$)[a-f0-9]{16}$/;
const uint64Max = 18_446_744_073_709_551_615n;
const metricNames = new Set(['mayura.runs', 'mayura.events', 'mayura.model.calls', 'mayura.tool.calls', 'mayura.cost.micros', 'mayura.export.dropped']);
// Keep in sync with OtlpSpanAttributeName; a key outside this set rejects the whole batch before transport.
const spanAttributeNames: ReadonlySet<string> = new Set<OtlpSpanAttributeName>([
  'mayura.workflow.definition.id', 'mayura.workflow.definition.version', 'mayura.workflow.definition.digest', 'mayura.workflow.status', 'mayura.workflow.events',
  'mayura.workflow.node.id', 'mayura.workflow.node.kind', 'mayura.workflow.step.status', 'mayura.workflow.step.code', 'mayura.workflow.receipt.execution',
  'mayura.workflow.child.run.id', 'mayura.agent.id', 'mayura.run.status', 'mayura.model.call', 'mayura.tool.id', 'mayura.tool.version', 'mayura.tool.status',
  'mayura.budget.spent_micros', 'mayura.budget.reserved_micros', 'mayura.budget.max_micros', 'mayura.budget.step_cost_micros', 'mayura.model.id', 'mayura.cost.micros',
  'gen_ai.operation.name', 'gen_ai.provider.name', 'gen_ai.request.model', 'gen_ai.agent.id', 'gen_ai.agent.name', 'gen_ai.tool.name', 'gen_ai.tool.call.id', 'gen_ai.tool.type']);

const failed = (): never => { throw new MayuraError('TOOL_FAILED', 'The telemetry export failed. Inspect authorized local diagnostics.'); };
function exact(value: bigint): ExactCount { return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString(); }
function object(value: JsonValue | undefined): JsonObject { if (!value || typeof value !== 'object' || Array.isArray(value)) return failed(); return value; }
function stable(value: unknown): string {
  if (typeof value !== 'string' || !stablePattern.test(value)) throw new MayuraError('INVALID_CONFIG', 'Exporter names must be bounded stable identifiers.');
  return value;
}
function destination(value: unknown, signal: 'traces' | 'metrics', allowLoopback: boolean): string {
  try {
    if (typeof value !== 'string' || value.length > 2_048) throw new Error(); const url = new URL(value);
    const loopback = ['127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith(`/v1/${signal}`)) throw new Error();
    return url.href;
  } catch { throw new MayuraError('INVALID_CONFIG', `OTLP ${signal} require an explicit HTTPS endpoint ending in /v1/${signal}.`); }
}
function fixedHeaders(value: OtlpHttpJsonSignalExporterOptions['headers']): Readonly<Record<string, string>> {
  try {
    if (value === undefined) return Object.freeze({ 'Content-Type': 'application/json' });
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(value); const result: Record<string, string> = { 'Content-Type': 'application/json' }; const seen = new Set(['content-type']);
    if (Object.getOwnPropertySymbols(value).length || Object.keys(descriptors).length > 32) throw new Error();
    for (const [key, descriptor] of Object.entries(descriptors)) {
      const normalized = key.toLowerCase();
      if (!descriptor.enumerable || !('value' in descriptor) || !headerPattern.test(key) || blockedHeaders.has(normalized) || seen.has(normalized)
        || typeof descriptor.value !== 'string' || descriptor.value.length > 4_096 || /[\r\n\0]/.test(descriptor.value)) throw new Error();
      seen.add(normalized); result[key] = descriptor.value;
    }
    return Object.freeze(result);
  } catch { throw new MayuraError('INVALID_CONFIG', 'Exporter headers must be bounded explicit HTTP fields.'); }
}
function attributes(values: Readonly<Record<string, string | undefined>>): JsonObject[] {
  return Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined).map(([key, value]) => ({ key, value: { stringValue: value } }));
}
function nano(value: unknown, field: string): string {
  if (typeof value !== 'string' || !decimal.test(value) || BigInt(value) > uint64Max) throw new MayuraError('INVALID_INPUT', `${field} must be an unsigned 64-bit decimal nanosecond timestamp.`);
  return value;
}
/** Catalog attributes, validated and encoded in key order so one span always encodes identically. */
function spanAttributes(value: JsonValue | undefined): JsonObject[] {
  if (value === undefined) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MayuraError('INVALID_INPUT', 'Trace span metadata is invalid.');
  return Object.keys(value).sort().map(key => {
    const item = value[key];
    if (!spanAttributeNames.has(key) || !((typeof item === 'string' && stablePattern.test(item)) || (typeof item === 'number' && Number.isSafeInteger(item) && item >= 0))) {
      throw new MayuraError('INVALID_INPUT', 'Trace span metadata is invalid.');
    }
    return { key, value: typeof item === 'string' ? { stringValue: item } : { intValue: String(item) } };
  });
}
function span(value: unknown): JsonObject {
  const raw = object(jsonValue(value, { maxBytes: 8_192, maxDepth: 4, maxNodes: 96 }));
  if (Object.keys(raw).some(key => !['traceId', 'spanId', 'parentSpanId', 'name', 'startTimeUnixNano', 'endTimeUnixNano', 'status', 'runId', 'attributes'].includes(key))
    || typeof raw['traceId'] !== 'string' || !traceId.test(raw['traceId']) || typeof raw['spanId'] !== 'string' || !spanId.test(raw['spanId'])
    || (raw['parentSpanId'] !== undefined && (typeof raw['parentSpanId'] !== 'string' || !spanId.test(raw['parentSpanId']) || raw['parentSpanId'] === raw['spanId']))
    || typeof raw['name'] !== 'string' || !stablePattern.test(raw['name']) || !['unset', 'ok', 'error'].includes(raw['status'] as string)
    || (raw['runId'] !== undefined && (typeof raw['runId'] !== 'string' || !stablePattern.test(raw['runId'])))) throw new MayuraError('INVALID_INPUT', 'Trace span metadata is invalid.');
  const start = nano(raw['startTimeUnixNano'], 'Span start'); const end = nano(raw['endTimeUnixNano'], 'Span end');
  if (BigInt(end) < BigInt(start)) throw new MayuraError('INVALID_INPUT', 'Span end must not precede its start.');
  const status = raw['status'] === 'ok' ? 1 : raw['status'] === 'error' ? 2 : 0;
  return { traceId: raw['traceId'], spanId: raw['spanId'], ...(raw['parentSpanId'] === undefined ? {} : { parentSpanId: raw['parentSpanId'] }), name: raw['name'], kind: 1,
    startTimeUnixNano: start, endTimeUnixNano: end, status: { code: status },
    attributes: [...attributes({ 'mayura.run.id': raw['runId'] as string | undefined }), ...spanAttributes(raw['attributes'])] };
}
function point(value: unknown): { readonly name: string; readonly kind: 'gauge'; readonly data: JsonObject }
  | { readonly name: string; readonly kind: 'sum'; readonly data: JsonObject; readonly monotonic: boolean } {
  const raw = object(jsonValue(value, { maxBytes: 4_096, maxDepth: 4, maxNodes: 32 }));
  if (Object.keys(raw).some(key => !['name', 'kind', 'value', 'timeUnixNano', 'startTimeUnixNano', 'monotonic', 'runId', 'profile', 'status'].includes(key))
    || typeof raw['name'] !== 'string' || !metricNames.has(raw['name']) || !['gauge', 'sum'].includes(raw['kind'] as string)
    || typeof raw['value'] !== 'number' || !Number.isFinite(raw['value']) || raw['value'] < 0
    || (raw['runId'] !== undefined && (typeof raw['runId'] !== 'string' || !stablePattern.test(raw['runId'])))
    || (raw['profile'] !== undefined && !['ephemeral', 'scheduled', 'workflow-tree'].includes(raw['profile'] as string))
    || (raw['status'] !== undefined && !['running', 'succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown'].includes(raw['status'] as string))) throw new MayuraError('INVALID_INPUT', 'Metric point metadata is invalid.');
  const time = nano(raw['timeUnixNano'], 'Metric time'); const kind = raw['kind'] as 'gauge' | 'sum';
  if (kind === 'gauge' && (raw['startTimeUnixNano'] !== undefined || raw['monotonic'] !== undefined)) throw new MayuraError('INVALID_INPUT', 'Gauge points cannot declare sum fields.');
  if (kind === 'sum' && (raw['startTimeUnixNano'] === undefined || typeof raw['monotonic'] !== 'boolean')) throw new MayuraError('INVALID_INPUT', 'Sum points require start time and monotonicity.');
  const start = raw['startTimeUnixNano'] === undefined ? undefined : nano(raw['startTimeUnixNano'], 'Metric start');
  if (start !== undefined && BigInt(time) < BigInt(start)) throw new MayuraError('INVALID_INPUT', 'Metric time must not precede its start.');
  const data = { attributes: attributes({ 'mayura.run.id': raw['runId'] as string | undefined, 'mayura.profile': raw['profile'] as string | undefined, 'mayura.status': raw['status'] as string | undefined }),
    ...(start === undefined ? {} : { startTimeUnixNano: start }), timeUnixNano: time, asDouble: raw['value'] };
  return kind === 'gauge' ? { name: raw['name'], kind, data } : { name: raw['name'], kind, data, monotonic: raw['monotonic'] as boolean };
}
function resource(serviceName: string, serviceVersion?: string): JsonObject { return { attributes: attributes({ 'service.name': serviceName, 'service.version': serviceVersion }) }; }
function traceRequest(records: readonly unknown[], serviceName: string, serviceVersion?: string): JsonObject {
  return { resourceSpans: [{ resource: resource(serviceName, serviceVersion), scopeSpans: [{ scope: { name: '@mayura/observability', version: '1.0.0' }, spans: records.map(span) }] }] };
}
function metricRequest(records: readonly unknown[], serviceName: string, serviceVersion?: string): JsonObject {
  const grouped = new Map<string, ReturnType<typeof point>[]>();
  for (const item of records.map(point)) {
    const existing = grouped.get(item.name) ?? [];
    if (existing.some(other => other.kind !== item.kind || (other.kind === 'sum' && item.kind === 'sum' && other.monotonic !== item.monotonic))) throw new MayuraError('INVALID_INPUT', 'One metric identity cannot change aggregation within a batch.');
    existing.push(item); grouped.set(item.name, existing);
  }
  const encoded = [...grouped.values()].map(items => { const first = items[0]!; return { name: first.name,
    ...(first.kind === 'gauge' ? { gauge: { dataPoints: items.map(item => item.data) } }
      : { sum: { dataPoints: items.map(item => item.data), aggregationTemporality: 2, isMonotonic: first.monotonic } }) }; });
  return { resourceMetrics: [{ resource: resource(serviceName, serviceVersion), scopeMetrics: [{ scope: { name: '@mayura/observability', version: '1.0.0' }, metrics: encoded }] }] };
}
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => undefined); throw signal.reason; } let listener: (() => void) | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { listener = () => reject(signal.reason); signal.addEventListener('abort', listener, { once: true }); if (signal.aborted) listener(); })]); }
  finally { if (listener) signal.removeEventListener('abort', listener); }
}
async function responsePayload(response: Response, limit: number, signal: AbortSignal, charge: (bytes: number) => void): Promise<JsonObject> {
  if (response.status !== 200 || response.redirected) { void response.body?.cancel().catch(() => undefined); return failed(); }
  if (!response.body) return {}; const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) { void response.body.cancel().catch(() => undefined); return failed(); }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const item = await abortable(reader.read(), signal); if (item.done) break; size += item.value.byteLength; charge(item.value.byteLength); if (size > limit) return failed(); chunks.push(item.value); }
    if (!size) return {}; if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) return failed();
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return object(jsonValue(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), { maxBytes: limit, maxDepth: 8, maxNodes: 1_024 }));
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
function rejected(payload: JsonObject, field: 'rejectedSpans' | 'rejectedDataPoints', sent: number): number {
  if (payload['partialSuccess'] === undefined) return 0; const value = object(payload['partialSuccess'])[field]; if (value === undefined) return 0;
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !/^\d{1,20}$/.test(text) || BigInt(text) > BigInt(sent)) return failed(); return Number(text);
}

function createSignalExporter<T>(signalName: 'traces' | 'metrics', options: OtlpHttpJsonSignalExporterOptions,
  encode: (records: readonly T[], serviceName: string, serviceVersion?: string) => JsonObject, rejectedField: 'rejectedSpans' | 'rejectedDataPoints') {
  let config: typeof defaults; let endpoint: string; let serviceName: string; let serviceVersion: string | undefined; let headers: Readonly<Record<string, string>>; let transport: typeof globalThis.fetch;
  try {
    const allow = options.allowInsecureLoopback ?? false; if (typeof allow !== 'boolean') throw new Error();
    config = Object.freeze(Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, options[key as keyof typeof defaults] ?? fallback]))) as typeof defaults;
    for (const [key, value] of Object.entries(config)) assertPositiveInteger(value, key);
    if (config.timeoutMs > 2_147_483_647 || config.maxBatchSize > 256 || config.maxRequestBytes > 16_777_216 || config.maxResponseBytes > 1_048_576) throw new Error();
    endpoint = destination(options.endpoint, signalName, allow); serviceName = stable(options.serviceName); serviceVersion = options.serviceVersion === undefined ? undefined : stable(options.serviceVersion);
    headers = fixedHeaders(options.headers); transport = options.fetch ?? globalThis.fetch; if (typeof transport !== 'function') throw new Error();
  } catch (error) { if (error instanceof MayuraError) throw error; throw new MayuraError('INVALID_CONFIG', 'OTLP exporter configuration must contain supported explicit bounds and transport.'); }
  const counts = Object.fromEntries(metrics.map(key => [key, 0n])) as Record<Metric, bigint>; const count = (key: Metric, amount = 1): void => { counts[key] += BigInt(amount); };
  let closed = false; let inFlight = false; let active: AbortController | undefined;
  const inspect = (): OtlpSignalExporterSnapshot => Object.freeze({ state: closed ? 'closed' : 'active', inFlight,
    metrics: Object.freeze(Object.fromEntries(metrics.map(key => [key, exact(counts[key])]))) as unknown as OtlpLogExporterMetrics });
  const sink = async (records: readonly T[], context: { readonly signal: AbortSignal }): Promise<void> => {
    if (closed || inFlight) throw new MayuraError('CONFLICT', closed ? 'The telemetry exporter is closed.' : 'The telemetry exporter already has an active request.');
    if (!Array.isArray(records) || !records.length || records.length > config.maxBatchSize || !(context.signal instanceof AbortSignal)) { if (Array.isArray(records)) count('recordsDropped', records.length); throw new MayuraError('INVALID_INPUT', 'Telemetry batches require admitted records, a signal and supported bounds.'); }
    count('batchesAttempted'); count('recordsAttempted', records.length); let body: string;
    try { body = JSON.stringify(jsonValue(encode(records, serviceName, serviceVersion), { maxBytes: config.maxRequestBytes, maxDepth: 16, maxNodes: 32_768 })); const bytes = new TextEncoder().encode(body).byteLength; if (bytes > config.maxRequestBytes) throw new Error(); count('requestBytes', bytes); }
    catch (error) { count('recordsDropped', records.length); if (error instanceof MayuraError && error.code === 'INVALID_INPUT') throw error; throw new MayuraError('INVALID_INPUT', 'Telemetry batches require admitted records within the configured request bound.'); }
    const controller = new AbortController(); active = controller; inFlight = true; let timedOut = false; const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeoutMs);
    const relay = (): void => controller.abort(); context.signal.addEventListener('abort', relay, { once: true }); if (context.signal.aborted) relay();
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      const response = await abortable(Promise.resolve(transport(endpoint, { method: 'POST', headers, body, signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store' })), controller.signal);
      const payload = await responsePayload(response, config.maxResponseBytes, controller.signal, bytes => count('responseBytes', bytes)); const dropped = rejected(payload, rejectedField, records.length);
      count('recordsAccepted', records.length - dropped); if (dropped) { count('recordsDropped', dropped); count('partialResponses'); }
    } catch { count('recordsDropped', records.length); if (timedOut) { count('timedOutRequests'); throw new MayuraError('TIMEOUT', 'The telemetry export timed out.'); } if (context.signal.aborted || closed) { count('cancelledRequests'); throw new MayuraError('CANCELLED', 'The telemetry export was cancelled.'); } count('failedRequests'); return failed(); }
    finally { clearTimeout(timer); context.signal.removeEventListener('abort', relay); active = undefined; inFlight = false; }
  };
  return Object.freeze({ sink, inspect, close: (): void => { if (!closed) { closed = true; active?.abort(); } } });
}

export function createOtlpHttpJsonTraceExporter(options: OtlpHttpJsonTraceExporterOptions): OtlpHttpJsonTraceExporter {
  return createSignalExporter<OtlpTraceSpan>('traces', options, traceRequest, 'rejectedSpans');
}
export function createOtlpHttpJsonMetricExporter(options: OtlpHttpJsonMetricExporterOptions): OtlpHttpJsonMetricExporter {
  return createSignalExporter<OtlpMetricPoint>('metrics', options, metricRequest, 'rejectedDataPoints');
}
