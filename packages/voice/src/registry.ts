import { MayuraError } from '@mayura/core';
import {
  characterCount, speechCostMicros, transcriptionCostMicros, VoiceProviderError,
  type Speaker, type SpeakerSettings, type Speech, type SpeechFormat, type SpeechPricing, type SpeechRequest, type Transcriber, type TranscriberSettings,
  type Transcript, type TranscriptionPricing, type TranscriptionRequest, type VoiceProvider,
} from './contracts.js';
import { wavDurationMs } from './audio.js';

export interface VoicesOptions {
  /** The providers voice models may come from. */
  readonly providers: readonly VoiceProvider[];
  /** The most one call may cost, unless a model sets its own. Required: nothing is spent without a bound. */
  readonly maxCallCostMicros: number;
  /**
   * Where prices come from: a map from voice id (`openai/gpt-4o-transcribe`) to its price, or `'catalog'` for the list
   * prices each provider package ships, as of its catalog's date. A model with no price is refused.
   */
  readonly prices?: 'catalog' | Readonly<Record<string, TranscriptionPricing | SpeechPricing>>;
  /** How long one call may take (default: each provider's own default). */
  readonly timeoutMs?: number;
  /** The largest audio a transcription accepts; 25 MiB by default, at most 100 MiB. */
  readonly maxAudioBytes?: number;
  /** The longest text a speech call accepts, in characters; 20,000 by default. */
  readonly maxTextCharacters?: number;
}
export interface VoiceModelOptions {
  /** This model's price; overrides `prices`. */
  readonly pricing?: TranscriptionPricing | SpeechPricing;
  /** This model's per-call bound; overrides `maxCallCostMicros`. */
  readonly maxCostMicros?: number;
  readonly timeoutMs?: number;
}
export interface RegisteredVoice {
  readonly id: string;
  readonly provider: string;
  readonly name: string;
  readonly kind: 'transcriber' | 'speaker';
  readonly pricing: TranscriptionPricing | SpeechPricing | null;
  readonly catalogAsOf: string | null;
}
export interface VoiceRegistry {
  /** A speech-to-text model by id (`openai/gpt-4o-transcribe`). Runtimes grant it as `voice:<id>`. */
  transcriber(id: string, options?: VoiceModelOptions): Transcriber;
  /** A text-to-speech model by id (`elevenlabs/eleven_v3`). Runtimes grant it as `voice:<id>`. */
  speaker(id: string, options?: VoiceModelOptions): Speaker;
  /** Every voice model with a price this registry can use. */
  list(): readonly RegisteredVoice[];
}

const providerIdentifier = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const modelName = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/u;
const catalogDate = /^\d{4}-\d{2}-\d{2}$/u;
const language = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
const mediaType = /^audio\/[a-z0-9.+-]{1,64}$/u;
const formats: readonly SpeechFormat[] = ['mp3', 'wav', 'opus', 'aac', 'flac', 'pcm16'];

function nonNegative(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new MayuraError('INVALID_CONFIG', `${where} must be a non-negative integer.`);
  return value;
}
function timeout(value: unknown, where: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 100 || value > 3_600_000) throw new MayuraError('INVALID_CONFIG', `${where} must be 100 to 3,600,000 ms.`);
  return value;
}
function transcriptionPricing(value: unknown, where: string): TranscriptionPricing {
  return Object.freeze({ microsPerMinute: nonNegative((value as Partial<TranscriptionPricing> | null)?.microsPerMinute, `${where}: microsPerMinute`) });
}
function speechPricing(value: unknown, where: string): SpeechPricing {
  return Object.freeze({ microsPerMillionCharacters: nonNegative((value as Partial<SpeechPricing> | null)?.microsPerMillionCharacters, `${where}: microsPerMillionCharacters`) });
}
const abortedError = () => new MayuraError('CANCELLED', 'The voice call was cancelled.');

/**
 * Speech-to-text and text-to-speech models from many providers, by id. Each provider package (`@mayurajs/voice-openai`,
 * `-elevenlabs`, ...) knows how to call its provider; the registry gives every model an id of the form
 * `<provider>/<model>`, a price and a per-call bound, and checks every call against them.
 *
 * Nothing is guessed. Every model needs a price, from `prices` or from a provider's dated catalog when you opt in with
 * `prices: 'catalog'`, and every call has a bound it cannot exceed: speech is priced from its text before the call, and
 * transcription from the audio's duration, measured from WAV and given by you for compressed audio. Runtimes grant each
 * model as `voice:<id>`.
 */
