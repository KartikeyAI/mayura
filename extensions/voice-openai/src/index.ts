import { APIConnectionError, APIError, APIUserAbortError, OpenAI, toFile } from 'openai';
import { assertPositiveInteger, MayuraError } from 'mayura';
import { providerEndpoint, providerHeaders } from 'mayura/core/host';
import {
  characterCount, speechCostMicros, transcriptionCostMicros, voiceHttpFailure, VoiceProviderError,
  type Speaker, type SpeakerSettings, type Speech, type SpeechFormat, type SpeechRequest, type Transcriber, type TranscriberSettings, type Transcript,
  type TranscriptionRequest, type TranscriptSegment, type VoiceCatalog, type VoiceProvider,
} from 'mayura/voice';

export interface OpenAIVoiceOptions {
  /** Your OpenAI API key. Required: the provider never reads keys, organizations or URLs from the environment. */
  readonly apiKey: string;
  /** Send requests here instead of https://api.openai.com/v1, for example through a gateway. It must be https. */
  readonly baseURL?: string;
  readonly organization?: string;
  readonly project?: string;
  /** Extra headers, such as a gateway's credential. Treated as credentials. They cannot replace Authorization. */
  readonly headers?: Readonly<Record<string, string>>;
  /** The largest speech audio a call may return; 64 MiB by default. */
  readonly maxAudioBytes?: number;
  /** How long one call may take unless the registry sets `timeoutMs` (default 120 s). */
  readonly timeoutMs?: number;
  /** A trusted transport for tests or proxies. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * OpenAI's list prices on 2026-09-30 for the audio models billed per minute of audio or per character of text. Models
 * billed per token (gpt-4o-transcribe, gpt-4o-mini-transcribe, gpt-transcribe, gpt-4o-mini-tts) are left out: their
 * cost cannot be known from the audio or text before the call. Give their price yourself if you use them.
 */
export const catalog: VoiceCatalog = Object.freeze({
  asOf: '2026-09-30',
  transcribers: Object.freeze({ 'whisper-1': Object.freeze({ pricing: Object.freeze({ microsPerMinute: 6_000 }) }) }),
  speakers: Object.freeze({
    'tts-1': Object.freeze({ pricing: Object.freeze({ microsPerMillionCharacters: 15_000_000 }) }),
    'tts-1-hd': Object.freeze({ pricing: Object.freeze({ microsPerMillionCharacters: 30_000_000 }) }),
  }),
});

const extensions: Readonly<Record<string, string>> = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/wave': 'wav', 'audio/x-wav': 'wav', 'audio/vnd.wave': 'wav',
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/mp4': 'm4a', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a' };
const speechTypes: Readonly<Record<SpeechFormat, { format: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm'; mediaType: string }>> = {
  mp3: { format: 'mp3', mediaType: 'audio/mpeg' }, opus: { format: 'opus', mediaType: 'audio/ogg' }, aac: { format: 'aac', mediaType: 'audio/aac' },
  flac: { format: 'flac', mediaType: 'audio/flac' }, wav: { format: 'wav', mediaType: 'audio/wav' }, pcm16: { format: 'pcm', mediaType: 'audio/L16;rate=24000;channels=1' },
};
/** Whisper answers with full language names; only BCP 47 tags are passed on. */
const languageTag = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;

/** A call's own signal: aborted by the caller, or by the timeout, which it then reports as the reason. */
function deadline(timeoutMs: number, caller: AbortSignal | undefined) {
  const controller = new AbortController(); let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onAbort = () => controller.abort();
  caller?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    failure: (error: unknown): never => {
      if (timedOut) throw new VoiceProviderError('timeout');
      if (caller?.aborted) throw new MayuraError('CANCELLED', 'The voice call was cancelled.');
      if (error instanceof VoiceProviderError || error instanceof MayuraError) throw error;
      if (error instanceof APIError && typeof error.status === 'number') throw voiceHttpFailure(error.status);
      if (error instanceof APIConnectionError || error instanceof APIUserAbortError || error instanceof TypeError) throw new VoiceProviderError('unavailable');
      throw new VoiceProviderError('invalid_response');
    },
    done: () => { clearTimeout(timer); caller?.removeEventListener('abort', onAbort); },
  };
}

/**
 * OpenAI speech-to-text and text-to-speech for a voice registry (`openaiVoice({ apiKey })`, ids `openai/<model>` such as
 * `openai/whisper-1` or `openai/tts-1`), through the official `openai` SDK. It reads nothing from the environment, turns
 * off the SDK's retries and logging, and bounds the audio a call may return.
 */
