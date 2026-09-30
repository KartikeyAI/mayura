import { assertPositiveInteger, MayuraError } from 'mayura';
import { providerEndpoint, providerHeaders } from 'mayura/core/host';
import {
  characterCount, speechCostMicros, transcriptionCostMicros, voiceAudio, voiceCall, voiceJson, VoiceProviderError, voiceResponseFailure,
  type Speaker, type SpeakerSettings, type Speech, type SpeechFormat, type SpeechRequest, type Transcriber, type TranscriberSettings, type Transcript,
  type TranscriptionRequest, type TranscriptSegment, type VoiceCatalog, type VoiceProvider,
} from 'mayura/voice';

export interface CartesiaVoiceOptions {
  /** Your Cartesia API key (`sk_car_...`), sent as a bearer token. Required: nothing is read from the environment. */
  readonly apiKey: string;
  /** Send requests here instead of https://api.cartesia.ai. It must be https. */
  readonly baseURL?: string;
  /** Extra headers, such as a gateway's credential. Treated as credentials. They cannot replace Authorization or Cartesia-Version. */
  readonly headers?: Readonly<Record<string, string>>;
  /** The largest speech audio a call may return; 64 MiB by default. */
  readonly maxAudioBytes?: number;
  /** The largest transcription response; 16 MiB by default. */
  readonly maxResponseBytes?: number;
  /** How long one call may take unless the registry sets `timeoutMs` (default 120 s). */
  readonly timeoutMs?: number;
  /** A trusted transport for tests or proxies. */
  readonly fetch?: typeof globalThis.fetch;
}

/** The API version the adapter speaks; Cartesia requires it on every request. */
export const cartesiaVersion = '2026-08-14';

/**
 * Cartesia's prices on 2026-09-30. Cartesia bills in credits: a character of speech is one credit, a second of
 * transcribed audio three. Credits cost least in a plan's allowance and most as Pro overage, $65 per million, so the
 * catalog uses that rate and may overcount, never undercount: $65 per million characters, $0.0117 a minute.
 */
export const catalog: VoiceCatalog = Object.freeze({
  asOf: '2026-09-30',
  transcribers: Object.freeze({
    'ink-whisper': Object.freeze({ pricing: Object.freeze({ microsPerMinute: 11_700 }) }),
  }),
  speakers: Object.freeze({
    'sonic-3.6': Object.freeze({ pricing: Object.freeze({ microsPerMillionCharacters: 65_000_000 }) }),
    'sonic-3.5': Object.freeze({ pricing: Object.freeze({ microsPerMillionCharacters: 65_000_000 }) }),
    'sonic-3': Object.freeze({ pricing: Object.freeze({ microsPerMillionCharacters: 65_000_000 }) }),
    'sonic-latest': Object.freeze({ pricing: Object.freeze({ microsPerMillionCharacters: 65_000_000 }) }),
  }),
});

const speechFormats: Readonly<Partial<Record<SpeechFormat, { outputFormat: Record<string, unknown>; mediaType: string }>>> = {
  mp3: { outputFormat: { container: 'mp3', sample_rate: 44_100, bit_rate: 128_000 }, mediaType: 'audio/mpeg' },
  wav: { outputFormat: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 24_000 }, mediaType: 'audio/wav' },
  pcm16: { outputFormat: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24_000 }, mediaType: 'audio/L16;rate=24000;channels=1' },
};
const voiceId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Cartesia speech-to-text and text-to-speech for a voice registry (`cartesiaVoice({ apiKey })`, ids
 * `cartesia/<model>` such as `cartesia/sonic-3.6` or `cartesia/ink-whisper`), over Cartesia's HTTP API with fetch. The
 * voice is a Cartesia voice id. Without a language, Cartesia transcribes as English: it does not detect one.
 */
