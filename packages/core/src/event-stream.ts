import { MayuraError } from './errors.js';
import { ModelProviderError, type ModelResponse, type ModelStreamEvent } from './contracts.js';
import { providerHttpFailure } from './model-schema.js';

export interface ServerSentEvent {
  /** The `event:` field, or `message` when absent. */
  readonly event: string;
  /** The joined `data:` lines, unparsed. */
  readonly data: string;
}
export interface ServerSentEventLimits {
  /** Most bytes read from the whole stream. */
  readonly maxBytes: number;
  /** Most bytes in one event frame. */
  readonly maxEventBytes: number;
  readonly signal: AbortSignal;
}

const failure = (): MayuraError => new MayuraError('MODEL_FAILED', 'The model provider returned an unavailable, refused or invalid response.');

/**
 * Bounded Server-Sent Events decoding for trusted provider adapters. It checks the content type, decodes strict UTF-8
 * across chunk boundaries, splits LF or CRLF frames, ignores comments and ids, and enforces the byte bounds and the
 * abort signal while reading. Raw provider bytes and error text are never surfaced; any violation is one generic error.
 */
export async function* readServerSentEvents(response: Response, limits: ServerSentEventLimits): AsyncIterable<ServerSentEvent> {
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1 || !Number.isSafeInteger(limits.maxEventBytes) || limits.maxEventBytes < 1) {
    throw new MayuraError('INVALID_CONFIG', 'Event stream bounds must be positive integers.');
  }
  if (!response.ok || response.redirected || !response.body || !/^text\/event-stream(?:\s*;|$)/iu.test(response.headers.get('content-type') ?? '')) {
    void response.body?.cancel().catch(() => undefined);
    // A refused stream fails for the provider's reason (credentials, rate limit, ...), as a refused call does.
    if (response.redirected) throw new ModelProviderError('rejected');
    if (!response.ok) throw providerHttpFailure(response.status);
    throw failure();
  }
  const reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true }); const encoder = new TextEncoder();
  let pending = ''; let total = 0;
  const read = (): Promise<ReadableStreamReadResult<Uint8Array>> => {
    if (limits.signal.aborted) return Promise.reject(new MayuraError('CANCELLED', 'Provider request was cancelled.'));
    let abort: (() => void) | undefined;
    return Promise.race([reader.read(), new Promise<never>((_, reject) => {
      abort = () => reject(new MayuraError('CANCELLED', 'Provider request was cancelled.'));
      limits.signal.addEventListener('abort', abort, { once: true });
    })]).finally(() => { if (abort) limits.signal.removeEventListener('abort', abort); });
  };
  try {
    while (true) {
      const next = await read();
      if (!next.done) {
        total += next.value.byteLength; if (total > limits.maxBytes) throw failure();
      }
      try { pending += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true }); } catch { throw failure(); }
      while (true) {
        const boundary = /\r?\n\r?\n/u.exec(pending); if (!boundary) break;
        const frame = pending.slice(0, boundary.index); pending = pending.slice(boundary.index + boundary[0].length);
        if (encoder.encode(frame).byteLength > limits.maxEventBytes) throw failure();
        let event = 'message'; const data: string[] = [];
        for (const line of frame.split(/\r?\n/u)) {
          if (!line || line.startsWith(':')) continue;
          const colon = line.indexOf(':'); const field = colon < 0 ? line : line.slice(0, colon); const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /u, '');
          if (field === 'event') event = value; else if (field === 'data') data.push(value);
        }
        if (data.length > 0) yield Object.freeze({ event, data: data.join('\n') });
      }
      if (encoder.encode(pending).byteLength > limits.maxEventBytes) throw failure();
      if (next.done) { if (pending.trim()) throw failure(); return; }
    }
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/**
 * Present a provider call that reports final-output text as it arrives as a model stream: each delta as it comes,
 * then the complete response. If the consumer stops reading early, the call's signal aborts so the request stops.
 */
export async function* streamModelCall(call: (onDelta: (text: string) => void, signal: AbortSignal) => Promise<ModelResponse>): AsyncIterable<ModelStreamEvent> {
  const queue: string[] = []; let wake: (() => void) | undefined; let done = false; let result: ModelResponse | undefined; let failed = false; let failure: unknown;
  const local = new AbortController();
  void call(text => { queue.push(text); wake?.(); }, local.signal)
    .then(value => { result = value; }, error => { failed = true; failure = error; })
    .finally(() => { done = true; wake?.(); });
  try {
    while (true) {
      while (queue.length > 0) yield { type: 'output.delta', text: queue.shift()! };
      if (done) break;
      await new Promise<void>(resolve => { wake = resolve; }); wake = undefined;
    }
    if (failed) throw failure;
    yield { type: 'response', response: result! };
  } finally { if (!done) local.abort(); }
}
