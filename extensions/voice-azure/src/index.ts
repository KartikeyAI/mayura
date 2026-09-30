import { assertPositiveInteger, MayuraError } from 'mayura';
import { providerEndpoint, providerHeaders } from 'mayura/core/host';
import {
  characterCount, speechCostMicros, transcriptionCostMicros, voiceAudio, voiceCall, voiceJson, VoiceProviderError, voiceResponseFailure,
  type Speaker, type SpeakerSettings, type Speech, type SpeechFormat, type SpeechPricing, type SpeechRequest, type Transcriber, type TranscriberSettings,
  type Transcript, type TranscriptionRequest, type TranscriptSegment, type VoiceCatalog, type VoiceProvider,
} from 'mayura/voice';

export interface AzureVoiceOptions {
  /** Your Speech resource's region, such as `eastus`: requests go to its regional endpoints. Give this or `resource`. */
  readonly region?: string;
  /** Your Speech resource's custom subdomain: requests go to https://<resource>.cognitiveservices.azure.com. Give this or `region`. */
  readonly resource?: string;
  /** The resource key, sent as `Ocp-Apim-Subscription-Key`. Give this or `token`. Nothing is read from the environment. */
  readonly apiKey?: string;
  /**
   * A bearer token source, called for every request so tokens stay fresh: a Microsoft Entra ID token for a `resource`,
   * or, for a `region`, `aad#<resource id>#<Entra token>` or an STS token. Give this or `apiKey`.
   */
  readonly token?: () => string | Promise<string>;
  /** Send transcription requests here instead, for example a sovereign cloud's endpoint. It must be https. */
  readonly speechToTextURL?: string;
  /** Send speech requests here instead, for example a sovereign cloud's endpoint. It must be https. */
  readonly textToSpeechURL?: string;
  /** Extra headers, such as a gateway's credential. Treated as credentials. They cannot replace Authorization or Ocp-Apim-Subscription-Key. */
  readonly headers?: Readonly<Record<string, string>>;
  /** The largest speech audio a call may return; 64 MiB by default. */
  readonly maxAudioBytes?: number;
  /** The largest transcription response; 16 MiB by default (word timings make long audio's responses large). */
  readonly maxResponseBytes?: number;
  /** How long one call may take unless the registry sets `timeoutMs` (default 300 s: fast transcription takes long audio). */
  readonly timeoutMs?: number;
  /** A trusted transport for tests or proxies. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Azure Speech's pay-as-you-go prices on 2026-09-30, the same in every region that offers them. `fast` is fast
 * transcription at $0.36 an hour; MAI-Transcribe-2's price is promotional until the end of 2026, so it is left out.
 * Speech ids are voice families: standard neural voices, HD voices and HD Flash voices. Azure bills speech per
 * character, counting each Chinese character twice, which the adapter counts and bounds before sending.
 */
export const catalog: VoiceCatalog = Object.freeze({
  asOf: '2026-09-30',
  transcribers: Object.freeze({
    fast: Object.freeze({ pricing: Object.freeze({ microsPerMinute: 6_000 }) }),
  }),
  speakers: Object.freeze({
    neural: Object.freeze({ pricing: Object.freeze({ microsPerMillionCharacters: 15_000_000 }) }),
    'neural-hd': Object.freeze({ pricing: Object.freeze({ microsPerMillionCharacters: 22_000_000 }) }),
    'neural-hd-flash': Object.freeze({ pricing: Object.freeze({ microsPerMillionCharacters: 15_000_000 }) }),
  }),
});

const transcriptionModels: Readonly<Record<string, Readonly<Record<string, string>>>> = { fast: {}, 'mai-transcribe-2': { modelName: 'MAI-Transcribe-2' } };
const locale = '([a-z]{2,3}-[A-Za-z]{2})';
/**
 * Each speech family's voice names. Azure OpenAI voices (`en-US-AlloyMultilingualNeural`) look like standard neural
 * voices but are not priced as them, so they are refused rather than charged at the standard price.
 */
const families: Readonly<Record<string, RegExp>> = {
  neural: new RegExp(`^${locale}(?:-[a-z]{2,16})?-[A-Za-z0-9]{1,48}Neural$`, 'u'),
  'neural-hd': new RegExp(`^${locale}-[A-Za-z0-9-]{1,48}:DragonHD(?!Flash)[A-Za-z0-9.]{0,32}Neural$`, 'u'),
  'neural-hd-flash': new RegExp(`^${locale}-[A-Za-z0-9-]{1,48}:DragonHDFlash[A-Za-z0-9.]{0,32}Neural$`, 'u'),
};
const openaiVoices = /(?:alloy|echo|fable|onyx|nova|shimmer)multilingualneural/iu;
const speechFormats: Readonly<Partial<Record<SpeechFormat, { header: string; mediaType: string }>>> = {
  mp3: { header: 'audio-24khz-48kbitrate-mono-mp3', mediaType: 'audio/mpeg' }, opus: { header: 'ogg-24khz-16bit-mono-opus', mediaType: 'audio/ogg' },
  wav: { header: 'riff-24khz-16bit-mono-pcm', mediaType: 'audio/wav' }, pcm16: { header: 'raw-24khz-16bit-mono-pcm', mediaType: 'audio/L16;rate=24000;channels=1' },
};

/** Text as SSML content: only `&`, `<` and `>` need escaping outside attributes. */
const escapeText = (text: string) => text.replace(/[&<>]/gu, character => character === '&' ? '&amp;' : character === '<' ? '&lt;' : '&gt;');
/**
 * The characters Azure bills for SSML content: every code point of the markup inside `<voice>` (escapes included), and
 * each Chinese character twice.
 */
export function billableCharacters(content: string): number { return characterCount(content) + (content.match(/\p{Script=Han}/gu)?.length ?? 0); }
const whole = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/**
 * Azure Speech transcription and text-to-speech for a voice registry (`azureVoice({ region, apiKey })`, ids
 * `azure/<model>` such as `azure/fast` or `azure/neural`), over Azure's HTTP APIs with fetch.
 *
 * Transcription uses fast transcription: without a language, Azure detects it. Speech ids name a voice family, and the
 * voice must be one of it (`azure/neural` with `en-US-AvaMultilingualNeural`, `azure/neural-hd` with
 * `en-US-Ava:DragonHDLatestNeural`), so a voice is never charged at another family's price.
 */
export function azureVoice(options: AzureVoiceOptions): VoiceProvider {
  const key = options?.apiKey; const token = options?.token;
  if (key !== undefined && (typeof key !== 'string' || !key.trim() || /[\r\n]/u.test(key) || key.length > 4096)) throw new MayuraError('INVALID_CONFIG', 'azureVoice(): apiKey must be a bounded header value.');
  if (token !== undefined && typeof token !== 'function') throw new MayuraError('INVALID_CONFIG', 'azureVoice(): token must be a function returning a bearer token.');
  if ((key === undefined) === (token === undefined)) throw new MayuraError('INVALID_CONFIG', 'azureVoice() needs an apiKey or a token source, not both.');
  const { region, resource } = options;
  if ((region === undefined) === (resource === undefined)) throw new MayuraError('INVALID_CONFIG', 'azureVoice() needs a region or a resource, not both.');
  if (region !== undefined && (typeof region !== 'string' || !/^[a-z][a-z0-9]{1,31}$/u.test(region))) throw new MayuraError('INVALID_CONFIG', 'azureVoice(): region must be an Azure region, such as eastus.');
  if (resource !== undefined && (typeof resource !== 'string' || !/^[a-z0-9][a-z0-9-]{1,62}$/u.test(resource))) throw new MayuraError('INVALID_CONFIG', 'azureVoice(): resource must be a custom subdomain name.');
  const speechToText = providerEndpoint(options.speechToTextURL ?? (region ? `https://${region}.api.cognitive.microsoft.com` : `https://${resource}.cognitiveservices.azure.com`), '', 'azureVoice()').replace(/\/$/u, '');
  const textToSpeech = providerEndpoint(options.textToSpeechURL ?? (region ? `https://${region}.tts.speech.microsoft.com` : `https://${resource}.cognitiveservices.azure.com/tts`), '', 'azureVoice()').replace(/\/$/u, '');
  const headers = providerHeaders(options.headers, ['Authorization', 'Ocp-Apim-Subscription-Key'], 'azureVoice()');
  const maxAudioBytes = options.maxAudioBytes ?? 64 * 1_048_576; const maxResponseBytes = options.maxResponseBytes ?? 16 * 1_048_576;
  const defaultTimeout = options.timeoutMs ?? 300_000;
  for (const [value, name] of [[maxAudioBytes, 'maxAudioBytes'], [maxResponseBytes, 'maxResponseBytes'], [defaultTimeout, 'timeoutMs']] as const) assertPositiveInteger(value, name);

  const credential = async (): Promise<Record<string, string>> => {
    if (key !== undefined) return { 'ocp-apim-subscription-key': key };
    let value: unknown;
    try { value = await token!(); } catch { throw new VoiceProviderError('authentication'); }
    if (typeof value !== 'string' || !value.trim() || /[\r\n]/u.test(value) || value.length > 16_384) throw new VoiceProviderError('authentication');
    return { authorization: `Bearer ${value}` };
  };
  const send = async (url: string, init: RequestInit & { headers?: Record<string, string> }) => (options.fetch ?? globalThis.fetch)(url, {
    ...init, method: 'POST', redirect: 'error', headers: { ...headers, ...await credential(), ...init.headers },
  });

  return Object.freeze({
    id: 'azure',
    catalog,
    transcriber(name: string, settings: TranscriberSettings): Transcriber {
      const model = typeof name === 'string' && Object.hasOwn(transcriptionModels, name) ? transcriptionModels[name]! : undefined;
      if (model === undefined) throw new MayuraError('INVALID_CONFIG', `azureVoice() transcribes with ${Object.keys(transcriptionModels).join(' or ')}.`);
      const timeoutMs = settings.timeoutMs ?? defaultTimeout;
      return Object.freeze({
        id: settings.id, maxCostMicros: settings.maxCostMicros,
        transcribe: async (request: TranscriptionRequest): Promise<Transcript> => {
          const call = voiceCall(timeoutMs, request.signal);
          try {
            const form = new FormData();
            form.append('audio', new Blob([request.audio.data as BlobPart], { type: request.audio.mediaType }), 'audio');
            form.append('definition', JSON.stringify({ ...(request.language ? { locales: [request.language] } : {}), profanityFilterMode: 'None', ...model }));
            const response = await send(`${speechToText}/speechtotext/transcriptions:transcribe?api-version=2025-10-15`, { signal: call.signal, body: form });
            if (!response.ok) throw voiceResponseFailure(response);
            const body = await voiceJson(response, maxResponseBytes) as { durationMilliseconds?: unknown; combinedPhrases?: unknown; phrases?: unknown } | null;
            if (!body || !whole(body.durationMilliseconds) || !Array.isArray(body.combinedPhrases) || (body.phrases !== undefined && !Array.isArray(body.phrases))) throw new VoiceProviderError('invalid_response');
            const texts: string[] = [];
            for (const combined of body.combinedPhrases as Record<string, unknown>[]) {
              if (typeof combined?.['text'] !== 'string') throw new VoiceProviderError('invalid_response');
              if (combined['text'].trim()) texts.push(combined['text'].trim());
            }
            const segments: TranscriptSegment[] = []; let detected: string | undefined;
            for (const phrase of (body.phrases ?? []) as Record<string, unknown>[]) {
              if (typeof phrase?.['text'] !== 'string' || !whole(phrase['offsetMilliseconds']) || !whole(phrase['durationMilliseconds'])) throw new VoiceProviderError('invalid_response');
              const startMs = phrase['offsetMilliseconds'];
              segments.push({ startMs, endMs: startMs + phrase['durationMilliseconds'], text: phrase['text'], ...(whole(phrase['speaker']) ? { speaker: String(phrase['speaker']) } : {}) });
              if (detected === undefined && typeof phrase['locale'] === 'string' && /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/u.test(phrase['locale'])) detected = phrase['locale'];
            }
            // Azure bills audio in whole seconds.
            const audioMs = Math.ceil(body.durationMilliseconds / 1_000) * 1_000;
            const language = request.language ?? detected;
            return { text: texts.join(' '), ...(language ? { language } : {}), segments, usage: { audioMs, costMicros: transcriptionCostMicros(settings.pricing, audioMs) } };
          } catch (error) { return call.failure(error); } finally { call.done(); }
        },
      });
    },
    speaker(name: string, settings: SpeakerSettings): Speaker {
      const voiceName = typeof name === 'string' && Object.hasOwn(families, name) ? families[name]! : undefined;
      if (voiceName === undefined) throw new MayuraError('INVALID_CONFIG', `azureVoice() speaks with a voice family: ${Object.keys(families).join(', ')}.`);
      const timeoutMs = settings.timeoutMs ?? defaultTimeout;
      const pricing: SpeechPricing = settings.pricing;
      return Object.freeze({
        id: settings.id, maxCostMicros: settings.maxCostMicros,
        speak: async (request: SpeechRequest): Promise<Speech> => {
          const format = speechFormats[request.format ?? 'mp3'];
          const voice = voiceName.exec(request.voice);
          if (!format || !voice || openaiVoices.test(request.voice)) throw new VoiceProviderError('configuration');
          if (request.language !== undefined && !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/u.test(request.language)) throw new VoiceProviderError('configuration');
          const content = escapeText(request.text);
          const characters = billableCharacters(content);
          // The registry bounds code points; Azure bills escapes and Chinese characters twice, so bound what it bills.
          const costMicros = speechCostMicros(pricing, characters);
          if (costMicros > settings.maxCostMicros) throw new MayuraError('BUDGET_EXCEEDED', `Speaking ${characters} billable characters would cost ${costMicros} micros; this model's bound is ${settings.maxCostMicros}.`);
          const lang = request.language ?? voice[1]!;
          const call = voiceCall(timeoutMs, request.signal);
          try {
            const response = await send(`${textToSpeech}/cognitiveservices/v1`, {
              signal: call.signal, headers: { 'content-type': 'application/ssml+xml', 'x-microsoft-outputformat': format.header, 'user-agent': 'mayura' },
              body: `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}"><voice name="${request.voice}">${content}</voice></speak>`,
            });
            if (!response.ok) throw voiceResponseFailure(response);
            const data = await voiceAudio(response, maxAudioBytes, request.onAudio);
            return { audio: { data, mediaType: format.mediaType }, usage: { characters, costMicros } };
          } catch (error) { return call.failure(error); } finally { call.done(); }
        },
      });
    },
  });
}
