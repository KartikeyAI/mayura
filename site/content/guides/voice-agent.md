---
title: "Build a voice agent you can talk to"
description: "Speech in, an agent run, speech out: transcribe with Deepgram, answer with a tool-using agent, speak with ElevenLabs, with every call priced and bounded before it is made."
date: 2026-10-12
tags: voice, speech, budgets, testing
---

A voice agent is three things in a row: speech-to-text turns what a person said into text, an agent works out the
answer, and text-to-speech says it back. Each step calls a paid service, and each is billed differently: transcription
by the minute of audio, speech by the character, the model by the token. A voice agent left open on a website is a
good way to find out what that adds up to.

This guide builds a turn-based voice assistant for order questions with `mayura/voice`: Deepgram's Nova-3 listens, a
Mayura agent with one read-only tool answers, and ElevenLabs speaks. Every voice call has a price and a bound that is
checked before anything is sent, the agent run has its own budget, and a conversation has a ceiling across its turns.

Mayura 1.1 doesn't do realtime speech-to-speech: there is no streaming audio session where the person and the model
talk over each other. Each turn here is a complete recording in and a complete answer out, with the spoken answer
streamed as it is made.

## What you'll build

1. A client records what the person says and sends it to your server as one audio file.
2. The server transcribes it with `deepgram/nova-3`, after checking that the audio is short enough for the
   transcription's cost bound.
3. An agent reads the transcript, looks the order up with its one tool, and answers in at most 500 characters.
4. The server speaks the answer with `elevenlabs/eleven_flash_v2_5` and returns the audio.
5. Each turn is charged to the conversation's budget; when it runs out, the next turn is refused before any provider
   is called.

## Prerequisites

- Node.js 22.12 or later, or 24.14.1 or later.
- `npm install mayura @mayurajs/voice-deepgram @mayurajs/voice-elevenlabs`.
- A Deepgram key, an ElevenLabs key and a model key for real runs. The tests in step 5 need none, and no network.

## 1. Voices with prices and bounds

```ts
import { createVoices } from 'mayura/voice';
import { deepgramVoice } from '@mayurajs/voice-deepgram';
import { elevenlabsVoice } from '@mayurajs/voice-elevenlabs';

const voices = createVoices({
  providers: [
    deepgramVoice({ apiKey: process.env.DEEPGRAM_API_KEY ?? '' }),
    elevenlabsVoice({ apiKey: process.env.ELEVENLABS_API_KEY ?? '' }),
  ],
  prices: 'catalog',
  maxCallCostMicros: 20_000, // no voice call costs more than $0.02 unless a model says otherwise
});

// Nova-3 at $0.0052 a minute: 6,000 micros pay for about 69 seconds of audio. Longer recordings are refused.
const transcriber = voices.transcriber('deepgram/nova-3', { maxCostMicros: 6_000 });
// Flash v2.5 at $0.04 per 1,000 characters: 20,000 micros pay for 500 characters, the longest answer the agent gives.
const speaker = voices.speaker('elevenlabs/eleven_flash_v2_5', { maxCostMicros: 20_000 });
```

Prices are in micros, millionths of a dollar. `prices: 'catalog'` uses the list prices each provider package ships,
dated 2026-09-30 for both of these; without it, you give every model's price yourself, and a model with no price is
refused. Where a provider charges more in some cases than others, the catalog uses the higher rate (Nova-3 is listed
at its multilingual rate), so a catalog price may overcount, never undercount.

The bound is checked before every call. Speech is priced from its text, in Unicode characters. Transcription is
priced from the audio's duration: Mayura measures WAV itself, and for compressed audio (MP3, WebM, Ogg) you must give
`durationMs`, because a guessed duration could let a call cost more than its bound. A call that would cost more than
its bound fails with `BUDGET_EXCEEDED`, and the provider never hears of it.

## 2. The agent and one turn

The agent never touches audio. It gets the transcript as text, has one read-only tool, and returns what to say. A turn
transcribes, runs the agent, and speaks, charging each step to the conversation's budget. Both go in `src/assistant.ts`:

```ts
import { Budget, createRuntime, defineAgent, defineTool, MayuraError, type ModelAdapter, z } from 'mayura';
import type { Audio, Speaker, Transcriber } from 'mayura/voice';

const lookupOrder = defineTool({
  id: 'orders.lookup', version: '1', description: 'Look up an order by its id, such as A1.',
  input: z.object({ orderId: z.string().max(32) }), output: z.object({ status: z.string(), eta: z.string().optional() }),
  effects: 'read', capabilities: [],
  execute: async ({ orderId }) => orders.status(orderId), // your order system
});

export const assistant = (model: ModelAdapter) => defineAgent({
  id: 'voice.orders', version: '1', model, tools: [lookupOrder],
  input: z.object({ said: z.string().max(5_000) }),
  output: z.object({ say: z.string().min(1).max(500) }),
  instructions: [
    'You answer questions about orders on a phone line. The input is what the caller said, transcribed.',
    'Look orders up with orders.lookup. If you did not catch an order id, ask for it.',
    'Your answer is read aloud: plain sentences, no lists, markdown or links, at most three sentences.',
  ].join('\n'),
});

const runCostMicros = 30_000; // the agent run's own budget: $0.03

export function createVoiceAssistant(options: { model: ModelAdapter; transcriber: Transcriber; speaker: Speaker; voice: string }) {
  const agent = assistant(options.model);
  const runtime = createRuntime({
    profile: 'ephemeral',
    permissions: { allow: [`model:${options.model.id}`, 'tool:orders.lookup', 'effect:read'] },
    limits: { maxSteps: 4, maxModelCalls: 3, maxToolCalls: 2, maxDurationMs: 20_000, maxCostMicros: runCostMicros },
  });

  async function turn(conversation: Budget, audio: Audio, durationMs?: number) {
    const heard = await charged(conversation, options.transcriber.maxCostMicros,
      () => options.transcriber.transcribe({ audio, language: 'en', ...(durationMs === undefined ? {} : { durationMs }) }),
      transcript => transcript.usage.costMicros);

    const hold = conversation.reserve(runCostMicros);
    const run = runtime.submit(agent, { input: { said: heard.text } });
    const outcome = await run.result();
    const { spentMicros, reservedMicros } = runtime.inspect(run).budget;
    hold.settleUsage(Number(spentMicros), reservedMicros); // a cost still unknown stays held
    const say = outcome.status === 'succeeded' ? outcome.output.say : 'Sorry, I could not help with that. Please try again.';

    const speech = await charged(conversation, options.speaker.maxCostMicros,
      () => options.speaker.speak({ text: say, voice: options.voice, format: 'mp3' }),
      result => result.usage.costMicros);
    return { heard: heard.text, said: say, audio: speech.audio };
  }
  return { turn, close: () => runtime.close() };
}

const refusedBeforeSending = new Set<string>(['INVALID_INPUT', 'LIMIT_EXCEEDED', 'BUDGET_EXCEEDED']);

/** Reserves a call's bound from the budget, then charges what the call reports. */
async function charged<T>(budget: Budget, bound: number, call: () => Promise<T>, cost: (result: T) => number): Promise<T> {
  const reservation = budget.reserve(bound); // BUDGET_EXCEEDED when the conversation has no room for this call
  let result: T;
  try {
    result = await call();
  } catch (error) {
    // A call refused before anything was sent cost nothing. Any other failure may have been billed: keep its bound.
    if (error instanceof MayuraError && refusedBeforeSending.has(error.code)) reservation.settle(0);
    throw error;
  }
  reservation.settle(cost(result));
  return result;
}
```

`say` is at most 500 characters, which is exactly what the speech bound pays for. The output schema and the bound
agree, so a long answer is rejected by the schema, as a failed run, instead of reaching the speech provider and being
refused there. Transcripts can be wrong, which is why the agent asks again instead of guessing an order id.

There are three levels of limit here, and each has a reason:

- **Per call.** The voice registry refuses a recording longer than about 69 seconds or an answer longer than 500
  characters before calling the provider. A model call can't exceed its adapter's `maxCostMicros`.
- **Per run.** The agent run reserves each model call's ceiling from its $0.03 before making it, and stops at three
  model calls or two tool calls. A turn is a short exchange, and the limits say so.
- **Per conversation.** `Budget` from `mayura` holds the whole conversation to a ceiling. Each step reserves its
  worst case before it starts, so the worst case of a turn, 6,000 + 30,000 + 20,000 micros, is known before the first
  provider is called, and a turn that doesn't fit is refused whole rather than cut off halfway.

The cost a call reports is what the provider billed. If Deepgram reports more audio than you declared, that is what
gets charged; when it is more than the bound, `settle` throws `BUDGET_EXCEEDED` and the conversation's budget accepts
no further calls.

## 3. Permissions

The runtime grants the agent its model, its one tool and the read effect, nothing else. The voice calls are made by
your server code, not by the agent: the model has no tool that spends money on audio, and no way to speak something
other than its checked answer.