export function openaiVoice(options: OpenAIVoiceOptions): VoiceProvider {
  const key = options?.apiKey;
  if (typeof key !== 'string' || !key.trim() || /[\r\n]/u.test(key) || key.length > 4096) throw new MayuraError('INVALID_CONFIG', 'openaiVoice() needs an apiKey.');
  const baseURL = providerEndpoint(options.baseURL ?? 'https://api.openai.com/v1', '', 'openaiVoice()');
  const headers = providerHeaders(options.headers, ['Authorization', 'OpenAI-Organization', 'OpenAI-Project'], 'openaiVoice()');
  const maxAudioBytes = options.maxAudioBytes ?? 64 * 1_048_576; const defaultTimeout = options.timeoutMs ?? 120_000;
  assertPositiveInteger(maxAudioBytes, 'maxAudioBytes'); assertPositiveInteger(defaultTimeout, 'timeoutMs');
  const client = new OpenAI({
    apiKey: key, baseURL, organization: options.organization ?? null, project: options.project ?? null, defaultHeaders: headers,
    // Mayura owns retries and time limits; the SDK's logging, which OPENAI_LOG could switch on, stays off.
    maxRetries: 0, timeout: 2_147_483_647, logLevel: 'off',
    fetch: (input, init) => (options.fetch ?? globalThis.fetch)(input, init),
  });

  return Object.freeze({
    id: 'openai',
    catalog,
    transcriber(name: string, settings: TranscriberSettings): Transcriber {
      if (typeof name !== 'string' || !name.trim() || name.length > 128) throw new MayuraError('INVALID_CONFIG', 'openaiVoice() needs a model name.');
      const timeoutMs = settings.timeoutMs ?? defaultTimeout;
      const verbose = name === 'whisper-1';
      return Object.freeze({
        id: settings.id, maxCostMicros: settings.maxCostMicros,
        transcribe: async (request: TranscriptionRequest): Promise<Transcript> => {
          const extension = extensions[request.audio.mediaType];
          if (!extension) throw new VoiceProviderError('configuration');
          const call = deadline(timeoutMs, request.signal);
          try {
            const file = await toFile(request.audio.data, `audio.${extension}`, { type: request.audio.mediaType });
            const language = request.language?.split('-')[0]?.toLowerCase();
            const response = await client.audio.transcriptions.create({ model: name, file, response_format: verbose ? 'verbose_json' : 'json',
              ...(language ? { language } : {}), ...(request.prompt ? { prompt: request.prompt } : {}) }, { signal: call.signal }) as unknown as Record<string, unknown>;
            if (!response || typeof response['text'] !== 'string') throw new VoiceProviderError('invalid_response');
            // The audio billed: what the provider reports, or else the duration measured or given for the call.
            const usage = response['usage'] as { type?: string; seconds?: number } | undefined;
            const reported = usage?.type === 'duration' && typeof usage.seconds === 'number' ? usage.seconds : typeof response['duration'] === 'number' ? response['duration'] : undefined;
            if (reported !== undefined && (!Number.isFinite(reported) || reported < 0)) throw new VoiceProviderError('invalid_response');
            const audioMs = reported === undefined ? request.durationMs ?? 0 : Math.ceil(reported * 1_000);
            const segments: TranscriptSegment[] = [];
            for (const raw of Array.isArray(response['segments']) ? response['segments'] as Record<string, unknown>[] : []) {
              if (typeof raw['text'] !== 'string' || typeof raw['start'] !== 'number' || typeof raw['end'] !== 'number' || raw['end'] < raw['start'] || raw['start'] < 0) throw new VoiceProviderError('invalid_response');
              segments.push({ startMs: Math.round(raw['start'] * 1_000), endMs: Math.round(raw['end'] * 1_000), text: raw['text'].trim() });
            }
            const reportedLanguage = typeof response['language'] === 'string' && languageTag.test(response['language']) ? response['language'] : undefined;
            return { text: response['text'].trim(), ...(reportedLanguage ? { language: reportedLanguage } : {}), segments,
              usage: { audioMs, costMicros: transcriptionCostMicros(settings.pricing, audioMs) } };
          } catch (error) { return call.failure(error); } finally { call.done(); }
        },
      });
    },
    speaker(name: string, settings: SpeakerSettings): Speaker {
      if (typeof name !== 'string' || !name.trim() || name.length > 128) throw new MayuraError('INVALID_CONFIG', 'openaiVoice() needs a model name.');
      const timeoutMs = settings.timeoutMs ?? defaultTimeout;
      return Object.freeze({
        id: settings.id, maxCostMicros: settings.maxCostMicros,
        speak: async (request: SpeechRequest): Promise<Speech> => {
          const type = speechTypes[request.format ?? 'mp3'];
          const call = deadline(timeoutMs, request.signal);
          try {
            const response = await client.audio.speech.create({ model: name, voice: request.voice, input: request.text, response_format: type.format,
              ...(request.instructions ? { instructions: request.instructions } : {}) }, { signal: call.signal });
            // Speech is audio: a JSON body (an error answered with 200) is not.
            const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
            if (!contentType.startsWith('audio/') && !contentType.startsWith('application/octet-stream')) { void response.body?.cancel().catch(() => undefined); throw new VoiceProviderError('invalid_response'); }
            const length = response.headers.get('content-length');
            if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maxAudioBytes)) { void response.body?.cancel().catch(() => undefined); throw new VoiceProviderError('invalid_response'); }
            if (!response.body) throw new VoiceProviderError('invalid_response');
            const chunks: Uint8Array[] = []; let size = 0;
            const reader = response.body.getReader();
            for (;;) {
              const { done, value } = await reader.read(); if (done) break;
              size += value.byteLength;
              if (size > maxAudioBytes) { void reader.cancel().catch(() => undefined); throw new VoiceProviderError('invalid_response'); }
              chunks.push(value); request.onAudio?.(value);
            }
            if (size === 0) throw new VoiceProviderError('invalid_response');
            const data = new Uint8Array(size); let offset = 0;
            for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
            const characters = characterCount(request.text);
            return { audio: { data, mediaType: type.mediaType }, usage: { characters, costMicros: speechCostMicros(settings.pricing, characters) } };
          } catch (error) { return call.failure(error); } finally { call.done(); }
        },
      });
    },
  });
}
