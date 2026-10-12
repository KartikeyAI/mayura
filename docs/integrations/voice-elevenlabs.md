---
title: "ElevenLabs voice"
description: "Speak text with ElevenLabs voices and transcribe audio with Scribe through @mayurajs/voice-elevenlabs: prices, bounds, formats and errors."
package: "@mayurajs/voice-elevenlabs"
vendor: "ElevenLabs"
logo: "elevenlabs"
website: "https://elevenlabs.io"
area: "voice"
---

[ElevenLabs](https://elevenlabs.io) makes text-to-speech models (Eleven v4, v3, Multilingual v2, Flash) and the Scribe
speech-to-text model. `@mayurajs/voice-elevenlabs` plugs them into the [voice registry](../guides/voice.md), so your
code and your agents use them with the same ids, prices, per-call bounds and `voice:<id>` permissions as every other
voice provider. It talks to ElevenLabs' HTTP API with `fetch`: no ElevenLabs SDK (it depends on `node-fetch`, `ws` and
`command-exists`), no other dependencies, and it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/voice-elevenlabs
```

## Credentials

Create an API key in ElevenLabs under [Settings, API keys](https://elevenlabs.io/app/settings/api-keys). The package
calls only `/v1/text-to-speech/<voice>/stream` and `/v1/speech-to-text`, so a key restricted to text-to-speech and
speech-to-text is enough. It is sent as `xi-api-key`. The package reads nothing from the environment: pass the key in
yourself, for example from `ELEVENLABS_API_KEY`.

## Use it

```ts
import { createVoices, speechTool } from 'mayura/voice';
import { elevenlabsVoice } from '@mayurajs/voice-elevenlabs';

const voices = createVoices({
  providers: [elevenlabsVoice({ apiKey: process.env.ELEVENLABS_API_KEY ?? '' })],
  prices: 'catalog',
  maxCallCostMicros: 50_000,
});

// The voice is an ElevenLabs voice id, from the voice library or your own voices.
const speech = await voices.speaker('elevenlabs/eleven_v3').speak({ text: 'Your order ships tomorrow.', voice: 'JBFqnCBsd6RMkjVDRZzb' });
// MP3 is compressed, so give its duration: Mayura bounds the call's cost from it before sending anything.
const transcript = await voices.transcriber('elevenlabs/scribe_v2').transcribe({ audio: speech.audio, durationMs: 3_000 });
console.log(transcript.text, transcript.usage.costMicros);

