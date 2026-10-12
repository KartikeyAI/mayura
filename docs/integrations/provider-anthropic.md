---
title: "Anthropic Claude models"
description: "Call Claude models through Anthropic's Messages API with @mayurajs/provider-anthropic: model ids, catalog prices, thinking, costs and errors."
package: "@mayurajs/provider-anthropic"
vendor: "Anthropic"
logo: "anthropic"
website: "https://www.anthropic.com"
area: "providers"
---

[Anthropic](https://www.anthropic.com) makes the Claude models. `@mayurajs/provider-anthropic` is a provider package
for the [model registry](../guides/model-registry.md): every Claude model gets an id such as
`anthropic/claude-sonnet-5-5`, which you price, bound and grant like any other registry model. It calls Anthropic's
Messages API through the official `@anthropic-ai/sdk`, pinned at 0.128.0, which is its only dependency (`mayura` is a
peer). The package itself uses no Node built-in modules and sends every request through `fetch`; its `engines` field
names Node.js 22 (22.12 or later) and 24 (24.14.1 or later), and its tests run on Node.

Mayura 1.0's own adapter, `anthropicMessages` from `mayura/provider-anthropic`, keeps working; see
[Model providers](../guides/model-providers.md).

## Install

```bash
npm install mayura @mayurajs/provider-anthropic
```

## Credentials

Create an API key in the [Claude Console](https://console.anthropic.com/settings/keys) under **API keys**. It is sent
in the `x-api-key` header; the package never sends an `Authorization` bearer token.

The package reads nothing from the environment: not `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
nor `ANTHROPIC_LOG`, which would make the SDK log every request. Pass the key in yourself, for example from
`ANTHROPIC_API_KEY`.

## Use it

```ts
import { createModels, createRuntime, defineAgent, z } from 'mayura';
import { anthropic } from '@mayurajs/provider-anthropic';

const models = createModels({
  providers: [anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' })],
  prices: 'catalog',          // Anthropic's list prices on the catalog's date
  maxCallCostMicros: 100_000, // at most $0.10 per model call
});

const agent = defineAgent({
  id: 'support', version: '1', instructions: 'Answer the customer in one or two sentences.',
  model: models.model('anthropic/claude-sonnet-5-5', { retry: { attempts: 2 } }), tools: [],
  input: z.object({ question: z.string() }), output: z.object({ answer: z.string() }),
});

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: { allow: ['model:anthropic/claude-sonnet-5-5'] },
  limits: { maxCostMicros: 500_000 }, // at most $0.50 per run
});
try {
  const outcome = await runtime.submit(agent, { input: { question: 'Where is my order?' } }).result();
  console.log(outcome.status === 'succeeded' ? outcome.output.answer : outcome.error);
} finally {
  await runtime.close();
}
```

The adapter's id is the model id, so the run needs `model:anthropic/claude-sonnet-5-5`, and that grant admits no other
model. A run without it ends `blocked` with `PERMISSION_DENIED` before any request is sent. See
[Permissions](../concepts/permissions.md).

## Model ids

A model id is `anthropic/<model>`, where `<model>` is Anthropic's own model name (up to 128 characters), such as
`anthropic/claude-sonnet-5-5` or the dated `anthropic/claude-haiku-4-5-20251001`. Any model name works once it has a
price; the catalog prices the models below.

## Catalog prices

`prices: 'catalog'` uses Anthropic's standard list prices as of **2026-09-29**, from Anthropic's
[pricing page](https://platform.claude.com/docs/en/about-claude/pricing). In US dollars per million tokens:

| Model | Input | Output | Context | Max output |
| --- | --- | --- | --- | --- |
| `claude-fable-5-1` | $10 | $50 | 1,000,000 | 128,000 |
| `claude-opus-5-5` | $4 | $20 | 1,000,000 | 128,000 |
| `claude-sonnet-5-5` | $2 | $10 | 1,000,000 | 128,000 |
| `claude-haiku-4-5` | $1 | $5 | 200,000 | 64,000 |
| `claude-haiku-4-5-20251001` | $1 | $5 | 200,000 | 64,000 |

Anthropic bills the whole context window at these rates, so there is no long-context tier. Requests pinned to a region
with `inference_geo` cost 10% more; the package never sets it, but if a proxy of yours does, give those prices yourself.

Prices change: `models.list()` shows each model's `catalogAsOf`, context and output limits, and the catalog is exported
as `catalog`. A price you give, in `prices` or as `pricing` on one model, always wins:

```ts
const models = createModels({
  providers: [anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' })],
  prices: { 'anthropic/claude-opus-5-5': { inputMicrosPerMillionTokens: 4_000_000, outputMicrosPerMillionTokens: 20_000_000 } },
  maxCallCostMicros: 200_000,
});
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | required | Your Anthropic API key, sent as `x-api-key`. |
| `baseURL` | `https://api.anthropic.com` | Where requests go instead, such as a gateway: an https URL, the part before `/v1/messages`. Prompts, tool results and outputs go to this host. |
| `headers` | none | Up to 8 extra headers, such as a gateway's credential. Treated as credentials. They cannot replace `x-api-key`, `anthropic-version`, `Authorization`, `Content-Type`, `Host` or cookies. |
| `media` | every Mayura media type, and URLs | What the models can see, `{ types, urls }`; `false` for none. |
| `maxRequestBytes` | 1 MiB | Largest request body, not counting media (the run's `maxMediaBytes` bounds those). |
| `maxResponseBytes` | 1 MiB | Largest response body; four times that for a stream. A larger one fails without being read into memory. |
| `timeoutMs` | 60,000 | How long one call may take, unless the registry or the model sets `timeoutMs`. |
| `fetch` | `globalThis.fetch` | The transport, for tests and proxies. Redirects are never followed. |

The registry's `timeoutMs` (on `createModels` or on one model, 100 to 3,600,000 ms) wins over the provider's.

## What it sends and supports

- **Structured output.** Every call asks for the agent's output as JSON Schema (`output_config.format` of type
  `json_schema`), and tools are sent with `strict: true` and `tool_choice: auto`, parallel calls allowed. The schemas
  must follow the [strict rules](../guides/model-providers.md#json-schemas); `defineAgent` checks them when the agent
  is defined.
- **Streaming.** With a [stream policy](../guides/streaming.md) on the agent, output text is reported as Claude writes
  it.
- **Thinking.** The package does not turn extended thinking on. When a model returns `thinking` or `redacted_thinking`
  blocks with a tool call, they are kept, signatures included, in the run's private state and sent back unchanged on
  the next call, as Anthropic requires. Thinking is never released as output or put in events. That state names the
  provider and model, so it never moves to another provider or model.
- **Narration.** Text Claude writes before a tool call is not an answer and is dropped.
- **Images and PDFs.** By default the models see every Mayura media type (PNG, JPEG, WebP, GIF and PDF), as bytes or
  URLs. Images are sent as `image` blocks and PDFs as `document` blocks; a named image is introduced by a text block.
  Images a tool returns go inside its tool result, PDFs right after it. Set `media: false` for none, or list fewer
  types. See [Vision](../guides/vision.md).
- **Prompt caching.** The package sets no cache breakpoints. Cache tokens Anthropic reports are charged as below.
- **Output tokens.** `max_tokens` is the run's `limits.maxOutputTokens` (4,096 unless you set it).

## Costs

Each call's cost is Anthropic's reported usage at your prices, rounded up to a whole micro:

- input tokens at the input rate;
- cache-creation tokens at **twice** the input rate (what a one-hour cache write costs), and cache-read tokens at the
  full input rate, so a budget never undercounts;
- output tokens at the output rate.

The tokens reported to events and traces count cache writes and reads as input.

`maxCallCostMicros` (or a model's `maxCostMicros`) is reserved before every call, and a call that doesn't fit in the
run's budget never starts. Choose it to cover your largest prompt plus `maxOutputTokens`: on `claude-sonnet-5-5`,
20,000 input tokens and 4,096 output tokens cost at most 40,000 + 40,960 = 80,960 micros, so 100,000 covers it. A call
whose cost is unknown, such as one that timed out after it was sent, is charged its full bound. See
[Costs and budgets](../concepts/costs-and-budgets.md).

## Retries and fallback

The SDK's own retries are off: one call is one HTTP request. Retries belong to the registry:

```ts
const model = models.model('anthropic/claude-sonnet-5-5', { retry: { attempts: 3, backoffMs: 500 } });
```

- `retry` calls the model again after `rate_limited`, `unavailable` (including Anthropic's 529 when it is overloaded)
  or `timeout`; never after the caller cancels, a failure that would repeat, or once streamed text was released.
- `attempts` is 1 to 5, and the model's bound becomes `attempts` times its bound. Every attempt is charged.
- Waits double from `backoffMs` (default 500 ms).

To fall back to another model, or to another provider during an outage, use a chain. It is a
[model router](../guides/model-routing.md) granted by the name you choose, and granting it grants every model in it:

```ts
import { createModels } from 'mayura';
import { anthropic } from '@mayurajs/provider-anthropic';
import { openai } from '@mayurajs/provider-openai';

const models = createModels({
  providers: [anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' }), openai({ apiKey: process.env.OPENAI_API_KEY ?? '' })],
  prices: 'catalog',
  maxCallCostMicros: 100_000,
});
const support = models.chain('support', ['anthropic/claude-sonnet-5-5', 'openai/gpt-6-sol']);
// Grant model:support. Each call reserves both bounds: 200,000 micros.
```

## Through a gateway

`baseURL` and `headers` send the same Messages requests through a gateway or proxy, such as Cloudflare AI Gateway's
Anthropic endpoint. A gateway is where your prompts and outputs go: choose it as deliberately as the provider.

```ts
const viaGateway = anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? '',
  baseURL: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/anthropic`,
  headers: { 'cf-aig-authorization': `Bearer ${process.env.CF_AIG_TOKEN}` },
});
```

Model ids and grants stay the same.

## Errors

A failed call ends the run with `MODEL_FAILED` and a `reason` (see [Errors](../guides/model-providers.md#errors) for the
messages):

| `reason` | When |
| --- | --- |
| `authentication` | HTTP 401 or 403: a wrong key, or no access to the model. |
| `rate_limited` | HTTP 429, or 402 for quota. |
| `unavailable` | HTTP 408, 5xx or 529 (overloaded), no connection, or an error event inside a stream. |
| `timeout` | No answer within `timeoutMs`. |
| `rejected` | Any other HTTP error, such as 404 for an unknown model or 400 for a request Anthropic refuses. |
| `refused` | Claude stopped with `refusal`, or at the output-token limit (`max_tokens`). |
| `invalid_response` | An answer that is not the required JSON, a response without usage, or one larger than `maxResponseBytes`. |
| `configuration` | A schema that breaks the strict rules (code `INVALID_CONFIG`). |

Anthropic's error text, your key and your headers never appear in outcomes or events. Options the package cannot use,
such as an empty key, an `http://` `baseURL` or a header that would replace `x-api-key`, throw `INVALID_CONFIG` when you
call `anthropic()`; a model name over 128 characters throws it when you call `models.model()`.

## How it is tested

- Unit tests run the package through the Anthropic SDK against a fake Messages API, given through `fetch`. It passes
  the [model adapter conformance suite](../guides/model-registry.md#writing-a-provider-package) from `mayura/testing`:
  response shapes, costs, tool calls, streaming, the reason for each failure, no leaked provider text, cancellation,
  timeouts and strict schemas.
- They also check that nothing comes from the environment and the SDK logs nothing even with `ANTHROPIC_LOG` set, that
  a call is one request and a 529 is `unavailable`, the cache-token charges, that thinking is sent back and never
  released, that another model's state is refused, and the catalog through a registry run.
- This package passed live runs against the real API through a Cloudflare AI Gateway on September 30, 2026:
  structured output, tools and streaming.

## Related

- [Model registry](../guides/model-registry.md): ids, prices, the per-call bound, retries and chains.
- [Amazon Bedrock](provider-bedrock.md): Claude models through your AWS account.
- [Model routing](../guides/model-routing.md): failover, circuit breakers and accounting.
- [Costs and budgets](../concepts/costs-and-budgets.md): how a call's cost is reserved and charged.
