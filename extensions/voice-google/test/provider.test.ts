import { afterEach, describe, expect, it, vi } from 'vitest';
import { audioFromBase64, audioToBase64, createVoices, transcriptionCostMicros } from 'mayura/voice';
import { conformanceWav, voiceAdapterConformance, type VoiceScenario } from 'mayura/testing';
import { catalog, googleVoice } from '../src/index.js';

type Seen = { url: string; headers: Headers; json: Record<string, any> }[];
const seconds = (ms: number) => `${ms / 1_000}s`;
/** Google's Speech-to-Text v2 and Text-to-Speech v1 APIs, answering one scenario in their own wire format. */
function transport(scenario: VoiceScenario, seen: Seen = [], billed?: string): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const json = JSON.parse(await request.text()) as Record<string, any>;
    seen.push({ url: request.url, headers: request.headers, json });
    const speech = request.url.includes('/v1/text:synthesize');
    switch (scenario.kind) {
      case 'transcript': {
        const words = json['config']?.features?.enableWordTimeOffsets
          ? { words: [{ startOffset: '0s', endOffset: seconds(scenario.audioMs), word: scenario.text, confidence: 0.9, speakerLabel: '1' }] } : {};
        return Response.json({ results: [{ alternatives: [{ transcript: ` ${scenario.text}`, confidence: 0.9, ...words }], resultEndOffset: seconds(scenario.audioMs), languageCode: 'en-us' }],
          metadata: { requestId: 'r', totalBilledDuration: billed ?? seconds(scenario.audioMs) } });
      }
      case 'speech': return Response.json({ audioContent: audioToBase64(scenario.audio) });
      case 'http': return Response.json({ error: { code: scenario.status, message: scenario.detail, status: 'FAILED' } }, { status: scenario.status });
      case 'invalid': return Response.json(speech ? { note: scenario.detail } : { results: [{ alternatives: [{ transcript: 42 }] }], note: scenario.detail });
      case 'network': throw new TypeError('fetch failed');
      case 'hang': return new Promise<Response>((_, reject) => { request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); });
    }
  }) as typeof globalThis.fetch;
}
const never = (() => { throw new Error('No request may be sent.'); }) as unknown as typeof globalThis.fetch;

describe('@mayurajs/voice-google keeps the voice adapter contract', () => {
  const harness = {
    transcriber: (scenario: VoiceScenario, settings: Parameters<NonNullable<ReturnType<typeof googleVoice>['transcriber']>>[1]) =>
      googleVoice({ token: () => 'fixture-token', project: 'fixture-project', fetch: transport(scenario) }).transcriber!('chirp_3', settings),
    speaker: (scenario: VoiceScenario, settings: Parameters<NonNullable<ReturnType<typeof googleVoice>['speaker']>>[1]) =>
      googleVoice({ apiKey: 'fixture-key', fetch: transport(scenario) }).speaker!('neural2', settings),
    voice: 'en-US-Neural2-A',
  };
  for (const test of voiceAdapterConformance) it(test.name, async () => { expect(await test.run(harness)).toBe('passed'); });
});

