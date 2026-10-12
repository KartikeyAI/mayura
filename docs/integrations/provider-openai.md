---
title: "OpenAI models"
description: "Call OpenAI's GPT models through the Responses API with @mayurajs/provider-openai: model ids, catalog prices, options, costs and errors."
package: "@mayurajs/provider-openai"
vendor: "OpenAI"
logo: "openai"
website: "https://openai.com"
area: "providers"
---

[OpenAI](https://openai.com) serves the GPT models. `@mayurajs/provider-openai` is a provider package for the
[model registry](../guides/model-registry.md): every OpenAI model gets an id such as `openai/gpt-6-sol`, which you
price, bound and grant like any other registry model. It calls OpenAI's Responses API through the official `openai`
SDK, pinned at 7.23.0, which is its only dependency (`mayura` is a peer). The package itself uses no Node built-in
modules and sends every request through `fetch`; its `engines` field names Node.js 22 (22.12 or later) and 24 (24.14.1
or later), and its tests run on Node.

The package also exports `responsesProvider`, for any other API that speaks the Responses API (see
[Other Responses APIs](#other-responses-apis)). Mayura 1.0's own adapter, `openAIResponses` from
`mayura/provider-openai`, keeps working; see [Model providers](../guides/model-providers.md).

## Install

```bash
npm install mayura @mayurajs/provider-openai
```

## Credentials

Create a secret key on OpenAI's [API keys page](https://platform.openai.com/api-keys). The package only calls
`POST /v1/responses`, so a restricted key needs access to the Responses endpoint and nothing else. Pass `organization`
and `project` only if your key needs them; they are sent as the `OpenAI-Organization` and `OpenAI-Project` headers.

The package reads nothing from the environment: not `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`,
`OPENAI_PROJECT_ID`, nor `OPENAI_LOG`, which would make the SDK log every request. Pass the key in yourself, for
example from `OPENAI_API_KEY`.

## Use it

```ts
import { createModels, createRuntime, defineAgent, z } from 'mayura';
import { openai } from '@mayurajs/provider-openai';

const models = createModels({
  providers: [openai({ apiKey: process.env.OPENAI_API_KEY ?? '' })],
  prices: 'catalog',          // OpenAI's list prices on the catalog's date
  maxCallCostMicros: 100_000, // at most $0.10 per model call
});

const agent = defineAgent({
  id: 'support', version: '1', instructions: 'Answer the customer in one or two sentences.',
  model: models.model('openai/gpt-6-sol', { retry: { attempts: 2 } }), tools: [],
  input: z.object({ question: z.string() }), output: z.object({ answer: z.string() }),
});

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: { allow: ['model:openai/gpt-6-sol'] },
  limits: { maxCostMicros: 500_000 }, // at most $0.50 per run
});
try {
  const outcome = await runtime.submit(agent, { input: { question: 'Where is my order?' } }).result();
  console.log(outcome.status === 'succeeded' ? outcome.output.answer : outcome.error);
} finally {
  await runtime.close();
}
```

The adapter's id is the model id, so the run needs `model:openai/gpt-6-sol`, and that grant admits no other model. A
run without it ends `blocked` with `PERMISSION_DENIED` before any request is sent. See
[Permissions](../concepts/permissions.md).

## Model ids

A model id is `openai/<model>`, where `<model>` is OpenAI's own model name (up to 128 characters), such as
`openai/gpt-6-sol`. Any model name works once it has a price; the catalog prices the models below.

## Catalog prices

`prices: 'catalog'` uses OpenAI's standard list prices as of **2026-09-29**, from OpenAI's
[pricing page](https://developers.openai.com/api/docs/pricing). In US dollars per million tokens:

| Model | Input | Output | Input over 272K | Output over 272K | Context | Max output |
| --- | --- | --- | --- | --- | --- | --- |
| `gpt-6-astra` | $10 | $50 | $20 | $75 | 1,050,000 | 128,000 |
| `gpt-6-sol` | $2 | $10 | $4 | $15 | 1,050,000 | 128,000 |
| `gpt-6-luna` | $0.10 | $0.50 | $0.20 | $0.75 | 1,050,000 | 128,000 |
| `gpt-5.5` | $5 | $30 | $10 | $45 | 1,050,000 | 128,000 |
| `gpt-5-mini` | $0.25 | $2 | $0.50 | $3 | 400,000 | 128,000 |
| `gpt-5-nano` | $0.05 | $0.40 | $0.10 | $0.60 | | |
| `gpt-4.1` | $2 | $8 | $4 | $12 | | |

The catalog errs towards charging more, so a budget never undercounts:

- A prompt over 272K input tokens is charged the long-context rates (twice the input rate, one and a half times the
  output rate) for the whole call, on every model here, including ones where OpenAI's pages don't say the rule applies.
- Cached input is charged at the full input rate.
- Promotional prices are left out, because they rise when the promotion ends.

Prices change: `models.list()` shows each model's `catalogAsOf`, and the catalog is exported as `catalog`. A price you
give, in `prices` or as `pricing` on one model, always wins. Give your own when the numbers matter, such as a
negotiated discount:

```ts
const models = createModels({
  providers: [openai({ apiKey: process.env.OPENAI_API_KEY ?? '' })],
  maxCallCostMicros: 100_000,
  prices: {
    'openai/gpt-6-sol': {
      inputMicrosPerMillionTokens: 1_800_000, outputMicrosPerMillionTokens: 9_000_000,
      longContext: { aboveInputTokens: 272_000, inputMicrosPerMillionTokens: 3_600_000, outputMicrosPerMillionTokens: 13_500_000 },
    },
  },
});
```

See [Long prompts](../guides/model-registry.md#long-prompts) for the long-context rule.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | required | Your OpenAI secret key, sent as `Authorization: Bearer`. |
| `baseURL` | `https://api.openai.com/v1` | Where requests go instead, such as a gateway: an https URL, the part before `/responses`. Prompts, tool results and outputs go to this host. |
| `organization` | none | Sent as `OpenAI-Organization`. |
| `project` | none | Sent as `OpenAI-Project`. |
| `headers` | none | Up to 8 extra headers, such as a gateway's credential. Treated as credentials. They cannot replace `Authorization`, `OpenAI-Organization`, `OpenAI-Project`, `api-key`, `Content-Type`, `Host` or cookies. |
| `media` | every Mayura media type, and URLs | What the models can see, `{ types, urls }`; `false` for none. |
| `maxRequestBytes` | 1 MiB | Largest request body, not counting media (the run's `maxMediaBytes` bounds those). |
| `maxResponseBytes` | 1 MiB | Largest response body; four times that for a stream. A larger one fails without being read into memory. |
| `timeoutMs` | 60,000 | How long one call may take, unless the registry or the model sets `timeoutMs`. |
| `fetch` | `globalThis.fetch` | The transport, for tests and proxies. Redirects are never followed. |

The registry's `timeoutMs` (on `createModels` or on one model, 100 to 3,600,000 ms) wins over the provider's.

## What it sends and supports

- **Structured output.** Every call asks for the agent's output as strict JSON Schema (`text.format` of type
  `json_schema`, `strict: true`). Tools are sent as strict functions, and parallel tool calls are on. The schemas must
  follow the [strict rules](../guides/model-providers.md#json-schemas); `defineAgent` checks them when the agent is
  defined.
- **Streaming.** With a [stream policy](../guides/streaming.md) on the agent, output text is reported as OpenAI writes
  it.
- **Reasoning.** Requests set `store: false` and ask for encrypted reasoning. A response's output items, reasoning
  included, are kept in the run's private state and sent back on the next call of the same run, so reasoning models
  keep their reasoning across tool calls. Reasoning is never released as output or put in events. The package sets no
  reasoning effort, so each model's default applies. That state names the provider and model, so it never moves to
  another provider or model.
- **Images and PDFs.** By default the models see every Mayura media type (PNG, JPEG, WebP, GIF and PDF), as bytes or
  URLs. Images are sent as `input_image` with `detail: 'auto'`, PDFs as `input_file`. Media a tool returns follows the
  tool results in one user message. Set `media: false` for a model that cannot see, or list fewer types. See
  [Vision](../guides/vision.md).
- **Output tokens.** `max_output_tokens` is the run's `limits.maxOutputTokens` (4,096 unless you set it).

## Costs

Each call's cost is OpenAI's reported `input_tokens` and `output_tokens` at your prices, rounded up to a whole micro;
the long-context rates apply to the whole call once its input is over the threshold. OpenAI counts reasoning tokens in
`output_tokens`, so they are charged as output.

`maxCallCostMicros` (or a model's `maxCostMicros`) is reserved before every call, and a call that doesn't fit in the
run's budget never starts. Choose it to cover your largest prompt plus `maxOutputTokens`: on `gpt-6-sol`, 20,000 input
tokens and 4,096 output tokens cost at most 40,000 + 40,960 = 80,960 micros, so 100,000 covers it. A call whose cost
is unknown, such as one that timed out after it was sent, is charged its full bound. See
[Costs and budgets](../concepts/costs-and-budgets.md).

## Retries and fallback

The SDK's own retries are off: one call is one HTTP request. Retries belong to the registry:

```ts
const model = models.model('openai/gpt-6-sol', { retry: { attempts: 3, backoffMs: 500 } });
```

- `retry` calls the model again after `rate_limited`, `unavailable` or `timeout`; never after the caller cancels, a
  failure that would repeat, or once streamed text was released.
- `attempts` is 1 to 5, and the model's bound becomes `attempts` times its bound. Every attempt is charged.
- Waits double from `backoffMs` (default 500 ms).

To fall back to another model, use a chain. It is a [model router](../guides/model-routing.md) granted by the name you
choose, and granting it grants every model in it:

```ts
const support = models.chain('support', ['openai/gpt-6-sol', 'openai/gpt-6-luna'], {
  models: { 'openai/gpt-6-sol': { retry: { attempts: 2 } } },
});
// Grant model:support.
```

A run that started on one route stays there while that route holds its reasoning state; if the route fails, the call
moves on with Mayura's own message history only.

## Through a gateway

`baseURL` and `headers` send the same Responses requests through a gateway or proxy, such as Cloudflare AI Gateway's
OpenAI endpoint. A gateway is where your prompts and outputs go: choose it as deliberately as the provider.

```ts
const viaGateway = openai({
  apiKey: process.env.OPENAI_API_KEY ?? '',
  baseURL: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/openai`,
  headers: { 'cf-aig-authorization': `Bearer ${process.env.CF_AIG_TOKEN}` },
});
```

Model ids and grants stay the same (`model:openai/gpt-6-sol`).

## Other Responses APIs

`responsesProvider` builds a provider for any API that speaks OpenAI's Responses API, with everything `openai()`
promises: strict schemas, streaming, bounded responses, no SDK retries, nothing read from the environment.
[`@mayurajs/provider-azure`](provider-azure.md) is built on it.

```ts
import { createModels } from 'mayura';
import { responsesProvider } from '@mayurajs/provider-openai';

const inHouse = responsesProvider({
  id: 'inhouse',                                  // model ids are inhouse/<model>
  baseURL: 'https://llm.internal.example.com/v1', // the part before /responses
  apiKey: () => getAccessToken(),                 // called before every request
});

const models = createModels({
  providers: [inHouse],
  prices: { 'inhouse/chat-large': { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 4_000_000 } },
  maxCallCostMicros: 50_000,
});
```

It takes every option above except `apiKey` and `baseURL`, plus:

| Option | Default | Meaning |
| --- | --- | --- |
| `id` | required | The provider id, the first part of every model id: lowercase letters, digits and `-`, up to 40 characters. |
| `baseURL` | required | The API's base URL, https, the part before `/responses`. |
| `apiKey` | required | A key, or a function that returns a fresh token for each request; sent as a bearer token. |
| `catalog` | none | The provider's dated prices, used only with `prices: 'catalog'`. |

A token function that throws fails the call with `authentication`, without its error text; one that returns something
other than a single-line string fails it with `configuration`.

## Errors

A failed call ends the run with `MODEL_FAILED` and a `reason` (see [Errors](../guides/model-providers.md#errors) for the
messages):

| `reason` | When |
| --- | --- |
| `authentication` | HTTP 401 or 403: a wrong key, or no access to the model. |
| `rate_limited` | HTTP 429, or 402 for quota. |
| `unavailable` | HTTP 408 or 5xx, no connection, or a stream that reported a failure. |
| `timeout` | No answer within `timeoutMs`. |
| `rejected` | Any other HTTP error, such as 404 for an unknown model or 400 for a request OpenAI refuses. |
| `refused` | The model refused, or the response was incomplete, for example at the output-token limit. |
| `invalid_response` | An answer that is not the required JSON, a response without usage, or one larger than `maxResponseBytes`. |
| `configuration` | A schema that breaks the strict rules (code `INVALID_CONFIG`). |

OpenAI's error text, your key and your headers never appear in outcomes or events. Options the package cannot use,
such as an empty key, an `http://` `baseURL` or a header that would replace `Authorization`, throw `INVALID_CONFIG` when
you call `openai()`; a model name over 128 characters throws it when you call `models.model()`.

## How it is tested

- Unit tests run the package through the OpenAI SDK against a fake Responses API, given through `fetch`. It passes the
  [model adapter conformance suite](../guides/model-registry.md#writing-a-provider-package) from `mayura/testing`:
  response shapes, costs, tool calls, streaming, the reason for each failure, no leaked provider text, cancellation,
  timeouts and strict schemas.
- They also check that nothing comes from the environment (base URL, organization, project), that the SDK logs nothing
  even with `OPENAI_LOG` set, that a call is one request, that oversized responses are refused, and that every catalog
  model carries the long-context rates.
- This package passed live runs against the real API through a Cloudflare AI Gateway on September 30, 2026:
  structured output, tools and streaming.

## Related

- [Model registry](../guides/model-registry.md): ids, prices, the per-call bound, retries and chains.
- [Azure OpenAI](provider-azure.md): the same models from your Azure resource.
- [Model routing](../guides/model-routing.md): failover, circuit breakers and accounting.
- [Costs and budgets](../concepts/costs-and-budgets.md): how a call's cost is reserved and charged.
