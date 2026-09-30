import { MayuraError } from '@mayura/core';
import {
  characterCount, speechCostMicros, transcriptionCostMicros, VoiceProviderError,
  type Speaker, type SpeakerSettings, type Transcriber, type TranscriberSettings,
} from '@mayura/voice';

/**
 * What a voice provider's fake transport must answer with. The harness turns each scenario into the provider's own wire
 * format, so the adapter parses a realistic response.
 */
export type VoiceScenario =
  /** A transcription of `text`, for which the provider billed `audioMs` of audio. */
  | { readonly kind: 'transcript'; readonly text: string; readonly language?: string; readonly audioMs: number }
  /** Speech: the provider returns `audio` (in one piece or streamed, as it does). */
  | { readonly kind: 'speech'; readonly audio: Uint8Array }
  /** An HTTP error whose body contains `detail`, text that must never reach Mayura's error messages. */
  | { readonly kind: 'http'; readonly status: number; readonly detail: string }
  /** A well-formed HTTP 200 response that is not a valid provider response. */
  | { readonly kind: 'invalid'; readonly detail: string }
  /** The connection fails before any response. */
  | { readonly kind: 'network' }
  /** No response ever arrives; only the signal or the timeout ends the call. */
  | { readonly kind: 'hang' };
export type VoiceScenarioKind = VoiceScenario['kind'];

export interface VoiceAdapterHarness {
  /** A fresh transcriber whose transport answers `scenario`, when the provider transcribes. */
  transcriber?(scenario: VoiceScenario, settings: TranscriberSettings): Transcriber;
  /** A fresh speaker whose transport answers `scenario`, when the provider speaks. */
  speaker?(scenario: VoiceScenario, settings: SpeakerSettings): Speaker;
  /** A voice the provider accepts, for the speech cases. */
  readonly voice?: string;
  /** Scenarios this provider cannot produce, with the reason; they are reported as skipped. */
  readonly skip?: Partial<Record<VoiceScenarioKind, string>>;
}
export interface VoiceConformanceCase {
  readonly name: string;
  /** Runs the case; throws an `Error` describing the first broken expectation. Resolves `'skipped'` when skipped. */
  run(harness: VoiceAdapterHarness): Promise<'passed' | 'skipped'>;
}

const transcriberSettings: TranscriberSettings = { id: 'conformance/transcriber-1', pricing: { microsPerMinute: 6_000 }, maxCostMicros: 50_000 };
const speakerSettings: SpeakerSettings = { id: 'conformance/speaker-1', pricing: { microsPerMillionCharacters: 15_000_000 }, maxCostMicros: 50_000 };
/** One second of silent 16 kHz mono 16-bit WAV. */
export function conformanceWav(milliseconds = 1_000): Uint8Array {
  const samples = Math.round(16 * milliseconds); const bytes = samples * 2; const data = new Uint8Array(44 + bytes); const view = new DataView(data.buffer);
  const ascii = (offset: number, text: string) => { for (let index = 0; index < 4; index++) data[offset + index] = text.charCodeAt(index); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + bytes, true); ascii(8, 'WAVE'); ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true); view.setUint32(28, 32_000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, bytes, true);
  return data;
}
const speechAudio = new Uint8Array(Array.from({ length: 4_096 }, (_, index) => (index * 37) % 251));
const secret = 'SECRET_PROVIDER_DIAGNOSTIC';

function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function failure(run: () => Promise<unknown>): Promise<unknown> { try { await run(); } catch (error) { return error; } throw new Error('The call must fail.'); }
function leaks(error: unknown): boolean { return JSON.stringify({ message: (error as Error)?.message, error }).includes(secret); }
const bounded = <T>(promise: Promise<T>, ms: number) => Promise.race([promise, new Promise<'still running'>(resolve => setTimeout(() => resolve('still running'), ms))]);

type Side = 'transcriber' | 'speaker';
const call = (harness: VoiceAdapterHarness, side: Side, scenario: VoiceScenario, overrides: { signal?: AbortSignal; timeoutMs?: number } = {}) => side === 'transcriber'
  ? harness.transcriber!(scenario, { ...transcriberSettings, ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }) })
    .transcribe({ audio: { data: conformanceWav(), mediaType: 'audio/wav' }, durationMs: 1_000, ...(overrides.signal ? { signal: overrides.signal } : {}) })
  : harness.speaker!(scenario, { ...speakerSettings, ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }) })
    .speak({ text: 'Hello from Mayura.', voice: harness.voice ?? 'default', ...(overrides.signal ? { signal: overrides.signal } : {}) });

function both(name: string, kind: VoiceScenarioKind, body: (harness: VoiceAdapterHarness, side: Side) => Promise<void>): VoiceConformanceCase {
  return { name, run: async harness => {
    if (harness.skip?.[kind]) return 'skipped';
    let ran = false;
    for (const side of ['transcriber', 'speaker'] as const) if (harness[side]) { await body(harness, side); ran = true; }
    return ran ? 'passed' : 'skipped';
  } };
}

/**
 * The voice adapter contract as test cases any test runner can run: result shapes, costs, error reasons without the
 * provider's text, cancellation and timeouts, for transcribers and speakers alike.
 */
