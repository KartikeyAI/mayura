import { assertPositiveInteger, MayuraError } from 'mayura';
import { providerEndpoint, providerHeaders } from 'mayura/core/host';
import {
  transcriptionCostMicros, voiceCall, voiceJson, VoiceProviderError, voiceResponseFailure,
  type Transcriber, type TranscriberSettings, type Transcript, type TranscriptionRequest, type TranscriptSegment, type VoiceCatalog, type VoiceProvider,
} from 'mayura/voice';

export interface AssemblyAIVoiceOptions {
  /** Your AssemblyAI API key. Required: nothing is read from the environment. */
  readonly apiKey: string;
  /** Send requests here instead of https://api.assemblyai.com, for example https://api.eu.assemblyai.com. It must be https. */
  readonly baseURL?: string;
  /** Extra headers, such as a gateway's credential. Treated as credentials. They cannot replace Authorization. */
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * Keep each transcript at AssemblyAI after reading it. Off by default: the transcript is deleted once read, so
   * AssemblyAI does not retain it.
   */
  readonly retainTranscripts?: boolean;
  /** How often to ask whether a transcript is ready; 1,000 ms by default. */
  readonly pollIntervalMs?: number;
  /** The largest transcript response; 16 MiB by default. */
  readonly maxResponseBytes?: number;
  /** How long one call may take unless the registry sets `timeoutMs` (default 10 minutes: transcription is queued). */
  readonly timeoutMs?: number;
  /** A trusted transport for tests or proxies. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * AssemblyAI's pay-as-you-go prices on 2026-09-30 for pre-recorded audio: Universal-3.5 Pro at $0.21 and Universal-2 at
 * $0.15 per hour, as micros per minute. The adapter uses no priced add-ons (no prompting, keyterms or speaker labels),
 * so these are the whole price.
 */
export const catalog: VoiceCatalog = Object.freeze({
  asOf: '2026-09-30',
  transcribers: Object.freeze({
    'universal-3-5-pro': Object.freeze({ pricing: Object.freeze({ microsPerMinute: 3_500 }) }),
    'universal-2': Object.freeze({ pricing: Object.freeze({ microsPerMinute: 2_500 }) }),
  }),
});

const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(new DOMException('aborted', 'AbortError')); return; }
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); };
  signal.addEventListener('abort', onAbort, { once: true });
});

/**
 * AssemblyAI speech-to-text for a voice registry (`assemblyaiVoice({ apiKey })`, ids `assemblyai/<model>` such as
 * `assemblyai/universal-3-5-pro`), over AssemblyAI's HTTP API with fetch. AssemblyAI transcribes asynchronously: the
 * audio is uploaded, a transcript is requested, and the adapter asks for it until it is ready. Cancelling after the
 * request stops the waiting, not the transcription, which AssemblyAI may still bill. AssemblyAI has no speech API.
 */