// A tool for agents and workflows: grant tool:voice.speak and voice:elevenlabs/eleven_v3 to the run.
const speak = speechTool(voices.speaker('elevenlabs/eleven_v3'), { voice: 'JBFqnCBsd6RMkjVDRZzb' });
```

Ids are `elevenlabs/<model>`, with the model id as ElevenLabs writes it (`eleven_v3`, `scribe_v2`). Each voice tool
requires `voice:<id>` besides `tool:<tool id>`, reserves the model's per-call bound from the run's budget and reports
what the call cost. See [Voice](../guides/voice.md#in-agents-and-workflows).

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | required | Your ElevenLabs API key. |
| `baseURL` | `https://api.elevenlabs.io` | Send requests here instead, for example a data-residency endpoint such as `https://api.eu.residency.elevenlabs.io`. It must be `https`. |
| `headers` | none | Up to 8 extra headers, such as a gateway's credential. They cannot replace `xi-api-key`, `Content-Type`, `Host` or cookies. |
| `maxAudioBytes` | 64 MiB | The largest speech audio a call may return. |
| `maxResponseBytes` | 16 MiB | The largest transcription response (word timings make long audio's responses large). |
| `timeoutMs` | 120 s | How long one call may take, unless the registry or the model sets `timeoutMs`. |
| `fetch` | `globalThis.fetch` | For tests and proxies. |

## Models and prices

The catalog has ElevenLabs' pay-as-you-go API prices as of 2026-09-30, the same on every plan, used when you pass
`prices: 'catalog'`. Promotional prices are left out: v4 and v4 Turbo are listed at their regular rates.

| Id | Kind | Catalog price |
| --- | --- | --- |
| `elevenlabs/scribe_v2` | Speech-to-text | $0.22 an hour, rounded up to 3,667 micros a minute |
| `elevenlabs/eleven_v4` | Text-to-speech | $0.08 per 1,000 characters |
| `elevenlabs/eleven_v4_turbo` | Text-to-speech | $0.04 per 1,000 characters |
| `elevenlabs/eleven_v3` | Text-to-speech | $0.08 per 1,000 characters |
| `elevenlabs/eleven_v3_conversational` | Text-to-speech | $0.04 per 1,000 characters |
| `elevenlabs/eleven_multilingual_v2` | Text-to-speech | $0.08 per 1,000 characters |
| `elevenlabs/eleven_flash_v2_5` | Text-to-speech | $0.04 per 1,000 characters |

Another ElevenLabs model works with a price you give in `prices` or the model's `pricing`.

## Cost bounds

Every call is priced before it is sent, and refused with `BUDGET_EXCEEDED` if it would cost more than the model's bound:
speech from its text's characters (Unicode code points), and transcription from the audio's duration, measured from WAV
or given as `durationMs` for compressed audio. With a 50,000-micro bound, `elevenlabs/eleven_v3` speaks up to 625
characters a call and `elevenlabs/scribe_v2` transcribes up to about 13 and a half minutes.

The cost a transcription reports is what ElevenLabs billed: the `audio_duration_secs` it reports, and otherwise the
duration measured or given. Speech is charged for the characters of the text.

## Audio and formats

- **Transcription** sends the audio as it is, with its media type, and asks for word timings: a transcript's segments
  are its words, with the speaker when ElevenLabs reports one. A `language` is sent as its primary subtag (`es-MX`
  becomes `es`); without one, ElevenLabs detects it. The registry accepts up to 25 MiB of audio by default.
- **Speech** goes through ElevenLabs' streaming endpoint, so audio reaches `onAudio` as it is made. Formats: `mp3`
  (44.1 kHz, 128 kbps, the default), `opus` (48 kHz, 128 kbps, `audio/ogg`), `wav` (44.1 kHz) and `pcm16` (24 kHz).
  `aac` and `flac` fail with `configuration`. A `language` is sent as its primary subtag.
- **The voice** is an ElevenLabs voice id: 1 to 64 letters and digits. Anything else fails with `configuration` before
  a request is made.
- A speech response that is not audio, is empty, or is larger than `maxAudioBytes` fails with `invalid_response`, as
  does a transcription response larger than `maxResponseBytes`. Redirects are not followed.

## Errors

Failures reach you as a `VoiceProviderError` with a `reason`. Its message is fixed text: nothing ElevenLabs wrote
reaches it.

| `reason` | When |
| --- | --- |
| `authentication` | ElevenLabs answered 401 or 403: the key is wrong or lacks permission. |
| `rate_limited` | ElevenLabs answered 402 or 429: a rate limit or quota was reached. |
| `unavailable` | ElevenLabs answered 408 or 5xx, or could not be reached. |
| `rejected` | ElevenLabs refused the request with another status, for example an unknown voice or model. |
| `timeout` | The call took longer than its `timeoutMs`. |
| `invalid_response` | The response was not what ElevenLabs' API promises, or was too large. |
| `configuration` | The speech format or the voice is not one ElevenLabs takes. |

A call cancelled through its `signal` fails with `CANCELLED`. Before anything is sent, the registry refuses a call over
its bound (`BUDGET_EXCEEDED`), audio or text over its limits (`LIMIT_EXCEEDED`), and compressed audio without
`durationMs` (`INVALID_INPUT`). A missing key, a non-`https` `baseURL`, a header that would replace `xi-api-key` or a
malformed model id fails with `INVALID_CONFIG`.

## How it is tested

- Unit tests run the package against a fake ElevenLabs API in ElevenLabs' own wire format. They check the URLs (the
  data-residency endpoint too), the `xi-api-key` header, the form fields and JSON sent, catalog charges, refused formats
  and voice ids, and that nothing is read from the environment.
- The [voice adapter conformance suite](../guides/voice.md#testing-a-provider) passes against that fake: result shapes,
  costs, HTTP failures mapped without ElevenLabs' text, cancellation and timeouts.
- `scripts/live/voice-elevenlabs.mjs` passed against a real ElevenLabs account on October 6, 2026: `eleven_v3` spoke a
  sentence, and `scribe_v2` transcribed it back with its words, through the shared voice checks at catalog prices.

## Related

- [Voice](../guides/voice.md): the registry, prices, bounds and voice tools.
- [Deepgram voice](voice-deepgram.md) and [Cartesia voice](voice-cartesia.md): other providers that speak and transcribe.
- [Costs and budgets](../concepts/costs-and-budgets.md): how a run's budget reserves each call's bound.
