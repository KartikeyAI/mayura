---
title: "Voice"
description: "Transcribe speech and speak text through voice providers, with explicit prices, a per-call cost bound and voice:<id> permissions."
---

`mayura/voice` turns speech into text and text into speech through provider packages such as
`@mayurajs/voice-openai`. A voice registry gives every model an id, `<provider>/<model>`, a price and a per-call cost
bound. Every call is checked against that bound before anything is sent: speech is priced from its text, and
transcription from the audio's duration.

```bash
npm install mayura @mayurajs/voice-openai
```

```ts
import { createVoices } from 'mayura/voice';
import { openaiVoice } from '@mayurajs/voice-openai';

const voices = createVoices({
  providers: [openaiVoice({ apiKey: process.env.OPENAI_API_KEY ?? '' })],
  prices: 'catalog',
  maxCallCostMicros: 50_000,
});

const speech = await voices.speaker('openai/tts-1').speak({ text: 'Your order ships tomorrow.', voice: 'alloy' });
const transcript = await voices.transcriber('openai/whisper-1').transcribe({ audio: speech.audio, durationMs: 2_000 });
console.log(transcript.text, transcript.usage.costMicros);
```

## Prices and bounds

Prices are micros (millionths of a US dollar): `microsPerMinute` of audio for transcription, charged by the
millisecond, and `microsPerMillionCharacters` of text for speech, counting Unicode code points. Give them in `prices`
by voice id, or use `prices: 'catalog'` for the list prices a provider package ships, as of its catalog's date. A model
without a price is refused.

| Option | Notes |
| --- | --- |
| `providers` | The voice providers models may come from. |
| `maxCallCostMicros` | The most one call may cost, unless a model sets its own `maxCostMicros`. Required. |
| `prices` | A map from voice id to its price, or `'catalog'`. |
| `timeoutMs` | How long one call may take; each provider has its own default. |
| `maxAudioBytes` | The largest audio a transcription accepts; 25 MiB by default. |
| `maxTextCharacters` | The longest text a speech call accepts; 20,000 characters by default. |

Speech that would cost more than its model's bound, or audio whose duration would, fails with `BUDGET_EXCEEDED` before
the provider is called. Mayura measures WAV audio itself. For compressed audio (MP3, WebM, Ogg, M4A, FLAC) give
`durationMs`: Mayura does not guess a duration, since a guess could let a call cost more than its bound. The cost a
call reports is what the provider billed: the audio duration it reports, or the duration measured or given.

## In agents and workflows

`transcriptionTool(transcriber)` and `speechTool(speaker, { voice })` make tools that take audio or text as data and
return the transcript or the audio as base64. Each requires the permission `voice:<id>` besides `tool:<tool id>`,
reserves the model's per-call bound from the run's budget, and reports what the call cost:

```ts
import { createVoices, transcriptionTool } from 'mayura/voice';
import { openaiVoice } from '@mayurajs/voice-openai';

const voices = createVoices({ providers: [openaiVoice({ apiKey: process.env.OPENAI_API_KEY ?? '' })], prices: 'catalog', maxCallCostMicros: 50_000 });
const transcribe = transcriptionTool(voices.transcriber('openai/whisper-1'));
// Grant: 'tool:voice.transcribe' and 'voice:openai/whisper-1'.
console.log(transcribe.capabilities);
```

## Errors

A failed call raises `VoiceProviderError` with a `reason`, as model calls do: `authentication`, `rate_limited`,
`unavailable`, `timeout`, `rejected`, `invalid_response`, `refused` or `configuration` (a format, voice or language the
provider does not take). Messages are fixed text: nothing the provider wrote reaches them. A call cancelled through its
`signal` fails with `CANCELLED`.

## Providers

| Package | Transcription | Speech |
| --- | --- | --- |
| `@mayurajs/voice-openai` | `whisper-1` in the catalog; `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` and `gpt-transcribe` with your own price | `tts-1`, `tts-1-hd` in the catalog; `gpt-4o-mini-tts` with your own price |
| `@mayurajs/voice-elevenlabs` | `scribe_v2` in the catalog | `eleven_v4`, `eleven_v4_turbo`, `eleven_v3`, `eleven_v3_conversational`, `eleven_multilingual_v2` and `eleven_flash_v2_5` in the catalog; the voice is an ElevenLabs voice id |

OpenAI bills some audio models per token rather than per minute or character. Their cost cannot be known from the
audio or text before a call, so they are left out of the catalog: give a per-minute or per-character price you are
comfortable bounding calls with.

## Testing a provider

`voiceAdapterConformance` in `mayura/testing` is the voice adapter contract as test cases: result shapes, costs,
error reasons without the provider's text, cancellation and timeouts. A provider package runs it against a fake
transport, as `modelAdapterConformance` does for model providers.

## Related

- [Model providers](model-providers.md)
- [Costs and budgets](../concepts/costs-and-budgets.md)
- [Testing](testing.md)
