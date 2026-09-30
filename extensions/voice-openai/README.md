# @mayurajs/voice-openai

OpenAI speech-to-text and text-to-speech for Mayura's voice registry, through the official `openai` SDK.

```bash
npm install mayura @mayurajs/voice-openai
```

```ts
import { createVoices } from 'mayura/voice';
import { openaiVoice } from '@mayurajs/voice-openai';

const voices = createVoices({ providers: [openaiVoice({ apiKey })], prices: 'catalog', maxCallCostMicros: 50_000 });
const speech = await voices.speaker('openai/tts-1').speak({ text: 'Hello.', voice: 'alloy' });
```

- Ids are `openai/<model>`, granted as `voice:<id>`. The catalog lists whisper-1, tts-1 and tts-1-hd at OpenAI's list
  prices on its date; models OpenAI bills per token need a price you give.
- Reads nothing from the environment; the SDK's retries and logging are off.
- Every call is bounded before it is sent. Passes Mayura's voice adapter conformance suite.

See the [voice guide](https://mayurajs.com/docs/guides/voice/). Apache-2.0.
