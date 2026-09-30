import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVoices, speechCostMicros, transcriptionCostMicros } from 'mayura/voice';
import { conformanceWav, voiceAdapterConformance, type VoiceScenario } from 'mayura/testing';
import { azureVoice, billableCharacters, catalog } from '../src/index.js';

type Seen = { url: string; headers: Headers; definition?: Record<string, unknown>; audio?: Blob; ssml?: string }[];
/** Azure's fast transcription and text-to-speech APIs, answering one scenario in their own wire format. */
function transport(scenario: VoiceScenario, seen: Seen = [], durationMs?: number): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const entry: Seen[number] = { url: request.url, headers: request.headers };
    if (request.url.includes('/speechtotext/')) {
      const form = await request.formData();
      entry.definition = JSON.parse(form.get('definition') as string) as Record<string, unknown>; entry.audio = form.get('audio') as Blob;
    } else entry.ssml = await request.text();
    seen.push(entry);
    switch (scenario.kind) {
      case 'transcript': return Response.json({ durationMilliseconds: durationMs ?? scenario.audioMs, combinedPhrases: [{ channel: 0, text: scenario.text, locale: 'en-US' }],
        phrases: [{ offsetMilliseconds: 0, durationMilliseconds: scenario.audioMs, text: scenario.text, channel: 0, speaker: 1, locale: 'en-US', confidence: 0.9, words: [] }] });
      case 'speech': {
        const audio = scenario.audio;
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(audio.slice(0, 700)); controller.enqueue(audio.slice(700)); controller.close(); } }),
          { status: 200, headers: { 'content-type': 'audio/mpeg' } });
      }
      case 'http': return Response.json({ error: { code: 'InvalidRequest', message: scenario.detail } }, { status: scenario.status });
      case 'invalid': return Response.json({ combinedPhrases: 'x', note: scenario.detail });
      case 'network': throw new TypeError('fetch failed');
      case 'hang': return new Promise<Response>((_, reject) => { request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); });
    }
  }) as typeof globalThis.fetch;
}
const never = (() => { throw new Error('No request may be sent.'); }) as unknown as typeof globalThis.fetch;
const speakerSettings = (name: string, maxCostMicros = 1_000_000) => ({ id: `azure/${name}`, pricing: catalog.speakers![name]!.pricing, maxCostMicros });

describe('@mayurajs/voice-azure keeps the voice adapter contract', () => {
  const harness = {
    transcriber: (scenario: VoiceScenario, settings: Parameters<NonNullable<ReturnType<typeof azureVoice>['transcriber']>>[1]) =>
      azureVoice({ region: 'eastus', apiKey: 'fixture-key', fetch: transport(scenario) }).transcriber!('fast', settings),
    speaker: (scenario: VoiceScenario, settings: Parameters<NonNullable<ReturnType<typeof azureVoice>['speaker']>>[1]) =>
      azureVoice({ region: 'eastus', apiKey: 'fixture-key', fetch: transport(scenario) }).speaker!('neural', settings),
    voice: 'en-US-AvaMultilingualNeural',
  };
  for (const test of voiceAdapterConformance) it(test.name, async () => { expect(await test.run(harness)).toBe('passed'); });
});

