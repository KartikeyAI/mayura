---
title: "Azure Speech"
description: "Transcribe audio with Azure's fast transcription and speak text with Azure neural voices through @mayurajs/voice-azure: prices, bounds and errors."
package: "@mayurajs/voice-azure"
vendor: "Microsoft Azure"
logo: "azure"
website: "https://azure.microsoft.com"
area: "voice"
---

[Azure AI Speech](https://azure.microsoft.com) serves speech-to-text through fast transcription and text-to-speech
through its neural, HD and HD Flash voices. `@mayurajs/voice-azure` plugs them into the
[voice registry](../guides/voice.md), so your code and your agents use them with the same ids, prices, per-call bounds
and `voice:<id>` permissions as every other voice provider. It talks to Azure's HTTP APIs with `fetch`: no Azure SDK,
no other dependencies, and it runs on every runtime Mayura runs on.

## Install

```bash
npm install mayura @mayurajs/voice-azure
```

## Credentials

Create a Speech resource in the [Azure portal](https://portal.azure.com) and open its **Keys and Endpoint** page. The
package needs where the resource is and one credential (one of each, not both):

- **Where:** its `region`, such as `eastus`, or its custom subdomain `resource` (requests then go to
  `https://<resource>.cognitiveservices.azure.com`).
- **Credential:** a resource key (`apiKey`), sent as `Ocp-Apim-Subscription-Key`, or a bearer `token` source, called
  for every request so tokens stay fresh. With a `resource`, the token is a Microsoft Entra ID token; with a `region`,
  it is `aad#<resource id>#<Entra token>` or a token from Azure's token service.

The package reads nothing from the environment: pass the key and region in yourself, for example from
`AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION`.

## Use it

```ts
import { createVoices, speechTool } from 'mayura/voice';
import { azureVoice } from '@mayurajs/voice-azure';

const voices = createVoices({
  providers: [azureVoice({ region: process.env.AZURE_SPEECH_REGION ?? 'eastus', apiKey: process.env.AZURE_SPEECH_KEY ?? '' })],
  prices: 'catalog',
  maxCallCostMicros: 50_000,
});

// Speech ids are voice families, and the voice must belong to the family.
const speech = await voices.speaker('azure/neural').speak({ text: 'Your order ships tomorrow.', voice: 'en-US-AvaMultilingualNeural', format: 'wav' });
// WAV is measured, so no duration is needed. Without a language, Azure detects it.
const transcript = await voices.transcriber('azure/fast').transcribe({ audio: speech.audio });
console.log(transcript.text, transcript.language, transcript.usage.costMicros);

// A tool for agents and workflows: grant tool:voice.speak and voice:azure/neural to the run.
const speak = speechTool(voices.speaker('azure/neural'), { voice: 'en-US-AvaMultilingualNeural' });
```

Ids are `azure/<model>`. Each voice tool requires `voice:<id>` besides `tool:<tool id>`, reserves the model's per-call
bound from the run's budget and reports what the call cost. See [Voice](../guides/voice.md#in-agents-and-workflows).

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `region` | none | Your Speech resource's region, such as `eastus`. Give this or `resource`. |
| `resource` | none | Your Speech resource's custom subdomain. Give this or `region`. |
| `apiKey` | none | The resource key, sent as `Ocp-Apim-Subscription-Key`. Give this or `token`. |
| `token` | none | A function returning a bearer token, called for every request. Give this or `apiKey`. |
| `speechToTextURL` | `https://<region>.api.cognitive.microsoft.com`, or the resource's subdomain | Send transcription requests here instead, for example a sovereign cloud's endpoint. It must be `https`. |
| `textToSpeechURL` | `https://<region>.tts.speech.microsoft.com`, or the resource's subdomain with `/tts` | Send speech requests here instead. It must be `https`. |
| `headers` | none | Up to 8 extra headers, such as a gateway's credential. They cannot replace `Authorization`, `Ocp-Apim-Subscription-Key`, `Content-Type`, `Host` or cookies. |
| `maxAudioBytes` | 64 MiB | The largest speech audio a call may return. |
| `maxResponseBytes` | 16 MiB | The largest transcription response. |
| `timeoutMs` | 300 s | How long one call may take, unless the registry or the model sets `timeoutMs`. Fast transcription takes long audio, so the default is long. |
| `fetch` | `globalThis.fetch` | For tests and proxies. |

## Models and prices

The catalog has Azure Speech's pay-as-you-go prices as of 2026-09-30, the same in every region that offers them, used
when you pass `prices: 'catalog'`:

| Id | Kind | Catalog price | Voices, for example |
| --- | --- | --- | --- |
| `azure/fast` | Speech-to-text (fast transcription) | $0.36 an hour (6,000 micros a minute) | |
| `azure/neural` | Text-to-speech | $15 per million characters | `en-US-AvaMultilingualNeural` |
| `azure/neural-hd` | Text-to-speech | $22 per million characters | `en-US-Ava:DragonHDLatestNeural` |
| `azure/neural-hd-flash` | Text-to-speech | $15 per million characters | `en-US-Tiana:DragonHDFlashLatestNeural` |

`azure/mai-transcribe-2` (MAI-Transcribe-2 through fast transcription) works with a price you give in `prices` or the
model's `pricing`: its price is promotional until the end of 2026, so it is left out of the catalog. Transcription ids
are `fast` and `mai-transcribe-2`, and speech ids the three families above; any other fails with `INVALID_CONFIG`.

## Cost bounds

Azure bills speech per character of the SSML content it receives, escapes included (`&` is billed as the five
characters of `&amp;`), and counts each Chinese character twice. The adapter escapes your text, counts it the way Azure
bills it, and refuses the call with `BUDGET_EXCEEDED` before sending it if that count would cost more than the model's
bound. That is stricter than the registry's own check, which counts code points. The speech's reported `characters` and
cost are those billable characters.

Transcription is priced before the call from the audio's duration (measured from WAV, or given as `durationMs` for
compressed audio). The cost it reports is the duration Azure returns, rounded up to a whole second, since Azure bills
whole seconds. With a 50,000-micro bound, `azure/neural` speaks up to 3,333 billable characters a call and `azure/fast`
transcribes up to 8 minutes 20 seconds.

## Audio and formats

- **Transcription** sends the audio as it is, with its media type, to fast transcription with the profanity filter
  off. A `language` is sent as the one locale to use; without one, Azure detects it and the transcript reports what it
  found. Segments are Azure's phrases, with a speaker when Azure reports one. The registry accepts up to 25 MiB of
  audio by default.
- **Speech** is sent as SSML with your text escaped. Formats: `mp3` (24 kHz, 48 kbps mono, the default), `opus` (Ogg,
  24 kHz, `audio/ogg`), `wav` (24 kHz 16-bit mono) and `pcm16` (raw 24 kHz). `aac` and `flac` fail with
  `configuration`. Audio streams to `onAudio` as it arrives.
- **The voice** must belong to the id's family: a standard neural voice (`en-US-AvaMultilingualNeural`) for `neural`, a
  `DragonHD` voice for `neural-hd`, a `DragonHDFlash` voice for `neural-hd-flash`. Azure OpenAI voices (such as
  `en-US-AlloyMultilingualNeural`) look like neural voices but are priced separately, so they are refused. The SSML's
  language is the `language` you give, or the voice's locale. A voice outside the family, or a malformed language,
  fails with `configuration` before a request is made.
- Audio larger than `maxAudioBytes`, a response that is not audio, and a transcription response larger than
  `maxResponseBytes` fail with `invalid_response`. Requests do not follow redirects.

## Errors

Failures reach you as a `VoiceProviderError` with a `reason`. Its message is fixed text: nothing Azure wrote reaches it.

| `reason` | When |
| --- | --- |
| `authentication` | Azure answered 401 or 403, or your `token` function threw or returned something that is not a token. No request is sent in that case. |
| `rate_limited` | Azure answered 402 or 429: a rate limit or quota was reached. |
| `unavailable` | Azure answered 408 or 5xx, or could not be reached. |
| `rejected` | Azure refused the request with another status. |
| `timeout` | The call took longer than its `timeoutMs`. |
| `invalid_response` | The response was not what Azure's API promises, or was too large. |
| `configuration` | The speech format, voice or language is not one this family takes. |

A call cancelled through its `signal` fails with `CANCELLED`. Before anything is sent, a call over its bound fails with
`BUDGET_EXCEEDED`, audio or text over the registry's limits with `LIMIT_EXCEEDED`, and compressed audio without
`durationMs` with `INVALID_INPUT`. `azureVoice()` fails with `INVALID_CONFIG` for neither or both credentials, neither
or both of `region` and `resource`, a malformed region or subdomain, or a non-`https` URL.

## How it is tested

- Unit tests run the package against fake fast-transcription and text-to-speech APIs in Azure's own wire format. They
  check the URLs for a region and a custom subdomain, both credentials, the transcription definition (locale, model),
  whole-second billing, the SSML sent and its escaping, each output format, Chinese characters counted twice and
  bounded before sending, voices of the wrong family and Azure OpenAI voices, a failing token source, and that nothing
  is read from the environment.
- The [voice adapter conformance suite](../guides/voice.md#testing-a-provider) passes against those fakes: result
  shapes, costs, HTTP failures mapped without Azure's text, cancellation and timeouts.
- It has not been run against a real Azure subscription yet.

## Related

- [Voice](../guides/voice.md): the registry, prices, bounds and voice tools.
- [Google Cloud speech](voice-google.md): another cloud's speech service, with voice families priced the same way.
- [OpenAI speech](voice-openai.md): OpenAI's own voices.
- [Costs and budgets](../concepts/costs-and-budgets.md): how a run's budget reserves each call's bound.