export function assemblyaiVoice(options: AssemblyAIVoiceOptions): VoiceProvider {
  const key = options?.apiKey;
  if (typeof key !== 'string' || !key.trim() || /[\r\n]/u.test(key) || key.length > 4096) throw new MayuraError('INVALID_CONFIG', 'assemblyaiVoice() needs an apiKey.');
  const baseURL = providerEndpoint(options.baseURL ?? 'https://api.assemblyai.com', '', 'assemblyaiVoice()').replace(/\/$/u, '');
  const headers = providerHeaders(options.headers, ['Authorization'], 'assemblyaiVoice()');
  const pollIntervalMs = options.pollIntervalMs ?? 1_000; const maxResponseBytes = options.maxResponseBytes ?? 16 * 1_048_576;
  const defaultTimeout = options.timeoutMs ?? 600_000;
  for (const [value, name] of [[pollIntervalMs, 'pollIntervalMs'], [maxResponseBytes, 'maxResponseBytes'], [defaultTimeout, 'timeoutMs']] as const) assertPositiveInteger(value, name);
  const send = (path: string, init: RequestInit) => (options.fetch ?? globalThis.fetch)(`${baseURL}${path}`, { ...init, redirect: 'error', headers: { ...headers, authorization: key, ...init.headers } });

  return Object.freeze({
    id: 'assemblyai',
    catalog,
    transcriber(name: string, settings: TranscriberSettings): Transcriber {
      if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,63}$/u.test(name)) throw new MayuraError('INVALID_CONFIG', 'assemblyaiVoice() needs a model, such as universal-3-5-pro.');
      const timeoutMs = settings.timeoutMs ?? defaultTimeout;
      return Object.freeze({
        id: settings.id, maxCostMicros: settings.maxCostMicros,
        transcribe: async (request: TranscriptionRequest): Promise<Transcript> => {
          const call = voiceCall(timeoutMs, request.signal);
          let transcriptId: string | undefined;
          try {
            const uploaded = await send('/v2/upload', { method: 'POST', signal: call.signal, headers: { 'content-type': 'application/octet-stream' }, body: request.audio.data as BodyInit });
            if (!uploaded.ok) throw voiceResponseFailure(uploaded);
            const upload = await voiceJson(uploaded, 65_536) as { upload_url?: unknown };
            if (typeof upload?.upload_url !== 'string' || !upload.upload_url.startsWith('https://')) throw new VoiceProviderError('invalid_response');
            const language = request.language?.split('-')[0]?.toLowerCase();
            const submitted = await send('/v2/transcript', { method: 'POST', signal: call.signal, headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ audio_url: upload.upload_url, speech_models: [name], ...(language ? { language_code: language } : { language_detection: true }) }) });
            if (!submitted.ok) throw voiceResponseFailure(submitted);
            const created = await voiceJson(submitted, maxResponseBytes) as { id?: unknown };
            if (typeof created?.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(created.id)) throw new VoiceProviderError('invalid_response');
            transcriptId = created.id;
            for (;;) {
              const polled = await send(`/v2/transcript/${transcriptId}`, { method: 'GET', signal: call.signal });
              if (!polled.ok) throw voiceResponseFailure(polled);
              const body = await voiceJson(polled, maxResponseBytes) as { status?: unknown; text?: unknown; words?: unknown; audio_duration?: unknown; language_code?: unknown };
              if (body?.status === 'error') throw new VoiceProviderError('rejected');
              if (body?.status !== 'completed') {
                if (body?.status !== 'queued' && body?.status !== 'processing') throw new VoiceProviderError('invalid_response');
                await pause(pollIntervalMs, call.signal); continue;
              }
              if (typeof body.text !== 'string' || (body.words !== undefined && body.words !== null && !Array.isArray(body.words))) throw new VoiceProviderError('invalid_response');
              const segments: TranscriptSegment[] = [];
              for (const word of (body.words ?? []) as Record<string, unknown>[]) {
                if (typeof word['text'] !== 'string' || !Number.isSafeInteger(word['start']) || !Number.isSafeInteger(word['end']) || (word['start'] as number) < 0 || (word['end'] as number) < (word['start'] as number)) {
                  throw new VoiceProviderError('invalid_response');
                }
                segments.push({ startMs: word['start'] as number, endMs: word['end'] as number, text: word['text'], ...(typeof word['speaker'] === 'string' ? { speaker: word['speaker'] } : {}) });
              }
              const duration = body.audio_duration;
              const reported = typeof duration === 'number' && Number.isFinite(duration) && duration >= 0 ? duration : undefined;
              const audioMs = reported === undefined ? request.durationMs ?? 0 : Math.ceil(reported * 1_000);
              const detected = typeof body.language_code === 'string' && /^[a-z]{2,3}(?:[-_][A-Za-z]{2})?$/u.test(body.language_code) ? body.language_code.replace('_', '-') : undefined;
              return { text: body.text.trim(), ...(detected ? { language: detected } : {}), segments, usage: { audioMs, costMicros: transcriptionCostMicros(settings.pricing, audioMs) } };
            }
          } catch (error) { return call.failure(error); }
          finally {
            call.done();
            // AssemblyAI keeps transcripts until deleted: delete this one unless asked to keep it. Best effort.
            if (transcriptId !== undefined && !options.retainTranscripts) void send(`/v2/transcript/${transcriptId}`, { method: 'DELETE' }).then(response => response.body?.cancel(), () => undefined).catch(() => undefined);
          }
        },
      });
    },
  });
}
