---
title: "AssemblyAI transcription"
description: "Transcribe audio with AssemblyAI's Universal models through @mayurajs/voice-assemblyai: prices, bounds, transcript deletion and errors."
package: "@mayurajs/voice-assemblyai"
vendor: "AssemblyAI"
logo: "assemblyai"
website: "https://www.assemblyai.com"
area: "voice"
---

[AssemblyAI](https://www.assemblyai.com) transcribes speech with its Universal models. `@mayurajs/voice-assemblyai`
plugs them into the [voice registry](../guides/voice.md), so your code and your agents transcribe with the same ids,
prices, per-call bounds and `voice:<id>` permissions as every other voice provider. AssemblyAI has no speech API, so the
package transcribes only. It talks to AssemblyAI's HTTP API with `fetch`: no AssemblyAI SDK, no other dependencies, and
it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/voice-assemblyai
```

## Credentials

Copy your API key from the [AssemblyAI dashboard](https://www.assemblyai.com/dashboard). It is sent as the
`Authorization` header to `/v2/upload` and `/v2/transcript`. The package reads nothing from the environment: pass the
key in yourself, for example from `ASSEMBLYAI_API_KEY`.

## Use it

```ts
import { createVoices, transcriptionTool } from 'mayura/voice';
import { assemblyaiVoice } from '@mayurajs/voice-assemblyai';

declare const recording: Uint8Array; // an MP3 file's bytes

const voices = createVoices({
  providers: [assemblyaiVoice({ apiKey: process.env.ASSEMBLYAI_API_KEY ?? '' })],
  prices: 'catalog',
  maxCallCostMicros: 50_000,
});

// MP3 is compressed, so give its duration: Mayura bounds the call's cost from it before sending anything.
const transcript = await voices.transcriber('assemblyai/universal-3-5-pro').transcribe({
  audio: { data: recording, mediaType: 'audio/mpeg' },
  durationMs: 90_000,
});
console.log(transcript.text, transcript.language, transcript.usage.costMicros);

// A tool for agents and workflows: grant tool:voice.transcribe and voice:assemblyai/universal-3-5-pro to the run.
const transcribe = transcriptionTool(voices.transcriber('assemblyai/universal-3-5-pro'));
```

Ids are `assemblyai/<model>`. The tool requires `voice:<id>` besides `tool:<tool id>`, reserves the model's per-call
bound from the run's budget and reports what the call cost. See [Voice](../guides/voice.md#in-agents-and-workflows).

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | required | Your AssemblyAI API key. |
| `baseURL` | `https://api.assemblyai.com` | Send requests here instead, for example `https://api.eu.assemblyai.com`. It must be `https`. |
| `headers` | none | Up to 8 extra headers, such as a gateway's credential. They cannot replace `Authorization`, `Content-Type`, `Host` or cookies. |
| `retainTranscripts` | `false` | Keep each transcript at AssemblyAI after reading it. By default it is deleted. |
| `pollIntervalMs` | 1,000 ms | How often to ask whether a transcript is ready. |
| `maxResponseBytes` | 16 MiB | The largest transcript response. |
| `timeoutMs` | 10 minutes | How long one call may take, unless the registry or the model sets `timeoutMs`. Transcription is queued, so the default is long. |
| `fetch` | `globalThis.fetch` | For tests and proxies. |

## Models and prices

The catalog has AssemblyAI's pay-as-you-go prices for pre-recorded audio as of 2026-09-30, used when you pass
`prices: 'catalog'`:

| Id | Catalog price |
| --- | --- |
| `assemblyai/universal-3-5-pro` | $0.21 an hour (3,500 micros a minute) |
| `assemblyai/universal-2` | $0.15 an hour (2,500 micros a minute) |

The package uses none of AssemblyAI's priced add-ons (no prompting, key terms or speaker labels), so these are the
whole price. Another AssemblyAI model works with a price you give in `prices` or the model's `pricing`.

## Cost bounds

Every call is priced before it is sent, from the audio's duration (measured from WAV, or given as `durationMs` for
compressed audio), and refused with `BUDGET_EXCEEDED` if it would cost more than the model's bound. With a 50,000-micro
bound, `assemblyai/universal-3-5-pro` transcribes up to about 14 minutes a call.

