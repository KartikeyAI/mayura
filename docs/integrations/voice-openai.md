---
title: "OpenAI speech"
description: "Transcribe audio with Whisper and speak text with OpenAI's TTS models through @mayurajs/voice-openai: prices, bounds, formats and errors."
package: "@mayurajs/voice-openai"
vendor: "OpenAI"
logo: "openai"
website: "https://openai.com"
area: "voice"
---

[OpenAI](https://openai.com) serves speech-to-text (Whisper and the GPT-4o transcribe models) and text-to-speech (the TTS
models) through its audio API. `@mayurajs/voice-openai` plugs them into the [voice registry](../guides/voice.md), so
your code and your agents transcribe and speak with the same ids, prices, per-call bounds and `voice:<id>` permissions
as every other voice provider. It talks to OpenAI through the official `openai` SDK, pinned at 7.23.0, with the SDK's
retries and logging turned off: Mayura owns time limits, and nothing is logged. The SDK supports Node.js 22 and 24,
Deno, Bun, Cloudflare Workers and Vercel Edge.

## Install

```bash
npm install mayura @mayurajs/voice-openai
```

The `openai` SDK comes with the package.

## Credentials

Create an API key on OpenAI's [API keys page](https://platform.openai.com/api-keys). The package calls only
`/v1/audio/transcriptions` and `/v1/audio/speech`, so a restricted key needs access to those audio endpoints and nothing
else. The package reads nothing from the environment (not `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID` or
`OPENAI_LOG`): pass the key in yourself, for example from `OPENAI_API_KEY`.

## Use it

```ts
import { createVoices, speechTool, transcriptionTool } from 'mayura/voice';
import { openaiVoice } from '@mayurajs/voice-openai';

const voices = createVoices({
  providers: [openaiVoice({ apiKey: process.env.OPENAI_API_KEY ?? '' })],
  prices: 'catalog',
  maxCallCostMicros: 50_000,
});

const speech = await voices.speaker('openai/tts-1').speak({ text: 'Your order ships tomorrow.', voice: 'alloy', format: 'mp3' });
// MP3 is compressed, so give its duration: Mayura bounds the call's cost from it before sending anything.
const transcript = await voices.transcriber('openai/whisper-1').transcribe({ audio: speech.audio, durationMs: 3_000, language: 'en' });
console.log(transcript.text, transcript.usage.costMicros);

// Tools for agents and workflows. Grant tool:voice.speak and voice:openai/tts-1, and
// tool:voice.transcribe and voice:openai/whisper-1, to the run.
const speak = speechTool(voices.speaker('openai/tts-1'), { voice: 'alloy' });
const transcribe = transcriptionTool(voices.transcriber('openai/whisper-1'));
```

Ids are `openai/<model>`. Each tool requires `voice:<id>` besides `tool:<tool id>`, reserves the model's per-call bound
from the run's budget and reports what the call cost. See [Voice](../guides/voice.md#in-agents-and-workflows).

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | required | Your OpenAI API key. |
| `baseURL` | `https://api.openai.com/v1` | Send requests here instead, for example through a gateway. It must be `https`, without credentials, query or fragment. |
| `organization` | none | Sent as `OpenAI-Organization`. |
| `project` | none | Sent as `OpenAI-Project`. |
| `headers` | none | Up to 8 extra headers, such as a gateway's credential. They cannot replace `Authorization`, `OpenAI-Organization`, `OpenAI-Project`, `Content-Type`, `Host` or cookies. |
| `maxAudioBytes` | 64 MiB | The largest speech audio a call may return. |
| `timeoutMs` | 120 s | How long one call may take, unless the registry or the model sets `timeoutMs`. |
| `fetch` | `globalThis.fetch` | For tests and proxies. |

## Models and prices

The catalog has OpenAI's list prices as of 2026-09-30, used when you pass `prices: 'catalog'`:

| Id | Kind | Catalog price |
| --- | --- | --- |
| `openai/whisper-1` | Speech-to-text | $0.006 a minute (`microsPerMinute: 6_000`) |
| `openai/tts-1` | Text-to-speech | $15 per million characters |
| `openai/tts-1-hd` | Text-to-speech | $30 per million characters |

OpenAI bills `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `gpt-transcribe` and `gpt-4o-mini-tts` per token, which
cannot be known from the audio or text before a call, so they are not in the catalog. You can still use them: give a
per-minute or per-character price in `prices` (or the model's `pricing`) that you are comfortable bounding calls with.

```ts
import { createVoices } from 'mayura/voice';
import { openaiVoice } from '@mayurajs/voice-openai';

