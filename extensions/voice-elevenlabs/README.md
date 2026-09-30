# @mayurajs/voice-elevenlabs

ElevenLabs speech-to-text and text-to-speech for Mayura's voice registry, over ElevenLabs' HTTP API.

```bash
npm install mayura @mayurajs/voice-elevenlabs
```

```ts
import { createVoices } from 'mayura/voice';
import { elevenlabsVoice } from '@mayurajs/voice-elevenlabs';

const voices = createVoices({ providers: [elevenlabsVoice({ apiKey })], prices: 'catalog', maxCallCostMicros: 50_000 });
const speech = await voices.speaker('elevenlabs/eleven_v3').speak({ text: 'Hello.', voice: 'JBFqnCBsd6RMkjVDRZzb' });
```

- Ids are `elevenlabs/<model>`, granted as `voice:<id>`; the voice is an ElevenLabs voice id. The catalog lists Scribe
  v2 and the v4, v3, Multilingual v2 and Flash v2.5 models at ElevenLabs' pay-as-you-go prices on its date.
- No dependencies: requests go through fetch. The official SDK is not used; it depends on node-fetch, ws and
  command-exists. Nothing is read from the environment.
- Every call is bounded before it is sent. Passes Mayura's voice adapter conformance suite.

See the [voice guide](https://mayurajs.com/docs/guides/voice/). Apache-2.0.
