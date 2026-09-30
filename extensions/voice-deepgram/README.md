# @mayurajs/voice-deepgram

Deepgram speech-to-text and text-to-speech for Mayura's voice registry, over Deepgram's HTTP API.

```bash
npm install mayura @mayurajs/voice-deepgram
```

```ts
import { createVoices } from 'mayura/voice';
import { deepgramVoice } from '@mayurajs/voice-deepgram';

const voices = createVoices({ providers: [deepgramVoice({ apiKey })], prices: 'catalog', maxCallCostMicros: 50_000 });
const speech = await voices.speaker('deepgram/aura-2').speak({ text: 'Hello.', voice: 'thalia-en' });
```

- Ids are `deepgram/<model>`, granted as `voice:<id>`. Speech ids name a model family that the voice completes:
  `deepgram/aura-2` with voice `thalia-en` is Deepgram's `aura-2-thalia-en`. The catalog lists Nova-3 (at its
  multilingual rate), Whisper Large, Aura-2 and Aura at Deepgram's pay-as-you-go prices on its date.
- No dependencies: requests go through fetch. Nothing is read from the environment.
- Every call is bounded before it is sent. Passes Mayura's voice adapter conformance suite.

See the [voice guide](https://mayurajs.com/docs/guides/voice/). Apache-2.0.
