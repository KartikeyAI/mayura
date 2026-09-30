import { assertPositiveInteger, MayuraError } from 'mayura';
import { providerEndpoint, providerHeaders, utf8ByteLength } from 'mayura/core/host';
import {
  audioFromBase64, audioToBase64, characterCount, speechCostMicros, transcriptionCostMicros, voiceCall, voiceJson, VoiceProviderError, voiceResponseFailure,
  type Speaker, type SpeakerSettings, type Speech, type SpeechFormat, type SpeechRequest, type Transcriber, type TranscriberSettings, type Transcript,
  type TranscriptionRequest, type TranscriptSegment, type VoiceCatalog, type VoiceProvider,
} from 'mayura/voice';

export interface GoogleVoiceOptions {
  /** A Google Cloud API key, sent as `x-goog-api-key`. Give this or `token`. Nothing is read from the environment. */
  readonly apiKey?: string;
  /**
   * An OAuth access token source, such as a service account's through `google-auth-library`
   * (`() => auth.getAccessToken()`), sent as a bearer token. Give this or `apiKey`. Called once per request.
   */
  readonly token?: () => string | Promise<string>;
  /** The Google Cloud project id or number transcription runs in. Required for transcription. */
  readonly project?: string;
  /** The Speech-to-Text location, such as `us`, `eu` or `global`; `us` by default (Chirp 3 is served in `us` and `eu`). */
  readonly location?: string;
  /** Send transcription requests here instead of `https://<location>-speech.googleapis.com`. It must be https. */
  readonly speechToTextURL?: string;
  /** Send speech requests here instead of `https://texttospeech.googleapis.com`. It must be https. */
  readonly textToSpeechURL?: string;
  /** Extra headers, such as `x-goog-user-project` or a gateway's credential. Treated as credentials. They cannot replace Authorization or x-goog-api-key. */
  readonly headers?: Readonly<Record<string, string>>;
  /** The largest speech audio a call may return; 32 MiB by default. */
  readonly maxAudioBytes?: number;
  /** The largest transcription response; 4 MiB by default. */
  readonly maxResponseBytes?: number;
  /** How long one call may take unless the registry sets `timeoutMs` (default 120 s). */
  readonly timeoutMs?: number;
  /** A trusted transport for tests or proxies. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Google Cloud's list prices on 2026-09-30. Transcription is Speech-to-Text v2's standard recognition at its first volume
 * tier (later tiers cost less, so the price may overcount, never undercount). Speech ids are voice families at their
 * per-character prices, before the monthly free characters. Gemini voices, billed per token, and instant custom voices
 * are left out.
 */
export const catalog: VoiceCatalog = Object.freeze({
  asOf: '2026-09-30',
  transcribers: Object.freeze({
    chirp_3: Object.freeze({ pricing: Object.freeze({ microsPerMinute: 16_000 }) }),
    chirp_2: Object.freeze({ pricing: Object.freeze({ microsPerMinute: 16_000 }) }),
    telephony: Object.freeze({ pricing: Object.freeze({ microsPerMinute: 16_000 }) }),
  }),
  speakers: Object.freeze({
    'chirp3-hd': Object.freeze({ pricing: Object.freeze({ microsPerMillionCharacters: 30_000_000 }) }),
    studio: Object.freeze({ pricing: Object.freeze({ microsPerMillionCharacters: 160_000_000 }) }),
    neural2: Object.freeze({ pricing: Object.freeze({ microsPerMillionCharacters: 16_000_000 }) }),
    polyglot: Object.freeze({ pricing: Object.freeze({ microsPerMillionCharacters: 16_000_000 }) }),
    wavenet: Object.freeze({ pricing: Object.freeze({ microsPerMillionCharacters: 4_000_000 }) }),
    standard: Object.freeze({ pricing: Object.freeze({ microsPerMillionCharacters: 4_000_000 }) }),
  }),
});

/** Each speech family's part of Google's voice names (`en-US-Chirp3-HD-Charon`): a voice must belong to the family priced. */
const families: Readonly<Record<string, string>> = { 'chirp3-hd': 'Chirp3-HD', studio: 'Studio', neural2: 'Neural2', polyglot: 'Polyglot', wavenet: 'Wavenet', standard: 'Standard' };
const speechFormats: Readonly<Partial<Record<SpeechFormat, { encoding: string; mediaType: string; sampleRateHertz?: number }>>> = {
  mp3: { encoding: 'MP3', mediaType: 'audio/mpeg' }, opus: { encoding: 'OGG_OPUS', mediaType: 'audio/ogg' }, aac: { encoding: 'M4A', mediaType: 'audio/mp4' },
  wav: { encoding: 'LINEAR16', mediaType: 'audio/wav' }, pcm16: { encoding: 'PCM', mediaType: 'audio/L16;rate=24000;channels=1', sampleRateHertz: 24_000 },
};
/** Synchronous recognition takes under a minute of audio and 10 MB inline; speech takes 5,000 bytes of text. */
const maxRecognizeMs = 60_000; const maxRecognizeBytes = 10 * 1_048_576; const maxSpeechTextBytes = 5_000;

/** A protobuf duration (`"3.5s"`) in milliseconds, rounded up; undefined when it is not one. */
function durationMs(value: unknown): number | undefined {
  const match = typeof value === 'string' ? /^(\d{1,9})(?:\.(\d{1,9}))?s$/u.exec(value) : null;
  if (!match) return undefined;
  const nanos = Number((match[2] ?? '').padEnd(9, '0'));
  return Number(match[1]) * 1_000 + Math.ceil(nanos / 1_000_000);
}
function languageTag(value: unknown): string | undefined {
  const match = typeof value === 'string' ? /^([A-Za-z]{2,3})(?:[-_]([A-Za-z]{2}|\d{3}))?$/u.exec(value) : null;
  return match ? `${match[1]!.toLowerCase()}${match[2] ? `-${match[2].toUpperCase()}` : ''}` : undefined;
}

/**
 * Google Cloud Speech-to-Text and Text-to-Speech for a voice registry (`googleVoice({ token, project })`, ids
 * `google/<model>` such as `google/chirp_3` or `google/chirp3-hd`), over Google's HTTP APIs with fetch.
 *
 * Transcription uses Speech-to-Text v2's synchronous recognition, which takes up to a minute of audio; longer audio is
 * refused before anything is sent. Without a language, Chirp 3 detects it; other models need one. Speech ids name a
 * voice family, and the voice must be one of it (`google/chirp3-hd` with `en-US-Chirp3-HD-Charon`), so a voice is never
 * charged at another family's price.
 */
export function googleVoice(options: GoogleVoiceOptions): VoiceProvider {
  const key = options?.apiKey; const token = options?.token;
  if (key !== undefined && (typeof key !== 'string' || !key.trim() || /[\r\n]/u.test(key) || key.length > 4096)) throw new MayuraError('INVALID_CONFIG', 'googleVoice(): apiKey must be a bounded header value.');
  if (token !== undefined && typeof token !== 'function') throw new MayuraError('INVALID_CONFIG', 'googleVoice(): token must be a function returning an access token.');
  if ((key === undefined) === (token === undefined)) throw new MayuraError('INVALID_CONFIG', 'googleVoice() needs an apiKey or a token source, not both.');
  const project = options.project;
  if (project !== undefined && (typeof project !== 'string' || !/^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|\d{1,20})$/u.test(project))) throw new MayuraError('INVALID_CONFIG', 'googleVoice(): project must be a Google Cloud project id or number.');
  const location = options.location ?? 'us';
  if (typeof location !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/u.test(location)) throw new MayuraError('INVALID_CONFIG', 'googleVoice(): location must be a Speech-to-Text location, such as us, eu or global.');
  const speechToText = providerEndpoint(options.speechToTextURL ?? `https://${location === 'global' ? '' : `${location}-`}speech.googleapis.com`, '', 'googleVoice()').replace(/\/$/u, '');
  const textToSpeech = providerEndpoint(options.textToSpeechURL ?? 'https://texttospeech.googleapis.com', '', 'googleVoice()').replace(/\/$/u, '');
  const headers = providerHeaders(options.headers, ['Authorization', 'x-goog-api-key'], 'googleVoice()');
  const maxAudioBytes = options.maxAudioBytes ?? 32 * 1_048_576; const maxResponseBytes = options.maxResponseBytes ?? 4 * 1_048_576;
  const defaultTimeout = options.timeoutMs ?? 120_000;
  for (const [value, name] of [[maxAudioBytes, 'maxAudioBytes'], [maxResponseBytes, 'maxResponseBytes'], [defaultTimeout, 'timeoutMs']] as const) assertPositiveInteger(value, name);

