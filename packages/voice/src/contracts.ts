import { MayuraError, type ModelFailureReason } from '@mayura/core';

/** Transcription list prices in micros (millionths of a US dollar) per minute of audio, charged by the millisecond. */
export interface TranscriptionPricing { readonly microsPerMinute: number }
/** Speech list prices in micros per million characters of input text. */
export interface SpeechPricing { readonly microsPerMillionCharacters: number }

/** A transcription model a provider's catalog knows about, with its list price on the catalog's date. */
export interface CatalogTranscriber { readonly pricing: TranscriptionPricing }
/** A speech model a provider's catalog knows about, with its list price on the catalog's date. */
export interface CatalogSpeaker { readonly pricing: SpeechPricing }
/** A provider's voice models and list prices as of `asOf` (YYYY-MM-DD). Prices change: check the date. */
export interface VoiceCatalog {
  readonly asOf: string;
  readonly transcribers?: Readonly<Record<string, CatalogTranscriber>>;
  readonly speakers?: Readonly<Record<string, CatalogSpeaker>>;
}

/** Audio: its bytes and IANA media type, such as `audio/mpeg`, `audio/wav` or `audio/webm`. */
export interface Audio {
  readonly data: Uint8Array;
  readonly mediaType: string;
}

export interface TranscriptionRequest {
  readonly audio: Audio;
  /**
   * How long the audio lasts. Measured from the audio for WAV; give it for compressed audio, whose length Mayura does not
   * guess: the cost of a call is bounded before it is made.
   */
  readonly durationMs?: number;
  /** The spoken language as a BCP 47 tag, such as `en` or `pt-BR`, when known. */
  readonly language?: string;
  /** Words or context that help the model, such as names and terms. */
  readonly prompt?: string;
  readonly signal?: AbortSignal;
}
/** A span of the transcript, with offsets into the audio. */
export interface TranscriptSegment { readonly startMs: number; readonly endMs: number; readonly text: string; readonly speaker?: string }
export interface Transcript {
  readonly text: string;
  readonly language?: string;
  readonly segments: readonly TranscriptSegment[];
  readonly usage: VoiceUsage;
}

/** Audio formats a speaker can produce. `pcm16` is raw 16-bit little-endian mono PCM at `sampleRate`. */
export type SpeechFormat = 'mp3' | 'wav' | 'opus' | 'aac' | 'flac' | 'pcm16';
export interface SpeechRequest {
  readonly text: string;
  /** The provider's voice, by its id or name. */
  readonly voice: string;
  readonly format?: SpeechFormat;
  readonly language?: string;
  /** Delivery instructions, such as tone, for models that take them. */
  readonly instructions?: string;
  readonly signal?: AbortSignal;
  /** Receives audio as the provider streams it, before the call completes. Provisional: a failed call may stop early. */
  readonly onAudio?: (chunk: Uint8Array) => void;
}
export interface Speech {
  readonly audio: Audio;
  readonly usage: VoiceUsage;
}

/** What a call cost, and what it was charged for: audio milliseconds for transcription, characters for speech. */
export interface VoiceUsage {
  readonly costMicros: number;
  readonly audioMs?: number;
  readonly characters?: number;
}

/** What a voice registry passes a provider for one transcription model: the adapter must use this id and bound. */
export interface TranscriberSettings {
  /** `<provider>/<model>`; runtimes grant it as `voice:<id>`. */
  readonly id: string;
  readonly pricing: TranscriptionPricing;
  /** The most one call may cost. */
  readonly maxCostMicros: number;
  readonly timeoutMs?: number;
}
export interface SpeakerSettings {
  readonly id: string;
  readonly pricing: SpeechPricing;
  readonly maxCostMicros: number;
  readonly timeoutMs?: number;
}

/**
 * Turns speech into text. Adapters are trusted code: they call the provider, report the audio it billed, and map every
 * failure to a {@link VoiceProviderError} without the provider's text.
 */
export interface Transcriber {
  readonly id: string;
  readonly maxCostMicros: number;
  transcribe(request: TranscriptionRequest): Promise<Transcript>;
}
/** Turns text into speech. */
export interface Speaker {
  readonly id: string;
  readonly maxCostMicros: number;
  speak(request: SpeechRequest): Promise<Speech>;
}

