import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVoices, speechCostMicros, transcriptionCostMicros } from 'mayura/voice';
import { conformanceWav, voiceAdapterConformance, type VoiceScenario } from 'mayura/testing';
import { cartesiaVersion, cartesiaVoice, catalog } from '../src/index.js';

type Seen = { url: string; headers: Headers; form?: FormData; json?: Record<string, unknown> }[];
const voice = 'a0e99841-438c-4a64-b679-ae501e7d6091';
/** Cartesia's API, answering one scenario in its own wire format. */
function transport(scenario: VoiceScenario, seen: Seen = [], duration?: number): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const entry: Seen[number] = { url: request.url, headers: request.headers };
    if (request.url.endsWith('/stt')) entry.form = await request.formData(); else entry.json = await request.json() as Record<string, unknown>;
    seen.push(entry);
    switch (scenario.kind) {
      case 'transcript': return Response.json({ type: 'transcript', request_id: 'r', text: ` ${scenario.text}`, language: 'en', duration: duration ?? scenario.audioMs / 1_000,
        words: [{ word: scenario.text, start: 0, end: scenario.audioMs / 1_000 }] });
      case 'speech': {
        const audio = scenario.audio;
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(audio.slice(0, 700)); controller.enqueue(audio.slice(700)); controller.close(); } }),
          { status: 200, headers: { 'content-type': 'audio/mpeg' } });
      }
      case 'http': return Response.json({ error: scenario.detail }, { status: scenario.status });
      case 'invalid': return Response.json({ type: 'transcript', note: scenario.detail });
      case 'network': throw new TypeError('fetch failed');
      case 'hang': return new Promise<Response>((_, reject) => { request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); });
    }
  }) as typeof globalThis.fetch;
}
const never = (() => { throw new Error('No request may be sent.'); }) as unknown as typeof globalThis.fetch;

describe('@mayurajs/voice-cartesia keeps the voice adapter contract', () => {
  const harness = {
    transcriber: (scenario: VoiceScenario, settings: Parameters<NonNullable<ReturnType<typeof cartesiaVoice>['transcriber']>>[1]) =>
      cartesiaVoice({ apiKey: 'fixture-key', fetch: transport(scenario) }).transcriber!('ink-whisper', settings),
    speaker: (scenario: VoiceScenario, settings: Parameters<NonNullable<ReturnType<typeof cartesiaVoice>['speaker']>>[1]) =>
      cartesiaVoice({ apiKey: 'fixture-key', fetch: transport(scenario) }).speaker!('sonic-3.6', settings),
    voice,
  };
  for (const test of voiceAdapterConformance) it(test.name, async () => { expect(await test.run(harness)).toBe('passed'); });
});