describe('@mayurajs/voice-google', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('transcribes with Chirp 3 through a token source, detects the language, charges the billed seconds, and reads nothing from the environment', async () => {
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/attacker/key.json'); vi.stubEnv('GOOGLE_API_KEY', 'key-from-env'); vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'attacker-project');
    const seen: Seen = []; const audio = conformanceWav(30_200); let tokens = 0;
    const voices = createVoices({ providers: [googleVoice({ token: async () => `token-${++tokens}`, project: 'my-project', fetch: transport({ kind: 'transcript', text: 'Hello', audioMs: 30_200 }, seen, '31s') })],
      maxCallCostMicros: 10_000, prices: 'catalog' });
    const result = await voices.transcriber('google/chirp_3').transcribe({ audio: { data: audio, mediaType: 'audio/wav' } });
    expect(result).toMatchObject({ text: 'Hello', language: 'en-US', segments: [{ startMs: 0, endMs: 30_200, text: 'Hello' }],
      usage: { audioMs: 31_000, costMicros: transcriptionCostMicros({ microsPerMinute: 16_000 }, 31_000) } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://us-speech.googleapis.com/v2/projects/my-project/locations/us/recognizers/_:recognize');
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer token-1'); expect(seen[0]!.headers.get('x-goog-api-key')).toBeNull();
    expect(seen[0]!.json).toEqual({ config: { autoDecodingConfig: {}, model: 'chirp_3', languageCodes: ['auto'] }, content: audioToBase64(audio) });
  });

  it('asks other models for word timings in the given language, at the location given', async () => {
    const seen: Seen = [];
    const transcriber = googleVoice({ apiKey: 'fixture-key', project: '123456789', location: 'global', fetch: transport({ kind: 'transcript', text: 'Hola', audioMs: 2_000 }, seen) })
      .transcriber!('telephony', { id: 'google/telephony', pricing: catalog.transcribers!['telephony']!.pricing, maxCostMicros: 1_000 });
    const result = await transcriber.transcribe({ audio: { data: conformanceWav(2_000), mediaType: 'audio/wav' }, durationMs: 2_000, language: 'es-MX' });
    expect(result).toMatchObject({ text: 'Hola', language: 'es-MX', segments: [{ startMs: 0, endMs: 2_000, text: 'Hola', speaker: '1' }], usage: { audioMs: 2_000 } });
    expect(seen[0]!.url).toBe('https://speech.googleapis.com/v2/projects/123456789/locations/global/recognizers/_:recognize');
    expect(seen[0]!.headers.get('x-goog-api-key')).toBe('fixture-key');
    expect(seen[0]!.json['config']).toEqual({ autoDecodingConfig: {}, model: 'telephony', languageCodes: ['es-MX'], features: { enableWordTimeOffsets: true } });
  });

  it('reads silence as an empty transcript and still charges what Google billed', async () => {
    const silent = (async () => Response.json({ results: [{ resultEndOffset: '4s' }], metadata: { totalBilledDuration: '4s' } })) as unknown as typeof globalThis.fetch;
    const transcriber = googleVoice({ apiKey: 'k', project: 'my-project', fetch: silent }).transcriber!('chirp_3', { id: 'google/chirp_3', pricing: { microsPerMinute: 16_000 }, maxCostMicros: 10_000 });
    expect(await transcriber.transcribe({ audio: { data: conformanceWav(4_000), mediaType: 'audio/wav' }, durationMs: 4_000 }))
      .toMatchObject({ text: '', segments: [], usage: { audioMs: 4_000, costMicros: transcriptionCostMicros({ microsPerMinute: 16_000 }, 4_000) } });
  });

  it('refuses audio past synchronous recognition\'s limits before sending it', async () => {
    const transcriber = googleVoice({ apiKey: 'k', project: 'my-project', fetch: never }).transcriber!('chirp_3', { id: 'google/chirp_3', pricing: { microsPerMinute: 16_000 }, maxCostMicros: 100_000 });
    await expect(transcriber.transcribe({ audio: { data: conformanceWav(61_000), mediaType: 'audio/wav' }, durationMs: 61_000 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await expect(transcriber.transcribe({ audio: { data: new Uint8Array(10 * 1_048_576 + 1), mediaType: 'audio/mpeg' }, durationMs: 1_000 })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it('speaks with a voice of the family priced, in each format, from Google\'s base64 audio', async () => {
    const audio = new Uint8Array([7, 8, 9, 10]);
    const seen: Seen = [];
    const voices = createVoices({ providers: [googleVoice({ apiKey: 'fixture-key', fetch: transport({ kind: 'speech', audio }, seen) })], maxCallCostMicros: 10_000, prices: 'catalog' });
    const speaker = voices.speaker('google/chirp3-hd');
    const streamed: Uint8Array[] = [];
    const speech = await speaker.speak({ text: 'Hello.', voice: 'en-GB-Chirp3-HD-Charon', onAudio: chunk => streamed.push(chunk) });
    expect(speech).toMatchObject({ audio: { mediaType: 'audio/mpeg' }, usage: { characters: 6, costMicros: 180 } });
    expect([...speech.audio.data]).toEqual([7, 8, 9, 10]); expect(streamed).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://texttospeech.googleapis.com/v1/text:synthesize');
    expect(seen[0]!.headers.get('x-goog-api-key')).toBe('fixture-key'); expect(seen[0]!.headers.get('authorization')).toBeNull();
    expect(seen[0]!.json).toEqual({ input: { text: 'Hello.' }, voice: { languageCode: 'en-GB', name: 'en-GB-Chirp3-HD-Charon' }, audioConfig: { audioEncoding: 'MP3' } });
    expect((await speaker.speak({ text: 'Hi', voice: 'en-US-Chirp3-HD-Kore', format: 'wav' })).audio.mediaType).toBe('audio/wav');
    expect(seen[1]!.json['audioConfig']).toEqual({ audioEncoding: 'LINEAR16' });
    await speaker.speak({ text: 'Hi', voice: 'en-US-Chirp3-HD-Kore', format: 'pcm16' });
    expect(seen[2]!.json['audioConfig']).toEqual({ audioEncoding: 'PCM', sampleRateHertz: 24_000 });
  });

  it('refuses a voice of another family, a format Google does not make and text past 5,000 bytes, before sending anything', async () => {
    const speaker = googleVoice({ apiKey: 'k', fetch: never }).speaker!('neural2', { id: 'google/neural2', pricing: catalog.speakers!['neural2']!.pricing, maxCostMicros: 1_000_000 });
    // A Studio voice costs ten times a Neural2 one: under the neural2 id it would be charged at the wrong price.
    for (const voice of ['en-US-Studio-O', 'en-US-Chirp3-HD-Charon', 'Neural2-A', 'en-US-Neural2-A/../x']) {
      await expect(speaker.speak({ text: 'Hi', voice })).rejects.toMatchObject({ reason: 'configuration' });
    }
    await expect(speaker.speak({ text: 'Hi', voice: 'en-US-Neural2-A', format: 'flac' })).rejects.toMatchObject({ reason: 'configuration' });
    await expect(speaker.speak({ text: 'é'.repeat(2_501), voice: 'en-US-Neural2-A' })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it('maps a failing token source to authentication without sending a request', async () => {
    const settings = { id: 'google/neural2', pricing: { microsPerMillionCharacters: 16_000_000 }, maxCostMicros: 1_000 };
    for (const token of [() => { throw new Error('SECRET'); }, async () => '', () => 'a\r\nx-injected: 1']) {
      const error = await googleVoice({ token, fetch: never }).speaker!('neural2', settings).speak({ text: 'Hi', voice: 'en-US-Neural2-A' }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ reason: 'authentication' }); expect(JSON.stringify(error)).not.toContain('SECRET');
    }
  });

  it('refuses a malformed audio body', async () => {
    const bad = (async () => Response.json({ audioContent: '%%%' })) as unknown as typeof globalThis.fetch;
    await expect(googleVoice({ apiKey: 'k', fetch: bad }).speaker!('standard', { id: 'google/standard', pricing: { microsPerMillionCharacters: 4_000_000 }, maxCostMicros: 1_000 })
      .speak({ text: 'Hi', voice: 'en-US-Standard-A' })).rejects.toMatchObject({ reason: 'invalid_response' });
    expect(audioFromBase64(audioToBase64(new Uint8Array([1, 2])))).toEqual(new Uint8Array([1, 2]));
  });

  it('needs one credential, https endpoints, a valid project and location, and a known voice family', () => {
    const invalid = expect.objectContaining({ code: 'INVALID_CONFIG' });
    expect(() => googleVoice({} as never)).toThrow(invalid);
    expect(() => googleVoice({ apiKey: 'k', token: () => 't' })).toThrow(invalid);
    expect(() => googleVoice({ apiKey: 'k\r\nx: 1' })).toThrow(invalid);
    expect(() => googleVoice({ apiKey: 'k', textToSpeechURL: 'http://texttospeech.googleapis.com' })).toThrow(invalid);
    expect(() => googleVoice({ apiKey: 'k', project: 'Bad/Project' })).toThrow(invalid);
    expect(() => googleVoice({ apiKey: 'k', location: 'us.evil.example/x' })).toThrow(invalid);
    expect(() => googleVoice({ apiKey: 'k', headers: { 'X-Goog-Api-Key': 'other' } })).toThrow(invalid);
    expect(() => googleVoice({ apiKey: 'k' }).transcriber!('chirp_3', { id: 'google/chirp_3', pricing: { microsPerMinute: 1 }, maxCostMicros: 1 })).toThrow(invalid);
    expect(() => googleVoice({ apiKey: 'k' }).speaker!('journey', { id: 'google/journey', pricing: { microsPerMillionCharacters: 1 }, maxCostMicros: 1 })).toThrow(invalid);
    expect(() => googleVoice({ apiKey: 'k' }).speaker!('__proto__', { id: 'google/__proto__', pricing: { microsPerMillionCharacters: 1 }, maxCostMicros: 1 })).toThrow(invalid);
  });
});
