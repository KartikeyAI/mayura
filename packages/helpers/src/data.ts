import { MayuraError, freezeJson, jsonValue, type JsonObject, type JsonValue } from '@mayura/core';

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;

function assertSignal(signal: AbortSignal): void {
  if (!(signal instanceof AbortSignal)) throw new MayuraError('INVALID_CONFIG', 'An AbortSignal is required.');
  if (signal.aborted) throw new MayuraError('CANCELLED', 'The operation was cancelled.');
}

export interface ArtifactStage<R> {
  write(chunk: Uint8Array): void | Promise<void>;
  commit(): R | Promise<R>;
  discard(): void | Promise<void>;
}

export interface ArtifactTransferOptions {
  readonly signal: AbortSignal;
  readonly expectedDigest: string;
  readonly maxBytes: number;
}

/** Stages bounded bytes, verifies SHA-256, and only then makes the destination visible. */
export async function transferArtifact<R>(
  source: AsyncIterable<Uint8Array>,
  stage: ArtifactStage<R>,
  options: ArtifactTransferOptions,
): Promise<Readonly<{ result: R; bytes: number; digest: string }>> {
  assertSignal(options.signal);
  if (!DIGEST.test(options.expectedDigest) || !Number.isSafeInteger(options.maxBytes)
    || options.maxBytes <= 0 || options.maxBytes > 67_108_864) {
    throw new MayuraError('INVALID_CONFIG', 'Artifact transfer requires a bounded size and SHA-256 digest.');
  }
  let total = 0; const chunks: Uint8Array[] = [];
  try {
    for await (const raw of source) {
      assertSignal(options.signal);
      if (!(raw instanceof Uint8Array) || (typeof SharedArrayBuffer !== 'undefined' && raw.buffer instanceof SharedArrayBuffer)) {
        throw new MayuraError('INVALID_OUTPUT', 'Artifact source returned an invalid byte chunk.');
      }
      const chunk = new Uint8Array(raw);
      total += chunk.byteLength;
      if (!Number.isSafeInteger(total) || total > options.maxBytes) throw new MayuraError('LIMIT_EXCEEDED', 'Artifact exceeded its transfer limit.');
      chunks.push(chunk); await stage.write(chunk);
    }
    const content = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { content.set(chunk, offset); offset += chunk.byteLength; }
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', content));
    const digest = `sha256:${[...hash].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
    if (digest !== options.expectedDigest) throw new MayuraError('INTEGRITY_VIOLATION', 'Artifact digest did not match.');
    assertSignal(options.signal);
    const result = await stage.commit();
    return Object.freeze({ result, bytes: total, digest });
  } catch (error) {
    try { await stage.discard(); } catch { /* Preserve the primary transfer failure. */ }
    throw error;
  }
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface RedactedLoggerOptions {
  readonly allowedFields: readonly string[];
  readonly redactedFields?: readonly string[];
  readonly clock?: () => number;
  readonly maxBytes?: number;
}

export interface RedactedLogger {
  log(level: LogLevel, event: string, fields?: Readonly<Record<string, unknown>>): Promise<void>;
}

/** Emits allowlisted bounded JSON; configured sensitive fields become fixed markers. */
export function createRedactedLogger(
  sink: (entry: JsonObject) => void | Promise<void>,
  options: RedactedLoggerOptions,
): RedactedLogger {
  if (!Array.isArray(options.allowedFields) || options.allowedFields.length > 128) {
    throw new MayuraError('INVALID_CONFIG', 'Logger field allowlist is invalid.');
  }
  const allowed = new Set(options.allowedFields); const redacted = new Set(options.redactedFields ?? []);
  if ([...allowed, ...redacted].some(key => !EVENT_ID.test(key)) || [...redacted].some(key => !allowed.has(key))) {
    throw new MayuraError('INVALID_CONFIG', 'Logger fields must be bounded allowlisted identifiers.');
  }
  const clock = options.clock ?? Date.now; const maxBytes = options.maxBytes ?? 16_384;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 1_048_576) throw new MayuraError('INVALID_CONFIG', 'Logger byte limit is invalid.');
  return Object.freeze({
    async log(level: LogLevel, event: string, fields: Readonly<Record<string, unknown>> = {}): Promise<void> {
      if (!['debug', 'info', 'warn', 'error'].includes(level) || !EVENT_ID.test(event)) {
        throw new MayuraError('INVALID_INPUT', 'Log identity is invalid.');
      }
      const snapshot = jsonValue(fields, { maxBytes, maxDepth: 16, maxNodes: 2_048 });
      if (snapshot === null || Array.isArray(snapshot) || typeof snapshot !== 'object') throw new MayuraError('INVALID_INPUT', 'Log fields must be a JSON object.');
      const safe: JsonObject = {};
      for (const [key, value] of Object.entries(snapshot)) {
        if (!allowed.has(key)) continue;
        safe[key] = redacted.has(key) ? '[REDACTED]' : value;
      }
      const timestamp = clock();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new MayuraError('INVALID_CONFIG', 'Logger clock returned an invalid timestamp.');
      const entry: JsonObject = { timestamp, level, event, fields: safe as JsonValue };
      await sink(freezeJson(jsonValue(entry, { maxBytes, maxDepth: 16, maxNodes: 2_048 })) as JsonObject);
    },
  });
}
