import { jsonValue, MayuraError, type GuardContext, type JsonValue, type Outcome } from '@mayura/core';
import { assertPipeline, snapshotContext, type GuardedContent, type Pipeline } from './pipeline.js';

export type OutputDisclosurePart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tool_preview'; readonly toolId: string; readonly preview: JsonValue }
  | { readonly kind: 'citation'; readonly label: string; readonly url: string }
  | { readonly kind: 'error'; readonly code: string; readonly message?: string }
  | { readonly kind: 'event'; readonly event: JsonValue };

export interface OutputDisclosureOptions {
  /** Exact HTTPS origins permitted for citations; query, fragment and credentials are always rejected. */
  readonly allowedCitationOrigins?: readonly string[];
  readonly maxParts?: number;
  readonly maxInputBytes?: number;
}

const errorCode = /^[A-Z][A-Z0-9_]{0,63}$/;

function fields(value: JsonValue, expected: readonly string[]): Record<string, JsonValue> {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new MayuraError('INVALID_INPUT', 'Output disclosure parts are malformed.');
  const names = Object.keys(value);
  if (names.length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) {
    throw new MayuraError('INVALID_INPUT', 'Output disclosure parts are malformed.');
  }
  return value;
}

function bounded(value: JsonValue | undefined, maximum = 65_536): string {
  if (typeof value !== 'string' || value.length > maximum) throw new MayuraError('INVALID_INPUT', 'Output disclosure text is invalid.');
  return value;
}

function origins(values: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(values) || values.length > 64) throw new MayuraError('INVALID_CONFIG', 'Citation origins must be a bounded array.');
  const result = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || value.length > 256) throw new MayuraError('INVALID_CONFIG', 'Citation origin is invalid.');
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new MayuraError('INVALID_CONFIG', 'Citation origin is invalid.'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash
      || parsed.origin !== value.replace(/\/$/u, '')) throw new MayuraError('INVALID_CONFIG', 'Citation origins must be exact HTTPS origins.');
    if (result.has(parsed.origin)) throw new MayuraError('INVALID_CONFIG', 'Citation origins must be unique.');
    result.add(parsed.origin);
  }
  return result;
}

/** Converts rich output into a content-only candidate, withholding privileged preview/event/error details before guard evaluation. */
export async function prepareOutputDisclosure(
  parts: readonly OutputDisclosurePart[], pipeline: Pipeline, supplied: GuardContext, options: OutputDisclosureOptions = {},
): Promise<Outcome<GuardedContent>> {
  const maxParts = options.maxParts ?? 256; const maxInputBytes = options.maxInputBytes ?? 1_048_576;
  if (!Number.isSafeInteger(maxParts) || maxParts < 1 || maxParts > 4_096
    || !Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1 || maxInputBytes > 16 * 1_048_576) {
    throw new MayuraError('INVALID_CONFIG', 'Output disclosure limits are invalid.');
  }
  assertPipeline(pipeline);
  const context = snapshotContext(supplied);
  if (context.boundary !== 'output') throw new MayuraError('INVALID_CONFIG', 'Output disclosure requires an output boundary context.');
  let copied: JsonValue;
  try { copied = jsonValue(parts, { maxBytes: maxInputBytes }); }
  catch { throw new MayuraError('INVALID_INPUT', 'Output disclosure input exceeds its plain-JSON boundary.'); }
  if (!Array.isArray(copied) || copied.length > maxParts) throw new MayuraError('INVALID_INPUT', 'Output disclosure parts exceed their limit.');
  const allowed = origins(options.allowedCitationOrigins ?? []); const rendered: string[] = [];
  for (const item of copied) {
    if (!item || Array.isArray(item) || typeof item !== 'object' || typeof item['kind'] !== 'string') {
      throw new MayuraError('INVALID_INPUT', 'Output disclosure parts are malformed.');
    }
    switch (item['kind']) {
      case 'text': rendered.push(bounded(fields(item, ['kind', 'text'])['text'])); break;
      case 'tool_preview': fields(item, ['kind', 'toolId', 'preview']); rendered.push('[tool preview withheld]'); break;
      case 'event': fields(item, ['kind', 'event']); rendered.push('[event withheld]'); break;
      case 'error': {
        const value = fields(item, Object.hasOwn(item, 'message') ? ['kind', 'code', 'message'] : ['kind', 'code']);
        if (Object.hasOwn(value, 'message')) bounded(value['message']);
        const code = bounded(value['code'], 64); rendered.push(`[error:${errorCode.test(code) ? code : 'UNKNOWN'}]`); break;
      }
      case 'citation': {
        const value = fields(item, ['kind', 'label', 'url']); const label = bounded(value['label'], 4_096); const raw = bounded(value['url'], 2_048);
        let url: URL | undefined;
        try { url = new URL(raw); } catch { /* Withhold malformed citation destinations. */ }
        if (!url || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !allowed.has(url.origin)) {
          rendered.push('[citation withheld]');
        } else rendered.push(`${label} [${url.href}]`);
        break;
      }
      default: throw new MayuraError('INVALID_INPUT', 'Output disclosure part kind is unsupported.');
    }
  }
  return pipeline.process(rendered.join('\n'), context);
}