describe('@mayurajs/voice-cartesia', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('uploads audio with word timings, charges whole seconds at the catalog price, and reads nothing from the environment', async () => {
    vi.stubEnv('CARTESIA_API_KEY', 'key-from-env'); vi.stubEnv('CARTESIA_BASE_URL', 'https://attacker.example');
    const seen: Seen = []; const audio = conformanceWav(30_000);
    const voices = createVoices({ providers: [cartesiaVoice({ apiKey: 'fixture-key', fetch: transport({ kind: 'transcript', text: 'Hello', audioMs: 30_000 }, seen, 30.2) })],
      maxCallCostMicros: 10_000, prices: 'catalog' });
    const result = await voices.transcriber('cartesia/ink-whisper').transcribe({ audio: { data: audio, mediaType: 'audio/wav' }, language: 'de-DE' });
    expect(result).toMatchObject({ text: 'Hello', language: 'de-DE', segments: [{ startMs: 0, endMs: 30_000, text: 'Hello' }],
      usage: { audioMs: 31_000, costMicros: transcriptionCostMicros({ microsPerMinute: 11_700 }, 31_000) } });
    expect(seen[0]!.url).toBe('https://api.cartesia.ai/stt');
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer fixture-key'); expect(seen[0]!.headers.get('cartesia-version')).toBe(cartesiaVersion);
    const form = seen[0]!.form!;
    expect([form.get('model'), form.get('language'), form.getAll('timestamp_granularities[]')]).toEqual(['ink-whisper', 'de', ['word']]);
    expect(new Uint8Array(await (form.get('file') as Blob).arrayBuffer())).toEqual(audio);
  });

  it('speaks with a voice id, in each format and language form, streaming the audio', async () => {
    const audio = new Uint8Array(Array.from({ length: 1_500 }, (_, index) => index % 251));
    const seen: Seen = [];
    const voices = createVoices({ providers: [cartesiaVoice({ apiKey: 'fixture-key', fetch: transport({ kind: 'speech', audio }, seen) })], maxCallCostMicros: 10_000, prices: 'catalog' });
    const speaker = voices.speaker('cartesia/sonic-3.6'); const streamed: Uint8Array[] = [];
    const speech = await speaker.speak({ text: 'Hello there.', voice, onAudio: chunk => streamed.push(chunk) });
    expect(speech).toMatchObject({ audio: { mediaType: 'audio/mpeg' }, usage: { characters: 12, costMicros: speechCostMicros({ microsPerMillionCharacters: 65_000_000 }, 12) } });
    expect(streamed).toHaveLength(2);
    expect(seen[0]!.url).toBe('https://api.cartesia.ai/tts/bytes');
    expect(seen[0]!.json).toEqual({ model_id: 'sonic-3.6', transcript: 'Hello there.', voice: { mode: 'id', id: voice }, output_format: { container: 'mp3', sample_rate: 44_100, bit_rate: 128_000 } });
    await speaker.speak({ text: 'Hi', voice, format: 'wav', language: 'en-GB' });
    await speaker.speak({ text: 'Hi', voice, format: 'pcm16', language: 'fr' });
    expect(seen[1]!.json).toMatchObject({ output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 24_000 }, locale: 'en-GB' });
    expect(seen[2]!.json).toMatchObject({ output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24_000 }, language: 'fr' });
  });

  it('refuses a voice that is not a voice id, a format Cartesia does not make and a malformed language, before sending anything', async () => {
    const speaker = cartesiaVoice({ apiKey: 'k', fetch: never }).speaker!('sonic-3', { id: 'cartesia/sonic-3', pricing: catalog.speakers!['sonic-3']!.pricing, maxCostMicros: 1_000_000 });
    for (const bad of [{ voice: 'katie' }, { voice, format: 'opus' as const }, { voice, format: 'flac' as const }, { voice, language: 'en_GB' }]) {
      await expect(speaker.speak({ text: 'Hi', ...bad })).rejects.toMatchObject({ reason: 'configuration' });
    }
    const transcriber = cartesiaVoice({ apiKey: 'k', fetch: never }).transcriber!('ink-whisper', { id: 'cartesia/ink-whisper', pricing: { microsPerMinute: 11_700 }, maxCostMicros: 1_000 });
    await expect(transcriber.transcribe({ audio: { data: conformanceWav(), mediaType: 'audio/wav' }, durationMs: 1_000, language: '12' })).rejects.toMatchObject({ reason: 'configuration' });
  });

  it('needs an API key and an https endpoint that its headers cannot redirect', () => {
    const invalid = expect.objectContaining({ code: 'INVALID_CONFIG' });
    expect(() => cartesiaVoice({} as never)).toThrow(invalid);
    expect(() => cartesiaVoice({ apiKey: 'k\nx' })).toThrow(invalid);
    expect(() => cartesiaVoice({ apiKey: 'k', baseURL: 'http://api.cartesia.ai' })).toThrow(invalid);
    expect(() => cartesiaVoice({ apiKey: 'k', headers: { 'Cartesia-Version': '2020-01-01' } })).toThrow(invalid);
    expect(() => cartesiaVoice({ apiKey: 'k' }).speaker!('Sonic 3', { id: 'cartesia/x', pricing: { microsPerMillionCharacters: 1 }, maxCostMicros: 1 })).toThrow(invalid);
  });
});