When you want voice inside runs instead, for example a [durable workflow](../../../docs/guides/durable-workflows.md)
step that transcribes a voicemail, `transcriptionTool(transcriber)` and `speechTool(speaker, { voice })` from
`mayura/voice` make tools that take and return audio as base64. Each needs `voice:<id>` (such as
`voice:deepgram/nova-3`) besides `tool:voice.transcribe` or `tool:voice.speak`, and reserves the model's bound from the
run's budget. Don't give those to a conversational agent: the audio would pass through the model's context.

## 4. The server

The endpoint takes the recording as the request body and answers with the spoken reply:

```ts
import { Budget, MayuraError } from 'mayura';

const conversations = new Map<string, Budget>(); // in memory: use durable budgets to survive restarts

export async function handleTurn(request: Request, conversationId: string): Promise<Response> {
  let budget = conversations.get(conversationId);
  if (!budget) conversations.set(conversationId, budget = new Budget(500_000, 200)); // $0.50 and 200 calls per conversation
  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim();
  const declared = Number(request.headers.get('x-duration-ms') ?? '');
  try {
    const reply = await voice.turn(budget, { data: new Uint8Array(await request.arrayBuffer()), mediaType },
      Number.isSafeInteger(declared) && declared > 0 ? declared : undefined);
    return new Response(reply.audio.data, { headers: { 'content-type': reply.audio.mediaType, 'x-transcript': encodeURIComponent(reply.heard) } });
  } catch (error) {
    if (error instanceof MayuraError && error.code === 'BUDGET_EXCEEDED') return new Response('This conversation has reached its limit.', { status: 429 });
    if (error instanceof MayuraError && error.code === 'INVALID_INPUT') return new Response('Send WAV audio, or the duration of compressed audio.', { status: 400 });
    throw error;
  }
}
```

Two details are worth copying:

- **Prefer WAV from the client.** Browsers record WebM by default, which is compressed, so the client has to say how
  long it is. A client that understates the duration can't make a call cheaper (the provider bills the real length,
  and that's what gets charged), but it gets a long recording past the check meant to refuse it. 16-bit mono WAV at 16 kHz
  is 32 KB a second, Mayura measures it itself, and the client's word doesn't matter.
- **Strip parameters from the media type.** `audio/webm;codecs=opus` is refused as `INVALID_INPUT`; the registry takes
  `audio/webm`.

To start playback sooner, `speak` takes `onAudio`, which receives each chunk as the provider streams it, before the
call completes. ElevenLabs speech goes through its streaming endpoint, so the first audio arrives early. Treat
streamed chunks as provisional: a call that fails may stop partway.

## 5. Test it offline

A voice provider is a small interface, so a test can register a fake one with its own catalog, and `scriptedModel` from
`mayura/testing` plays the model. `conformanceWav(ms)` makes a valid WAV file of a given length:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Budget } from 'mayura';
import { conformanceWav, scriptedModel } from 'mayura/testing';
import { characterCount, createVoices, speechCostMicros, transcriptionCostMicros, type VoiceProvider } from 'mayura/voice';
import { createVoiceAssistant } from './assistant.js';

const fake: VoiceProvider = {
  id: 'fake',
  catalog: { asOf: '2026-10-12', transcribers: { ears: { pricing: { microsPerMinute: 5_200 } } }, speakers: { mouth: { pricing: { microsPerMillionCharacters: 40_000_000 } } } },
  transcriber: (_name, settings) => ({
    id: settings.id, maxCostMicros: settings.maxCostMicros,
    transcribe: async request => ({ text: 'Where is order A1?', segments: [],
      usage: { audioMs: request.durationMs ?? 0, costMicros: transcriptionCostMicros(settings.pricing, request.durationMs ?? 0) } }),
  }),
  speaker: (_name, settings) => ({
    id: settings.id, maxCostMicros: settings.maxCostMicros,
    speak: async request => ({ audio: { data: new Uint8Array([1, 2, 3]), mediaType: 'audio/mpeg' },
      usage: { characters: characterCount(request.text), costMicros: speechCostMicros(settings.pricing, characterCount(request.text)) } }),
  }),
};
const voices = createVoices({ providers: [fake], prices: 'catalog', maxCallCostMicros: 20_000 });
const transcriber = voices.transcriber('fake/ears', { maxCostMicros: 6_000 });
const speaker = voices.speaker('fake/mouth', { maxCostMicros: 20_000 });

