# @mayurajs/provider-groq

Groq models for [Mayura](https://mayurajs.com), through the official `groq-sdk` and Groq's Chat Completions API.

```bash
npm install mayura @mayurajs/provider-groq
```

```ts
import { createModels, defineAgent, z } from 'mayura';
import { groq } from '@mayurajs/provider-groq';

const models = createModels({
  providers: [groq({ apiKey: process.env.GROQ_API_KEY! })],
  prices: { 'groq/openai/gpt-oss-120b': { inputMicrosPerMillionTokens: 150_000, outputMicrosPerMillionTokens: 600_000 } },
  maxCallCostMicros: 20_000,
});

const agent = defineAgent({
  id: 'helper', version: '1', instructions: 'Answer in one sentence.', model: models.model('groq/openai/gpt-oss-120b'), tools: [],
  input: z.object({ question: z.string() }), output: z.object({ answer: z.string() }),
});
// Grant it as model:groq/openai/gpt-oss-120b.
```

- Credentials are options: nothing is read from the environment, including the SDK's `GROQ_CUSTOM_HEADERS`.
- The SDK's own retries and logging are off; the registry's `retry` option retries and charges every attempt.
- Tool inputs and structured output use strict JSON Schema, so choose a model with strict structured outputs. Groq takes no response format beside tools, so with tools the answer comes from one more call once the model calls no more tools (both calls are charged); streaming reports output text as it arrives; the model's reasoning is kept for the next call and never released.
- Models see no media unless you say so: pass `media: { types: ['image/png', 'image/jpeg'], urls: true }` for a vision model.
- `catalog` holds Groq's on-demand list prices on its date, used only with `prices: 'catalog'`.

See the [model registry guide](https://mayurajs.com/docs/guides/model-registry/). Apache-2.0.
