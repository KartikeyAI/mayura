import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVoices } from 'mayura/voice';
import { conformanceWav, voiceAdapterConformance, type VoiceScenario } from 'mayura/testing';
import { catalog, deepgramVoice } from '../src/index.js';

type Seen = { url: string; headers: Headers; bytes: number; json?: Record<string, unknown> }[];
/** Deepgram's API, answering one scenario in its own wire format. */
function transport(scenario: VoiceScenario, seen: Seen = []): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = new Uint8Array(await request.arrayBuffer());
    seen.push({ url: request.url, headers: request.headers, bytes: body.byteLength,
      ...(request.headers.get('content-type') === 'application/json' ? { json: JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown> } : {}) });
    switch (scenario.kind) {
      case 'transcript': return Response.json({ metadata: { request_id: 'r', duration: scenario.audioMs / 1_000, channels: 1 },
        results: { channels: [{ detected_language: 'en', alternatives: [{ transcript: scenario.text, confidence: 0.99,
          words: [{ word: 'where', punctuated_word: scenario.text, start: 0, end: scenario.audioMs / 1_000, confidence: 0.99, speaker: 0 }] }] }] } });
      case 'speech': {
        const audio = scenario.audio;
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(audio.slice(0, 700)); controller.enqueue(audio.slice(700)); controller.close(); } }),
          { status: 200, headers: { 'content-type': 'audio/mpeg' } });
      }
      case 'http': return Response.json({ err_code: 'Bad Request', err_msg: scenario.detail }, { status: scenario.status });
      case 'invalid': return Response.json({ results: { channels: [] }, note: scenario.detail });
      case 'network': throw new TypeError('fetch failed');
      case 'hang': return new Promise<Response>((_, reject) => { request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); });
    }
  }) as typeof globalThis.fetch;
}

describe('@mayurajs/voice-deepgram keeps the voice adapter contract', () => {
  const harness = {
    transcriber: (scenario: VoiceScenario, settings: Parameters<NonNullable<ReturnType<typeof deepgramVoice>['transcriber']>>[1]) =>
      deepgramVoice({ apiKey: 'fixture-key', fetch: transport(scenario) }).transcriber!('nova-3', settings),
    speaker: (scenario: VoiceScenario, settings: Parameters<NonNullable<ReturnType<typeof deepgramVoice>['speaker']>>[1]) =>
      deepgramVoice({ apiKey: 'fixture-key', fetch: transport(scenario) }).speaker!('aura-2', settings),
    voice: 'thalia-en',
  };
  for (const test of voiceAdapterConformance) it(test.name, async () => { expect(await test.run(harness)).toBe('passed'); });
});

describe('@mayurajs/voice-deepgram', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('sends raw audio with the key it was given, detects the language when none is given, and reads nothing from the environment', async () => {
    vi.stubEnv('DEEPGRAM_API_KEY', 'key-from-env'); vi.stubEnv('DEEPGRAM_API_URL', 'https://attacker.example');
    const seen: Seen = [];
    const voices = createVoices({ providers: [deepgramVoice({ apiKey: 'fixture-key', fetch: transport({ kind: 'transcript', text: 'Where is it?', audioMs: 30_000 }, seen) })], maxCallCostMicros: 10_000, prices: 'catalog' });
    const result = await voices.transcriber('deepgram/nova-3').transcribe({ audio: { data: conformanceWav(30_000), mediaType: 'audio/wav' } });
    expect(result).toMatchObject({ text: 'Where is it?', language: 'en', usage: { audioMs: 30_000, costMicros: 2_600 }, segments: [{ startMs: 0, endMs: 30_000, speaker: '0' }] });
    expect(seen[0]!.url).toBe('https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&detect_language=true');
    expect(seen[0]!.headers.get('authorization')).toBe('Token fixture-key'); expect(seen[0]!.headers.get('content-type')).toBe('audio/wav');
    expect(seen[0]!.bytes).toBe(conformanceWav(30_000).byteLength);
    await voices.transcriber('deepgram/nova-3').transcribe({ audio: { data: conformanceWav(1_000), mediaType: 'audio/wav' }, language: 'pt-BR' });
    expect(seen[1]!.url).toBe('https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&language=pt-BR');
  });

  it('speaks with the family and voice as one model, in the format asked', async () => {
    const seen: Seen = []; const audio = new Uint8Array(1_500).fill(9);
    const voices = createVoices({ providers: [deepgramVoice({ apiKey: 'fixture-key', fetch: transport({ kind: 'speech', audio }, seen) })], maxCallCostMicros: 10_000, prices: 'catalog' });
    const speech = await voices.speaker('deepgram/aura-2').speak({ text: 'Hello there', voice: 'thalia-en', format: 'wav' });
    expect(seen[0]!.url).toBe('https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=linear16&container=wav');
    expect(seen[0]!.json).toEqual({ text: 'Hello there' });
    expect(speech.audio.mediaType).toBe('audio/wav'); expect(speech.audio.data).toEqual(audio);
    expect(speech.usage).toEqual({ characters: 11, costMicros: 330 });
    await expect(voices.speaker('deepgram/aura-2').speak({ text: 'hi', voice: 'Thalia EN' })).rejects.toMatchObject({ reason: 'configuration' });
    expect(seen).toHaveLength(1);
    expect(catalog.transcribers?.['nova-3']?.pricing).toEqual({ microsPerMinute: 5_200 });
  });

  it('needs an API key and an https endpoint', () => {
    expect(() => deepgramVoice({} as never)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => deepgramVoice({ apiKey: 'k', baseURL: 'http://api.deepgram.com' })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });
});
