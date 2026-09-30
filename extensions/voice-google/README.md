# @mayurajs/voice-google

Google Cloud Speech-to-Text and Text-to-Speech for Mayura's voice registry, over Google's HTTP APIs.

```bash
npm install mayura @mayurajs/voice-google
```

```ts
import { createVoices } from 'mayura/voice';
import { googleVoice } from '@mayurajs/voice-google';

// token: an OAuth access token source, such as google-auth-library's () => auth.getAccessToken().
const voices = createVoices({ providers: [googleVoice({ token, project: 'my-project' })], prices: 'catalog', maxCallCostMicros: 50_000 });
const speech = await voices.speaker('google/chirp3-hd').speak({ text: 'Hello.', voice: 'en-US-Chirp3-HD-Charon' });
const transcript = await voices.transcriber('google/chirp_3').transcribe({ audio: speech.audio, durationMs: 2_000 });
```

- Ids are `google/<model>`, granted as `voice:<id>`. Transcription models are Speech-to-Text v2 models (`chirp_3`,
  `chirp_2`, `telephony`); speech ids are voice families (`chirp3-hd`, `studio`, `neural2`, `polyglot`, `wavenet`,
  `standard`), and the voice must belong to the family, so it is charged at its own price.
- Transcription is synchronous: up to a minute and 10 MB of audio per call, refused before sending otherwise. Chirp 3
  detects the language when none is given. `location` picks the Speech-to-Text location (`us` by default).
- Credentials: an OAuth `token` source or an `apiKey`. No dependencies: requests go through fetch. Nothing is read
  from the environment.
- Every call is bounded before it is sent. Passes Mayura's voice adapter conformance suite.

See the [voice guide](https://mayurajs.com/docs/guides/voice/). Apache-2.0.
