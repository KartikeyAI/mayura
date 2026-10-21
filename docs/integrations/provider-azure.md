---
title: "Azure OpenAI models"
description: "Call your Azure OpenAI deployments through Azure's v1 API with @mayurajs/provider-azure: deployment ids, Global prices, Entra ID tokens and errors."
package: "@mayurajs/provider-azure"
vendor: "Microsoft Azure"
logo: "azure"
website: "https://azure.microsoft.com"
area: "providers"
---

[Azure OpenAI](https://azure.microsoft.com) serves OpenAI's models from an Azure resource you own, as deployments you
name. `@mayurajs/provider-azure` is a provider package for the [model registry](../guides/model-registry.md): every
deployment gets an id such as `azure/prod-chat`, which you price, bound and grant like any other registry model. It
calls Azure's v1 API (the Responses API) through the official `openai` SDK, by way of `responsesProvider` from
[`@mayurajs/provider-openai`](provider-openai.md), its only dependency (`mayura` is a peer). Everything that package
promises holds here: strict schemas, streaming, bounded responses, no SDK retries and nothing read from the
environment. The package uses no Node built-in modules and sends every request through `fetch`; its `engines` field
names Node.js 22 (22.12 or later) and 24 (24.14.1 or later), and its tests run on Node.

## Install

```bash
npm install mayura @mayurajs/provider-azure
```

## Credentials

Give the package one of:

- **The resource's API key**, from your Azure OpenAI resource's **Keys and Endpoint** page in the
  [Azure portal](https://portal.azure.com), or from [Azure AI Foundry](https://ai.azure.com).
- **A Microsoft Entra ID token source**: a function that returns an access token for Azure OpenAI (scope
  `https://cognitiveservices.azure.com/.default`). It is called before every request, so tokens stay fresh. The
  identity needs a role that may call the resource's models, such as **Cognitive Services OpenAI User**.

Either one is sent as `Authorization: Bearer`. The package reads nothing from the environment: not
`AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT` or `OPENAI_BASE_URL`. Pass the resource, key and deployment in
yourself, for example from `AZURE_OPENAI_RESOURCE`, `AZURE_OPENAI_API_KEY` and `AZURE_OPENAI_DEPLOYMENT`.

## Use it

```ts
import { createModels, createRuntime, defineAgent, z } from 'mayura';
import { azure } from '@mayurajs/provider-azure';

const models = createModels({
  providers: [azure({
    resource: 'contoso', // https://contoso.openai.azure.com/openai/v1
    apiKey: process.env.AZURE_OPENAI_API_KEY ?? '',
    deployments: { 'prod-chat': { model: 'gpt-5.5', type: 'global' } },
  })],
  prices: 'catalog',          // Azure's Global list prices for the model each deployment runs
  maxCallCostMicros: 200_000, // at most $0.20 per model call
});

const agent = defineAgent({
  id: 'support', version: '1', instructions: 'Answer the customer in one or two sentences.',
  model: models.model('azure/prod-chat', { retry: { attempts: 2 } }), tools: [],
  input: z.object({ question: z.string() }), output: z.object({ answer: z.string() }),
});

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: { allow: ['model:azure/prod-chat'] },
  limits: { maxCostMicros: 1_000_000 }, // at most $1 per run
});
try {
  const outcome = await runtime.submit(agent, { input: { question: 'Where is my order?' } }).result();
  console.log(outcome.status === 'succeeded' ? outcome.output.answer : outcome.error);
} finally {
  await runtime.close();
}
```

The adapter's id is the model id, so the run needs `model:azure/prod-chat`, and that grant admits no other deployment.
A run without it ends `blocked` with `PERMISSION_DENIED` before any request is sent. See
[Permissions](../concepts/permissions.md).

With Microsoft Entra ID instead of a key, pass `token`, for example from `@azure/identity`:

```ts
const provider = azure({
  baseURL: 'https://contoso.cognitiveservices.azure.com/openai/v1',
  token: () => getEntraToken('https://cognitiveservices.azure.com/.default'),
});
```

## Model ids

A model id is `azure/<deployment>`: the deployment's name in your resource, not the model's. The name is sent as the
request's `model`. Names in `deployments` must be up to 64 letters, digits, `.`, `_` or `-`, starting with a letter or
digit.

## Catalog prices

Catalog prices reach a deployment only through `deployments`, which says which model each deployment runs. Only
**Global** deployments have catalog prices: Data Zone and Regional deployments cost more, so give their prices yourself.
A deployment not listed in `deployments` has no catalog price.

The catalog holds Azure OpenAI's Global list prices as of **2026-09-29**, from Azure's
[pricing page](https://azure.microsoft.com/pricing/details/cognitive-services/openai-service/), by model. In US dollars
per million tokens:

| Model | Input | Output | Input over 272K | Output over 272K |
| --- | --- | --- | --- | --- |
| `gpt-6-astra` | $10 | $50 | $20 | $75 |
| `gpt-5.5` | $5 | $30 | $10 | $45 |
| `gpt-5.4` | $2.50 | $15 | $5 | $22.50 |
| `gpt-5.4-mini` | $0.75 | $4.50 | $1.50 | $6.75 |
| `gpt-5-mini` | $0.25 | $2 | $0.50 | $3 |
| `gpt-4.1` | $2 | $8 | $4 | $12 |

The catalog errs towards charging more, so a budget never undercounts:

- A prompt over 272K input tokens is charged the long-context rates (twice the input rate, one and a half times the
  output rate) for the whole call, on every model, as Azure applies OpenAI's rule.
- Cached input is charged at the full input rate.
- Models whose Azure prices were not yet published on that date (GPT-6 Sol and Luna) are left out.

Prices change: `models.list()` shows each deployment's `catalogAsOf`, and the catalog is exported as `catalog`. A
price you give, in `prices` or as `pricing` on one model, always wins, and is the only way to price a Data Zone or
Regional deployment:

```ts
const models = createModels({
  providers: [azure({ resource: 'contoso', apiKey: process.env.AZURE_OPENAI_API_KEY ?? '' })],
  // A Data Zone deployment: use the prices Azure lists for its deployment type and region.
  prices: { 'azure/eu-chat': { inputMicrosPerMillionTokens: 5_500_000, outputMicrosPerMillionTokens: 33_000_000 } },
  maxCallCostMicros: 200_000,
});
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `resource` | none | Your Azure OpenAI resource name; requests go to `https://<resource>.openai.azure.com/openai/v1`. Give this or `baseURL`. |
| `baseURL` | none | The v1 API's base URL instead, such as a custom domain or a gateway (https only). Give this or `resource`. |
| `apiKey` | none | The resource's API key. Give this or `token`. |
| `token` | none | A Microsoft Entra ID token source, `() => Promise<string>`, called for every request. Give this or `apiKey`. |
| `deployments` | none | Your Global deployments by name, `{ model, type: 'global' }`, for catalog prices. |
| `headers` | none | Up to 8 extra headers, such as a gateway's credential. Treated as credentials. They cannot replace `Authorization`, `api-key`, `OpenAI-Organization`, `OpenAI-Project`, `Content-Type`, `Host` or cookies. |
| `media` | every Mayura media type, and URLs | What the models can see, `{ types, urls }`; `false` for none. |
| `maxRequestBytes` | 1 MiB | Largest request body, not counting media (the run's `maxMediaBytes` bounds those). |
| `maxResponseBytes` | 1 MiB | Largest response body; four times that for a stream. A larger one fails without being read into memory. |
| `timeoutMs` | 60,000 | How long one call may take, unless the registry or the model sets `timeoutMs`. |
| `fetch` | `globalThis.fetch` | The transport, for tests and proxies. Redirects are never followed. |

The registry's `timeoutMs` (on `createModels` or on one model, 100 to 3,600,000 ms) wins over the provider's.

## What it sends and supports

Requests are OpenAI Responses requests, as [`@mayurajs/provider-openai`](provider-openai.md) sends them:

- **Structured output.** The agent's output as strict JSON Schema, tools as strict functions, parallel tool calls on.
  The schemas must follow the [strict rules](../guides/model-providers.md#json-schemas).
- **Streaming.** With a [stream policy](../guides/streaming.md) on the agent, output text is reported as it arrives.
- **Reasoning.** `store: false`; encrypted reasoning items are kept in the run's private state between calls of one
  run and never released. That state names the provider, so a run never continues on Azure with state from OpenAI, or
  the other way round.
- **Images and PDFs.** By default every Mayura media type, as bytes or URLs; `media: false` for none. See
  [Vision](../guides/vision.md).
- **Output tokens.** `max_output_tokens` is the run's `limits.maxOutputTokens` (4,096 unless you set it).

## Costs

Each call's cost is Azure's reported `input_tokens` and `output_tokens` at your prices, rounded up to a whole micro;
the long-context rates apply to the whole call once its input is over the threshold.

`maxCallCostMicros` (or a model's `maxCostMicros`) is reserved before every call, and a call that doesn't fit in the
run's budget never starts. Choose it to cover your largest prompt plus `maxOutputTokens`: on a `gpt-5.5` deployment,
20,000 input tokens and 4,096 output tokens cost at most 100,000 + 122,880 = 222,880 micros, so lower `maxOutputTokens`
or raise the bound for prompts that large. A call whose cost is unknown, such as one that timed out after it was sent,
is charged its full bound. See [Costs and budgets](../concepts/costs-and-budgets.md).

## Retries and fallback

The SDK's own retries are off: one call is one HTTP request. Retries belong to the registry:

```ts
const model = models.model('azure/prod-chat', { retry: { attempts: 3, backoffMs: 500 } });
```

- `retry` calls the model again after `rate_limited`, `unavailable` or `timeout`; never after the caller cancels, a
  failure that would repeat, or once streamed text was released.
- `attempts` is 1 to 5, and the model's bound becomes `attempts` times its bound. Every attempt is charged.
- Waits double from `backoffMs` (default 500 ms).

To fall back to another deployment, or to OpenAI itself during an outage, use a chain. It is a
[model router](../guides/model-routing.md) granted by the name you choose, and granting it grants every model in it:

```ts
import { createModels } from 'mayura';
import { azure } from '@mayurajs/provider-azure';
import { openai } from '@mayurajs/provider-openai';

const models = createModels({
  providers: [
    azure({ resource: 'contoso', apiKey: process.env.AZURE_OPENAI_API_KEY ?? '', deployments: { 'prod-chat': { model: 'gpt-5.5', type: 'global' } } }),
    openai({ apiKey: process.env.OPENAI_API_KEY ?? '' }),
  ],
  prices: 'catalog',
  maxCallCostMicros: 200_000,
});
const support = models.chain('support', ['azure/prod-chat', 'openai/gpt-5.5']);
// Grant model:support. Each call reserves both bounds: 400,000 micros.
```

## Errors

A failed call ends the run with `MODEL_FAILED` and a `reason` (see [Errors](../guides/model-providers.md#errors) for the
messages):

| `reason` | When |
| --- | --- |
| `authentication` | HTTP 401 or 403: a wrong key or token, or no access to the deployment; or the token source threw. |
| `rate_limited` | HTTP 429, or 402 for quota. |
| `unavailable` | HTTP 408 or 5xx, no connection, or a stream that reported a failure. |
| `timeout` | No answer within `timeoutMs`. |
| `rejected` | Any other HTTP error, such as 404 for an unknown deployment or 400 for a request Azure refuses. |
| `refused` | The model refused, or the response was incomplete, for example at the output-token limit. |
| `invalid_response` | An answer that is not the required JSON, a response without usage, one larger than `maxResponseBytes`, or a run's state from another provider. |
| `configuration` | A schema that breaks the strict rules, or a token source that returned something other than a single-line string (code `INVALID_CONFIG`). |

Azure's error text, the token source's error, your key and your headers never appear in outcomes or events. Options
the package cannot use throw `INVALID_CONFIG` when you call `azure()`: both or neither of `resource` and `baseURL`, both
or neither of `apiKey` and `token`, a resource name with characters other than letters, digits and `-`, an `http://`
`baseURL`, a header that would replace `api-key`, and a deployment that is not `type: 'global'`, runs a model the
catalog does not have, or has a malformed name.

## How it is tested

- Unit tests run the package through the OpenAI SDK against a fake Azure v1 API, given through `fetch`. It passes the
  [model adapter conformance suite](../guides/model-registry.md#writing-a-provider-package) from `mayura/testing`:
  response shapes, costs, tool calls, streaming, the reason for each failure, no leaked provider text, cancellation,
  timeouts and strict schemas.
- They also check that requests go to the resource's v1 API by deployment name with nothing from the environment, that
  a token source is asked for a fresh token on every request and its failures are reported without their text, that
  only listed Global deployments get catalog prices, and that a run OpenAI started is never continued on Azure.
- It has not been run against a real Azure account yet.

## Related

- [Model registry](../guides/model-registry.md): ids, prices, the per-call bound, retries and chains.
- [OpenAI](provider-openai.md): the same models from OpenAI, and `responsesProvider`.
- [Model routing](../guides/model-routing.md): failover, circuit breakers and accounting.
- [Costs and budgets](../concepts/costs-and-budgets.md): how a call's cost is reserved and charged.

### RAG embeddings

This provider exports `azureEmbeddings` for scoped RAG ingestion and retrieval. See [the RAG guide](../guides/rag.md) for explicit permissions, cost ceilings and sensitivity profiles. Offline embedding tests passed locally with fake transports. Live embedding service behavior remains unqualified; see [release validation status](../guides/release-readiness.md).
