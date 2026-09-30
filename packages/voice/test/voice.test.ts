import { describe, expect, it, vi } from 'vitest';
import {
  audioFromBase64, audioToBase64, createVoices, speechCostMicros, speechTool, transcriptionCostMicros, transcriptionTool, VoiceProviderError, wavDurationMs,
  type Speaker, type SpeakerSettings, type Transcriber, type TranscriberSettings, type VoiceProvider,
} from '@mayura/voice';
import { conformanceWav, testTool, toolGrants, voiceAdapterConformance, type VoiceScenario } from '../../testing/src/index.js';

/** A reference adapter over scenarios: what a provider package must do, without a network. */
function reference(scenario: VoiceScenario, settings: TranscriberSettings | SpeakerSettings, side: 'transcriber' | 'speaker'): Transcriber & Speaker {
  const answer = async (signal: AbortSignal | undefined) => {
    if (scenario.kind === 'http') throw new VoiceProviderError(scenario.status === 429 ? 'rate_limited' : scenario.status >= 500 ? 'unavailable' : [401, 403].includes(scenario.status) ? 'authentication' : 'rejected', { httpStatus: scenario.status });
    if (scenario.kind === 'invalid') throw new VoiceProviderError('invalid_response');
    if (scenario.kind === 'network') throw new VoiceProviderError('unavailable');
    if (scenario.kind === 'hang') await new Promise<void>((_, reject) => {
      const timer = settings.timeoutMs ? setTimeout(() => reject(new VoiceProviderError('timeout')), settings.timeoutMs) : undefined;
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new (class extends Error {})()); });
    }).catch(error => { if (error instanceof VoiceProviderError) throw error; throw Object.assign(new VoiceProviderError('timeout'), {}); });
  };
  return {
    id: settings.id, maxCostMicros: settings.maxCostMicros,
    transcribe: async request => {
      await answer(request.signal);
      if (scenario.kind !== 'transcript' || side !== 'transcriber') throw new VoiceProviderError('invalid_response');
      return { text: scenario.text, ...(scenario.language ? { language: scenario.language } : {}), segments: [{ startMs: 0, endMs: scenario.audioMs, text: scenario.text }],
        usage: { audioMs: scenario.audioMs, costMicros: transcriptionCostMicros((settings as TranscriberSettings).pricing, scenario.audioMs) } };
    },
    speak: async request => {
      await answer(request.signal);
      if (scenario.kind !== 'speech' || side !== 'speaker') throw new VoiceProviderError('invalid_response');
      request.onAudio?.(scenario.audio.subarray(0, 100)); request.onAudio?.(scenario.audio.subarray(100));
      const characters = [...request.text].length;
      return { audio: { data: scenario.audio, mediaType: 'audio/mpeg' }, usage: { characters, costMicros: speechCostMicros((settings as SpeakerSettings).pricing, characters) } };
    },
  };
}

describe('voice adapter conformance (reference adapter)', () => {
  const harness = { transcriber: (scenario: VoiceScenario, settings: TranscriberSettings) => reference(scenario, settings, 'transcriber'),
    speaker: (scenario: VoiceScenario, settings: SpeakerSettings) => reference(scenario, settings, 'speaker'), voice: 'alloy' };
  for (const test of voiceAdapterConformance) it(test.name, async () => { expect(await test.run(harness)).toBe('passed'); });
});

