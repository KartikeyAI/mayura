import { assertPositiveInteger, MayuraError } from 'mayura';
import { providerEndpoint, providerHeaders } from 'mayura/core/host';
import {
  characterCount, speechCostMicros, transcriptionCostMicros, voiceAudio, voiceCall, voiceJson, VoiceProviderError, voiceResponseFailure,
  type Speaker, type SpeakerSettings, type Speech, type SpeechFormat, type SpeechRequest, type Transcriber, type TranscriberSettings, type Transcript,
  type TranscriptionRequest, type TranscriptSegment, type VoiceCatalog, type VoiceProvider,
} from 'mayura/voice';

export interface DeepgramVoiceOptions {
  /** Your Deepgram API key. Required: nothing is read from the environment. */
  readonly apiKey: string;
  /** Send requests here instead of https://api.deepgram.com, for example a self-hosted or EU endpoint. It must be https. */
  readonly baseURL?: string;
  /** Extra headers, such as a gateway's credential. Treated as credentials. They cannot replace Authorization. */
  readonly headers?: Readonly<Record<string, string>>;
  /** The largest speech audio a call may return; 64 MiB by default. */
  readonly maxAudioBytes?: number;
  /** The largest transcription response; 16 MiB by default (word timings make long audio's responses large). */
  readonly maxResponseBytes?: number;
  /** How long one call may take unless the registry sets `timeoutMs` (default 120 s). */
  readonly timeoutMs?: number;
  /** A trusted transport for tests or proxies. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Deepgram's pay-as-you-go prices on 2026-09-30 for pre-recorded transcription and speech. Nova-3 costs more when it
 * transcribes several languages than one, and the model id is the same, so it is listed at its multilingual rate: a
 * catalog price may overcount, never undercount. Speech models are families (`aura-2`); the voice completes the model.
 */
export const catalog: VoiceCatalog = Object.freeze({
  asOf: '2026-09-30',
  transcribers: Object.freeze({
    'nova-3': Object.freeze({ pricing: Object.freeze({ microsPerMinute: 5_200 }) }),
    'whisper-large': Object.freeze({ pricing: Object.freeze({ microsPerMinute: 4_800 }) }),
  }),
  speakers: Object.freeze({
    'aura-2': Object.freeze({ pricing: Object.freeze({ microsPerMillionCharacters: 30_000_000 }) }),
    aura: Object.freeze({ pricing: Object.freeze({ microsPerMillionCharacters: 15_000_000 }) }),
  }),
});

const speechFormats: Readonly<Record<SpeechFormat, { query: string; mediaType: string }>> = {
  mp3: { query: 'encoding=mp3', mediaType: 'audio/mpeg' }, opus: { query: 'encoding=opus&container=ogg', mediaType: 'audio/ogg' },
  aac: { query: 'encoding=aac', mediaType: 'audio/aac' }, flac: { query: 'encoding=flac', mediaType: 'audio/flac' },
  wav: { query: 'encoding=linear16&container=wav', mediaType: 'audio/wav' }, pcm16: { query: 'encoding=linear16&container=none&sample_rate=24000', mediaType: 'audio/L16;rate=24000;channels=1' },
};
const voiceName = /^[a-z]+(?:-[a-z]{2}(?:-[A-Za-z]{2})?)?$/u;

/**
 * Deepgram speech-to-text and text-to-speech for a voice registry (`deepgramVoice({ apiKey })`, ids
 * `deepgram/<model>` such as `deepgram/nova-3` or `deepgram/aura-2`), over Deepgram's HTTP API with fetch. Speech ids
 * name a model family; the voice (`thalia-en`) completes it, as in `aura-2-thalia-en`. Without a language, transcription
 * detects it.
 */
export function deepgramVoice(options: DeepgramVoiceOptions): VoiceProvider {
  const key = options?.apiKey;
  if (typeof key !== 'string' || !key.trim() || /[\r\n]/u.test(key) || key.length > 4096) throw new MayuraError('INVALID_CONFIG', 'deepgramVoice() needs an apiKey.');
  const baseURL = providerEndpoint(options.baseURL ?? 'https://api.deepgram.com', '', 'deepgramVoice()').replace(/\/$/u, '');
  const headers = providerHeaders(options.headers, ['Authorization'], 'deepgramVoice()');
  const maxAudioBytes = options.maxAudioBytes ?? 64 * 1_048_576; const maxResponseBytes = options.maxResponseBytes ?? 16 * 1_048_576;
  const defaultTimeout = options.timeoutMs ?? 120_000;
  for (const [value, name] of [[maxAudioBytes, 'maxAudioBytes'], [maxResponseBytes, 'maxResponseBytes'], [defaultTimeout, 'timeoutMs']] as const) assertPositiveInteger(value, name);
  const send = (path: string, init: RequestInit) => (options.fetch ?? globalThis.fetch)(`${baseURL}${path}`, { ...init, redirect: 'error', headers: { ...headers, authorization: `Token ${key}`, ...init.headers } });
  const model = (name: string) => {
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,63}$/u.test(name)) throw new MayuraError('INVALID_CONFIG', 'deepgramVoice() needs a model, such as nova-3 or aura-2.');
    return name;
  };

  return Object.freeze({
    id: 'deepgram',
    catalog,
    transcriber(name: string, settings: TranscriberSettings): Transcriber {
      const modelId = model(name); const timeoutMs = settings.timeoutMs ?? defaultTimeout;
      return Object.freeze({
        id: settings.id, maxCostMicros: settings.maxCostMicros,
        transcribe: async (request: TranscriptionRequest): Promise<Transcript> => {
          const call = voiceCall(timeoutMs, request.signal);
          try {
            const query = new URLSearchParams({ model: modelId, smart_format: 'true', ...(request.language ? { language: request.language } : { detect_language: 'true' }) });
            const response = await send(`/v1/listen?${query}`, { method: 'POST', signal: call.signal, headers: { 'content-type': request.audio.mediaType }, body: request.audio.data as BodyInit });
            if (!response.ok) throw voiceResponseFailure(response);
            const body = await voiceJson(response, maxResponseBytes) as { metadata?: { duration?: unknown }; results?: { channels?: unknown } };
            const channel = Array.isArray(body?.results?.channels) ? body.results.channels[0] as { alternatives?: unknown; detected_language?: unknown } | undefined : undefined;
            const best = Array.isArray(channel?.alternatives) ? channel.alternatives[0] as { transcript?: unknown; words?: unknown } | undefined : undefined;
            if (!best || typeof best.transcript !== 'string' || (best.words !== undefined && !Array.isArray(best.words))) throw new VoiceProviderError('invalid_response');
            const segments: TranscriptSegment[] = [];
            for (const word of (best.words ?? []) as Record<string, unknown>[]) {
              const text = typeof word['punctuated_word'] === 'string' ? word['punctuated_word'] : word['word'];
              if (typeof text !== 'string' || typeof word['start'] !== 'number' || typeof word['end'] !== 'number' || word['start'] < 0 || word['end'] < word['start']) throw new VoiceProviderError('invalid_response');
              segments.push({ startMs: Math.round(word['start'] * 1_000), endMs: Math.round(word['end'] * 1_000), text,
                ...(typeof word['speaker'] === 'number' ? { speaker: String(word['speaker']) } : {}) });
            }
            const duration = body.metadata?.duration;
            const reported = typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : undefined;
            const audioMs = reported === undefined ? request.durationMs ?? 0 : Math.ceil(reported * 1_000);
            const detected = typeof channel?.detected_language === 'string' && /^[a-z]{2,3}(?:-[A-Za-z]{2})?$/u.test(channel.detected_language) ? channel.detected_language : undefined;
            const language = request.language ?? detected;
            return { text: best.transcript.trim(), ...(language ? { language } : {}), segments, usage: { audioMs, costMicros: transcriptionCostMicros(settings.pricing, audioMs) } };
          } catch (error) { return call.failure(error); } finally { call.done(); }
        },
      });
    },
    speaker(name: string, settings: SpeakerSettings): Speaker {
      const family = model(name); const timeoutMs = settings.timeoutMs ?? defaultTimeout;
      return Object.freeze({
        id: settings.id, maxCostMicros: settings.maxCostMicros,
        speak: async (request: SpeechRequest): Promise<Speech> => {
          const format = speechFormats[request.format ?? 'mp3'];
          if (!voiceName.test(request.voice)) throw new VoiceProviderError('configuration');
          const call = voiceCall(timeoutMs, request.signal);
          try {
            const response = await send(`/v1/speak?model=${encodeURIComponent(`${family}-${request.voice}`)}&${format.query}`, {
              method: 'POST', signal: call.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: request.text }),
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
