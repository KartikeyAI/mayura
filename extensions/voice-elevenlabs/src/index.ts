import { assertPositiveInteger, MayuraError } from 'mayura';
import { providerEndpoint, providerHeaders } from 'mayura/core/host';
import {
  characterCount, speechCostMicros, transcriptionCostMicros, voiceAudio, voiceCall, voiceJson, VoiceProviderError, voiceResponseFailure,
  type Speaker, type SpeakerSettings, type Speech, type SpeechFormat, type SpeechRequest, type Transcriber, type TranscriberSettings, type Transcript,
  type TranscriptionRequest, type TranscriptSegment, type VoiceCatalog, type VoiceProvider,
} from 'mayura/voice';

export interface ElevenLabsVoiceOptions {
  /** Your ElevenLabs API key. Required: nothing is read from the environment. */
  readonly apiKey: string;
  /**
   * Send requests here instead of https://api.elevenlabs.io, for example a data-residency endpoint such as
   * https://api.eu.residency.elevenlabs.io. It must be https.
   */
  readonly baseURL?: string;
  /** Extra headers, such as a gateway's credential. Treated as credentials. They cannot replace xi-api-key. */
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

const perThousand = (dollars: number) => Object.freeze({ pricing: Object.freeze({ microsPerMillionCharacters: Math.round(dollars * 1_000_000_000) }) });
/**
 * ElevenLabs' pay-as-you-go API prices on 2026-09-30, the same on every plan. Promotional prices are left out: v4 and v4
 * Turbo are listed at their regular rates. Scribe v2 is $0.22 per hour, rounded up to the micro per minute.
 */
export const catalog: VoiceCatalog = Object.freeze({
  asOf: '2026-09-30',
  transcribers: Object.freeze({ scribe_v2: Object.freeze({ pricing: Object.freeze({ microsPerMinute: 3_667 }) }) }),
  speakers: Object.freeze({
    eleven_v4: perThousand(0.08), eleven_v4_turbo: perThousand(0.04), eleven_v3: perThousand(0.08), eleven_v3_conversational: perThousand(0.04),
    eleven_multilingual_v2: perThousand(0.08), eleven_flash_v2_5: perThousand(0.04),
  }),
});

const speechFormats: Readonly<Partial<Record<SpeechFormat, { query: string; mediaType: string }>>> = {
  mp3: { query: 'mp3_44100_128', mediaType: 'audio/mpeg' }, opus: { query: 'opus_48000_128', mediaType: 'audio/ogg' },
  wav: { query: 'wav_44100', mediaType: 'audio/wav' }, pcm16: { query: 'pcm_24000', mediaType: 'audio/L16;rate=24000;channels=1' },
};
const voiceId = /^[A-Za-z0-9]{1,64}$/u;

/**
 * ElevenLabs speech-to-text and text-to-speech for a voice registry (`elevenlabsVoice({ apiKey })`, ids
 * `elevenlabs/<model>` such as `elevenlabs/eleven_v3` or `elevenlabs/scribe_v2`), over ElevenLabs' HTTP API with fetch.
 * The official SDK is not used: it depends on node-fetch, ws and command-exists, which runs shell commands to find media
 * players. Speech streams through `onAudio`; the voice is an ElevenLabs voice id.
 */
export function elevenlabsVoice(options: ElevenLabsVoiceOptions): VoiceProvider {
  const key = options?.apiKey;
  if (typeof key !== 'string' || !key.trim() || /[\r\n]/u.test(key) || key.length > 4096) throw new MayuraError('INVALID_CONFIG', 'elevenlabsVoice() needs an apiKey.');
  const baseURL = providerEndpoint(options.baseURL ?? 'https://api.elevenlabs.io', '', 'elevenlabsVoice()').replace(/\/$/u, '');
  const headers = providerHeaders(options.headers, ['xi-api-key'], 'elevenlabsVoice()');
  const maxAudioBytes = options.maxAudioBytes ?? 64 * 1_048_576; const maxResponseBytes = options.maxResponseBytes ?? 16 * 1_048_576;
  const defaultTimeout = options.timeoutMs ?? 120_000;
  for (const [value, name] of [[maxAudioBytes, 'maxAudioBytes'], [maxResponseBytes, 'maxResponseBytes'], [defaultTimeout, 'timeoutMs']] as const) assertPositiveInteger(value, name);
  const send = (path: string, init: RequestInit) => (options.fetch ?? globalThis.fetch)(`${baseURL}${path}`, { ...init, redirect: 'error', headers: { ...headers, 'xi-api-key': key, ...init.headers } });
  const model = (name: string) => {
    if (typeof name !== 'string' || !/^[a-z0-9_.-]{1,64}$/u.test(name)) throw new MayuraError('INVALID_CONFIG', 'elevenlabsVoice() needs a model id, such as eleven_v3.');
    return name;
  };

  return Object.freeze({
    id: 'elevenlabs',
    catalog,
    transcriber(name: string, settings: TranscriberSettings): Transcriber {
      const modelId = model(name); const timeoutMs = settings.timeoutMs ?? defaultTimeout;
      return Object.freeze({
        id: settings.id, maxCostMicros: settings.maxCostMicros,
        transcribe: async (request: TranscriptionRequest): Promise<Transcript> => {
          const call = voiceCall(timeoutMs, request.signal);
          try {
            const form = new FormData();
            form.set('model_id', modelId);
            form.set('file', new Blob([request.audio.data as BlobPart], { type: request.audio.mediaType }), 'audio');
            const language = request.language?.split('-')[0]?.toLowerCase(); if (language) form.set('language_code', language);
            form.set('timestamps_granularity', 'word');
            const response = await send('/v1/speech-to-text', { method: 'POST', body: form, signal: call.signal });
            if (!response.ok) throw voiceResponseFailure(response);
            // 202 answers a multichannel or webhook request, which this adapter never makes.
            if (response.status !== 200) throw new VoiceProviderError('invalid_response');
            const body = await voiceJson(response, maxResponseBytes) as { text?: unknown; language_code?: unknown; words?: unknown; audio_duration_secs?: unknown };
            if (!body || typeof body.text !== 'string' || (body.words !== undefined && !Array.isArray(body.words))) throw new VoiceProviderError('invalid_response');
            const segments: TranscriptSegment[] = [];
            for (const word of (body.words ?? []) as Record<string, unknown>[]) {
              if (word['type'] !== 'word') continue;
              if (typeof word['text'] !== 'string' || typeof word['start'] !== 'number' || typeof word['end'] !== 'number' || word['start'] < 0 || word['end'] < word['start']) throw new VoiceProviderError('invalid_response');
              segments.push({ startMs: Math.round(word['start'] * 1_000), endMs: Math.round(word['end'] * 1_000), text: word['text'],
                ...(typeof word['speaker_id'] === 'string' ? { speaker: word['speaker_id'] } : {}) });
            }
            const reported = typeof body.audio_duration_secs === 'number' && Number.isFinite(body.audio_duration_secs) && body.audio_duration_secs >= 0 ? body.audio_duration_secs : undefined;
            const audioMs = reported === undefined ? request.durationMs ?? 0 : Math.ceil(reported * 1_000);
            return { text: body.text.trim(), ...(typeof body.language_code === 'string' && /^[a-z]{2,3}$/u.test(body.language_code) ? { language: body.language_code } : {}),
              segments, usage: { audioMs, costMicros: transcriptionCostMicros(settings.pricing, audioMs) } };
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
          const call = voiceCall(timeoutMs, request.signal);
          try {
            const language = request.language?.split('-')[0]?.toLowerCase();
            const response = await send(`/v1/text-to-speech/${request.voice}/stream?output_format=${format.query}`, {
              method: 'POST', signal: call.signal, headers: { 'content-type': 'application/json', accept: format.mediaType.split(';')[0]! },
              body: JSON.stringify({ text: request.text, model_id: modelId, ...(language ? { language_code: language } : {}) }),
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
