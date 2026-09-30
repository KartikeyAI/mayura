import { MayuraError, type JsonObject, type Schema } from '@mayura/core';
import { defineTool, type AnyTool } from '@mayura/tools';
import { audioFromBase64, audioToBase64 } from './audio.js';
import type { Speaker, SpeechFormat, Transcriber } from './contracts.js';

type Fields = Record<string, 'string' | 'integer' | 'string?' | 'integer?'>;
/** A bounded object schema of strings and integers, without a schema library. */
function object<T>(fields: Fields, maxStringBytes: number): Schema<T> {
  return { '~standard': { version: 1, vendor: 'mayura-voice', validate: (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { issues: [{ message: 'Expected an object.' }] };
    const input = value as Record<string, unknown>;
    for (const key of Object.keys(input)) if (!(key in fields)) return { issues: [{ message: `Unexpected field ${key}.` }] };
    for (const [key, kind] of Object.entries(fields)) {
      const item = input[key]; const optional = kind.endsWith('?');
      if (item === undefined) { if (optional) continue; return { issues: [{ message: `${key} is required.` }] }; }
      if (kind.startsWith('string') && (typeof item !== 'string' || item.length > maxStringBytes)) return { issues: [{ message: `${key} must be a string.` }] };
      if (kind.startsWith('integer') && (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0)) return { issues: [{ message: `${key} must be a non-negative integer.` }] };
    }
    return { value: input as T };
  } } } as Schema<T>;
}
const anything: Schema<unknown> = { '~standard': { version: 1, vendor: 'mayura-voice', validate: (value: unknown) => ({ value }) } } as Schema<unknown>;
const toolId = /^[a-z][a-z0-9_.-]{0,63}$/u;

export interface TranscriptionToolOptions {
  /** The tool's id; `voice.transcribe` by default. Grant it as `tool:<id>`. */
  readonly id?: string;
  readonly description?: string;
  /** The largest audio the tool accepts, as base64 characters; 36 MB (27 MiB of audio) by default. */
  readonly maxBase64Characters?: number;
}
/**
 * A tool that transcribes audio given as base64 data, for workflows and applications that pass audio as data. It
 * requires the permission `voice:<transcriber id>`, reserves the transcriber's per-call bound and reports what the call
 * cost.
 */
export function transcriptionTool(transcriber: Transcriber, options: TranscriptionToolOptions = {}): AnyTool {
  const id = options.id ?? 'voice.transcribe';
  if (!toolId.test(id)) throw new MayuraError('INVALID_CONFIG', 'A voice tool id is lowercase letters, digits, ., _ and -.');
  const maxBase64 = options.maxBase64Characters ?? 36_000_000;
  const input = object<{ audio: string; mediaType: string; durationMs?: number; language?: string }>({ audio: 'string', mediaType: 'string', durationMs: 'integer?', language: 'string?' }, maxBase64);
  return defineTool({
    id, version: `1:${transcriber.id}`, effects: 'none', capabilities: [`voice:${transcriber.id}`], costMicros: transcriber.maxCostMicros, timeoutMs: 600_000,
    description: options.description ?? 'Transcribe speech in audio to text. Give the audio as base64 with its media type, and its duration for compressed audio.',
    input, output: anything,
    inputJsonSchema: { type: 'object', additionalProperties: false, required: ['audio', 'mediaType'], properties: {
      audio: { type: 'string', description: 'The audio, base64-encoded.' }, mediaType: { type: 'string', description: 'Its media type, such as audio/wav.' },
      durationMs: { type: 'integer', minimum: 1, description: 'How long it lasts, for compressed audio.' }, language: { type: 'string', description: 'The spoken language, such as en.' } } } as JsonObject,
    execute: async (request, context) => {
      let data: Uint8Array;
      try { data = audioFromBase64(request.audio); } catch { throw new MayuraError('INVALID_INPUT', 'audio must be base64.'); }
      const transcript = await transcriber.transcribe({ audio: { data, mediaType: request.mediaType }, signal: context.signal,
        ...(request.durationMs === undefined ? {} : { durationMs: request.durationMs }), ...(request.language === undefined ? {} : { language: request.language }) });
      context.reportUsage({ knownCostMicros: Math.min(transcript.usage.costMicros, transcriber.maxCostMicros), unknownCostMicros: 0 });
      return { text: transcript.text, ...(transcript.language === undefined ? {} : { language: transcript.language }),
        segments: transcript.segments.map(segment => ({ ...segment })), costMicros: transcript.usage.costMicros } as JsonObject;
    },
  }) as unknown as AnyTool;
}

export interface SpeechToolOptions {
  /** The voice every call uses. */
  readonly voice: string;
  readonly format?: SpeechFormat;
  /** The tool's id; `voice.speak` by default. Grant it as `tool:<id>`. */
  readonly id?: string;
  readonly description?: string;
}
/**
 * A tool that speaks text and returns the audio as base64. It requires the permission `voice:<speaker id>`, reserves
 * the speaker's per-call bound and reports what the call cost.
 */
export function speechTool(speaker: Speaker, options: SpeechToolOptions): AnyTool {
  const id = options?.id ?? 'voice.speak';
  if (!toolId.test(id)) throw new MayuraError('INVALID_CONFIG', 'A voice tool id is lowercase letters, digits, ., _ and -.');
  if (!options || typeof options.voice !== 'string' || options.voice === '') throw new MayuraError('INVALID_CONFIG', 'A speech tool needs a voice.');
  const input = object<{ text: string; instructions?: string }>({ text: 'string', instructions: 'string?' }, 1_000_000);
  return defineTool({
    id, version: `1:${speaker.id}:${options.voice}:${options.format ?? 'mp3'}`, effects: 'none', capabilities: [`voice:${speaker.id}`], costMicros: speaker.maxCostMicros, timeoutMs: 300_000,
    description: options.description ?? 'Speak text aloud: returns the audio, base64-encoded.',
    input, output: anything,
    inputJsonSchema: { type: 'object', additionalProperties: false, required: ['text'], properties: {
      text: { type: 'string', description: 'What to say.' }, instructions: { type: 'string', description: 'How to say it, for models that take instructions.' } } } as JsonObject,
    execute: async (request, context) => {
      const speech = await speaker.speak({ text: request.text, voice: options.voice, signal: context.signal, ...(options.format === undefined ? {} : { format: options.format }),
        ...(request.instructions === undefined ? {} : { instructions: request.instructions }) });
      context.reportUsage({ knownCostMicros: Math.min(speech.usage.costMicros, speaker.maxCostMicros), unknownCostMicros: 0 });
      return { audio: audioToBase64(speech.audio.data), mediaType: speech.audio.mediaType, costMicros: speech.usage.costMicros } as JsonObject;
    },
  }) as unknown as AnyTool;
}
