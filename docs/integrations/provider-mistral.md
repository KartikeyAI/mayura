---
title: "Mistral models"
description: "Call Mistral models through the Chat Completions API with @mayurajs/provider-mistral: model ids, catalog prices, EU endpoint, costs and errors."
package: "@mayurajs/provider-mistral"
vendor: "Mistral AI"
logo: "mistral"
website: "https://mistral.ai"
area: "providers"
---

[Mistral AI](https://mistral.ai) makes and serves the Mistral and Ministral models. `@mayurajs/provider-mistral` is a
provider package for the [model registry](../guides/model-registry.md): every Mistral model gets an id such as
`mistral/mistral-medium-3-5`, which you price, bound and grant like any other registry model. It calls Mistral's Chat
Completions API through the official `@mistralai/mistralai` SDK, pinned at 2.7.0, which is its only dependency
(`mayura` is a peer). The SDK's retries, debug logging and telemetry are turned off. The package itself uses no Node
built-in modules and sends every request through `fetch`; its `engines` field names Node.js 22 (22.12 or later) and 24
(24.14.1 or later), and its tests run on Node.

## Install

```bash
npm install mayura @mayurajs/provider-mistral
```

## Credentials

Create an API key in the [Mistral console](https://console.mistral.ai/api-keys). It is sent as
`Authorization: Bearer`. A free key may call only some models, with tight rate limits; `ministral-8b-2512` works with
one.

The package reads nothing from the environment: not `MISTRAL_API_KEY`, nor `MISTRAL_DEBUG`, which would make the SDK
log every request with its credentials, nor `MISTRAL_SDK_TELEMETRY` and `MISTRAL_OTLP_TRACES_ENDPOINT`, which would
make it export a trace of every call. Pass the key in yourself, for example from `MISTRAL_API_KEY`.

## Use it

```ts
import { createModels, createRuntime, defineAgent, z } from 'mayura';
import { mistral } from '@mayurajs/provider-mistral';

const models = createModels({
  providers: [mistral({ apiKey: process.env.MISTRAL_API_KEY ?? '' })],
  prices: 'catalog',         // Mistral's list prices on the catalog's date
  maxCallCostMicros: 75_000, // at most $0.075 per model call
});

const agent = defineAgent({
  id: 'support', version: '1', instructions: 'Answer the customer in one or two sentences.',
  model: models.model('mistral/mistral-medium-3-5', { retry: { attempts: 2 } }), tools: [],
  input: z.object({ question: z.string() }), output: z.object({ answer: z.string() }),
});

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: { allow: ['model:mistral/mistral-medium-3-5'] },
  limits: { maxCostMicros: 500_000 }, // at most $0.50 per run
});
try {
  const outcome = await runtime.submit(agent, { input: { question: 'Where is my order?' } }).result();
  console.log(outcome.status === 'succeeded' ? outcome.output.answer : outcome.error);
} finally {
  await runtime.close();
}
```

The adapter's id is the model id, so the run needs `model:mistral/mistral-medium-3-5`, and that grant admits no other
model. A run without it ends `blocked` with `PERMISSION_DENIED` before any request is sent. See
[Permissions](../concepts/permissions.md).

To keep requests in the EU, send them to Mistral's EU endpoint:

```ts
const provider = mistral({ apiKey: process.env.MISTRAL_API_KEY ?? '', baseURL: 'https://api.eu.mistral.ai' });
```

## Model ids

A model id is `mistral/<model>`, where `<model>` is Mistral's own model name (up to 128 characters), such as
`mistral/mistral-medium-3-5`. Any model name works once it has a price; the catalog prices the models below.

## Catalog prices

`prices: 'catalog'` uses Mistral's list prices as of **2026-09-29**, from Mistral's
[models page](https://docs.mistral.ai/getting-started/models/). In US dollars per million tokens; Mistral bills the
whole 256,000-token context window at these rates:

| Model | Input | Output | Context |
| --- | --- | --- | --- |
| `mistral-medium-3-5` | $1.50 | $7.50 | 256,000 |
| `mistral-large-2512` | $0.50 | $1.50 | 256,000 |
| `mistral-small-2603` | $0.15 | $0.60 | 256,000 |
| `ministral-8b-2512` | $0.15 | $0.15 | 256,000 |

Only dated model versions are listed. A `-latest` alias, such as `mistral-medium-latest`, moves to newer models whose
prices can differ, so it has no catalog price: give it yourself if you call one.

Prices change: `models.list()` shows each model's `catalogAsOf`, and the catalog is exported as `catalog`. A price you
give, in `prices` or as `pricing` on one model, always wins:

```ts
const models = createModels({
  providers: [mistral({ apiKey: process.env.MISTRAL_API_KEY ?? '' })],
  // An alias: check what it points to, and its price, on Mistral's models page.
  prices: { 'mistral/mistral-medium-latest': { inputMicrosPerMillionTokens: 1_500_000, outputMicrosPerMillionTokens: 7_500_000 } },
  maxCallCostMicros: 75_000,
});
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | required | Your Mistral API key, sent as `Authorization: Bearer`. |
| `baseURL` | `https://api.mistral.ai` | Where requests go instead: `https://api.eu.mistral.ai` to keep data in the EU, or a gateway. https only. Prompts, tool results and outputs go to this host. |
| `headers` | none | Up to 8 extra headers, such as a gateway's credential. Treated as credentials. They cannot replace `Authorization`, `Content-Type`, `Host` or cookies. |
| `media` | PNG, JPEG, WebP and GIF, as bytes or URLs | What the models can see, `{ types, urls }`; `false` for none. PDFs are not accepted. |
| `maxRequestBytes` | 1 MiB | Largest request body, not counting media (the run's `maxMediaBytes` bounds those). |
| `maxResponseBytes` | 1 MiB | Largest response body; four times that for a stream. A larger one fails without being read into memory. |
| `timeoutMs` | 60,000 | How long one call may take, unless the registry or the model sets `timeoutMs`. |
| `fetch` | `globalThis.fetch` | The transport, for tests and proxies. Redirects are never followed. |

The registry's `timeoutMs` (on `createModels` or on one model, 100 to 3,600,000 ms) wins over the provider's.

## What it sends and supports

- **Structured output.** Every call asks for the agent's output as strict JSON Schema (`response_format` of type
  `json_schema`, `strict: true`). Tools are sent as strict functions with an `auto` tool choice, and parallel tool
  calls are on. The schemas must follow the [strict rules](../guides/model-providers.md#json-schemas); `defineAgent`
  checks them when the agent is defined.
- **Streaming.** With a [stream policy](../guides/streaming.md) on the agent, output text is reported as Mistral
  writes it.
- **Thinking.** Thinking a model returns with a tool call, its signature included, is kept in the run's private state
  and sent back on the next call. It is never released as output or put in events. That state names the provider and
  model, so it never moves to another provider or model.
- **Tool call ids.** Mistral accepts only nine letters and digits as a call id. Ids from elsewhere in the
  conversation, for example from a run that failed over from another provider, are renamed for the request, the same
  way every time.
- **Narration.** Text a model writes before a tool call is not an answer and is dropped.
- **Images.** By default the models see PNG, JPEG, WebP and GIF images, inline as data URLs or as URLs Mistral fetches;
  a named image is introduced by a text chunk. PDFs are not sent. Set `media: false` for a model that cannot see, or
  `urls: false` to send bytes only. See [Vision](../guides/vision.md).
- **Output tokens.** `max_tokens` is the run's `limits.maxOutputTokens` (4,096 unless you set it).

## Costs

Each call's cost is Mistral's reported prompt and completion tokens at your prices, rounded up to a whole micro.

`maxCallCostMicros` (or a model's `maxCostMicros`) is reserved before every call, and a call that doesn't fit in the
run's budget never starts. Choose it to cover your largest prompt plus `maxOutputTokens`: on `mistral-medium-3-5`,
20,000 input tokens and 4,096 output tokens cost at most 30,000 + 30,720 = 60,720 micros, so 75,000 covers it. A call
whose cost is unknown, such as one that timed out after it was sent, is charged its full bound. See
[Costs and budgets](../concepts/costs-and-budgets.md).

## Retries and fallback

The SDK's own retries are off: one call is one HTTP request. Retries belong to the registry:

```ts
const model = models.model('mistral/mistral-medium-3-5', { retry: { attempts: 3, backoffMs: 1_000 } });
```

- `retry` calls the model again after `rate_limited`, `unavailable` or `timeout`; never after the caller cancels, a
  failure that would repeat, or once streamed text was released.
- `attempts` is 1 to 5, and the model's bound becomes `attempts` times its bound. Every attempt is charged.
- Waits double from `backoffMs` (default 500 ms).

To fall back to another model, use a chain. It is a [model router](../guides/model-routing.md) granted by the name you
choose, and granting it grants every model in it:

```ts
const support = models.chain('support', ['mistral/mistral-medium-3-5', 'mistral/mistral-small-2603']);
// Grant model:support.
```

## Errors

A failed call ends the run with `MODEL_FAILED` and a `reason` (see [Errors](../guides/model-providers.md#errors) for the
messages):

| `reason` | When |
| --- | --- |
| `authentication` | HTTP 401 or 403: a wrong key, or no access to the model. |
| `rate_limited` | HTTP 429, or 402 for quota. |
| `unavailable` | HTTP 408 or 5xx, no connection, or a response that finished with `error`. |
| `timeout` | No answer within `timeoutMs`. |
| `rejected` | Any other HTTP error, such as 404 for an unknown model or 400 for a request Mistral refuses. |
| `refused` | The answer stopped at the output-token limit or the model's context length. |
| `invalid_response` | An answer that is not the required JSON, a response without usage, or one larger than `maxResponseBytes`. |
| `configuration` | A schema that breaks the strict rules, or media of a type the provider does not send (code `INVALID_CONFIG`). |

Mistral's error text, your key and your headers never appear in outcomes or events. Options the package cannot use,
such as an empty key, an `http://` `baseURL`, a header that would replace `Authorization`, or `media` with a type other
than the four image types, throw `INVALID_CONFIG` when you call `mistral()`. So does a version of the SDK whose
telemetry the package cannot turn off: it refuses to start rather than run with it. A model name over 128 characters
throws `INVALID_CONFIG` when you call `models.model()`.

## How it is tested

- Unit tests run the package through the Mistral SDK against a fake Chat Completions API, given through `fetch`. It
  passes the [model adapter conformance suite](../guides/model-registry.md#writing-a-provider-package) from
  `mayura/testing`: response shapes, costs, tool calls, streaming, the reason for each failure, no leaked provider
  text, cancellation, timeouts and strict schemas.
- They also check that nothing comes from the environment, that no call reaches the SDK's telemetry even with a tracer
  registered, that `baseURL` and headers are honoured, that a call is one request, that thinking is sent back and never
  released, that foreign call ids are renamed consistently, streamed tool calls, images as data URLs or URLs, and the
  catalog through a registry run.
- `scripts/live/provider-mistral.mjs`, a structured answer and a tool call through a registry priced from the catalog,
  passed against Mistral on October 12, 2026 with `ministral-8b-2512`. The free key used got rate limits on other
  models.

## Related

- [Model registry](../guides/model-registry.md): ids, prices, the per-call bound, retries and chains.
- [Model routing](../guides/model-routing.md): failover, circuit breakers and accounting.
- [Amazon Bedrock](provider-bedrock.md): Mistral models through your AWS account.
- [Costs and budgets](../concepts/costs-and-budgets.md): how a call's cost is reserved and charged.

### RAG embeddings

This provider exports `mistralEmbeddings` for scoped RAG ingestion and retrieval. See [the RAG guide](../guides/rag.md) for explicit permissions, cost ceilings and sensitivity profiles. Offline embedding tests passed locally with fake transports. Live embedding service behavior remains unqualified; see [release validation status](../guides/release-readiness.md).
