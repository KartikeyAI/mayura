---
title: "Google Cloud speech"
description: "Transcribe audio with Chirp and speak text with Google Cloud voices through @mayurajs/voice-google: credentials, prices, limits and errors."
package: "@mayurajs/voice-google"
vendor: "Google Cloud"
logo: "google-cloud"
website: "https://cloud.google.com"
area: "voice"
---

[Google Cloud](https://cloud.google.com) serves speech-to-text through Speech-to-Text v2 (Chirp 3, Chirp 2, telephony)
and text-to-speech through Text-to-Speech (Chirp 3 HD, Studio, Neural2, Polyglot, WaveNet and Standard voices).
`@mayurajs/voice-google` plugs them into the [voice registry](../guides/voice.md), so your code and your agents use
them with the same ids, prices, per-call bounds and `voice:<id>` permissions as every other voice provider. It talks to
Google's HTTP APIs with `fetch`: no Google SDK, no other dependencies, and it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/voice-google
```

## Credentials

Enable the Cloud Speech-to-Text API and the Cloud Text-to-Speech API in your Google Cloud project, then give the
package one of two credentials (not both):

- **An API key** (`apiKey`), created on the [Credentials page](https://console.cloud.google.com/apis/credentials) and
  sent as `x-goog-api-key`. Restrict it to the two speech APIs.
- **An OAuth access token source** (`token`), such as a service account's through `google-auth-library`, sent as a
  bearer token. It is called once per request, so it can refresh tokens as they expire. The service account needs
  permission to run recognition in the project (for example the Cloud Speech Client role).

Transcription also needs `project`, the project id or number it runs in. The package reads nothing from the environment
(not `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_API_KEY` or `GOOGLE_CLOUD_PROJECT`): pass them in yourself, for example
from `GOOGLE_API_KEY` and `GOOGLE_CLOUD_PROJECT`.

```ts
import { googleVoice } from '@mayurajs/voice-google';

declare function accessToken(): Promise<string>; // for example from google-auth-library

const google = googleVoice({ token: accessToken, project: 'my-project', location: 'eu' });
```

## Use it

```ts
import { createVoices, speechTool } from 'mayura/voice';
import { googleVoice } from '@mayurajs/voice-google';

const voices = createVoices({
  providers: [googleVoice({ apiKey: process.env.GOOGLE_API_KEY ?? '', project: process.env.GOOGLE_CLOUD_PROJECT ?? '' })],
  prices: 'catalog',
  maxCallCostMicros: 50_000,
});

// Speech ids are voice families, and the voice must belong to the family.
const speech = await voices.speaker('google/chirp3-hd').speak({ text: 'Your order ships tomorrow.', voice: 'en-US-Chirp3-HD-Charon', format: 'wav' });
// WAV is measured, so no duration is needed. Without a language, Chirp 3 detects it.
const transcript = await voices.transcriber('google/chirp_3').transcribe({ audio: speech.audio });
console.log(transcript.text, transcript.language, transcript.usage.costMicros);

// A tool for agents and workflows: grant tool:voice.speak and voice:google/chirp3-hd to the run.
const speak = speechTool(voices.speaker('google/chirp3-hd'), { voice: 'en-US-Chirp3-HD-Charon' });
```

Ids are `google/<model>`. Each voice tool requires `voice:<id>` besides `tool:<tool id>`, reserves the model's
per-call bound from the run's budget and reports what the call cost. See
[Voice](../guides/voice.md#in-agents-and-workflows).

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | none | A Google Cloud API key, sent as `x-goog-api-key`. Give this or `token`. |
| `token` | none | A function returning an OAuth access token, called once per request. Give this or `apiKey`. |
| `project` | none | The project id or number transcription runs in. Required to transcribe. |
| `location` | `us` | The Speech-to-Text location, such as `us`, `eu` or `global`. Chirp 3 is served in `us` and `eu`. |
| `speechToTextURL` | `https://<location>-speech.googleapis.com` | Send transcription requests here instead (`https://speech.googleapis.com` for `global`). It must be `https`. |
| `textToSpeechURL` | `https://texttospeech.googleapis.com` | Send speech requests here instead. It must be `https`. |
| `headers` | none | Up to 8 extra headers, such as `x-goog-user-project` or a gateway's credential. They cannot replace `Authorization`, `x-goog-api-key`, `Content-Type`, `Host` or cookies. |
| `maxAudioBytes` | 32 MiB | The largest speech audio a call may return. |
| `maxResponseBytes` | 4 MiB | The largest transcription response. |
| `timeoutMs` | 120 s | How long one call may take, unless the registry or the model sets `timeoutMs`. |
| `fetch` | `globalThis.fetch` | For tests and proxies. |

## Models and prices

The catalog has Google Cloud's list prices as of 2026-09-30, used when you pass `prices: 'catalog'`. Transcription is
Speech-to-Text v2's standard recognition at its first volume tier; later tiers cost less, so the price may overcount,
never undercount. Speech prices are per character, before the monthly free characters.

| Id | Kind | Catalog price | Voices, for example |
| --- | --- | --- | --- |
| `google/chirp_3` | Speech-to-text | $0.016 a minute | |
| `google/chirp_2` | Speech-to-text | $0.016 a minute | |
| `google/telephony` | Speech-to-text | $0.016 a minute | |
| `google/chirp3-hd` | Text-to-speech | $30 per million characters | `en-US-Chirp3-HD-Charon` |
| `google/studio` | Text-to-speech | $160 per million characters | `en-US-Studio-O` |
| `google/neural2` | Text-to-speech | $16 per million characters | `en-US-Neural2-A` |
| `google/polyglot` | Text-to-speech | $16 per million characters | `<locale>-Polyglot-<name>` |
| `google/wavenet` | Text-to-speech | $4 per million characters | `<locale>-Wavenet-<name>` |
| `google/standard` | Text-to-speech | $4 per million characters | `en-US-Standard-A` |

Gemini voices, billed per token, and instant custom voices are left out. Speech ids are the six families above and no
others; another transcription model works with a price you give in `prices` or the model's `pricing`.

## Cost bounds

Every call is priced before it is sent, and refused with `BUDGET_EXCEEDED` if it would cost more than the model's bound:
speech from its text's characters (Unicode code points), and transcription from the audio's duration, measured from WAV
or given as `durationMs` for compressed audio. With a 50,000-micro bound, `google/chirp3-hd` speaks up to 1,666
characters a call.

The cost a transcription reports is what Google billed: the `totalBilledDuration` in its response, which Google rounds
up to a whole second, and otherwise the duration measured or given, rounded up to a whole second. Speech is charged for
the characters of the text. Because a speech id names a family and the voice must belong to it, a Studio voice is never
charged at the Neural2 price.

## Limits, audio and formats

- **Transcription is synchronous:** at most 60 seconds and 10 MiB of audio per call. Longer or larger audio fails with
  `LIMIT_EXCEEDED` before anything is sent.
- **Decoding and language.** Audio is sent base64-encoded with automatic decoding, so Google reads its format. A
  `language` is sent as given; without one, `auto` is sent, which Chirp 3 resolves by detecting the language. Other
  models need a language.
- **Segments.** Chirp 3 has no word timings in synchronous recognition, so its segments are the recognized results;
  other models are asked for word timings, and their segments are words.
- **Speech** formats: `mp3` (the default), `opus` (`OGG_OPUS`, `audio/ogg`), `aac` (`M4A`, `audio/mp4`), `wav`
  (`LINEAR16`) and `pcm16` (24 kHz). `flac` fails with `configuration`. Text is limited to 5,000 bytes of UTF-8 per call,
  and longer text fails with `LIMIT_EXCEEDED` before anything is sent.
- **The voice** must be a Google voice name of the id's family, `<language>-<REGION>-<family>-<name>`, such as
  `en-GB-Chirp3-HD-Charon` for `google/chirp3-hd`; its language is taken from the name. A voice of another family fails
  with `configuration` before a request is made.
- Google returns speech in one piece, so `onAudio` receives it once. Audio larger than `maxAudioBytes`, and a
  transcription response larger than `maxResponseBytes`, fail with `invalid_response`. Requests do not follow
  redirects.

## Errors

Failures reach you as a `VoiceProviderError` with a `reason`. Its message is fixed text: nothing Google wrote reaches
it.

| `reason` | When |
| --- | --- |
| `authentication` | Google answered 401 or 403, or your `token` function threw or returned something that is not a token. No request is sent in that case. |
| `rate_limited` | Google answered 402 or 429: a rate limit or quota was reached. |
| `unavailable` | Google answered 408 or 5xx, or could not be reached. |
| `rejected` | Google refused the request with another status. |
| `timeout` | The call took longer than its `timeoutMs`. |
| `invalid_response` | The response was not what Google's API promises, or was too large. |
| `configuration` | The speech format or the voice is not one this family takes. |

A call cancelled through its `signal` fails with `CANCELLED`. Before anything is sent, the registry refuses a call over
its bound (`BUDGET_EXCEEDED`), audio or text over its limits (`LIMIT_EXCEEDED`), and compressed audio without
`durationMs` (`INVALID_INPUT`). `googleVoice()` fails with `INVALID_CONFIG` for neither or both credentials, a malformed
project or location, or a non-`https` URL; asking for a transcriber without `project`, or a speaker outside the six
families, fails the same way.

## How it is tested

- Unit tests run the package against fake Speech-to-Text v2 and Text-to-Speech APIs in Google's own wire format. They
  check the URLs per location, both credentials, the recognition config (language detection, word timings), billed
  seconds, silence, the 60-second and 10 MiB limits, voices of the wrong family, the 5,000-byte text limit, a failing
  token source, and that nothing is read from the environment.
- The [voice adapter conformance suite](../guides/voice.md#testing-a-provider) passes against those fakes: result
  shapes, costs, HTTP failures mapped without Google's text, cancellation and timeouts.
- It has not been run against a real Google Cloud project yet.

## Related

- [Voice](../guides/voice.md): the registry, prices, bounds and voice tools.
- [Azure Speech](voice-azure.md): another cloud's speech service, with voice families priced the same way.
- [Model providers](../guides/model-providers.md): Google's Gemini models.
- [Costs and budgets](../concepts/costs-and-budgets.md): how a run's budget reserves each call's bound.
