# @mayurajs/voice-azure

Azure Speech transcription and text-to-speech for Mayura's voice registry, over Azure's HTTP APIs.

```bash
npm install mayura @mayurajs/voice-azure
```

```ts
import { createVoices } from 'mayura/voice';
import { azureVoice } from '@mayurajs/voice-azure';

const voices = createVoices({ providers: [azureVoice({ region: 'eastus', apiKey })], prices: 'catalog', maxCallCostMicros: 50_000 });
const speech = await voices.speaker('azure/neural').speak({ text: 'Hello.', voice: 'en-US-AvaMultilingualNeural' });
const transcript = await voices.transcriber('azure/fast').transcribe({ audio: speech.audio, durationMs: 2_000 });
```

- Ids are `azure/<model>`, granted as `voice:<id>`. Transcription uses fast transcription (`azure/fast`; also
  `azure/mai-transcribe-2` with your own price) and detects the language when none is given.
- Speech ids are voice families: `neural` (`en-US-AvaMultilingualNeural`), `neural-hd`
  (`en-US-Ava:DragonHDLatestNeural`) and `neural-hd-flash`. The voice must belong to the family, so it is charged at its
  own price; Azure OpenAI voices, priced separately, are refused.
- Azure bills the escaped text and counts each Chinese character twice: the adapter counts characters the same way
  and bounds the call before sending it.
- Credentials: an `apiKey`, or a `token` source (Microsoft Entra ID). Endpoints: a `region` or a custom subdomain
  `resource`. No dependencies: requests go through fetch. Nothing is read from the environment.
- Every call is bounded before it is sent. Passes Mayura's voice adapter conformance suite.

See the [voice guide](https://mayurajs.com/docs/guides/voice/). Apache-2.0.
