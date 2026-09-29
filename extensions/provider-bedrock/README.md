# @mayurajs/provider-bedrock

Amazon Bedrock models for [Mayura](https://mayurajs.com), through the official AWS SDK and the Converse API: Claude,
Nova, Llama, Mistral and the other models Bedrock serves, by model id or inference profile id.

```bash
npm install mayura @mayurajs/provider-bedrock
```

```ts
import { createModels, defineAgent, z } from 'mayura';
import { bedrock } from '@mayurajs/provider-bedrock';

const models = createModels({
  providers: [bedrock({ region: 'us-east-1', credentials: { accessKeyId: process.env.AWS_ACCESS_KEY_ID!, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY! } })],
  prices: 'catalog',
  maxCallCostMicros: 50_000,
});

const agent = defineAgent({
  id: 'helper', version: '1', instructions: 'Answer in one sentence.', model: models.model('bedrock/global.anthropic.claude-sonnet-5-5'), tools: [],
  input: z.object({ question: z.string() }), output: z.object({ answer: z.string() }),
});
// Grant it as model:bedrock/global.anthropic.claude-sonnet-5-5.
```

- The region and credentials are options: AWS credentials (or a function returning fresh ones), or a Bedrock API key.
  Nothing is read from the environment, AWS config files or instance metadata.
- One attempt per call: the SDK's retries are off, and the registry's `retry` option retries and charges every attempt.
- Requests go through `fetch`, with bounded response sizes.
- Tool inputs and structured output use strict JSON Schema; streaming reports output text as it arrives; reasoning
  is kept for the next call and never released.
- Cache writes are charged at twice the input rate and cache reads at the full rate, so a budget never undercounts.
- `catalog` holds on-demand list prices in us-east-1 on its date, offered only by a provider in us-east-1 and used
  only with `prices: 'catalog'`.

See the [model registry guide](https://mayurajs.com/docs/guides/model-registry/). Apache-2.0.