  const credential = async (): Promise<Record<string, string>> => {
    if (key !== undefined) return { 'x-goog-api-key': key };
    let value: unknown;
    try { value = await token!(); } catch { throw new VoiceProviderError('authentication'); }
    if (typeof value !== 'string' || !value.trim() || /[\r\n]/u.test(value) || value.length > 8_192) throw new VoiceProviderError('authentication');
    return { authorization: `Bearer ${value}` };
  };
  const send = async (url: string, body: unknown, signal: AbortSignal) => (options.fetch ?? globalThis.fetch)(url, {
    method: 'POST', signal, redirect: 'error', headers: { ...headers, ...await credential(), 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  return Object.freeze({
    id: 'google',
    catalog,
    transcriber(name: string, settings: TranscriberSettings): Transcriber {
      if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/u.test(name)) throw new MayuraError('INVALID_CONFIG', 'googleVoice() needs a transcription model, such as chirp_3.');
      if (project === undefined) throw new MayuraError('INVALID_CONFIG', 'googleVoice() needs a project to transcribe.');
      const timeoutMs = settings.timeoutMs ?? defaultTimeout;
      const url = `${speechToText}/v2/projects/${project}/locations/${location}/recognizers/_:recognize`;
      // Chirp 3 has no word timings in synchronous recognition: its segments are the recognized results.
      const wordTimes = name !== 'chirp_3';
      return Object.freeze({
        id: settings.id, maxCostMicros: settings.maxCostMicros,
        transcribe: async (request: TranscriptionRequest): Promise<Transcript> => {
          if ((request.durationMs ?? 0) > maxRecognizeMs || request.audio.data.byteLength > maxRecognizeBytes) {
            throw new MayuraError('LIMIT_EXCEEDED', 'googleVoice() transcribes at most 60 seconds and 10 MB of audio per call.');
          }
          const call = voiceCall(timeoutMs, request.signal);
          try {
            const response = await send(url, {
              config: { autoDecodingConfig: {}, model: name, languageCodes: [request.language ?? 'auto'], ...(wordTimes ? { features: { enableWordTimeOffsets: true } } : {}) },
              content: audioToBase64(request.audio.data),
            }, call.signal);
            if (!response.ok) throw voiceResponseFailure(response);
            const body = await voiceJson(response, maxResponseBytes) as { results?: unknown; metadata?: { totalBilledDuration?: unknown } } | null;
            if (!body || typeof body !== 'object' || (body.results !== undefined && !Array.isArray(body.results))) throw new VoiceProviderError('invalid_response');
            const texts: string[] = []; const segments: TranscriptSegment[] = []; let detected: string | undefined; let previousEnd = 0;
            for (const result of (body.results ?? []) as Record<string, unknown>[]) {
              const best = Array.isArray(result?.['alternatives']) ? result['alternatives'][0] as Record<string, unknown> | undefined : undefined;
              const end = result?.['resultEndOffset'] === undefined ? previousEnd : durationMs(result['resultEndOffset']);
              if (!best && end !== undefined) continue;
              if (!best || typeof best['transcript'] !== 'string' || end === undefined || (best['words'] !== undefined && !Array.isArray(best['words']))) throw new VoiceProviderError('invalid_response');
              const text = best['transcript'].trim();
              detected ??= languageTag(result['languageCode']);
              if (text) texts.push(text);
              const words = (best['words'] ?? []) as Record<string, unknown>[];
              for (const word of words) {
                const startMs = durationMs(word['startOffset'] ?? '0s'); const endMs = durationMs(word['endOffset'] ?? '0s');
                if (typeof word['word'] !== 'string' || startMs === undefined || endMs === undefined || endMs < startMs) throw new VoiceProviderError('invalid_response');
                segments.push({ startMs, endMs, text: word['word'], ...(typeof word['speakerLabel'] === 'string' && word['speakerLabel'] ? { speaker: word['speakerLabel'] } : {}) });
              }
              if (!words.length && text) segments.push({ startMs: Math.min(previousEnd, end), endMs: end, text });
              previousEnd = Math.max(previousEnd, end);
            }
            // Google bills each request rounded up to a whole second.
            const billed = durationMs(body.metadata?.totalBilledDuration);
            const audioMs = billed ?? Math.ceil((request.durationMs ?? 0) / 1_000) * 1_000;
            const language = request.language ?? detected;
            return { text: texts.join(' '), ...(language ? { language } : {}), segments, usage: { audioMs, costMicros: transcriptionCostMicros(settings.pricing, audioMs) } };
          } catch (error) { return call.failure(error); } finally { call.done(); }
        },
      });
    },
    speaker(name: string, settings: SpeakerSettings): Speaker {
      const marker = typeof name === 'string' && Object.hasOwn(families, name) ? families[name]! : undefined;
      if (marker === undefined) throw new MayuraError('INVALID_CONFIG', `googleVoice() speaks with a voice family: ${Object.keys(families).join(', ')}.`);
      const voiceName = new RegExp(`^([a-z]{2,3}-[A-Z]{2})-${marker}-[A-Za-z0-9]{1,32}$`, 'u');
      const timeoutMs = settings.timeoutMs ?? defaultTimeout;
      return Object.freeze({
        id: settings.id, maxCostMicros: settings.maxCostMicros,
        speak: async (request: SpeechRequest): Promise<Speech> => {
          const format = speechFormats[request.format ?? 'mp3'];
          const voice = voiceName.exec(request.voice);
          if (!format || !voice) throw new VoiceProviderError('configuration');
          if (utf8ByteLength(request.text) > maxSpeechTextBytes) throw new MayuraError('LIMIT_EXCEEDED', 'googleVoice() speaks at most 5,000 bytes of text per call.');
          const call = voiceCall(timeoutMs, request.signal);
          try {
            const response = await send(`${textToSpeech}/v1/text:synthesize`, {
              input: { text: request.text }, voice: { languageCode: voice[1], name: request.voice },
              audioConfig: { audioEncoding: format.encoding, ...(format.sampleRateHertz ? { sampleRateHertz: format.sampleRateHertz } : {}) },
            }, call.signal);
            if (!response.ok) throw voiceResponseFailure(response);
            const body = await voiceJson(response, Math.ceil(maxAudioBytes / 3) * 4 + 4_096) as { audioContent?: unknown } | null;
            if (typeof body?.audioContent !== 'string' || !body.audioContent) throw new VoiceProviderError('invalid_response');
            const data = audioFromBase64(body.audioContent);
            if (data.byteLength === 0 || data.byteLength > maxAudioBytes) throw new VoiceProviderError('invalid_response');
            request.onAudio?.(data);
            const characters = characterCount(request.text);
            return { audio: { data, mediaType: format.mediaType }, usage: { characters, costMicros: speechCostMicros(settings.pricing, characters) } };
          } catch (error) { return call.failure(error); } finally { call.done(); }
        },
      });
    },
  });
}
