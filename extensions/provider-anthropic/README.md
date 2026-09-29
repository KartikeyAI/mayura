# @mayurajs/provider-anthropic

Anthropic Claude models for [Mayura](https://mayurajs.com), through the official `@anthropic-ai/sdk` and the Messages API.

```bash
npm install mayura @mayurajs/provider-anthropic
```

```ts
import { createModels, defineAgent, z } from 'mayura';
import { anthropic } from '@mayurajs/provider-anthropic';

const models = createModels({
  providers: [anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })],
  prices: { 'anthropic/claude-sonnet-5-5': { inputMicrosPerMillionTokens: 2_000_000, outputMicrosPerMillionTokens: 10_000_000 } },
  maxCallCostMicros: 50_000,
});

const agent = defineAgent({
  id: 'helper', version: '1', instructions: 'Answer in one sentence.', model: models.model('anthropic/claude-sonnet-5-5'), tools: [],
  input: z.object({ question: z.string() }), output: z.object({ answer: z.string() }),
});
// Grant it as model:anthropic/claude-sonnet-5-5.
```

- Credentials are options: nothing is read from the environment.
- The SDK's own retries are off; the registry's `retry` option retries and charges every attempt.
- Tool inputs and structured output use strict JSON Schema; streaming reports output text as it arrives; the model's thinking is kept for the next call and never released.
- Prompt-cache writes are charged at twice the input rate and reads at the full rate, so a budget never undercounts.
- `catalog` holds Anthropic's list prices on its date, used only with `prices: 'catalog'`.

See the [model registry guide](https://mayurajs.com/docs/guides/model-registry/). Apache-2.0.
