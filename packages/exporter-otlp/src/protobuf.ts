import { MayuraError, type JsonObject, type JsonValue } from '@mayura/core';

/**
 * OTLP's protobuf encoding for the trace requests Mayura builds, written by hand so the exporter stays free of
 * dependencies. It covers exactly what the JSON encoder emits: resource and span attributes with string and integer
 * values, one scope, and spans with ids, name, kind, times and status. Field numbers follow
 * opentelemetry/proto/collector/trace/v1 and trace/v1 (ExportTraceServiceRequest, ResourceSpans, ScopeSpans, Span).
 */
const invalid = (): never => { throw new MayuraError('INVALID_INPUT', 'Trace span metadata is invalid.'); };

class Writer {
  private readonly parts: Uint8Array[] = []; length = 0;
  private push(bytes: Uint8Array): void { this.parts.push(bytes); this.length += bytes.byteLength; }
  private varint(value: bigint): void {
    const bytes: number[] = []; let rest = value;
    do { let byte = Number(rest & 0x7fn); rest >>= 7n; if (rest > 0n) byte |= 0x80; bytes.push(byte); } while (rest > 0n);
    this.push(Uint8Array.from(bytes));
  }
  private tag(field: number, wire: 0 | 1 | 2): void { this.varint(BigInt((field << 3) | wire)); }
  /** A varint field; proto3 leaves zero out, except for a oneof member (`always`), which is written whenever set. */
  uint(field: number, value: bigint, always = false): void { if (value < 0n || value > 0xffffffffffffffffn) invalid(); if (value === 0n && !always) return; this.tag(field, 0); this.varint(value); }
  fixed64(field: number, value: bigint): void {
    if (value < 0n || value > 0xffffffffffffffffn) invalid();
    const bytes = new Uint8Array(8); let rest = value; for (let index = 0; index < 8; index++) { bytes[index] = Number(rest & 0xffn); rest >>= 8n; }
    this.tag(field, 1); this.push(bytes);
  }
  bytes(field: number, value: Uint8Array): void { this.tag(field, 2); this.varint(BigInt(value.byteLength)); this.push(value); }
  string(field: number, value: string): void { if (value) this.bytes(field, new TextEncoder().encode(value)); }
  message(field: number, build: (writer: Writer) => void): void { const inner = new Writer(); build(inner); this.bytes(field, inner.finish()); }
  finish(): Uint8Array<ArrayBuffer> { const out = new Uint8Array(this.length); let offset = 0; for (const part of this.parts) { out.set(part, offset); offset += part.byteLength; } return out; }
}

const record = (value: JsonValue | undefined): JsonObject => (value && typeof value === 'object' && !Array.isArray(value) ? value : invalid());
const list = (value: JsonValue | undefined): readonly JsonValue[] => (value === undefined ? [] : Array.isArray(value) ? value : invalid());
const text = (value: JsonValue | undefined): string => (typeof value === 'string' ? value : invalid());
const hex = (value: JsonValue | undefined, length: number): Uint8Array => {
  const string = text(value); if (string.length !== length * 2 || !/^[0-9a-f]+$/u.test(string)) return invalid();
  return Uint8Array.from({ length }, (_, index) => Number.parseInt(string.slice(index * 2, index * 2 + 2), 16));
};
const decimal = (value: JsonValue | undefined): bigint => { const string = text(value); if (!/^(?:0|[1-9]\d{0,19})$/u.test(string)) invalid(); return BigInt(string); };

/** KeyValue { key = 1; AnyValue value = 2 }, AnyValue { string_value = 1; int_value = 3 }. */
function keyValues(writer: Writer, field: number, attributes: JsonValue | undefined): void {
  for (const item of list(attributes)) {
    const entry = record(item); const value = record(entry['value']);
    writer.message(field, pair => {
      pair.string(1, text(entry['key']));
      pair.message(2, any => {
        if (typeof value['stringValue'] === 'string') any.string(1, value['stringValue']);
        else if (value['intValue'] !== undefined) any.uint(3, decimal(value['intValue']), true);
        else invalid();
      });
    });
  }
}

