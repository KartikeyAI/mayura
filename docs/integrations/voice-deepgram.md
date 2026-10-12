---
title: "Deepgram voice"
description: "Transcribe audio with Nova-3 and speak text with Aura voices through @mayurajs/voice-deepgram: prices, bounds, formats and errors."
package: "@mayurajs/voice-deepgram"
vendor: "Deepgram"
logo: "deepgram"
website: "https://deepgram.com"
area: "voice"
---

[Deepgram](https://deepgram.com) serves speech-to-text (Nova-3, Whisper) and text-to-speech (Aura-2, Aura).
`@mayurajs/voice-deepgram` plugs them into the [voice registry](../guides/voice.md), so your code and your agents use
them with the same ids, prices, per-call bounds and `voice:<id>` permissions as every other voice provider. It talks to
Deepgram's HTTP API with `fetch`: no Deepgram SDK, no other dependencies, and it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/voice-deepgram
```

## Credentials

Create an API key in the [Deepgram console](https://console.deepgram.com) under **API Keys**. The package calls only
`/v1/listen` and `/v1/speak`, and sends the key as `Authorization: Token <key>`. The package reads nothing from the
environment: pass the key in yourself, for example from `DEEPGRAM_API_KEY`.

## Use it

```ts
import { createVoices, transcriptionTool } from 'mayura/voice';
import { deepgramVoice } from '@mayurajs/voice-deepgram';

const voices = createVoices({
  providers: [deepgramVoice({ apiKey: process.env.DEEPGRAM_API_KEY ?? '' })],
  prices: 'catalog',
  maxCallCostMicros: 50_000,
});

// Speech ids name a model family; the voice completes it: aura-2 with thalia-en is Deepgram's aura-2-thalia-en.
const speech = await voices.speaker('deepgram/aura-2').speak({ text: 'Your order ships tomorrow.', voice: 'thalia-en', format: 'wav' });
// WAV is measured, so no duration is needed. Without a language, Deepgram detects it.
const transcript = await voices.transcriber('deepgram/nova-3').transcribe({ audio: speech.audio });
console.log(transcript.text, transcript.language, transcript.usage.costMicros);

// A tool for agents and workflows: grant tool:voice.transcribe and voice:deepgram/nova-3 to the run.
const transcribe = transcriptionTool(voices.transcriber('deepgram/nova-3'));
```

Ids are `deepgram/<model>`. Each voice tool requires `voice:<id>` besides `tool:<tool id>`, reserves the model's
per-call bound from the run's budget and reports what the call cost. See
[Voice](../guides/voice.md#in-agents-and-workflows).

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | required | Your Deepgram API key. |
| `baseURL` | `https://api.deepgram.com` | Send requests here instead, for example a self-hosted or EU endpoint. It must be `https`. |
| `headers` | none | Up to 8 extra headers, such as a gateway's credential. They cannot replace `Authorization`, `Content-Type`, `Host` or cookies. |
| `maxAudioBytes` | 64 MiB | The largest speech audio a call may return. |
| `maxResponseBytes` | 16 MiB | The largest transcription response (word timings make long audio's responses large). |
| `timeoutMs` | 120 s | How long one call may take, unless the registry or the model sets `timeoutMs`. |
| `fetch` | `globalThis.fetch` | For tests and proxies. |

## Models and prices

The catalog has Deepgram's pay-as-you-go prices for pre-recorded audio as of 2026-09-30, used when you pass
`prices: 'catalog'`:

| Id | Kind | Catalog price |
| --- | --- | --- |
| `deepgram/nova-3` | Speech-to-text | $0.0052 a minute, its multilingual rate |
| `deepgram/whisper-large` | Speech-to-text | $0.0048 a minute |
| `deepgram/aura-2` | Text-to-speech | $30 per million characters |
| `deepgram/aura` | Text-to-speech | $15 per million characters |

Nova-3 costs more when it transcribes several languages than one, under the same model id, so the catalog lists it at
the multilingual rate: a catalog price may overcount, never undercount. Give your own price in `prices` if you know your
audio is monolingual. Another Deepgram model works with a price you give.

## Cost bounds

Every call is priced before it is sent, and refused with `BUDGET_EXCEEDED` if it would cost more than the model's bound:
speech from its text's characters (Unicode code points), and transcription from the audio's duration, measured from WAV
or given as `durationMs` for compressed audio. With a 50,000-micro bound, `deepgram/aura-2` speaks up to 1,666
characters a call and `deepgram/nova-3` transcribes up to about 9 and a half minutes.

The cost a transcription reports is what Deepgram billed: the duration in its response's metadata, and otherwise the
duration measured or given. Speech is charged for the characters of the text.

## Audio and formats

- **Transcription** sends the audio's bytes as the request body with its media type, with smart formatting on. A
  `language` is sent as given (`pt-BR`); without one, Deepgram is asked to detect it and the transcript reports what it
  found. Segments are words, with their timings and a speaker when Deepgram reports one. The registry accepts up to 25
  MiB of audio by default.
- **Speech** comes in every Mayura format: `mp3` (the default), `opus` (in Ogg, `audio/ogg`), `aac`, `flac`, `wav`
  (16-bit linear PCM in WAV) and `pcm16` (raw 16-bit PCM at 24 kHz). Audio streams to `onAudio` as it arrives.
- **The voice** completes the model family: lowercase letters, optionally followed by a language such as `-en`, as in
  `thalia-en`. Anything else fails with `configuration` before a request is made.
- A speech response that is not audio, is empty, or is larger than `maxAudioBytes` fails with `invalid_response`, as
  does a transcription response larger than `maxResponseBytes`. Redirects are not followed.

## Errors

Failures reach you as a `VoiceProviderError` with a `reason`. Its message is fixed text: nothing Deepgram wrote reaches
it.

| `reason` | When |
| --- | --- |
| `authentication` | Deepgram answered 401 or 403: the key is wrong or lacks permission. |
| `rate_limited` | Deepgram answered 402 or 429: a rate limit or quota was reached. |
| `unavailable` | Deepgram answered 408 or 5xx, or could not be reached. |
| `rejected` | Deepgram refused the request with another status, for example an unknown model or unreadable audio. |
| `timeout` | The call took longer than its `timeoutMs`. |
| `invalid_response` | The response was not what Deepgram's API promises, or was too large. |
| `configuration` | The voice is not a Deepgram voice name. |

A call cancelled through its `signal` fails with `CANCELLED`. Before anything is sent, the registry refuses a call over
its bound (`BUDGET_EXCEEDED`), audio or text over its limits (`LIMIT_EXCEEDED`), and compressed audio without
`durationMs` (`INVALID_INPUT`). A missing key, a non-`https` `baseURL` or a malformed model id fails with
`INVALID_CONFIG`.

## How it is tested

- Unit tests run the package against a fake Deepgram API in Deepgram's own wire format. They check the URLs and query
  parameters, the `Authorization` header, that the raw audio is sent with its media type, language detection, the
  family-and-voice model name, catalog charges and refused voices, and that nothing is read from the environment.
- The [voice adapter conformance suite](../guides/voice.md#testing-a-provider) passes against that fake: result shapes,
  costs, HTTP failures mapped without Deepgram's text, cancellation and timeouts.
- `scripts/live/voice-deepgram.mjs` passed against a real Deepgram account on October 6, 2026: `aura-2` with
  `thalia-en` spoke a sentence, and `nova-3` transcribed it back with its words, through the shared voice checks at
  catalog prices.

## Related

- [Voice](../guides/voice.md): the registry, prices, bounds and voice tools.
- [AssemblyAI transcription](voice-assemblyai.md): another transcription provider.
- [ElevenLabs voice](voice-elevenlabs.md): another provider that speaks and transcribes.
- [Costs and budgets](../concepts/costs-and-budgets.md): how a run's budget reserves each call's bound.
