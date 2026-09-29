# @mayurajs/provider-mistral

Mistral models for [Mayura](https://mayurajs.com), through the official `@mistralai/mistralai` SDK and the Chat Completions API.

```bash
npm install mayura @mayurajs/provider-mistral
```

```ts
import { createModels, defineAgent, z } from 'mayura';
import { mistral } from '@mayurajs/provider-mistral';

const models = createModels({
  providers: [mistral({ apiKey: process.env.MISTRAL_API_KEY! })],
  prices: { 'mistral/mistral-medium-3-5': { inputMicrosPerMillionTokens: 1_500_000, outputMicrosPerMillionTokens: 7_500_000 } },
  maxCallCostMicros: 50_000,
});

const agent = defineAgent({
  id: 'helper', version: '1', instructions: 'Answer in one sentence.', model: models.model('mistral/mistral-medium-3-5'), tools: [],
  input: z.object({ question: z.string() }), output: z.object({ answer: z.string() }),
});
// Grant it as model:mistral/mistral-medium-3-5.
```

- Credentials are options: nothing is read from the environment. Set `baseURL: 'https://api.eu.mistral.ai'` to keep requests in the EU.
- The SDK's own retries, debug logging and telemetry are off; the registry's `retry` option retries and charges every attempt.
- Tool inputs and structured output use strict JSON Schema; streaming reports output text as it arrives; the model's thinking is kept for the next call and never released.
- Models see PNG, JPEG, WebP and GIF images, as bytes or URLs.
- `catalog` holds Mistral's list prices on its date for dated model versions, used only with `prices: 'catalog'`. A `-latest` alias moves to newer models, so give its price yourself.

See the [model registry guide](https://mayurajs.com/docs/guides/model-registry/). Apache-2.0.
