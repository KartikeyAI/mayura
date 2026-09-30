import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVoices } from 'mayura/voice';
import { conformanceWav, voiceAdapterConformance, type VoiceScenario } from 'mayura/testing';
import { assemblyaiVoice, catalog } from '../src/index.js';

type Seen = { method: string; url: string; headers: Headers; json?: Record<string, unknown>; bytes?: number }[];
/** AssemblyAI's asynchronous API (upload, submit, poll, delete), answering one scenario in its own wire format. */
function transport(scenario: VoiceScenario, seen: Seen = []): typeof globalThis.fetch {
  let polls = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init); const path = new URL(request.url).pathname;
    const entry: Seen[number] = { method: request.method, url: request.url, headers: request.headers };
    if (request.method === 'POST') { const body = new Uint8Array(await request.arrayBuffer()); if (path === '/v2/upload') entry.bytes = body.byteLength; else entry.json = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>; }
    seen.push(entry);
    if (scenario.kind === 'network') throw new TypeError('fetch failed');
    if (scenario.kind === 'hang') return new Promise<Response>((_, reject) => { request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); });
    if (scenario.kind === 'http') return Response.json({ error: scenario.detail }, { status: scenario.status });
    if (path === '/v2/upload') return scenario.kind === 'invalid' ? Response.json({ note: scenario.detail }) : Response.json({ upload_url: 'https://cdn.assemblyai.com/upload/abc' });
    if (path === '/v2/transcript' && request.method === 'POST') return Response.json({ id: 'tr_1', status: 'queued' });
    if (request.method === 'DELETE') return Response.json({ id: 'tr_1', status: 'completed' });
    if (scenario.kind !== 'transcript') return Response.json({ id: 'tr_1', status: 'error', error: 'SECRET' });
    if (polls++ === 0) return Response.json({ id: 'tr_1', status: 'processing' });
    return Response.json({ id: 'tr_1', status: 'completed', text: scenario.text, language_code: 'en_us', audio_duration: scenario.audioMs / 1_000,
      words: [{ text: scenario.text, start: 0, end: scenario.audioMs, confidence: 0.99, speaker: null }] });
  }) as typeof globalThis.fetch;
}

describe('@mayurajs/voice-assemblyai keeps the voice adapter contract', () => {
  const harness = {
    transcriber: (scenario: VoiceScenario, settings: Parameters<NonNullable<ReturnType<typeof assemblyaiVoice>['transcriber']>>[1]) =>
      assemblyaiVoice({ apiKey: 'fixture-key', pollIntervalMs: 5, fetch: transport(scenario) }).transcriber!('universal-3-5-pro', settings),
  };
  // AssemblyAI has no speech API, so only the speech case is skipped; every other case runs on the transcriber.
  for (const test of voiceAdapterConformance) it(test.name, async () => { expect(await test.run(harness)).toBe(test.name.startsWith('speaks') ? 'skipped' : 'passed'); });
});

describe('@mayurajs/voice-assemblyai', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('uploads, requests one model, waits for the transcript, deletes it, and reads nothing from the environment', async () => {
    vi.stubEnv('ASSEMBLYAI_API_KEY', 'key-from-env');
    const seen: Seen = [];
    const voices = createVoices({ providers: [assemblyaiVoice({ apiKey: 'fixture-key', pollIntervalMs: 5, fetch: transport({ kind: 'transcript', text: 'Hello', audioMs: 120_000 }, seen) })],
      maxCallCostMicros: 10_000, prices: 'catalog' });
    const result = await voices.transcriber('assemblyai/universal-3-5-pro').transcribe({ audio: { data: conformanceWav(120_000), mediaType: 'audio/wav' } });
    expect(result).toMatchObject({ text: 'Hello', language: 'en-us', usage: { audioMs: 120_000, costMicros: 7_000 }, segments: [{ startMs: 0, endMs: 120_000, text: 'Hello' }] });
    await vi.waitFor(() => { expect(seen.some(item => item.method === 'DELETE')).toBe(true); });
    expect(seen.map(item => `${item.method} ${new URL(item.url).pathname}`)).toEqual(['POST /v2/upload', 'POST /v2/transcript', 'GET /v2/transcript/tr_1', 'GET /v2/transcript/tr_1', 'DELETE /v2/transcript/tr_1']);
    expect(seen.every(item => item.headers.get('authorization') === 'fixture-key' && item.url.startsWith('https://api.assemblyai.com/'))).toBe(true);
    expect(seen[0]!.bytes).toBe(conformanceWav(120_000).byteLength);
    expect(seen[1]!.json).toEqual({ audio_url: 'https://cdn.assemblyai.com/upload/abc', speech_models: ['universal-3-5-pro'], language_detection: true });
  });

  it('keeps transcripts only when asked, sends a given language, and reports a failed transcript as rejected', async () => {
    const seen: Seen = [];
    const transcriber = assemblyaiVoice({ apiKey: 'fixture-key', baseURL: 'https://api.eu.assemblyai.com', retainTranscripts: true, pollIntervalMs: 5,
      fetch: transport({ kind: 'transcript', text: 'Hola', audioMs: 1_000 }, seen) }).transcriber!('universal-2', { id: 'assemblyai/universal-2', pricing: catalog.transcribers!['universal-2']!.pricing, maxCostMicros: 1_000 });
    await transcriber.transcribe({ audio: { data: conformanceWav(), mediaType: 'audio/wav' }, durationMs: 1_000, language: 'es-MX' });
    expect(seen[1]!.json).toMatchObject({ speech_models: ['universal-2'], language_code: 'es' });
    expect(seen.some(item => item.method === 'DELETE')).toBe(false);
    expect(seen[0]!.url).toBe('https://api.eu.assemblyai.com/v2/upload');
    const failing = assemblyaiVoice({ apiKey: 'fixture-key', pollIntervalMs: 5, fetch: transport({ kind: 'speech', audio: new Uint8Array([1]) }) })
      .transcriber!('universal-2', { id: 'assemblyai/universal-2', pricing: { microsPerMinute: 1 }, maxCostMicros: 1_000 });
    const error = await failing.transcribe({ audio: { data: conformanceWav(), mediaType: 'audio/wav' }, durationMs: 1_000 }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ reason: 'rejected' }); expect(JSON.stringify(error)).not.toContain('SECRET');
  });

  it('needs an API key and an https endpoint, and offers no speech', () => {
    expect(() => assemblyaiVoice({} as never)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => assemblyaiVoice({ apiKey: 'k', baseURL: 'http://api.assemblyai.com' })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(assemblyaiVoice({ apiKey: 'k' }).speaker).toBeUndefined();
  });
});
