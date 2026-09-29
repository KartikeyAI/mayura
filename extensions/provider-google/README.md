# @mayurajs/provider-google

Google Gemini models for [Mayura](https://mayurajs.com), through the official `@google/genai` SDK and the Gemini API.

```bash
npm install mayura @mayurajs/provider-google
```

```ts
import { createModels, defineAgent, z } from 'mayura';
import { google } from '@mayurajs/provider-google';

const models = createModels({
  providers: [google({ apiKey: process.env.GEMINI_API_KEY! })],
  prices: { 'google/gemini-3.5-flash': { inputMicrosPerMillionTokens: 1_500_000, outputMicrosPerMillionTokens: 9_000_000 } },
  maxCallCostMicros: 50_000,
});

const agent = defineAgent({
  id: 'helper', version: '1', instructions: 'Answer in one sentence.', model: models.model('google/gemini-3.5-flash'), tools: [],
  input: z.object({ question: z.string() }), output: z.object({ answer: z.string() }),
});
// Grant it as model:google/gemini-3.5-flash.
```

- Credentials are options: nothing is read from the environment (not `GEMINI_API_KEY`, `GOOGLE_API_KEY`,
  `GOOGLE_GEMINI_BASE_URL` or the Vertex AI settings).
- The SDK's own retries are off; the registry's `retry` option retries and charges every attempt.
- Tool parameters and structured output use strict JSON Schema; streaming reports output text as it arrives; the
  model's thoughts and thought signatures are kept for the next call and never released.
- Thinking tokens are charged as output, and cached input at the full input rate. Media is sent as bytes.
- `catalog` holds the Gemini API's list prices on its date, used only with `prices: 'catalog'`. Gemini 3.8 Flash is
  listed at the price announced from January 1, 2027, so a budget never undercounts.

See the [model registry guide](https://mayurajs.com/docs/guides/model-registry/). Apache-2.0.
