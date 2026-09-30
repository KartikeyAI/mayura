# @mayurajs/voice-assemblyai

AssemblyAI speech-to-text for Mayura's voice registry, over AssemblyAI's HTTP API.

```bash
npm install mayura @mayurajs/voice-assemblyai
```

```ts
import { createVoices } from 'mayura/voice';
import { assemblyaiVoice } from '@mayurajs/voice-assemblyai';

const voices = createVoices({ providers: [assemblyaiVoice({ apiKey })], prices: 'catalog', maxCallCostMicros: 50_000 });
const transcript = await voices.transcriber('assemblyai/universal-3-5-pro').transcribe({ audio, durationMs: 60_000 });
```

- Ids are `assemblyai/<model>`, granted as `voice:<id>`. The catalog lists Universal-3.5 Pro and Universal-2 at
  AssemblyAI's pay-as-you-go prices on its date. AssemblyAI has no speech API, so there is no speaker.
- AssemblyAI transcribes asynchronously: the audio is uploaded, a transcript requested and polled until ready.
  Each transcript is deleted from AssemblyAI once read, unless `retainTranscripts: true`.
- No dependencies: requests go through fetch. Nothing is read from the environment. `baseURL` reaches the EU endpoint.
- Every call is bounded before it is sent. Passes Mayura's voice adapter conformance suite.

See the [voice guide](https://mayurajs.com/docs/guides/voice/). Apache-2.0.
