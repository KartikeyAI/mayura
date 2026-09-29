import { assertPositiveInteger, jsonValue, MayuraError, type JsonObject, type JsonValue, type RunEvent } from '@mayura/core';
import { snapshotRunEventMetadata } from '@mayura/observability';
import type { ExactCount, OtlpHttpJsonLogExporter, OtlpHttpJsonLogExporterOptions, OtlpLogExporterMetrics, OtlpLogExporterSnapshot } from './contracts.js';

const defaults = Object.freeze({ timeoutMs: 5_000, maxBatchSize: 256, maxRequestBytes: 1_048_576, maxResponseBytes: 65_536 });
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const stableName = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const blockedHeaders = new Set(['connection', 'content-length', 'content-type', 'cookie', 'host', 'set-cookie', 'transfer-encoding']);
const metricNames = ['batchesAttempted', 'recordsAttempted', 'recordsAccepted', 'recordsDropped', 'partialResponses', 'failedRequests', 'timedOutRequests', 'cancelledRequests', 'requestBytes', 'responseBytes'] as const;
type Metric = typeof metricNames[number];

const failed = (): never => { throw new MayuraError('TOOL_FAILED', 'The telemetry export failed. Inspect authorized local diagnostics.'); };
function exact(value: bigint): ExactCount { return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString(); }
function object(value: JsonValue | undefined): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return failed();
  return value;
}
function stable(value: unknown): string {
  if (typeof value !== 'string' || !stableName.test(value)) throw new MayuraError('INVALID_CONFIG', 'Exporter names must be bounded stable identifiers.');
  return value;
}
function endpoint(value: unknown, allowInsecureLoopback: boolean): string {
  try {
    if (typeof value !== 'string' || value.length > 2_048) throw new Error();
    const url = new URL(value);
    const loopback = ['127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(allowInsecureLoopback && url.protocol === 'http:' && loopback))
      || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/v1/logs')) throw new Error();
    return url.href;
  } catch { throw new MayuraError('INVALID_CONFIG', 'OTLP logs require an explicit HTTPS endpoint ending in /v1/logs.'); }
}
function headers(value: OtlpHttpJsonLogExporterOptions['headers']): Readonly<Record<string, string>> {
  try {
    if (value === undefined) return Object.freeze({ 'Content-Type': 'application/json' });
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error();
    const result: Record<string, string> = { 'Content-Type': 'application/json' };
    const seen = new Set(['content-type']);
    if (Object.getOwnPropertySymbols(value).length > 0 || Object.keys(descriptors).length > 32) throw new Error();
    for (const [key, descriptor] of Object.entries(descriptors)) {
      const normalized = key.toLowerCase();
      if (!descriptor.enumerable || !('value' in descriptor) || !headerName.test(key) || blockedHeaders.has(normalized) || seen.has(normalized)
        || typeof descriptor.value !== 'string' || descriptor.value.length > 4_096 || /[\r\n\0]/.test(descriptor.value)) throw new Error();
      seen.add(normalized);
      result[key] = descriptor.value;
    }
    return Object.freeze(result);
  } catch { throw new MayuraError('INVALID_CONFIG', 'Exporter headers must be bounded explicit HTTP fields.'); }
}

function anyValue(value: string | number | boolean): JsonObject {
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
}
function attribute(key: string, value: string | number | boolean): JsonObject { return { key, value: anyValue(value) }; }
function severity(event: RunEvent): readonly [number, string] {
  if (event.type === 'events.gap') return [13, 'WARN'];
  if (event.type !== 'run.completed' && event.type !== 'tool.completed' && event.type !== 'hook.completed' && event.type !== 'delegate.completed') return [9, 'INFO'];
  const status = event.metadata['status'];
  if (status === 'failed' || status === 'outcome_unknown') return [17, 'ERROR'];
  if (status === 'blocked' || status === 'cancelled') return [13, 'WARN'];
  return [9, 'INFO'];
}
function record(event: RunEvent): JsonObject {
  const [severityNumber, severityText] = severity(event);
  const attributes = [attribute('mayura.run.id', event.runId), attribute('mayura.event.sequence', event.sequence)];
  for (const [key, value] of Object.entries(event.metadata)) attributes.push(attribute(`mayura.${key}`, value));
  return {
    timeUnixNano: (BigInt(Date.parse(event.timestamp)) * 1_000_000n).toString(),
    severityNumber, severityText, body: { stringValue: event.type }, attributes,
  };
}
function request(events: readonly RunEvent[], serviceName: string, serviceVersion?: string): JsonObject {
  const attributes = [attribute('service.name', serviceName)];
  if (serviceVersion) attributes.push(attribute('service.version', serviceVersion));
  return { resourceLogs: [{ resource: { attributes }, scopeLogs: [{ scope: { name: '@mayura/observability', version: '1.0.0-rc.1' }, logRecords: events.map(record) }] }] };
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => undefined); throw signal.reason; }
  let listener: (() => void) | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      listener = () => reject(signal.reason); signal.addEventListener('abort', listener, { once: true });
      if (signal.aborted) listener();
    })]);
  } finally { if (listener) signal.removeEventListener('abort', listener); }
}
async function responsePayload(response: Response, limit: number, signal: AbortSignal, charge: (bytes: number) => void): Promise<JsonObject> {
  if (response.status !== 200 || response.redirected) { void response.body?.cancel().catch(() => undefined); return failed(); }
  if (!response.body) return {};
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) { void response.body.cancel().catch(() => undefined); return failed(); }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const item = await abortable(reader.read(), signal);
      if (item.done) break;
      size += item.value.byteLength; charge(item.value.byteLength);
      if (size > limit) return failed();
      chunks.push(item.value);
    }
    if (size === 0) return {};
    if (!/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) return failed();
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return object(jsonValue(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), { maxBytes: limit, maxDepth: 8, maxNodes: 1_024 }));
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
function rejectedRecords(payload: JsonObject, sent: number): number {
  const partial = payload['partialSuccess'];
  if (partial === undefined) return 0;
  const value = object(partial)['rejectedLogRecords'];
  if (value === undefined) return 0;
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== 'string' || !/^\d{1,20}$/.test(text)) return failed();
  const rejected = BigInt(text);
  if (rejected > BigInt(sent)) return failed();
  return Number(rejected);
}