describe('voice registry', () => {
  const calls = { transcribe: 0, speak: 0 };
  const provider: VoiceProvider = {
    id: 'fake', catalog: { asOf: '2026-09-30', transcribers: { listen: { pricing: { microsPerMinute: 6_000 } } }, speakers: { talk: { pricing: { microsPerMillionCharacters: 15_000_000 } } } },
    transcriber: (_name, settings) => { const inner = reference({ kind: 'transcript', text: 'hi', audioMs: 1_000 }, settings, 'transcriber'); return { ...inner, transcribe: request => { calls.transcribe++; return inner.transcribe(request); } }; },
    speaker: (_name, settings) => { const inner = reference({ kind: 'speech', audio: new Uint8Array([1, 2, 3]) }, settings, 'speaker'); return { ...inner, speak: request => { calls.speak++; return inner.speak(request); } }; },
  };

  it('needs a price for every model and a bound for every call, and uses catalog prices only when asked', () => {
    expect(() => createVoices({ providers: [provider] } as never)).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(() => createVoices({ providers: [provider], maxCallCostMicros: 10_000 }).transcriber('fake/listen')).toThrow(/No price for fake\/listen/);
    const catalog = createVoices({ providers: [provider], maxCallCostMicros: 10_000, prices: 'catalog' });
    expect(catalog.transcriber('fake/listen').id).toBe('fake/listen');
    expect(catalog.list().map(item => `${item.kind}:${item.id}:${item.catalogAsOf}`)).toEqual(['transcriber:fake/listen:2026-09-30', 'speaker:fake/talk:2026-09-30']);
    expect(() => catalog.transcriber('other/listen')).toThrow(/No voice provider other/);
    expect(() => catalog.speaker('fake/listen', { pricing: { microsPerMillionCharacters: -1 } })).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
  });

  it('refuses a call that would exceed its bound before calling the provider', async () => {
    const voices = createVoices({ providers: [provider], maxCallCostMicros: 1_000, prices: 'catalog' });
    calls.speak = 0; calls.transcribe = 0;
    // 100 characters at $15 per million cost 1,500 micros: more than the 1,000 bound.
    await expect(voices.speaker('fake/talk').speak({ text: 'x'.repeat(100), voice: 'alloy' })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    // Eleven seconds of WAV at $0.006 per minute cost 1,100 micros.
    await expect(voices.transcriber('fake/listen').transcribe({ audio: { data: conformanceWav(11_000), mediaType: 'audio/wav' } })).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' });
    expect(calls).toEqual({ transcribe: 0, speak: 0 });
    expect((await voices.speaker('fake/talk').speak({ text: 'x'.repeat(50), voice: 'alloy' })).usage.costMicros).toBe(750);
    expect(calls.speak).toBe(1);
  });

  it('measures WAV, and needs a duration for compressed audio it cannot measure', async () => {
    expect(wavDurationMs({ data: conformanceWav(2_500), mediaType: 'audio/wav' })).toBe(2_500);
    expect(wavDurationMs({ data: conformanceWav(), mediaType: 'audio/mpeg' })).toBeUndefined();
    const voices = createVoices({ providers: [provider], maxCallCostMicros: 10_000, prices: 'catalog' });
    await expect(voices.transcriber('fake/listen').transcribe({ audio: { data: new Uint8Array([1, 2, 3]), mediaType: 'audio/webm' } })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await voices.transcriber('fake/listen').transcribe({ audio: { data: new Uint8Array([1, 2, 3]), mediaType: 'audio/webm' }, durationMs: 1_000 })).text).toBe('hi');
    for (const request of [{ audio: { data: new Uint8Array(), mediaType: 'audio/wav' } }, { audio: { data: conformanceWav(), mediaType: 'text/plain' } },
      { audio: { data: conformanceWav(), mediaType: 'audio/wav' }, language: 'not a tag' }]) {
      await expect(voices.transcriber('fake/listen').transcribe(request as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
  });

  it('refuses an adapter that does not use the id and bound it was given, and a malformed result', async () => {
    const wrong: VoiceProvider = { id: 'wrong', speaker: (_name, settings) => ({ ...reference({ kind: 'speech', audio: new Uint8Array([1]) }, settings, 'speaker'), maxCostMicros: settings.maxCostMicros + 1 }) };
    expect(() => createVoices({ providers: [wrong], maxCallCostMicros: 10, prices: { 'wrong/x': { microsPerMillionCharacters: 1 } } }).speaker('wrong/x')).toThrow(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    const empty: VoiceProvider = { id: 'empty', speaker: (_name, settings) => ({ id: settings.id, maxCostMicros: settings.maxCostMicros, speak: async () => ({ audio: { data: new Uint8Array(), mediaType: 'audio/mpeg' }, usage: { costMicros: 0 } }) }) };
    await expect(createVoices({ providers: [empty], maxCallCostMicros: 10, prices: { 'empty/x': { microsPerMillionCharacters: 1 } } }).speaker('empty/x').speak({ text: 'hi', voice: 'v' }))
      .rejects.toMatchObject({ reason: 'invalid_response' });
  });

  it('runs voice tools only with voice:<id>, reporting what each call cost', async () => {
    const voices = createVoices({ providers: [provider], maxCallCostMicros: 10_000, prices: 'catalog' });
    const listen = transcriptionTool(voices.transcriber('fake/listen'));
    expect(listen.capabilities).toEqual(['voice:fake/listen']);
    const input = { audio: audioToBase64(conformanceWav()), mediaType: 'audio/wav' };
    const granted = await testTool(listen, input);
    expect(granted.outcome).toMatchObject({ status: 'succeeded' });
    expect(granted.spentMicros).toBe(100);
    const denied = await testTool(listen, input, { permissions: toolGrants(listen).filter(grant => !grant.startsWith('voice:')) });
    expect(denied.outcome.status).not.toBe('succeeded'); expect(denied.spentMicros).toBe(0);
    const talk = speechTool(voices.speaker('fake/talk'), { voice: 'alloy' });
    const spoken = await testTool(talk, { text: 'hello' });
    expect(spoken.outcome).toMatchObject({ status: 'succeeded' });
    expect(audioFromBase64((spoken.outcome as unknown as { output: { audio: string } }).output.audio)).toEqual(new Uint8Array([1, 2, 3]));
    expect(spoken.spentMicros).toBe(75);
  });

  it('stops a tool call when its signal aborts', async () => {
    const hang: VoiceProvider = { id: 'hang', speaker: (_name, settings) => reference({ kind: 'hang' }, settings, 'speaker') };
    const talk = speechTool(createVoices({ providers: [hang], maxCallCostMicros: 10_000, prices: { 'hang/x': { microsPerMillionCharacters: 1 } } }).speaker('hang/x'), { voice: 'v' });
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20);
    const result = await testTool(talk, { text: 'hello' }, { signal: controller.signal }); clearTimeout(timer);
    expect(result.outcome.status).not.toBe('succeeded');
    vi.useRealTimers();
  });
});
