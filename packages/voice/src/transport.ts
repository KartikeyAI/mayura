import { MayuraError } from '@mayura/core';
import { VoiceProviderError, voiceHttpFailure } from './contracts.js';

/** One provider call's own signal, aborted by the caller's signal or by the timeout, and its failure mapping. */
export interface VoiceCall {
  readonly signal: AbortSignal;
  /**
   * The error to raise for anything that ended the call: `timeout` past the deadline, `CANCELLED` when the caller
   * aborted, Mayura's own errors unchanged, `unavailable` for a failed connection, `invalid_response` otherwise.
   */
  failure(error: unknown): never;
  /** Releases the timer and the caller's listener; call it in `finally`. */
  done(): void;
}
/** For provider packages: a call that stops at `timeoutMs` or when `caller` aborts. */
export function voiceCall(timeoutMs: number, caller: AbortSignal | undefined): VoiceCall {
  const controller = new AbortController(); let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onAbort = () => controller.abort();
  if (caller?.aborted) controller.abort(); else caller?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    failure: (error: unknown): never => {
      if (timedOut) throw new VoiceProviderError('timeout');
      if (caller?.aborted) throw new MayuraError('CANCELLED', 'The voice call was cancelled.');
      if (error instanceof MayuraError) throw error;
      if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) throw new VoiceProviderError('unavailable');
      throw new VoiceProviderError('invalid_response');
    },
    done: () => { clearTimeout(timer); caller?.removeEventListener('abort', onAbort); },
  };
}

/** For provider packages: a non-2xx response as its failure, without reading the provider's text. */
export function voiceResponseFailure(response: Response): VoiceProviderError {
  void response.body?.cancel().catch(() => undefined);
  return voiceHttpFailure(response.status);
}

/** For provider packages: a response's JSON, refusing a body larger than `maxBytes` or not JSON. */
export async function voiceJson(response: Response, maxBytes: number): Promise<unknown> {
  const bytes = await boundedBytes(response, maxBytes);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new VoiceProviderError('invalid_response'); }
}

/**
 * For provider packages: a response's audio, passed to `onAudio` as it arrives and refused past `maxBytes`. The
 * response must be audio: a JSON or text body in its place (an error answered with 200) is refused.
 */
export async function voiceAudio(response: Response, maxBytes: number, onAudio?: (chunk: Uint8Array) => void): Promise<Uint8Array> {
  const type = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!type.startsWith('audio/') && !type.startsWith('application/octet-stream')) { void response.body?.cancel().catch(() => undefined); throw new VoiceProviderError('invalid_response'); }
  const data = await boundedBytes(response, maxBytes, onAudio);
  if (data.byteLength === 0) throw new VoiceProviderError('invalid_response');
  return data;
}

async function boundedBytes(response: Response, maxBytes: number, onChunk?: (chunk: Uint8Array) => void): Promise<Uint8Array> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) { void response.body?.cancel().catch(() => undefined); throw new VoiceProviderError('invalid_response'); }
  if (!response.body) return new Uint8Array();
  const chunks: Uint8Array[] = []; let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { void reader.cancel().catch(() => undefined); throw new VoiceProviderError('invalid_response'); }
    chunks.push(value); onChunk?.(value);
  }
  const data = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return data;
}
