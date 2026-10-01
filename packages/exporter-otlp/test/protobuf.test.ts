import { describe, expect, it, vi } from 'vitest';
import type { RunEvent } from '@mayura/core';
import { agentRunTraceSpans, createOtlpHttpJsonTraceExporter, createOtlpHttpProtobufTraceExporter, type OtlpHttpJsonTraceExporterOptions, type OtlpTraceSpan } from '../src/index.js';

/** A protobuf reader written for these tests, separately from the exporter's encoder: wire records, then the OTLP schema. */
type Field = { readonly field: number; readonly wire: number; readonly value: bigint | Uint8Array };
function varint(bytes: Uint8Array, at: number): [bigint, number] {
  let value = 0n; let shift = 0n; let index = at;
  for (;;) { const byte = bytes[index++]; if (byte === undefined) throw new Error('truncated varint'); value += BigInt(byte & 127) << shift; shift += 7n; if (byte < 128) return [value, index]; }
}
function wire(bytes: Uint8Array): Field[] {
  const out: Field[] = []; let at = 0;
  while (at < bytes.length) {
    const [key, next] = varint(bytes, at); at = next; const field = Number(key / 8n); const type = Number(key % 8n);
    if (type === 0) { const [value, after] = varint(bytes, at); out.push({ field, wire: type, value }); at = after; }
    else if (type === 1) { let value = 0n; for (let index = 7; index >= 0; index--) value = value * 256n + BigInt(bytes[at + index]!); out.push({ field, wire: type, value }); at += 8; }
    else if (type === 2) { const [length, after] = varint(bytes, at); out.push({ field, wire: type, value: bytes.slice(after, after + Number(length)) }); at = after + Number(length); }
    else throw new Error(`unexpected wire type ${type}`);
  }
  if (at !== bytes.length) throw new Error('overrun'); return out;
}
const all = (fields: Field[], number: number) => fields.filter(item => item.field === number);
const one = (fields: Field[], number: number) => { const found = all(fields, number); expect(found.length).toBeLessThanOrEqual(1); return found[0]?.value; };
const str = (value: unknown) => (value === undefined ? '' : new TextDecoder().decode(value as Uint8Array));
const hex = (value: unknown) => [...(value as Uint8Array)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const keyValues = (fields: Field[]) => fields.map(item => {
  const pair = wire(item.value as Uint8Array); const any = wire(one(pair, 2) as Uint8Array);
  const string = one(any, 1); const integer = one(any, 3);
  return { key: str(one(pair, 1)), value: string !== undefined ? { stringValue: str(string) } : { intValue: String(integer) } };
});
/** ExportTraceServiceRequest in OTLP/JSON's shape. */
function decodeRequest(bytes: Uint8Array) {
  return { resourceSpans: all(wire(bytes), 1).map(rs => {
    const resourceSpans = wire(rs.value as Uint8Array);
    return { resource: { attributes: keyValues(all(wire(one(resourceSpans, 1) as Uint8Array), 1)) }, scopeSpans: all(resourceSpans, 2).map(ss => {
      const scopeSpans = wire(ss.value as Uint8Array); const scope = wire(one(scopeSpans, 1) as Uint8Array);
      return { scope: { name: str(one(scope, 1)), version: str(one(scope, 2)) }, spans: all(scopeSpans, 2).map(item => {
        const span = wire(item.value as Uint8Array); const parent = one(span, 4);
        expect(all(span, 7)[0]?.wire).toBe(1); // fixed64 times
        return { traceId: hex(one(span, 1)), spanId: hex(one(span, 2)), ...(parent === undefined ? {} : { parentSpanId: hex(parent) }), name: str(one(span, 5)),
          kind: Number(one(span, 6) ?? 0n), startTimeUnixNano: String(one(span, 7)), endTimeUnixNano: String(one(span, 8)),
          status: { code: Number(one(wire(one(span, 15) as Uint8Array), 3) ?? 0n) }, attributes: keyValues(all(span, 9)) };
      }) };
    }) };
  }) };
}

const at = (second: number) => `2026-10-01T00:00:0${second}.000Z`;
const event = (sequence: number, type: RunEvent['type'], metadata: RunEvent['metadata']): RunEvent => ({ runId: 'run-1', sequence, timestamp: at(sequence), type, metadata });
const spans = agentRunTraceSpans([
  event(1, 'run.started', { profile: 'ephemeral', agentId: 'support' }), event(2, 'model.started', { step: 0, modelCall: 1, modelId: 'openai/gpt-test' }),
  event(3, 'model.completed', { step: 0, response: 'tool_calls', costMicros: 0, inputTokens: 300, outputTokens: 20 }), event(4, 'tool.started', { callId: 'c-1', toolId: 'orders.lookup' }),
  event(5, 'tool.completed', { callId: 'c-1', toolId: 'orders.lookup', status: 'failed', execution: 'failed', disclosure: 'withheld' }),
  event(6, 'run.completed', { status: 'failed', spentMicros: 0, reservedMicros: 0, calls: 1 }),
]);
const options = (fetch: typeof globalThis.fetch, extra: Partial<OtlpHttpJsonTraceExporterOptions> = {}): OtlpHttpJsonTraceExporterOptions =>
  ({ endpoint: 'https://collector.example/v1/traces', serviceName: 'agent', serviceVersion: '1.0.0', fetch, ...extra });
const reply = (body: BodyInit | null, type = 'application/x-protobuf', status = 200) => new Response(body, { status, headers: body === null ? {} : { 'Content-Type': type } });
const signal = () => new AbortController().signal;

describe('OTLP HTTP protobuf trace exporter', () => {
  it('sends the same request as the JSON exporter, in OTLP\'s protobuf encoding', async () => {
    const extra = { resourceAttributes: { 'openinference.project.name': 'support' }, spanAttributes: (span: OtlpTraceSpan) => ({ 'openinference.span.kind': span.name.startsWith('tool:') ? 'TOOL' : 'CHAIN' }) };
    const json = vi.fn<typeof globalThis.fetch>().mockResolvedValue(reply('{}', 'application/json'));
    await createOtlpHttpJsonTraceExporter(options(json, extra)).sink(spans, { signal: signal() });
    const protobuf = vi.fn<typeof globalThis.fetch>().mockResolvedValue(reply(null));
    const exporter = createOtlpHttpProtobufTraceExporter(options(protobuf, { headers: { authorization: 'Bearer SECRET' }, ...extra }));
    await exporter.sink(spans, { signal: signal() });
    const [url, init] = protobuf.mock.calls[0]!;
    expect(url).toBe('https://collector.example/v1/traces');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/x-protobuf', authorization: 'Bearer SECRET' });
    expect(init?.body).toBeInstanceOf(Uint8Array);
    expect(decodeRequest(init?.body as Uint8Array)).toEqual(JSON.parse(String(json.mock.calls[0]![1]?.body)));
    // A zero integer is still written: AnyValue's int_value is a oneof member.
    expect(JSON.stringify(decodeRequest(init?.body as Uint8Array))).toContain('{"key":"mayura.cost.micros","value":{"intValue":"0"}}');
    expect(exporter.inspect().metrics).toMatchObject({ recordsAccepted: 3, recordsDropped: 0, requestBytes: (init?.body as Uint8Array).byteLength });
    expect(JSON.stringify(exporter.inspect())).not.toContain('SECRET');
  });

  it('reads a partial success from a protobuf or JSON reply, and accepts an empty one', async () => {
    // ExportTraceServiceResponse { partial_success (1) { rejected_spans (1) = 2, error_message (2) = "SECRET" } }
    const message = new TextEncoder().encode('SECRET');
    const partial = Uint8Array.from([0x0a, 4 + message.length, 0x08, 0x02, 0x12, message.length, ...message]);
    for (const [body, type] of [[partial, 'application/x-protobuf'], ['{"partialSuccess":{"rejectedSpans":"2","errorMessage":"SECRET"}}', 'application/json']] as const) {
      const exporter = createOtlpHttpProtobufTraceExporter(options(vi.fn<typeof globalThis.fetch>().mockResolvedValue(reply(body, type))));
      await exporter.sink(spans, { signal: signal() });
      expect(exporter.inspect().metrics).toMatchObject({ recordsAccepted: 1, recordsDropped: 2, partialResponses: 1 });
      expect(JSON.stringify(exporter.inspect())).not.toContain('SECRET');
    }
    const empty = createOtlpHttpProtobufTraceExporter(options(vi.fn<typeof globalThis.fetch>().mockResolvedValue(reply(new Uint8Array(0)))));
    await empty.sink(spans, { signal: signal() });
    expect(empty.inspect().metrics).toMatchObject({ recordsAccepted: 3, partialResponses: 0 });
  });

  it.each([
    ['a reply shorter than it declares', Uint8Array.from([0x0a, 0x05, 0x08, 0x02])], ['more rejected spans than were sent', Uint8Array.from([0x0a, 0x02, 0x08, 0x09])],
    ['an unknown wire type', Uint8Array.from([0x0f])], ['an unsupported content type', new TextEncoder().encode('ok'), 'text/plain'],
  ] as const)('fails on %s without retrying', async (_name, body, type: string = 'application/x-protobuf') => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(reply(body, type));
    const exporter = createOtlpHttpProtobufTraceExporter(options(fetch));
    await expect(exporter.sink(spans, { signal: signal() })).rejects.toMatchObject({ code: 'TOOL_FAILED' });
    expect(fetch).toHaveBeenCalledTimes(1); expect(exporter.inspect().metrics).toMatchObject({ failedRequests: 1, recordsDropped: 3 });
  });

  it('bounds the protobuf request by its own size, not by its larger JSON form', async () => {
    let size = 0; const measure = vi.fn<typeof globalThis.fetch>(async (_url, init) => { size = (init?.body as Uint8Array).byteLength; return reply(null); });
    await createOtlpHttpProtobufTraceExporter(options(measure)).sink(spans, { signal: signal() });
    let jsonSize = 0; const measureJson = vi.fn<typeof globalThis.fetch>(async (_url, init) => { jsonSize = new TextEncoder().encode(String(init?.body)).byteLength; return reply('{}', 'application/json'); });
    await createOtlpHttpJsonTraceExporter(options(measureJson)).sink(spans, { signal: signal() });
    expect(size).toBeLessThan(jsonSize);
    const exact = vi.fn<typeof globalThis.fetch>().mockResolvedValue(reply(null));
    await createOtlpHttpProtobufTraceExporter(options(exact, { maxRequestBytes: size })).sink(spans, { signal: signal() });
    expect(exact).toHaveBeenCalledTimes(1);
    await expect(createOtlpHttpProtobufTraceExporter(options(exact, { maxRequestBytes: size - 1 })).sink(spans, { signal: signal() })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('refuses spans outside the catalog and requests over the byte bound before transport', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(createOtlpHttpProtobufTraceExporter(options(fetch)).sink([{ ...spans[0]!, attributes: { 'gen_ai.prompt': 'SECRET' } } as unknown as OtlpTraceSpan], { signal: signal() }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(createOtlpHttpProtobufTraceExporter(options(fetch, { maxRequestBytes: 64 })).sink(spans, { signal: signal() })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
