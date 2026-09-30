import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVoices } from 'mayura/voice';
import { conformanceWav, voiceAdapterConformance, type VoiceScenario } from 'mayura/testing';
import { catalog, openaiVoice } from '../src/index.js';

type Seen = { url: string; headers: Headers; form?: FormData; json?: Record<string, unknown> }[];
/** OpenAI's audio endpoints, answering one scenario in OpenAI's own wire format. */
function transport(scenario: VoiceScenario, seen: Seen = []): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    // The SDK fetches a data: URL of its own to learn what fetch supports; only API calls are the scenario's.
    if (!request.url.startsWith('https:')) return globalThis.fetch(input, init);
    const entry: Seen[number] = { url: request.url, headers: request.headers };
    if (request.headers.get('content-type')?.startsWith('multipart/form-data')) entry.form = await request.formData();
    else if (request.method === 'POST') entry.json = await request.json() as Record<string, unknown>;
    seen.push(entry);
    switch (scenario.kind) {
      case 'transcript': return Response.json({ task: 'transcribe', language: 'english', duration: scenario.audioMs / 1_000, text: ` ${scenario.text} `,
        segments: [{ id: 0, start: 0, end: scenario.audioMs / 1_000, text: ` ${scenario.text}` }], usage: { type: 'duration', seconds: scenario.audioMs / 1_000 } });
      case 'speech': {
        const audio = scenario.audio;
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(audio.slice(0, 1_000)); controller.enqueue(audio.slice(1_000)); controller.close(); } }),
          { status: 200, headers: { 'content-type': 'audio/mpeg' } });
      }
      case 'http': return Response.json({ error: { message: scenario.detail, type: 'invalid_request_error' } }, { status: scenario.status });
      case 'invalid': return Response.json({ unexpected: scenario.detail });
      case 'network': throw new TypeError('fetch failed');
      case 'hang': return new Promise<Response>((_, reject) => { request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); });
    }
  }) as typeof globalThis.fetch;
}

describe('@mayurajs/voice-openai keeps the voice adapter contract', () => {
  const harness = {
    transcriber: (scenario: VoiceScenario, settings: Parameters<NonNullable<ReturnType<typeof openaiVoice>['transcriber']>>[1]) =>
      openaiVoice({ apiKey: 'fixture-key', fetch: transport(scenario) }).transcriber!('whisper-1', settings),
    speaker: (scenario: VoiceScenario, settings: Parameters<NonNullable<ReturnType<typeof openaiVoice>['speaker']>>[1]) =>
      openaiVoice({ apiKey: 'fixture-key', fetch: transport(scenario) }).speaker!('tts-1', settings),
    voice: 'alloy',
  };
  for (const test of voiceAdapterConformance) it(test.name, async () => { expect(await test.run(harness)).toBe('passed'); });
});

describe('@mayurajs/voice-openai', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('sends the key it was given to its own endpoint, and reads nothing from the environment', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'key-from-env'); vi.stubEnv('OPENAI_BASE_URL', 'https://attacker.example/v1'); vi.stubEnv('OPENAI_LOG', 'debug');
    vi.stubEnv('OPENAI_ORG_ID', 'org-env'); vi.stubEnv('OPENAI_PROJECT_ID', 'project-env');
    const seen: Seen = []; const log = vi.spyOn(console, 'log'); const debug = vi.spyOn(console, 'debug');
    const voices = createVoices({ providers: [openaiVoice({ apiKey: 'fixture-key', fetch: transport({ kind: 'transcript', text: 'hi', audioMs: 1_500 }, seen) })], maxCallCostMicros: 1_000, prices: 'catalog' });
    const result = await voices.transcriber('openai/whisper-1').transcribe({ audio: { data: conformanceWav(1_500), mediaType: 'audio/wav' }, language: 'en-GB', prompt: 'Mayura' });
    expect(result).toMatchObject({ text: 'hi', usage: { audioMs: 1_500, costMicros: 150 }, segments: [{ startMs: 0, endMs: 1_500, text: 'hi' }] });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer fixture-key');
    expect(seen[0]!.headers.get('openai-organization')).toBeNull(); expect(seen[0]!.headers.get('openai-project')).toBeNull();
    expect(seen[0]!.form?.get('model')).toBe('whisper-1'); expect(seen[0]!.form?.get('language')).toBe('en');
    expect(seen[0]!.form?.get('response_format')).toBe('verbose_json'); expect(seen[0]!.form?.get('prompt')).toBe('Mayura');
    expect((seen[0]!.form?.get('file') as File).name).toBe('audio.wav');
    expect(log).not.toHaveBeenCalled(); expect(debug).not.toHaveBeenCalled();
  });

  it('speaks with the voice, format and instructions given, and charges characters at catalog prices', async () => {
    const seen: Seen = []; const audio = new Uint8Array(3_000).fill(7);
    const voices = createVoices({ providers: [openaiVoice({ apiKey: 'fixture-key', fetch: transport({ kind: 'speech', audio }, seen) })], maxCallCostMicros: 1_000, prices: 'catalog' });
    const speech = await voices.speaker('openai/tts-1-hd').speak({ text: 'Hello there', voice: 'coral', format: 'wav', instructions: 'Warmly.' });
    expect(seen[0]!.url).toBe('https://api.openai.com/v1/audio/speech');
    expect(seen[0]!.json).toMatchObject({ model: 'tts-1-hd', voice: 'coral', input: 'Hello there', response_format: 'wav', instructions: 'Warmly.' });
    expect(speech.audio).toMatchObject({ mediaType: 'audio/wav' }); expect(speech.audio.data).toEqual(audio);
    expect(speech.usage).toEqual({ characters: 11, costMicros: 330 });
    expect(catalog.asOf).toBe('2026-09-30');
  });

  it('refuses compressed audio types OpenAI does not take, and speech larger than its bound', async () => {
    const transcriber = openaiVoice({ apiKey: 'fixture-key', fetch: transport({ kind: 'transcript', text: 'hi', audioMs: 1_000 }) }).transcriber!('whisper-1', { id: 'openai/whisper-1', pricing: { microsPerMinute: 6_000 }, maxCostMicros: 1_000 });
    await expect(transcriber.transcribe({ audio: { data: new Uint8Array([1]), mediaType: 'audio/aiff' }, durationMs: 1_000 })).rejects.toMatchObject({ reason: 'configuration' });
    const speaker = openaiVoice({ apiKey: 'fixture-key', maxAudioBytes: 100, fetch: transport({ kind: 'speech', audio: new Uint8Array(3_000) }) }).speaker!('tts-1', { id: 'openai/tts-1', pricing: { microsPerMillionCharacters: 1 }, maxCostMicros: 1_000 });
    await expect(speaker.speak({ text: 'hi', voice: 'alloy' })).rejects.toMatchObject({ reason: 'invalid_response' });
  });

  it('needs an API key and an https endpoint', () => {
    expect(() => openaiVoice({} as never)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => openaiVoice({ apiKey: 'k', baseURL: 'http://example.com/v1' })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });
});
