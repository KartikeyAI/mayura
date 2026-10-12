---
title: "Cartesia voice"
description: "Speak text with Cartesia's Sonic models and transcribe audio with Ink-Whisper through @mayurajs/voice-cartesia: prices, bounds, formats and errors."
package: "@mayurajs/voice-cartesia"
vendor: "Cartesia"
logo: "cartesia"
website: "https://cartesia.ai"
area: "voice"
---

[Cartesia](https://cartesia.ai) makes the Sonic text-to-speech models and the Ink-Whisper speech-to-text model.
`@mayurajs/voice-cartesia` plugs them into the [voice registry](../guides/voice.md), so your code and your agents use
them with the same ids, prices, per-call bounds and `voice:<id>` permissions as every other voice provider. It talks to
Cartesia's HTTP API with `fetch`, at API version `2026-08-14`: no Cartesia SDK, no other dependencies, and it runs on
every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/voice-cartesia
```

## Credentials

Create an API key (`sk_car_...`) on Cartesia's [API keys page](https://play.cartesia.ai/keys). It is sent as a bearer
token to `/tts/bytes` and `/stt`. The package reads nothing from the environment: pass the key in yourself, for example
from `CARTESIA_API_KEY`.

## Use it

```ts
import { createVoices, speechTool } from 'mayura/voice';
import { cartesiaVoice } from '@mayurajs/voice-cartesia';

const voices = createVoices({
  providers: [cartesiaVoice({ apiKey: process.env.CARTESIA_API_KEY ?? '' })],
  prices: 'catalog',
  maxCallCostMicros: 50_000,
});

// The voice is a Cartesia voice id.
const voice = 'a0e99841-438c-4a64-b679-ae501e7d6091';
const speech = await voices.speaker('cartesia/sonic-3.6').speak({ text: 'Your order ships tomorrow.', voice, format: 'wav' });
// WAV is measured, so no duration is needed. Give the language: Cartesia assumes English otherwise.
const transcript = await voices.transcriber('cartesia/ink-whisper').transcribe({ audio: speech.audio, language: 'en' });
console.log(transcript.text, transcript.usage.costMicros);

// A tool for agents and workflows: grant tool:voice.speak and voice:cartesia/sonic-3.6 to the run.
const speak = speechTool(voices.speaker('cartesia/sonic-3.6'), { voice });
```

Ids are `cartesia/<model>`. Each voice tool requires `voice:<id>` besides `tool:<tool id>`, reserves the model's
per-call bound from the run's budget and reports what the call cost. See
[Voice](../guides/voice.md#in-agents-and-workflows).

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | required | Your Cartesia API key. |
| `baseURL` | `https://api.cartesia.ai` | Send requests here instead. It must be `https`. |
| `headers` | none | Up to 8 extra headers, such as a gateway's credential. They cannot replace `Authorization`, `Cartesia-Version`, `Content-Type`, `Host` or cookies. |
| `maxAudioBytes` | 64 MiB | The largest speech audio a call may return. |
| `maxResponseBytes` | 16 MiB | The largest transcription response. |
| `timeoutMs` | 120 s | How long one call may take, unless the registry or the model sets `timeoutMs`. |
| `fetch` | `globalThis.fetch` | For tests and proxies. |

The package also exports `cartesiaVersion`, the API version it sends on every request.

## Models and prices

Cartesia bills in credits: a character of speech is one credit, a second of transcribed audio three. Credits cost least
inside a plan's allowance and most as Pro overage, $65 per million, so the catalog (as of 2026-09-30) uses that rate
and may overcount, never undercount. It is used when you pass `prices: 'catalog'`:

| Id | Kind | Catalog price |
| --- | --- | --- |
| `cartesia/sonic-3.6` | Text-to-speech | $65 per million characters |
| `cartesia/sonic-3.5` | Text-to-speech | $65 per million characters |
| `cartesia/sonic-3` | Text-to-speech | $65 per million characters |
| `cartesia/sonic-latest` | Text-to-speech | $65 per million characters |
| `cartesia/ink-whisper` | Speech-to-text | $0.0117 a minute |

If your credits cost less, give your own price in `prices` or the model's `pricing`. Another Cartesia model works the
same way.

## Cost bounds

Every call is priced before it is sent, and refused with `BUDGET_EXCEEDED` if it would cost more than the model's bound:
speech from its text's characters (Unicode code points), and transcription from the audio's duration, measured from WAV
or given as `durationMs` for compressed audio. With a 50,000-micro bound, `cartesia/sonic-3.6` speaks up to 769
characters a call and `cartesia/ink-whisper` transcribes up to about 4 minutes.

Cartesia bills transcription by the second, so the cost a transcript reports is the duration Cartesia returns, or
otherwise the duration measured or given, rounded up to a whole second. Speech is charged for the characters of the
text.

## Audio and formats

- **Transcription** uploads the audio as it is, with its media type, and asks for word timings: segments are words. A
  `language` is sent as its primary subtag (`de-DE` becomes `de`). Cartesia does not detect the language: without one,
  it transcribes as English. The registry accepts up to 25 MiB of audio by default.
- **Speech** formats: `mp3` (44.1 kHz, 128 kbps, the default), `wav` (16-bit PCM at 24 kHz) and `pcm16` (raw 16-bit
  PCM at 24 kHz). `opus`, `aac` and `flac` fail with `configuration`. A `language` such as `fr` is sent as Cartesia's
  `language`, and one with a region such as `en-GB` as its `locale`; any other form fails with `configuration`. Audio
  streams to `onAudio` as it arrives.
- **The voice** is a Cartesia voice id, a UUID. Anything else, such as a voice's name, fails with `configuration` before
  a request is made.
- A speech response that is not audio, is empty, or is larger than `maxAudioBytes` fails with `invalid_response`, as
  does a transcription response larger than `maxResponseBytes`. Requests do not follow redirects.

## Errors

Failures reach you as a `VoiceProviderError` with a `reason`. Its message is fixed text: nothing Cartesia wrote reaches
it.

| `reason` | When |
| --- | --- |
| `authentication` | Cartesia answered 401 or 403: the key is wrong or lacks permission. |
| `rate_limited` | Cartesia answered 402 or 429: a rate limit or your credits were reached. |
| `unavailable` | Cartesia answered 408 or 5xx, or could not be reached. |
| `rejected` | Cartesia refused the request with another status, for example an unknown voice. |
| `timeout` | The call took longer than its `timeoutMs`. |
| `invalid_response` | The response was not what Cartesia's API promises, or was too large. |
| `configuration` | The speech format, voice or language is not one Cartesia takes. |

A call cancelled through its `signal` fails with `CANCELLED`. Before anything is sent, the registry refuses a call over
its bound (`BUDGET_EXCEEDED`), audio or text over its limits (`LIMIT_EXCEEDED`), and compressed audio without
`durationMs` (`INVALID_INPUT`). A missing or malformed key, a non-`https` `baseURL`, a header that would replace
`Authorization` or `Cartesia-Version`, or a malformed model id fails with `INVALID_CONFIG`.

## How it is tested

- Unit tests run the package against a fake Cartesia API in Cartesia's own wire format. They check the URLs, the
  `Authorization` and `Cartesia-Version` headers, the form fields and JSON sent, whole-second charges at catalog
  prices, each output format and language form, refused voices, formats and languages, and that nothing is read from
  the environment.
- The [voice adapter conformance suite](../guides/voice.md#testing-a-provider) passes against that fake: result shapes,
  costs, HTTP failures mapped without Cartesia's text, cancellation and timeouts.
- `scripts/live/voice-cartesia.mjs` passed against a real Cartesia account on October 6, 2026: `sonic-3.6` spoke a
  sentence, and `ink-whisper` transcribed it back with its words, through the shared voice checks at catalog prices.

## Related

- [Voice](../guides/voice.md): the registry, prices, bounds and voice tools.
- [ElevenLabs voice](voice-elevenlabs.md) and [Deepgram voice](voice-deepgram.md): other providers that speak and
  transcribe.
- [Costs and budgets](../concepts/costs-and-budgets.md): how a run's budget reserves each call's bound.