/** A voice provider, as `@mayurajs/voice-*` packages export it. A provider may offer transcription, speech or both. */
export interface VoiceProvider {
  /** Lowercase letters, digits and `-`, such as `openai`: the first part of every voice id. */
  readonly id: string;
  readonly catalog?: VoiceCatalog;
  transcriber?(name: string, settings: TranscriberSettings): Transcriber;
  speaker?(name: string, settings: SpeakerSettings): Speaker;
}

/** The fixed public message for a voice failure, with the provider's HTTP status when there is one. */
export function voiceFailureMessage(reason: ModelFailureReason, httpStatus?: number): string {
  const status = httpStatus === undefined ? '' : ` (HTTP ${httpStatus})`;
  switch (reason) {
    case 'authentication': return `The voice provider refused the credentials or access to this model${status}. Check the API key and that it may use this model.`;
    case 'rate_limited': return `The voice provider's rate limit or quota was reached${status}. Try again later, or raise the limit with the provider.`;
    case 'unavailable': return `The voice provider was unavailable${status}. Try again later.`;
    case 'timeout': return 'The voice provider did not answer in time. Try again, or raise the timeoutMs.';
    case 'rejected': return `The voice provider rejected the request${status}. Check the model, voice, format and audio.`;
    case 'invalid_response': return 'The voice provider returned a response Mayura could not use, for example no text, no audio or no usage.';
    case 'refused': return 'The voice provider refused the content.';
    case 'configuration': return 'The voice adapter could not send this request: the audio format, speech format, voice or language is not one this provider takes.';
  }
}
/** A voice call that failed for a known reason. `costMicros`, when given, is usage the provider confirmed before failing. */
export class VoiceProviderError extends MayuraError {
  readonly reason: ModelFailureReason;
  declare readonly httpStatus?: number;
  declare readonly costMicros?: number;
  constructor(reason: ModelFailureReason, options: { readonly httpStatus?: number; readonly costMicros?: number } = {}) {
    const reasons: readonly ModelFailureReason[] = ['authentication', 'rate_limited', 'unavailable', 'timeout', 'rejected', 'invalid_response', 'refused', 'configuration'];
    if (!reasons.includes(reason)) throw new MayuraError('INVALID_CONFIG', 'Unknown voice failure reason.');
    const { httpStatus, costMicros } = options;
    if (httpStatus !== undefined && (!Number.isSafeInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) throw new MayuraError('INVALID_CONFIG', 'An HTTP status must be between 100 and 599.');
    if (costMicros !== undefined && (!Number.isSafeInteger(costMicros) || costMicros < 0)) throw new MayuraError('INVALID_CONFIG', 'Known voice usage must be a nonnegative safe integer.');
    super(reason === 'configuration' ? 'INVALID_CONFIG' : 'MODEL_FAILED', voiceFailureMessage(reason, httpStatus));
    this.reason = reason;
    if (httpStatus !== undefined) Object.defineProperty(this, 'httpStatus', { value: httpStatus, enumerable: true });
    if (costMicros !== undefined) Object.defineProperty(this, 'costMicros', { value: costMicros, enumerable: true });
    Object.freeze(this);
  }
}

/** The cost of `audioMs` of audio at `pricing`, rounded up to a whole micro. */
export function transcriptionCostMicros(pricing: TranscriptionPricing, audioMs: number): number {
  return Math.ceil((pricing.microsPerMinute * audioMs) / 60_000);
}
/** The cost of `characters` characters at `pricing`, rounded up to a whole micro. */
export function speechCostMicros(pricing: SpeechPricing, characters: number): number {
  return Math.ceil((pricing.microsPerMillionCharacters * characters) / 1_000_000);
}
/** Characters as providers bill them: Unicode code points. */
export function characterCount(text: string): number { let count = 0; for (const _ of text) count++; return count; }

/**
 * The failure for a voice provider's HTTP error status, as for models: 401 and 403 are credentials or model access,
 * 402 and 429 a rate limit or quota, 408 and 5xx the provider being unavailable, and any other status a rejected request.
 */
export function voiceHttpFailure(status: number, costMicros?: number): VoiceProviderError {
  const reason: ModelFailureReason = status === 401 || status === 403 ? 'authentication' : status === 402 || status === 429 ? 'rate_limited'
    : status === 408 || (status >= 500 && status <= 599) ? 'unavailable' : 'rejected';
  const httpStatus = Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : undefined;
  return new VoiceProviderError(reason, { ...(httpStatus === undefined ? {} : { httpStatus }), ...(costMicros === undefined ? {} : { costMicros }) });
}