export function cartesiaVoice(options: CartesiaVoiceOptions): VoiceProvider {
  const key = options?.apiKey;
  if (typeof key !== 'string' || !key.trim() || /[\r\n]/u.test(key) || key.length > 4096) throw new MayuraError('INVALID_CONFIG', 'cartesiaVoice() needs an apiKey.');
  const baseURL = providerEndpoint(options.baseURL ?? 'https://api.cartesia.ai', '', 'cartesiaVoice()').replace(/\/$/u, '');
  const headers = providerHeaders(options.headers, ['Authorization', 'Cartesia-Version'], 'cartesiaVoice()');
  const maxAudioBytes = options.maxAudioBytes ?? 64 * 1_048_576; const maxResponseBytes = options.maxResponseBytes ?? 16 * 1_048_576;
  const defaultTimeout = options.timeoutMs ?? 120_000;
  for (const [value, name] of [[maxAudioBytes, 'maxAudioBytes'], [maxResponseBytes, 'maxResponseBytes'], [defaultTimeout, 'timeoutMs']] as const) assertPositiveInteger(value, name);
  const send = (path: string, init: RequestInit & { headers?: Record<string, string> }) => (options.fetch ?? globalThis.fetch)(`${baseURL}${path}`, {
    ...init, method: 'POST', redirect: 'error', headers: { ...headers, authorization: `Bearer ${key}`, 'cartesia-version': cartesiaVersion, ...init.headers },
  });
  const model = (name: string) => {
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,63}$/u.test(name)) throw new MayuraError('INVALID_CONFIG', 'cartesiaVoice() needs a model, such as sonic-3.6 or ink-whisper.');
    return name;
  };

  return Object.freeze({
    id: 'cartesia',
    catalog,
    transcriber(name: string, settings: TranscriberSettings): Transcriber {
      const modelId = model(name); const timeoutMs = settings.timeoutMs ?? defaultTimeout;
      return Object.freeze({
        id: settings.id, maxCostMicros: settings.maxCostMicros,
        transcribe: async (request: TranscriptionRequest): Promise<Transcript> => {
          const language = request.language?.split('-')[0]?.toLowerCase();
          if (language !== undefined && !/^[a-z]{2,3}$/u.test(language)) throw new VoiceProviderError('configuration');
          const call = voiceCall(timeoutMs, request.signal);
          try {
            const form = new FormData();
            form.append('file', new Blob([request.audio.data as BlobPart], { type: request.audio.mediaType }), 'audio');
            form.append('model', modelId);
            if (language) form.append('language', language);
            form.append('timestamp_granularities[]', 'word');
            const response = await send('/stt', { signal: call.signal, body: form });
            if (!response.ok) throw voiceResponseFailure(response);
            const body = await voiceJson(response, maxResponseBytes) as { text?: unknown; language?: unknown; duration?: unknown; words?: unknown } | null;
            if (typeof body?.text !== 'string' || (body.words !== undefined && body.words !== null && !Array.isArray(body.words))) throw new VoiceProviderError('invalid_response');
            const segments: TranscriptSegment[] = [];
            for (const word of (body.words ?? []) as Record<string, unknown>[]) {
              const start = word?.['start']; const end = word?.['end'];
              if (typeof word?.['word'] !== 'string' || typeof start !== 'number' || typeof end !== 'number' || !(start >= 0) || !(end >= start) || !Number.isFinite(end)) throw new VoiceProviderError('invalid_response');
              segments.push({ startMs: Math.round(start * 1_000), endMs: Math.round(end * 1_000), text: word['word'] });
            }
            // Cartesia bills three credits a second: whole seconds, rounded up.
            const duration = body.duration;
            const reported = typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : undefined;
            const audioMs = Math.ceil((reported === undefined ? (request.durationMs ?? 0) / 1_000 : reported)) * 1_000;
            const detected = typeof body.language === 'string' && /^[a-z]{2,3}$/u.test(body.language) ? body.language : undefined;
            const reportedLanguage = request.language ?? detected;
            return { text: body.text.trim(), ...(reportedLanguage ? { language: reportedLanguage } : {}), segments, usage: { audioMs, costMicros: transcriptionCostMicros(settings.pricing, audioMs) } };
          } catch (error) { return call.failure(error); } finally { call.done(); }
        },
      });
    },
    speaker(name: string, settings: SpeakerSettings): Speaker {
      const modelId = model(name); const timeoutMs = settings.timeoutMs ?? defaultTimeout;
      return Object.freeze({
        id: settings.id, maxCostMicros: settings.maxCostMicros,
        speak: async (request: SpeechRequest): Promise<Speech> => {
          const format = speechFormats[request.format ?? 'mp3'];
          if (!format || !voiceId.test(request.voice)) throw new VoiceProviderError('configuration');
          const language = request.language;
          if (language !== undefined && !/^[a-z]{2,3}(?:-[A-Z]{2})?$/u.test(language)) throw new VoiceProviderError('configuration');
          const call = voiceCall(timeoutMs, request.signal);
          try {
            const response = await send('/tts/bytes', {
              signal: call.signal, headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ model_id: modelId, transcript: request.text, voice: { mode: 'id', id: request.voice }, output_format: format.outputFormat,
                ...(language ? language.includes('-') ? { locale: language } : { language } : {}) }),
            });
            if (!response.ok) throw voiceResponseFailure(response);
            const data = await voiceAudio(response, maxAudioBytes, request.onAudio);
            const characters = characterCount(request.text);
            return { audio: { data, mediaType: format.mediaType }, usage: { characters, costMicros: speechCostMicros(settings.pricing, characters) } };
          } catch (error) { return call.failure(error); } finally { call.done(); }
        },
      });
    },
  });
}
