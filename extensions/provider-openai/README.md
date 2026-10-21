# @mayurajs/provider-openai

OpenAI models for [Mayura](https://mayurajs.com), through the official `openai` SDK and the Responses API.

```bash
npm install mayura @mayurajs/provider-openai
```

```ts
import { createModels, defineAgent, z } from 'mayura';
import { openai } from '@mayurajs/provider-openai';

const models = createModels({
  providers: [openai({ apiKey: process.env.OPENAI_API_KEY! })],
  prices: { 'openai/gpt-5.1': { inputMicrosPerMillionTokens: 1_250_000, outputMicrosPerMillionTokens: 10_000_000 } },
  maxCallCostMicros: 50_000,
});

const agent = defineAgent({
  id: 'helper', version: '1', instructions: 'Answer in one sentence.', model: models.model('openai/gpt-5.1'), tools: [],
  input: z.object({ question: z.string() }), output: z.object({ answer: z.string() }),
});
// Grant it as model:openai/gpt-5.1.
```

- Credentials are options: nothing is read from the environment.
- The SDK's own retries are off; the registry's `retry` option retries and charges every attempt.
- Tool inputs and structured output use strict JSON Schema, and streaming reports output text as it arrives.
- Runs can take a conversation history (`runtime.submit(agent, { input, history })`), sent before the run's own messages on every call.
- `catalog` holds OpenAI's list prices on its date, used only with `prices: 'catalog'`.

See the [model registry guide](https://mayurajs.com/docs/guides/model-registry/). Apache-2.0.

The optional gateway packages share `gatewayProvider`, `gatewayCredential`, `GatewayOptions`, `GatewayBinding` and `GatewayProvider` from this extension. See [AI gateways](../../docs/guides/ai-gateways.md) for host prices, explicit discovery permissions and deferred qualification.

### RAG embeddings

This provider exports `openAIEmbeddings` for scoped RAG ingestion and retrieval. See [the RAG guide](../../docs/guides/rag.md) for explicit permissions, cost ceilings and sensitivity profiles. Development cases are authored; validation is deferred.