export function createVoices(options: VoicesOptions): VoiceRegistry {
  if (!options || !Array.isArray(options.providers) || options.providers.length < 1 || options.providers.length > 64) throw new MayuraError('INVALID_CONFIG', 'A voice registry needs 1–64 providers.');
  const providers = new Map<string, VoiceProvider>();
  for (const provider of options.providers) {
    if (!provider || typeof provider.id !== 'string' || !providerIdentifier.test(provider.id) || (typeof provider.transcriber !== 'function' && typeof provider.speaker !== 'function')) {
      throw new MayuraError('INVALID_CONFIG', 'Every voice provider needs an id of lowercase letters, digits and -, and a transcriber() or speaker() function.');
    }
    if (providers.has(provider.id)) throw new MayuraError('INVALID_CONFIG', `Voice provider ${provider.id} is listed twice.`);
    if (provider.catalog !== undefined && (typeof provider.catalog?.asOf !== 'string' || !catalogDate.test(provider.catalog.asOf))) throw new MayuraError('INVALID_CONFIG', `Voice provider ${provider.id} has a catalog without a YYYY-MM-DD date.`);
    providers.set(provider.id, provider);
  }
  const maxCallCostMicros = nonNegative(options.maxCallCostMicros, 'maxCallCostMicros');
  const registryTimeout = timeout(options.timeoutMs, 'timeoutMs');
  const maxAudioBytes = options.maxAudioBytes === undefined ? 25 * 1_048_576 : nonNegative(options.maxAudioBytes, 'maxAudioBytes');
  if (maxAudioBytes < 1 || maxAudioBytes > 100 * 1_048_576) throw new MayuraError('INVALID_CONFIG', 'maxAudioBytes must be 1 byte to 100 MiB.');
  const maxTextCharacters = options.maxTextCharacters === undefined ? 20_000 : nonNegative(options.maxTextCharacters, 'maxTextCharacters');
  if (maxTextCharacters < 1 || maxTextCharacters > 1_000_000) throw new MayuraError('INVALID_CONFIG', 'maxTextCharacters must be 1 to 1,000,000.');
  const useCatalog = options.prices === 'catalog';
  const explicit = new Map<string, unknown>();
  if (options.prices !== undefined && !useCatalog) {
    if (!options.prices || typeof options.prices !== 'object') throw new MayuraError('INVALID_CONFIG', "prices must be 'catalog' or a map from voice id to prices.");
    for (const [id, pricing] of Object.entries(options.prices)) explicit.set(id, pricing);
  }
  const parse = (id: unknown) => {
    if (typeof id !== 'string' || !id.includes('/')) throw new MayuraError('INVALID_CONFIG', 'A voice id is <provider>/<model>, for example openai/gpt-4o-transcribe.');
    const slash = id.indexOf('/'); const provider = providers.get(id.slice(0, slash)); const name = id.slice(slash + 1);
    if (!provider) throw new MayuraError('INVALID_CONFIG', `No voice provider ${id.slice(0, slash)} is registered; add its @mayurajs/voice-* package.`);
    if (!modelName.test(name)) throw new MayuraError('INVALID_CONFIG', `${id} is not a valid voice id.`);
    return { provider, name, id };
  };
  const settingsOf = (id: string, modelOptions: VoiceModelOptions) => ({
    maxCostMicros: modelOptions.maxCostMicros === undefined ? maxCallCostMicros : nonNegative(modelOptions.maxCostMicros, `The maxCostMicros of ${id}`),
    timeoutMs: timeout(modelOptions.timeoutMs, `The timeoutMs of ${id}`) ?? registryTimeout,
  });

  const transcriber = (id: string, modelOptions: VoiceModelOptions = {}): Transcriber => {
    const parsed = parse(id);
    if (typeof parsed.provider.transcriber !== 'function') throw new MayuraError('INVALID_CONFIG', `Voice provider ${parsed.provider.id} does not transcribe.`);
    const listed = useCatalog ? parsed.provider.catalog?.transcribers?.[parsed.name] : undefined;
    const source = modelOptions.pricing ?? explicit.get(id) ?? listed?.pricing;
    if (source === undefined) throw new MayuraError('INVALID_CONFIG', `No price for ${id}: give it in prices or pricing${useCatalog ? '' : ", or use prices: 'catalog'"}.`);
    const pricing = transcriptionPricing(source, `The price of ${id}`);
    const { maxCostMicros, timeoutMs } = settingsOf(id, modelOptions);
    const settings: TranscriberSettings = Object.freeze({ id, pricing, maxCostMicros, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    const adapter = parsed.provider.transcriber(parsed.name, settings);
    if (!adapter || adapter.id !== id || typeof adapter.transcribe !== 'function' || adapter.maxCostMicros !== maxCostMicros) {
      throw new MayuraError('INVALID_CONFIG', `Voice provider ${parsed.provider.id} returned a transcriber that does not use the id and cost bound it was given.`);
    }
    return Object.freeze({
      id, maxCostMicros,
      transcribe: async (request: TranscriptionRequest): Promise<Transcript> => {
        const audio = request?.audio;
        if (!audio || !(audio.data instanceof Uint8Array) || audio.data.byteLength === 0 || typeof audio.mediaType !== 'string' || !mediaType.test(audio.mediaType)) {
          throw new MayuraError('INVALID_INPUT', 'Transcription needs audio: non-empty bytes and an audio/* media type.');
        }
        if (audio.data.byteLength > maxAudioBytes) throw new MayuraError('LIMIT_EXCEEDED', `The audio is larger than ${maxAudioBytes} bytes.`);
        if (request.language !== undefined && (typeof request.language !== 'string' || !language.test(request.language))) throw new MayuraError('INVALID_INPUT', 'language must be a BCP 47 tag, such as en or pt-BR.');
        if (request.prompt !== undefined && (typeof request.prompt !== 'string' || characterCount(request.prompt) > 4_000)) throw new MayuraError('INVALID_INPUT', 'prompt must be text of at most 4,000 characters.');
        const measured = wavDurationMs(audio);
        const declared = request.durationMs;
        if (declared !== undefined && (!Number.isSafeInteger(declared) || declared < 1 || declared > 86_400_000)) throw new MayuraError('INVALID_INPUT', 'durationMs must be 1 ms to 24 hours.');
        const durationMs = measured ?? declared;
        if (durationMs === undefined) throw new MayuraError('INVALID_INPUT', `Give durationMs for ${audio.mediaType} audio: Mayura measures WAV, and bounds every call's cost before making it.`);
        const expected = transcriptionCostMicros(pricing, durationMs);
        if (expected > maxCostMicros) throw new MayuraError('BUDGET_EXCEEDED', `Transcribing ${durationMs} ms of audio would cost ${expected} micros; this model's bound is ${maxCostMicros}.`);
        if (request.signal?.aborted) throw abortedError();
        const result = await adapter.transcribe({ ...request, audio: { data: audio.data, mediaType: audio.mediaType }, durationMs });
        if (!result || typeof result.text !== 'string' || !Array.isArray(result.segments) || !result.usage || !Number.isSafeInteger(result.usage.costMicros) || result.usage.costMicros < 0) {
          throw new VoiceProviderError('invalid_response');
        }
        for (const segment of result.segments) {
          if (!segment || typeof segment.text !== 'string' || !Number.isSafeInteger(segment.startMs) || !Number.isSafeInteger(segment.endMs) || segment.startMs < 0 || segment.endMs < segment.startMs) throw new VoiceProviderError('invalid_response');
        }
        // A provider that bills more audio than was measured or declared still charges it: usage is the truth.
        return Object.freeze({ ...result, segments: Object.freeze(result.segments.map(segment => Object.freeze({ ...segment }))), usage: Object.freeze({ ...result.usage }) });
      },
    });
  };

  const speaker = (id: string, modelOptions: VoiceModelOptions = {}): Speaker => {
    const parsed = parse(id);
    if (typeof parsed.provider.speaker !== 'function') throw new MayuraError('INVALID_CONFIG', `Voice provider ${parsed.provider.id} does not speak.`);
    const listed = useCatalog ? parsed.provider.catalog?.speakers?.[parsed.name] : undefined;
    const source = modelOptions.pricing ?? explicit.get(id) ?? listed?.pricing;
    if (source === undefined) throw new MayuraError('INVALID_CONFIG', `No price for ${id}: give it in prices or pricing${useCatalog ? '' : ", or use prices: 'catalog'"}.`);
    const pricing = speechPricing(source, `The price of ${id}`);
    const { maxCostMicros, timeoutMs } = settingsOf(id, modelOptions);
    const settings: SpeakerSettings = Object.freeze({ id, pricing, maxCostMicros, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    const adapter = parsed.provider.speaker(parsed.name, settings);
    if (!adapter || adapter.id !== id || typeof adapter.speak !== 'function' || adapter.maxCostMicros !== maxCostMicros) {
      throw new MayuraError('INVALID_CONFIG', `Voice provider ${parsed.provider.id} returned a speaker that does not use the id and cost bound it was given.`);
    }
    return Object.freeze({
      id, maxCostMicros,
      speak: async (request: SpeechRequest): Promise<Speech> => {
        if (!request || typeof request.text !== 'string' || request.text.trim() === '') throw new MayuraError('INVALID_INPUT', 'Speech needs non-empty text.');
        const characters = characterCount(request.text);
        if (characters > maxTextCharacters) throw new MayuraError('LIMIT_EXCEEDED', `The text is longer than ${maxTextCharacters} characters.`);
        if (typeof request.voice !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._:/@-]{0,127}$/u.test(request.voice)) throw new MayuraError('INVALID_INPUT', 'voice must be a provider voice id or name.');
        if (request.format !== undefined && !formats.includes(request.format)) throw new MayuraError('INVALID_INPUT', `format must be one of ${formats.join(', ')}.`);
        if (request.language !== undefined && (typeof request.language !== 'string' || !language.test(request.language))) throw new MayuraError('INVALID_INPUT', 'language must be a BCP 47 tag, such as en or pt-BR.');
        if (request.instructions !== undefined && (typeof request.instructions !== 'string' || characterCount(request.instructions) > 4_000)) throw new MayuraError('INVALID_INPUT', 'instructions must be text of at most 4,000 characters.');
        if (request.onAudio !== undefined && typeof request.onAudio !== 'function') throw new MayuraError('INVALID_INPUT', 'onAudio must be a function.');
        const expected = speechCostMicros(pricing, characters);
        if (expected > maxCostMicros) throw new MayuraError('BUDGET_EXCEEDED', `Speaking ${characters} characters would cost ${expected} micros; this model's bound is ${maxCostMicros}.`);
        if (request.signal?.aborted) throw abortedError();
        const result = await adapter.speak(request);
        if (!result?.audio || !(result.audio.data instanceof Uint8Array) || result.audio.data.byteLength === 0 || typeof result.audio.mediaType !== 'string'
          || !result.usage || !Number.isSafeInteger(result.usage.costMicros) || result.usage.costMicros < 0) throw new VoiceProviderError('invalid_response');
        return Object.freeze({ audio: Object.freeze({ data: result.audio.data, mediaType: result.audio.mediaType }), usage: Object.freeze({ ...result.usage }) });
      },
    });
  };

  return Object.freeze({
    transcriber, speaker,
    list: () => {
      const found: RegisteredVoice[] = []; const seen = new Set<string>();
      for (const [id, pricing] of explicit) {
        const slash = id.indexOf('/'); const provider = providers.get(id.slice(0, slash)); if (!provider) continue;
        const kind = pricing && typeof pricing === 'object' && 'microsPerMinute' in pricing ? 'transcriber' : 'speaker';
        found.push(Object.freeze({ id, provider: provider.id, name: id.slice(slash + 1), kind, pricing: pricing as TranscriptionPricing | SpeechPricing, catalogAsOf: null })); seen.add(id);
      }
      if (useCatalog) for (const provider of providers.values()) {
        const catalog = provider.catalog; if (!catalog) continue;
        for (const [name, entry] of Object.entries(catalog.transcribers ?? {})) { const id = `${provider.id}/${name}`; if (!seen.has(id)) found.push(Object.freeze({ id, provider: provider.id, name, kind: 'transcriber' as const, pricing: entry.pricing, catalogAsOf: catalog.asOf })); }
        for (const [name, entry] of Object.entries(catalog.speakers ?? {})) { const id = `${provider.id}/${name}`; if (!seen.has(id)) found.push(Object.freeze({ id, provider: provider.id, name, kind: 'speaker' as const, pricing: entry.pricing, catalogAsOf: catalog.asOf })); }
      }
      return Object.freeze(found);
    },
  });
}