/** ExportTraceServiceRequest from the OTLP/JSON request the trace exporter built and checked. */
export function otlpTraceProtobuf(request: JsonObject): Uint8Array<ArrayBuffer> {
  const writer = new Writer();
  for (const resourceSpans of list(request['resourceSpans'])) {
    const resource = record(resourceSpans);
    writer.message(1, rs => {
      rs.message(1, r => keyValues(r, 1, record(resource['resource'])['attributes']));
      for (const scopeSpans of list(resource['scopeSpans'])) {
        const scoped = record(scopeSpans);
        rs.message(2, ss => {
          const scope = record(scoped['scope']); ss.message(1, s => { s.string(1, text(scope['name'])); s.string(2, text(scope['version'])); });
          for (const item of list(scoped['spans'])) {
            const span = record(item);
            ss.message(2, sp => {
              sp.bytes(1, hex(span['traceId'], 16)); sp.bytes(2, hex(span['spanId'], 8));
              if (span['parentSpanId'] !== undefined) sp.bytes(4, hex(span['parentSpanId'], 8));
              sp.string(5, text(span['name']));
              if (typeof span['kind'] !== 'number') invalid(); sp.uint(6, BigInt(span['kind'] as number));
              sp.fixed64(7, decimal(span['startTimeUnixNano'])); sp.fixed64(8, decimal(span['endTimeUnixNano']));
              keyValues(sp, 9, span['attributes']);
              const code = record(span['status'])['code']; if (typeof code !== 'number') invalid();
              sp.message(15, status => status.uint(3, BigInt(code as number)));
            });
          }
        });
      }
    });
  }
  return writer.finish();
}

/** Reads a protobuf varint at `offset`; returns the value and the next offset. */
function readVarint(bytes: Uint8Array, offset: number): [bigint, number] {
  let value = 0n; let shift = 0n;
  for (let index = offset; index < bytes.byteLength && shift < 70n; index++) {
    const byte = bytes[index]!; value |= BigInt(byte & 0x7f) << shift; shift += 7n;
    if (!(byte & 0x80)) return [value, index + 1];
  }
  throw new Error();
}
/** Top-level fields of a message: field number to the last value (varint) or byte range (length-delimited). */
function fields(bytes: Uint8Array): Map<number, bigint | Uint8Array> {
  const result = new Map<number, bigint | Uint8Array>(); let offset = 0;
  while (offset < bytes.byteLength) {
    const [key, next] = readVarint(bytes, offset); offset = next; const field = Number(key >> 3n); const wire = Number(key & 7n);
    if (field < 1) throw new Error();
    if (wire === 0) { const [value, after] = readVarint(bytes, offset); result.set(field, value); offset = after; }
    else if (wire === 1) { offset += 8; } else if (wire === 5) { offset += 4; }
    else if (wire === 2) { const [length, after] = readVarint(bytes, offset); const end = after + Number(length); result.set(field, bytes.subarray(after, end)); offset = end; }
    else throw new Error();
    if (offset > bytes.byteLength) throw new Error();
  }
  return result;
}
/**
 * The partial success of an Export*ServiceResponse (`partial_success = 1`, its rejected count `= 1`), in the OTLP/JSON
 * shape the exporter reads; the error message is never read.
 */
export function otlpPartialSuccess(bytes: Uint8Array, field: 'rejectedSpans' | 'rejectedDataPoints'): JsonObject {
  try {
    const partial = fields(bytes).get(1); if (partial === undefined) return {};
    if (!(partial instanceof Uint8Array)) throw new Error();
    const rejected = fields(partial).get(1); if (rejected === undefined) return { partialSuccess: {} };
    if (typeof rejected !== 'bigint') throw new Error();
    return { partialSuccess: { [field]: rejected.toString() } };
  } catch { throw new MayuraError('TOOL_FAILED', 'The telemetry export failed. Inspect authorized local diagnostics.'); }
}
