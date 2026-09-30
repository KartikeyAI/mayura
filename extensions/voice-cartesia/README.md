# @mayurajs/voice-cartesia

Cartesia speech-to-text and text-to-speech for Mayura's voice registry, over Cartesia's HTTP API.

```bash
npm install mayura @mayurajs/voice-cartesia
```

```ts
import { createVoices } from 'mayura/voice';
import { cartesiaVoice } from '@mayurajs/voice-cartesia';

const voices = createVoices({ providers: [cartesiaVoice({ apiKey })], prices: 'catalog', maxCallCostMicros: 50_000 });
const speech = await voices.speaker('cartesia/sonic-3.6').speak({ text: 'Hello.', voice: 'a0e99841-438c-4a64-b679-ae501e7d6091' });
```

- Ids are `cartesia/<model>`, granted as `voice:<id>`; the voice is a Cartesia voice id.
- Cartesia bills in credits. The catalog prices them at Cartesia's highest per-credit rate (Pro overage), so it may
  overcount, never undercount.
- Transcription (`cartesia/ink-whisper`) assumes English unless a language is given: Cartesia does not detect it.
- No dependencies: requests go through fetch. Nothing is read from the environment.
- Every call is bounded before it is sent. Passes Mayura's voice adapter conformance suite.

See the [voice guide](https://mayurajs.com/docs/guides/voice/). Apache-2.0.