The cost a transcript reports is what AssemblyAI billed: the `audio_duration` it reports, and otherwise the duration
measured or given.

## How a transcription runs

AssemblyAI transcribes asynchronously, so one `transcribe` call makes several requests:

1. `POST /v2/upload` with the audio's bytes.
2. `POST /v2/transcript` with the uploaded file's URL and the one model asked for. A `language` is sent as its primary
   subtag (`es-MX` becomes `es`); without one, language detection is turned on and the transcript reports what was
   found.
3. `GET /v2/transcript/<id>` every `pollIntervalMs` until the transcript is completed. A transcript AssemblyAI reports
   as failed is `rejected`.
4. `DELETE /v2/transcript/<id>`, unless `retainTranscripts` is set. It runs after every call that got as far as
   requesting a transcript, whether the call succeeded or not, and is best effort: a failed delete does not fail your
   call.

Segments are words, with their timings and a speaker when AssemblyAI reports one. The registry accepts up to 25 MiB of
audio by default (`maxAudioBytes` on `createVoices`). Requests do not follow redirects.

Cancelling a call, or reaching its timeout, after the transcript was requested stops the waiting, not the
transcription, which AssemblyAI may still bill.

## Errors

Failures reach you as a `VoiceProviderError` with a `reason`. Its message is fixed text: nothing AssemblyAI wrote, such
as a failed transcript's error, reaches it.

| `reason` | When |
| --- | --- |
| `authentication` | AssemblyAI answered 401 or 403: the key is wrong. |
| `rate_limited` | AssemblyAI answered 402 or 429: a rate limit or quota was reached. |
| `unavailable` | AssemblyAI answered 408 or 5xx, or could not be reached. |
| `rejected` | AssemblyAI refused a request with another status, or reported the transcript as failed. |
| `timeout` | The call took longer than its `timeoutMs`, waiting included. |
| `invalid_response` | A response was not what AssemblyAI's API promises, or was too large. |

A call cancelled through its `signal` fails with `CANCELLED`. Before anything is sent, the registry refuses a call over
its bound (`BUDGET_EXCEEDED`), audio over its size limit (`LIMIT_EXCEEDED`), and compressed audio without `durationMs`
(`INVALID_INPUT`). Asking the registry for an `assemblyai/...` speaker fails with `INVALID_CONFIG`, as do a missing key,
a non-`https` `baseURL` and a malformed model id.

## How it is tested

- Unit tests run the package against a fake AssemblyAI API (upload, submit, poll, delete) in AssemblyAI's own wire
  format. They check the order of requests, the `Authorization` header on each, the model and language sent, that
  transcripts are deleted unless kept, the EU endpoint, that a failed transcript is `rejected` without its error text,
  and that nothing is read from the environment.
- The [voice adapter conformance suite](../guides/voice.md#testing-a-provider) passes against that fake for every
  transcription case; its speech case is skipped.
- `scripts/live/voice-assemblyai.mjs` passed against a real AssemblyAI account on October 6, 2026: a sentence spoken by
  Deepgram or ElevenLabs was transcribed back with its words by `universal-3-5-pro`, through the shared voice checks at
  catalog prices.

## Related

- [Voice](../guides/voice.md): the registry, prices, bounds and voice tools.
- [Deepgram voice](voice-deepgram.md) and [ElevenLabs voice](voice-elevenlabs.md): providers that also speak, for
  example to answer what was transcribed.
- [Costs and budgets](../concepts/costs-and-budgets.md): how a run's budget reserves each call's bound.