describe('@mayurajs/voice-azure', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('sends audio and a definition to fast transcription, detects the language, charges whole seconds, and reads nothing from the environment', async () => {
    vi.stubEnv('AZURE_SPEECH_KEY', 'key-from-env'); vi.stubEnv('SPEECH_REGION', 'attackerregion'); vi.stubEnv('AZURE_CLIENT_SECRET', 'secret-from-env');
    const seen: Seen = []; const audio = conformanceWav(30_000);
    const voices = createVoices({ providers: [azureVoice({ region: 'westeurope', apiKey: 'fixture-key', fetch: transport({ kind: 'transcript', text: 'Hello there.', audioMs: 30_000 }, seen, 30_250) })],
      maxCallCostMicros: 10_000, prices: 'catalog' });
    const result = await voices.transcriber('azure/fast').transcribe({ audio: { data: audio, mediaType: 'audio/wav' } });
    expect(result).toMatchObject({ text: 'Hello there.', language: 'en-US', segments: [{ startMs: 0, endMs: 30_000, text: 'Hello there.', speaker: '1' }],
      usage: { audioMs: 31_000, costMicros: transcriptionCostMicros({ microsPerMinute: 6_000 }, 31_000) } });
    expect(seen[0]!.url).toBe('https://westeurope.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15');
    expect(seen[0]!.headers.get('ocp-apim-subscription-key')).toBe('fixture-key'); expect(seen[0]!.headers.get('authorization')).toBeNull();
    expect(seen[0]!.definition).toEqual({ profanityFilterMode: 'None' });
    expect(new Uint8Array(await seen[0]!.audio!.arrayBuffer())).toEqual(audio);
  });

  it('sends the given locale and model, with a token source, to a custom subdomain', async () => {
    const seen: Seen = []; let calls = 0;
    const transcriber = azureVoice({ resource: 'my-speech', token: async () => `entra-${++calls}`, fetch: transport({ kind: 'transcript', text: 'Hola', audioMs: 1_000 }, seen) })
      .transcriber!('mai-transcribe-2', { id: 'azure/mai-transcribe-2', pricing: { microsPerMinute: 1_667 }, maxCostMicros: 1_000 });
    expect(await transcriber.transcribe({ audio: { data: conformanceWav(), mediaType: 'audio/wav' }, durationMs: 1_000, language: 'es-MX' })).toMatchObject({ text: 'Hola', language: 'es-MX' });
    expect(seen[0]!.url).toBe('https://my-speech.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15');
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer entra-1'); expect(seen[0]!.headers.get('ocp-apim-subscription-key')).toBeNull();
    expect(seen[0]!.definition).toEqual({ locales: ['es-MX'], profanityFilterMode: 'None', modelName: 'MAI-Transcribe-2' });
  });

  it('speaks SSML with the voice and output format, streaming the audio', async () => {
    const audio = new Uint8Array(Array.from({ length: 1_500 }, (_, index) => index % 251));
    const seen: Seen = [];
    const voices = createVoices({ providers: [azureVoice({ region: 'eastus', apiKey: 'fixture-key', fetch: transport({ kind: 'speech', audio }, seen) })], maxCallCostMicros: 10_000, prices: 'catalog' });
    const streamed: Uint8Array[] = [];
    const speech = await voices.speaker('azure/neural-hd').speak({ text: 'Fish & chips <3', voice: 'en-US-Ava:DragonHDLatestNeural', onAudio: chunk => streamed.push(chunk) });
    expect(seen[0]!.url).toBe('https://eastus.tts.speech.microsoft.com/cognitiveservices/v1');
    expect(seen[0]!.headers.get('x-microsoft-outputformat')).toBe('audio-24khz-48kbitrate-mono-mp3');
    expect(seen[0]!.headers.get('content-type')).toBe('application/ssml+xml');
    expect(seen[0]!.ssml).toBe('<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="en-US-Ava:DragonHDLatestNeural">Fish &amp; chips &lt;3</voice></speak>');
    // Azure bills the escapes as written: "Fish &amp; chips &lt;3" is 22 characters.
    expect(speech).toMatchObject({ audio: { mediaType: 'audio/mpeg' }, usage: { characters: 22, costMicros: speechCostMicros({ microsPerMillionCharacters: 22_000_000 }, 22) } });
    expect(streamed.length).toBe(2);
  });

  it('uses the custom subdomain\'s speech path and each output format', async () => {
    const seen: Seen = [];
    const speaker = azureVoice({ resource: 'my-speech', apiKey: 'k', fetch: transport({ kind: 'speech', audio: new Uint8Array([1, 2, 3]) }, seen) }).speaker!('neural', speakerSettings('neural'));
    expect((await speaker.speak({ text: 'Hi', voice: 'en-US-AvaMultilingualNeural', format: 'wav' })).audio.mediaType).toBe('audio/wav');
    await speaker.speak({ text: 'Hi', voice: 'zh-CN-liaoning-XiaobeiNeural', format: 'pcm16', language: 'zh-CN' });
    await speaker.speak({ text: 'Hi', voice: 'en-US-AvaMultilingualNeural', format: 'opus' });
    expect(seen.map(item => item.url)).toEqual(Array(3).fill('https://my-speech.cognitiveservices.azure.com/tts/cognitiveservices/v1'));
    expect(seen.map(item => item.headers.get('x-microsoft-outputformat'))).toEqual(['riff-24khz-16bit-mono-pcm', 'raw-24khz-16bit-mono-pcm', 'ogg-24khz-16bit-mono-opus']);
    expect(seen[1]!.ssml).toContain('xml:lang="zh-CN"');
  });

  it('counts Chinese characters twice and bounds what Azure bills before sending', async () => {
    expect(billableCharacters('你好 world')).toBe(10);
    const speaker = azureVoice({ region: 'eastus', apiKey: 'k', fetch: never }).speaker!('neural', speakerSettings('neural', 100));
    // Five Chinese characters: 5 code points the registry would count (75 micros), 10 billable characters (150 micros).
    await expect(speaker.speak({ text: '你好世界啊', voice: 'zh-CN-XiaoxiaoNeural' })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
  });

  it('refuses a voice of another family, Azure OpenAI voices, a format Azure does not make and a malformed language, before sending anything', async () => {
    const neural = azureVoice({ region: 'eastus', apiKey: 'k', fetch: never }).speaker!('neural', speakerSettings('neural'));
    // An HD voice costs more than a standard one: under the neural id it would be charged at the wrong price.
    for (const voice of ['en-US-Ava:DragonHDLatestNeural', 'en-US-AlloyMultilingualNeural', 'en-us-shimmermultilingualNeural', 'en-US-AlloyMultilingualNeuralHD', 'Ava', 'en-US-Ava"Neural']) {
      await expect(neural.speak({ text: 'Hi', voice })).rejects.toMatchObject({ reason: 'configuration' });
    }
    const hd = azureVoice({ region: 'eastus', apiKey: 'k', fetch: never }).speaker!('neural-hd', speakerSettings('neural-hd'));
    await expect(hd.speak({ text: 'Hi', voice: 'en-US-Tiana:DragonHDFlashLatestNeural' })).rejects.toMatchObject({ reason: 'configuration' });
    const flash = azureVoice({ region: 'eastus', apiKey: 'k', fetch: never }).speaker!('neural-hd-flash', speakerSettings('neural-hd-flash'));
    await expect(flash.speak({ text: 'Hi', voice: 'en-US-Ava:DragonHDLatestNeural' })).rejects.toMatchObject({ reason: 'configuration' });
    await expect(neural.speak({ text: 'Hi', voice: 'en-US-AvaNeural', format: 'flac' })).rejects.toMatchObject({ reason: 'configuration' });
    await expect(neural.speak({ text: 'Hi', voice: 'en-US-AvaNeural', language: 'en"><x' })).rejects.toMatchObject({ reason: 'configuration' });
  });

  it('maps a failing token source to authentication without sending a request', async () => {
    for (const token of [() => { throw new Error('SECRET'); }, async () => ' ', () => 'a\nb']) {
      const error = await azureVoice({ region: 'eastus', token, fetch: never }).speaker!('neural', speakerSettings('neural'))
        .speak({ text: 'Hi', voice: 'en-US-AvaNeural' }).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ reason: 'authentication' }); expect(JSON.stringify(error)).not.toContain('SECRET');
    }
  });

  it('needs one credential, one of region and resource, https endpoints and a known model or family', () => {
    const invalid = expect.objectContaining({ code: 'INVALID_CONFIG' });
    expect(() => azureVoice({ region: 'eastus' } as never)).toThrow(invalid);
    expect(() => azureVoice({ region: 'eastus', apiKey: 'k', token: () => 't' })).toThrow(invalid);
    expect(() => azureVoice({ apiKey: 'k' })).toThrow(invalid);
    expect(() => azureVoice({ apiKey: 'k', region: 'eastus', resource: 'r1' })).toThrow(invalid);
    expect(() => azureVoice({ apiKey: 'k', region: 'east.us/x' })).toThrow(invalid);
    expect(() => azureVoice({ apiKey: 'k', resource: 'evil.example' })).toThrow(invalid);
    expect(() => azureVoice({ apiKey: 'k', region: 'eastus', textToSpeechURL: 'http://eastus.tts.speech.microsoft.com' })).toThrow(invalid);
    expect(() => azureVoice({ apiKey: 'k', region: 'eastus', headers: { 'ocp-apim-subscription-key': 'other' } })).toThrow(invalid);
    expect(() => azureVoice({ apiKey: 'k', region: 'eastus' }).transcriber!('whisper', { id: 'azure/whisper', pricing: { microsPerMinute: 1 }, maxCostMicros: 1 })).toThrow(invalid);
    expect(() => azureVoice({ apiKey: 'k', region: 'eastus' }).speaker!('constructor', { id: 'azure/constructor', pricing: { microsPerMillionCharacters: 1 }, maxCostMicros: 1 })).toThrow(invalid);
  });
});
