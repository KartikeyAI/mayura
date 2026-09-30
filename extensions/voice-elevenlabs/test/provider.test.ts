import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVoices } from 'mayura/voice';
import { conformanceWav, voiceAdapterConformance, type VoiceScenario } from 'mayura/testing';
import { catalog, elevenlabsVoice } from '../src/index.js';

type Seen = { url: string; headers: Headers; form?: FormData; json?: Record<string, unknown> }[];
/** ElevenLabs' API, answering one scenario in its own wire format. */
function transport(scenario: VoiceScenario, seen: Seen = []): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const entry: Seen[number] = { url: request.url, headers: request.headers };
    if (request.headers.get('content-type')?.startsWith('multipart/form-data')) entry.form = await request.formData();
    else entry.json = await request.json() as Record<string, unknown>;
    seen.push(entry);
    switch (scenario.kind) {
      case 'transcript': return Response.json({ language_code: 'eng', language_probability: 0.98, text: scenario.text, audio_duration_secs: scenario.audioMs / 1_000, transcription_id: 't',
        words: [{ text: scenario.text, type: 'word', start: 0, end: scenario.audioMs / 1_000, speaker_id: 'speaker_0' }, { text: ' ', type: 'spacing', start: 0, end: 0 }] });
      case 'speech': {
        const audio = scenario.audio;
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(audio.slice(0, 500)); controller.enqueue(audio.slice(500)); controller.close(); } }),
          { status: 200, headers: { 'content-type': 'audio/mpeg' } });
      }
      case 'http': return Response.json({ detail: { status: 'error', message: scenario.detail } }, { status: scenario.status });
      case 'invalid': return Response.json({ detail: scenario.detail });
      case 'network': throw new TypeError('fetch failed');
      case 'hang': return new Promise<Response>((_, reject) => { request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); });
    }
  }) as typeof globalThis.fetch;
}

describe('@mayurajs/voice-elevenlabs keeps the voice adapter contract', () => {
  const harness = {
    transcriber: (scenario: VoiceScenario, settings: Parameters<NonNullable<ReturnType<typeof elevenlabsVoice>['transcriber']>>[1]) =>
      elevenlabsVoice({ apiKey: 'fixture-key', fetch: transport(scenario) }).transcriber!('scribe_v2', settings),
    speaker: (scenario: VoiceScenario, settings: Parameters<NonNullable<ReturnType<typeof elevenlabsVoice>['speaker']>>[1]) =>
      elevenlabsVoice({ apiKey: 'fixture-key', fetch: transport(scenario) }).speaker!('eleven_v3', settings),
    voice: 'JBFqnCBsd6RMkjVDRZzb',
  };
  for (const test of voiceAdapterConformance) it(test.name, async () => { expect(await test.run(harness)).toBe('passed'); });
});

describe('@mayurajs/voice-elevenlabs', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('sends the key it was given to its own endpoint, charges the audio ElevenLabs billed, and reads nothing from the environment', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', 'key-from-env'); vi.stubEnv('ELEVENLABS_BASE_URL', 'https://attacker.example');
    const seen: Seen = [];
    const voices = createVoices({ providers: [elevenlabsVoice({ apiKey: 'fixture-key', fetch: transport({ kind: 'transcript', text: 'hola', audioMs: 60_000 }, seen) })], maxCallCostMicros: 10_000, prices: 'catalog' });
    const result = await voices.transcriber('elevenlabs/scribe_v2').transcribe({ audio: { data: conformanceWav(60_000), mediaType: 'audio/wav' }, language: 'es-MX' });
    expect(result).toMatchObject({ text: 'hola', usage: { audioMs: 60_000, costMicros: 3_667 }, segments: [{ startMs: 0, endMs: 60_000, text: 'hola', speaker: 'speaker_0' }] });
    expect(seen[0]!.url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(seen[0]!.headers.get('xi-api-key')).toBe('fixture-key');
    expect(seen[0]!.form?.get('model_id')).toBe('scribe_v2'); expect(seen[0]!.form?.get('language_code')).toBe('es');
  });

  it('speaks through the streaming endpoint in the format asked, and refuses formats and voices it cannot use', async () => {
    const seen: Seen = []; const audio = new Uint8Array(2_000).fill(3);
    const provider = elevenlabsVoice({ apiKey: 'fixture-key', baseURL: 'https://api.eu.residency.elevenlabs.io', fetch: transport({ kind: 'speech', audio }, seen) });
    const voices = createVoices({ providers: [provider], maxCallCostMicros: 10_000, prices: 'catalog' });
    const speech = await voices.speaker('elevenlabs/eleven_flash_v2_5').speak({ text: 'Hello world', voice: 'JBFqnCBsd6RMkjVDRZzb', format: 'wav', language: 'en-US' });
    expect(seen[0]!.url).toBe('https://api.eu.residency.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/stream?output_format=wav_44100');
    expect(seen[0]!.json).toEqual({ text: 'Hello world', model_id: 'eleven_flash_v2_5', language_code: 'en' });
    expect(speech.audio).toMatchObject({ mediaType: 'audio/wav' }); expect(speech.audio.data).toEqual(audio);
    expect(speech.usage).toEqual({ characters: 11, costMicros: 440 });
    await expect(voices.speaker('elevenlabs/eleven_v3').speak({ text: 'hi', voice: 'JBFqnCBsd6RMkjVDRZzb', format: 'aac' })).rejects.toMatchObject({ reason: 'configuration' });
    await expect(voices.speaker('elevenlabs/eleven_v3').speak({ text: 'hi', voice: '../admin' })).rejects.toBeDefined();
    expect(seen).toHaveLength(1);
    expect(catalog.speakers?.['eleven_v4']?.pricing).toEqual({ microsPerMillionCharacters: 80_000_000 });
  });

  it('needs an API key and an https endpoint', () => {
    expect(() => elevenlabsVoice({} as never)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => elevenlabsVoice({ apiKey: 'k', baseURL: 'http://api.elevenlabs.io' })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => elevenlabsVoice({ apiKey: 'k', headers: { 'xi-api-key': 'other' } })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });
});