export const voiceAdapterConformance: readonly VoiceConformanceCase[] = [
  { name: 'transcribes, charging the audio the provider billed at the given price', run: async harness => {
    if (!harness.transcriber || harness.skip?.transcript) return 'skipped';
    const adapter = harness.transcriber({ kind: 'transcript', text: 'Where is my order?', language: 'en', audioMs: 1_000 }, transcriberSettings);
    check(adapter.id === transcriberSettings.id, 'The transcriber must use the id it was given.');
    check(adapter.maxCostMicros === transcriberSettings.maxCostMicros, 'The transcriber must use the cost bound it was given.');
    const result = await adapter.transcribe({ audio: { data: conformanceWav(), mediaType: 'audio/wav' }, durationMs: 1_000 });
    check(result.text === 'Where is my order?', 'The transcript must be the provider\'s text.');
    check(Array.isArray(result.segments) && result.segments.every(segment => Number.isSafeInteger(segment.startMs) && segment.endMs >= segment.startMs && typeof segment.text === 'string'), 'Segments must have whole-millisecond offsets.');
    check(result.usage.audioMs === 1_000, 'Usage must report the audio the provider billed.');
    check(result.usage.costMicros === transcriptionCostMicros(transcriberSettings.pricing, 1_000), 'Cost must be the billed audio at the given price.');
    return 'passed';
  } },
  { name: 'speaks, charging the characters of the text at the given price', run: async harness => {
    if (!harness.speaker || harness.skip?.speech) return 'skipped';
    const adapter = harness.speaker({ kind: 'speech', audio: speechAudio }, speakerSettings);
    check(adapter.id === speakerSettings.id, 'The speaker must use the id it was given.');
    check(adapter.maxCostMicros === speakerSettings.maxCostMicros, 'The speaker must use the cost bound it was given.');
    const text = 'Your order ships tomorrow. 🚚';
    const streamed: Uint8Array[] = [];
    const result = await adapter.speak({ text, voice: harness.voice ?? 'default', onAudio: chunk => streamed.push(chunk) });
    check(result.audio.data.byteLength === speechAudio.byteLength && result.audio.data.every((byte, index) => byte === speechAudio[index]), 'The audio must be the provider\'s audio, byte for byte.');
    check(/^audio\//u.test(result.audio.mediaType), 'The audio must carry an audio/* media type.');
    check(result.usage.characters === characterCount(text), 'Usage must count characters as code points.');
    check(result.usage.costMicros === speechCostMicros(speakerSettings.pricing, characterCount(text)), 'Cost must be the characters at the given price.');
    if (streamed.length) {
      const joined = new Uint8Array(streamed.reduce((sum, chunk) => sum + chunk.byteLength, 0)); let offset = 0;
      for (const chunk of streamed) { joined.set(chunk, offset); offset += chunk.byteLength; }
      check(joined.byteLength === speechAudio.byteLength && joined.every((byte, index) => byte === speechAudio[index]), 'Streamed audio must add up to the returned audio.');
    }
    return 'passed';
  } },
  ...([[401, 'authentication'], [403, 'authentication'], [429, 'rate_limited'], [500, 'unavailable'], [503, 'unavailable'], [400, 'rejected']] as const).map(([status, reason]) =>
    both(`reports HTTP ${status} as ${reason} without the provider's text`, 'http', async (harness, side) => {
      const error = await failure(() => call(harness, side, { kind: 'http', status, detail: secret }));
      check(error instanceof VoiceProviderError, `HTTP ${status} must fail with a VoiceProviderError.`);
      check(error.reason === reason, `HTTP ${status} must be reported as ${reason}, not ${(error as VoiceProviderError).reason}.`);
      check(!leaks(error), 'An error must never carry the provider\'s text.');
    })),
  both('reports a malformed response as invalid_response', 'invalid', async (harness, side) => {
    const error = await failure(() => call(harness, side, { kind: 'invalid', detail: secret }));
    check(error instanceof VoiceProviderError && error.reason === 'invalid_response', 'A malformed response must fail as invalid_response.');
    check(!leaks(error), 'An error must never carry the provider\'s text.');
  }),
  both('reports a failed connection as unavailable', 'network', async (harness, side) => {
    const error = await failure(() => call(harness, side, { kind: 'network' }));
    check(error instanceof VoiceProviderError && error.reason === 'unavailable', 'A failed connection must be reported as unavailable.');
  }),
  both('stops when the caller cancels', 'hang', async (harness, side) => {
    const controller = new AbortController(); setTimeout(() => controller.abort(), 20);
    const outcome = await bounded(failure(() => call(harness, side, { kind: 'hang' }, { signal: controller.signal })), 5_000);
    check(outcome !== 'still running', 'The call must stop when its signal aborts.');
    check(outcome instanceof MayuraError && (outcome.code === 'CANCELLED' || (outcome instanceof VoiceProviderError && outcome.reason === 'timeout')), 'A cancelled call must fail with CANCELLED.');
  }),
  both('stops at its timeout', 'hang', async (harness, side) => {
    const outcome = await bounded(failure(() => call(harness, side, { kind: 'hang' }, { timeoutMs: 150 })), 5_000);
    check(outcome !== 'still running', 'The call must stop at its timeout.');
    check(outcome instanceof VoiceProviderError && outcome.reason === 'timeout', 'A call past its timeout must fail as timeout.');
  }),
];