test('a turn hears, answers with the tool and speaks, within its budget', async () => {
  const model = scriptedModel([
    { type: 'tool_calls', calls: [{ id: 'c1', toolId: 'orders.lookup', input: { orderId: 'A1' } }], usage: { costMicros: 0 } },
    { type: 'final', output: { say: 'Order A1 has shipped and arrives tomorrow.' }, usage: { costMicros: 0 } },
  ]);
  const voice = createVoiceAssistant({ model, transcriber, speaker, voice: 'any' });
  const conversation = new Budget(500_000, 200);
  try {
    const reply = await voice.turn(conversation, { data: conformanceWav(3_000), mediaType: 'audio/wav' });
    assert.equal(reply.heard, 'Where is order A1?');
    assert.equal(reply.said, 'Order A1 has shipped and arrives tomorrow.');
    // 3 s of audio at $0.0052 a minute is 260 micros; 42 characters at $40 per million is 1,680.
    assert.equal(conversation.snapshot().spentMicros, 260 + 1_680);
  } finally {
    await voice.close();
  }
});

test('a recording too long for its bound is refused before the provider is called', async () => {
  const voice = createVoiceAssistant({ model: scriptedModel([]), transcriber, speaker, voice: 'any' });
  const conversation = new Budget(500_000, 200);
  try {
    await assert.rejects(voice.turn(conversation, { data: conformanceWav(90_000), mediaType: 'audio/wav' }), { code: 'BUDGET_EXCEEDED' });
    assert.equal(conversation.snapshot().spentMicros, 0);
  } finally {
    await voice.close();
  }
});
```

The fake prices its calls the way a real provider package does, so the costs in the test are the costs the registry
and the budget would see in production. The second test shows the bound doing its job: 90 seconds of audio would cost
7,800 micros, over the 6,000 bound, so the turn fails and nothing is charged. In this test the order lookup is your own
code; give it a stand-in for the order system. The [Testing guide](../../../docs/guides/testing.md) has more patterns,
and `voiceAdapterConformance` in `mayura/testing` holds the contract every provider package passes.

## 6. Go to production

- **Choose the providers.** Swap ids, not code. `openai/whisper-1` or `elevenlabs/scribe_v2` can listen instead of
  Nova-3; `cartesia/sonic-3.6`, `deepgram/aura-2` or `openai/tts-1` can speak instead of ElevenLabs. Each needs its
  package in `providers`, and its voice: an ElevenLabs or Cartesia voice id, `thalia-en` for Aura-2, `alloy` for
  OpenAI. Recompute each bound from the model's price, and keep the speech bound and the answer's maximum length in
  step.
- **Check the dated prices.** The catalog's prices are as of its date. For a model billed per token rather than per
  minute or character, such as OpenAI's newer transcription models, there is no catalog price: give a per-minute or
  per-character price you are comfortable bounding calls with.
- **Choose a model.** Give the agent a real adapter with prices and a per-call ceiling that fits in the run's
  $0.03. See [Model providers](../../../docs/guides/model-providers.md).
- **Keep conversation budgets durable.** A `Budget` lives in memory. To hold a ceiling across restarts or servers,
  keep the ledger in SQLite or PostgreSQL with `store.durableBudgets`; see [Storage](../../../docs/guides/storage.md).
- **Keys come from you.** None of the packages reads the environment. Deepgram's and ElevenLabs' packages each passed
  a live check against a real account on October 6, 2026: speaking a sentence and transcribing it back, at catalog
  prices.

## Know the limits

- **Turn-based only.** No realtime speech-to-speech, no voice activity detection and no interruption in Mayura 1.1:
  the client decides when a turn ends and sends the whole recording.
- **Transcription is a guess.** A misheard order id is a wrong order id. Read back anything that matters before acting
  on it, and keep tools that change things behind a confirmation, or an
  [approval](../../../docs/guides/approvals-and-human-input.md).
- **Costs are estimates from your prices.** Mayura records what the provider reports at the prices you configured; it
  is not your provider's invoice.

## Next steps

- [Voice](../../../docs/guides/voice.md): the registry, prices, bounds, voice tools and every provider.
- [Deepgram](../../../docs/integrations/voice-deepgram.md), [ElevenLabs](../../../docs/integrations/voice-elevenlabs.md)
  and [Cartesia](../../../docs/integrations/voice-cartesia.md).
- [Costs and budgets](../../../docs/concepts/costs-and-budgets.md): run budgets and `Budget` in depth.
- [Build a refund agent](refund-approval.md): an agent whose side effects wait for a person's approval.