/** Explicit OTLP/HTTP JSON log export with bounded metadata-only delivery and no retries. */
export function createOtlpHttpJsonLogExporter(options: OtlpHttpJsonLogExporterOptions): OtlpHttpJsonLogExporter {
  let config: typeof defaults; let destination: string; let serviceName: string; let serviceVersion: string | undefined;
  let transport: typeof globalThis.fetch; let fixedHeaders: Readonly<Record<string, string>>;
  try {
    const allowInsecureLoopback = options.allowInsecureLoopback ?? false;
    if (typeof allowInsecureLoopback !== 'boolean') throw new Error();
    config = Object.freeze(Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, options[key as keyof typeof defaults] ?? fallback]))) as typeof defaults;
    for (const [key, value] of Object.entries(config)) assertPositiveInteger(value, key);
    if (config.timeoutMs > 2_147_483_647 || config.maxBatchSize > 256 || config.maxRequestBytes > 16_777_216 || config.maxResponseBytes > 1_048_576) throw new Error();
    destination = endpoint(options.endpoint, allowInsecureLoopback); serviceName = stable(options.serviceName);
    serviceVersion = options.serviceVersion === undefined ? undefined : stable(options.serviceVersion);
    fixedHeaders = headers(options.headers); transport = options.fetch ?? globalThis.fetch;
    if (typeof transport !== 'function') throw new Error();
  } catch (error) {
    if (error instanceof MayuraError) throw error;
    throw new MayuraError('INVALID_CONFIG', 'OTLP exporter configuration must contain supported explicit bounds and transport.');
  }
  const metrics = Object.fromEntries(metricNames.map(key => [key, 0n])) as Record<Metric, bigint>;
  const count = (key: Metric, amount = 1): void => { metrics[key] += BigInt(amount); };
  let closed = false; let inFlight = false; let active: AbortController | undefined;
  const inspect = (): OtlpLogExporterSnapshot => Object.freeze({ state: closed ? 'closed' : 'active', inFlight,
    metrics: Object.freeze(Object.fromEntries(metricNames.map(key => [key, exact(metrics[key])]))) as unknown as OtlpLogExporterMetrics,
  });
  const sink = async (rawEvents: readonly RunEvent[], context: { readonly signal: AbortSignal }): Promise<void> => {
    if (closed) throw new MayuraError('CONFLICT', 'The telemetry exporter is closed.');
    if (inFlight) throw new MayuraError('CONFLICT', 'The telemetry exporter already has an active request.');
    if (!Array.isArray(rawEvents) || rawEvents.length === 0 || rawEvents.length > config.maxBatchSize || !(context.signal instanceof AbortSignal)) {
      if (Array.isArray(rawEvents)) count('recordsDropped', rawEvents.length);
      throw new MayuraError('INVALID_INPUT', 'Telemetry batches require admitted events, a signal and supported bounds.');
    }
    count('batchesAttempted'); count('recordsAttempted', rawEvents.length);
    let events: readonly RunEvent[]; let body: string;
    try {
      events = Object.freeze(rawEvents.map(value => snapshotRunEventMetadata(value)));
      body = JSON.stringify(jsonValue(request(events, serviceName, serviceVersion), { maxBytes: config.maxRequestBytes, maxDepth: 12, maxNodes: 32_768 }));
      const bytes = new TextEncoder().encode(body).byteLength;
      if (bytes > config.maxRequestBytes) throw new Error();
      count('requestBytes', bytes);
    } catch {
      count('recordsDropped', rawEvents.length); throw new MayuraError('INVALID_INPUT', 'Telemetry batches require admitted events within the configured request bound.');
    }
    const controller = new AbortController(); active = controller; inFlight = true; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeoutMs);
    const relay = (): void => { controller.abort(); };
    context.signal.addEventListener('abort', relay, { once: true }); if (context.signal.aborted) relay();
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      const response = await abortable(Promise.resolve(transport(destination, {
        method: 'POST', headers: fixedHeaders, body, signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
      })), controller.signal);
      const payload = await responsePayload(response, config.maxResponseBytes, controller.signal, bytes => count('responseBytes', bytes));
      const rejected = rejectedRecords(payload, events.length);
      count('recordsAccepted', events.length - rejected);
      if (rejected > 0) { count('recordsDropped', rejected); count('partialResponses'); }
    } catch {
      count('recordsDropped', events.length);
      if (timedOut) { count('timedOutRequests'); throw new MayuraError('TIMEOUT', 'The telemetry export timed out.'); }
      if (context.signal.aborted || closed) { count('cancelledRequests'); throw new MayuraError('CANCELLED', 'The telemetry export was cancelled.'); }
      count('failedRequests'); return failed();
    } finally {
      clearTimeout(timer); context.signal.removeEventListener('abort', relay); active = undefined; inFlight = false;
    }
  };
  const close = (): void => { if (!closed) { closed = true; active?.abort(); } };
  return Object.freeze({ sink, inspect, close });
}