const voices = createVoices({
  providers: [openaiVoice({ apiKey: process.env.OPENAI_API_KEY ?? '' })],
  prices: { 'openai/gpt-4o-mini-tts': { microsPerMillionCharacters: 20_000_000 } },
  maxCallCostMicros: 50_000,
});
const speech = await voices.speaker('openai/gpt-4o-mini-tts').speak({ text: 'Hello.', voice: 'coral', instructions: 'Warmly.' });
```

## Cost bounds

Every call is priced before it is sent, and refused with `BUDGET_EXCEEDED` if it would cost more than the model's bound
(`maxCallCostMicros`, or the model's own `maxCostMicros`): speech from its text's characters (Unicode code points), and
transcription from the audio's duration, measured from WAV or given as `durationMs` for compressed audio. With a
50,000-micro bound, `openai/tts-1` speaks up to 3,333 characters a call and `openai/whisper-1` transcribes up to 8
minutes 20 seconds.

The cost a transcription reports is what OpenAI billed: the seconds OpenAI reports in the response's usage or duration,
and otherwise the duration measured or given. Speech is charged for the characters of the text.

## Audio and formats

- **Transcription** takes `audio/mpeg`, `audio/mp3`, `audio/wav` (and `audio/wave`, `audio/x-wav`, `audio/vnd.wave`),
  `audio/webm`, `audio/ogg`, `audio/flac` (and `audio/x-flac`), `audio/mp4`, `audio/m4a` and `audio/x-m4a`. Any other
  type fails with `configuration` before anything is sent. The registry accepts up to 25 MiB of audio by default
  (`maxAudioBytes` on `createVoices`).
- **Language and prompt.** A `language` is sent as its primary subtag (`en-GB` becomes `en`), and a `prompt` is passed
  on. Whisper reports languages by name, so a transcript's `language` is set only when OpenAI returns a language tag.
- **Segments.** `whisper-1` is asked for `verbose_json`, so its transcripts have timed segments; other models return
  text only.
- **Speech** comes in every Mayura format: `mp3` (`audio/mpeg`, the default), `opus` (`audio/ogg`), `aac`, `flac`,
  `wav` and `pcm16` (16-bit mono PCM at 24 kHz). The voice is an OpenAI voice name such as `alloy` or `coral`, and
  `instructions` are passed on for models that take them. Audio streams to `onAudio` as it arrives.
- A speech response that is not audio, is empty, or is larger than `maxAudioBytes` fails with `invalid_response`.

## Errors

Failures reach you as a `VoiceProviderError` with a `reason`. Its message is fixed text: nothing OpenAI wrote reaches
it.

| `reason` | When |
| --- | --- |
| `authentication` | OpenAI answered 401 or 403: the key is wrong or may not use this model. |
| `rate_limited` | OpenAI answered 402 or 429: a rate limit or quota was reached. |
| `unavailable` | OpenAI answered 408 or 5xx, or could not be reached. |
| `rejected` | OpenAI refused the request with another status, for example an unknown model or voice. |
| `timeout` | The call took longer than its `timeoutMs`. |
| `invalid_response` | The response had no text or no audio, or the audio was too large. |
| `configuration` | The audio's media type is not one OpenAI takes. |

A call cancelled through its `signal` fails with `CANCELLED`. Before anything is sent, the registry refuses a call over
its bound (`BUDGET_EXCEEDED`), audio or text over its limits (`LIMIT_EXCEEDED`), and compressed audio without
`durationMs` (`INVALID_INPUT`). A missing key or a non-`https` `baseURL` fails with `INVALID_CONFIG` when you call
`openaiVoice()`.

## How it is tested

- Unit tests run the package against a fake OpenAI API in OpenAI's own wire format. They check the URL, the
  `Authorization` header, the form fields and JSON sent, catalog charges, refused media types and the audio size limit,
  and that nothing is read from the environment and nothing is logged.
- The [voice adapter conformance suite](../guides/voice.md#testing-a-provider) passes against that fake: result shapes,
  costs, HTTP failures mapped without OpenAI's text, cancellation and timeouts.
- It has not been run against a real OpenAI account yet.

## Related

- [Voice](../guides/voice.md): the registry, prices, bounds and voice tools.
- [Model providers](../guides/model-providers.md): OpenAI's chat models.
- [ElevenLabs voice](voice-elevenlabs.md) and [Deepgram voice](voice-deepgram.md): other speech providers.
- [Costs and budgets](../concepts/costs-and-budgets.md): how a run's budget reserves each call's bound.
