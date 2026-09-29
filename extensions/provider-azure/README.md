# @mayurajs/provider-azure

Azure OpenAI models for [Mayura](https://mayurajs.com), through the official OpenAI SDK and Azure's v1 API, with an API
key or a Microsoft Entra ID token.

```bash
npm install mayura @mayurajs/provider-azure
```

```ts
import { createModels, defineAgent, z } from 'mayura';
import { azure } from '@mayurajs/provider-azure';

const models = createModels({
  providers: [azure({
    resource: 'contoso', apiKey: process.env.AZURE_OPENAI_API_KEY!,
    deployments: { 'prod-chat': { model: 'gpt-5.5', type: 'global' } },
  })],
  prices: 'catalog',
  maxCallCostMicros: 50_000,
});

const agent = defineAgent({
  id: 'helper', version: '1', instructions: 'Answer in one sentence.', model: models.model('azure/prod-chat'), tools: [],
  input: z.object({ question: z.string() }), output: z.object({ answer: z.string() }),
});
// Grant it as model:azure/prod-chat.
```

- Models are called by deployment name. Catalog prices apply only to the Global deployments listed in `deployments`;
  give your own prices for Data Zone and Regional deployments, which cost more.
- `token` takes a Microsoft Entra ID token source, called for every request, instead of `apiKey`.
- Built on `responsesProvider` from `@mayurajs/provider-openai`: nothing is read from the environment, the SDK's
  retries are off, responses are bounded, and schemas are strict.

See the [model registry guide](https://mayurajs.com/docs/guides/model-registry/). Apache-2.0.
