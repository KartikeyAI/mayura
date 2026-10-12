---
title: "Groq models"
description: "Call open models on Groq through its Chat Completions API with @mayurajs/provider-groq: model ids, catalog prices, tools, costs and errors."
package: "@mayurajs/provider-groq"
vendor: "Groq"
logo: "groq"
website: "https://groq.com"
area: "providers"
---

[Groq](https://groq.com) serves open models, such as OpenAI's gpt-oss and Qwen, on its own inference hardware.
`@mayurajs/provider-groq` is a provider package for the [model registry](../guides/model-registry.md): every Groq model
gets an id such as `groq/openai/gpt-oss-120b`, which you price, bound and grant like any other registry model. It calls
Groq's Chat Completions API through the official `groq-sdk`, pinned at 1.6.0, which is its only dependency (`mayura` is
a peer). The SDK's retries and logging are turned off. The package itself uses no Node built-in modules and sends every
request through `fetch`; its `engines` field names Node.js 22 (22.12 or later) and 24 (24.14.1 or later), and its tests
run on Node.

## Install

```bash
npm install mayura @mayurajs/provider-groq
```

## Credentials

Create an API key in the [Groq console](https://console.groq.com/keys). It is sent as `Authorization: Bearer`.

The package reads nothing from the environment: not `GROQ_API_KEY`, `GROQ_BASE_URL`, `GROQ_LOG`, nor
`GROQ_CUSTOM_HEADERS`, which the SDK would otherwise add to every request. Pass the key in yourself, for example from
`GROQ_API_KEY`.

## Use it

```ts
import { createModels, createRuntime, defineAgent, defineTool, z } from 'mayura';
import { groq } from '@mayurajs/provider-groq';

const models = createModels({
  providers: [groq({ apiKey: process.env.GROQ_API_KEY ?? '' })],
  prices: 'catalog',         // Groq's on-demand list prices on the catalog's date
  maxCallCostMicros: 20_000, // at most $0.02 per model call
});

const lookup = defineTool({
  id: 'orders.lookup', version: '1', description: 'Look up an order by its id.', effects: 'none', capabilities: [],
  input: z.object({ orderId: z.string() }), output: z.object({ status: z.string() }),
  execute: async ({ orderId }) => ({ status: orderId === 'ord-1' ? 'shipped' : 'unknown' }),
});

const agent = defineAgent({
  id: 'support', version: '1', instructions: 'Use orders.lookup, then answer in one sentence.',
  model: models.model('groq/openai/gpt-oss-120b', { retry: { attempts: 2 } }), tools: [lookup],
  input: z.object({ question: z.string() }), output: z.object({ answer: z.string() }),
});

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: { allow: ['model:groq/openai/gpt-oss-120b', 'tool:orders.lookup'] },
  limits: { maxCostMicros: 200_000 }, // at most $0.20 per run
});
try {
  const outcome = await runtime.submit(agent, { input: { question: 'Where is order ord-1?' } }).result();
  console.log(outcome.status === 'succeeded' ? outcome.output.answer : outcome.error);
} finally {
  await runtime.close();
}
```

The adapter's id is the model id, so the run needs `model:groq/openai/gpt-oss-120b`, and that grant admits no other
model. A run without it ends `blocked` with `PERMISSION_DENIED` before any request is sent. See
[Permissions](../concepts/permissions.md).

## Model ids

A model id is `groq/<model>`, where `<model>` is Groq's own model name (up to 128 characters). Groq's names often
contain a `/` themselves, so the id has two: `groq/openai/gpt-oss-120b`. Everything after the first `/` is sent to Groq.
Any model name works once it has a price; the catalog prices the models below.

## Catalog prices

`prices: 'catalog'` uses Groq's on-demand list prices as of **2026-09-29**, from Groq's
[models page](https://console.groq.com/docs/models). In US dollars per million tokens:

| Model | Input | Output | Context | Max output |
| --- | --- | --- | --- | --- |
| `openai/gpt-oss-120b` | $0.15 | $0.60 | 131,072 | 65,536 |
| `openai/gpt-oss-20b` | $0.075 | $0.30 | 131,072 | 65,536 |
| `qwen/qwen3.8-27b` | $0.80 | $4 | 131,072 | 16,384 |

Cached input is charged at the full input rate. Models Groq sells only through its sales team (Llama 3.3 70B Versatile
and Llama 3.1 8B Instant, on that date) are left out, and Batch and Flex tier prices differ: give those yourself.

Prices change: `models.list()` shows each model's `catalogAsOf`, context and output limits, and the catalog is exported
as `catalog`. A price you give, in `prices` or as `pricing` on one model, always wins:

```ts
const models = createModels({
  providers: [groq({ apiKey: process.env.GROQ_API_KEY ?? '' })],
  prices: { 'groq/openai/gpt-oss-20b': { inputMicrosPerMillionTokens: 75_000, outputMicrosPerMillionTokens: 300_000 } },
  maxCallCostMicros: 10_000,
});
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | required | Your Groq API key, sent as `Authorization: Bearer`. |
| `baseURL` | `https://api.groq.com` | Where requests go instead, such as a gateway: an https URL, the part before `/openai/v1`. Prompts, tool results and outputs go to this host. |
| `headers` | none | Up to 8 extra headers, such as a gateway's credential. Treated as credentials. They cannot replace `Authorization`, `Content-Type`, `Host` or cookies. |
| `media` | none | What the models can see, for a vision model: PNG, JPEG, WebP or GIF images, `{ types, urls }`. |
| `maxRequestBytes` | 1 MiB | Largest request body, not counting media (the run's `maxMediaBytes` bounds those). |
| `maxResponseBytes` | 1 MiB | Largest response body; four times that for a stream. A larger one fails without being read into memory. |
| `timeoutMs` | 60,000 | How long one call may take, unless the registry or the model sets `timeoutMs`. |
| `fetch` | `globalThis.fetch` | The transport, for tests and proxies. Redirects are never followed. |

The registry's `timeoutMs` (on `createModels` or on one model, 100 to 3,600,000 ms) wins over the provider's.

## What it sends and supports

- **Structured output.** A call without tools asks for the agent's output as strict JSON Schema (`response_format` of
  type `json_schema`, `strict: true`), so choose a model with strict structured outputs. The schemas must follow the
  [strict rules](../guides/model-providers.md#json-schemas); `defineAgent` checks them when the agent is defined.
- **Tools.** Tools are sent as strict functions with an `auto` tool choice, and parallel tool calls are on. Groq
  refuses a response format beside tools, so a call with tools offers the tools alone. When the model calls no more
  tools, the package makes **one more request** in the same model call, with the format and without the tools, and
  that answer is the output. Both requests are charged to the call.
- **Streaming.** With a [stream policy](../guides/streaming.md) on the agent, output text is reported as Groq writes
  it. With tools, the model's free reply is never streamed, only the answer in the format.
- **Reasoning.** Reasoning a model returns with a tool call is kept in the run's private state and sent back on the
  next call. It is never released as output or put in events. That state names the provider and model, so it never
  moves to another provider or model.
- **Narration.** Text a model writes before a tool call is not an answer and is dropped.
- **Images.** Models see nothing unless you say so. For a vision model, pass for example
  `media: { types: ['image/png', 'image/jpeg'], urls: true }`: images go inline as data URLs, or as URLs Groq fetches.
  Images a tool returns follow the tool results in one user message. See [Vision](../guides/vision.md).
- **Output tokens.** `max_completion_tokens` is the run's `limits.maxOutputTokens` (4,096 unless you set it).

## Costs

Each request's cost is Groq's reported prompt and completion tokens at your prices, rounded up to a whole micro.
Reasoning tokens are part of the completion tokens; cached prompt tokens are charged at the full rate. A model call with
tools that ends in an answer makes two requests, and its cost is the sum of both.

`maxCallCostMicros` (or a model's `maxCostMicros`) is reserved before every call, and a call that doesn't fit in the
run's budget never starts. With tools, choose it to cover **two** requests of your largest prompt plus
`maxOutputTokens`: on `openai/gpt-oss-120b`, two requests of 20,000 input tokens and 4,096 output tokens cost at most
2 × (3,000 + 2,458) = 10,916 micros, so 20,000 covers them. A call whose cost is unknown, such as one that timed out
after it was sent, is charged its full bound. See [Costs and budgets](../concepts/costs-and-budgets.md).

## Retries and fallback

The SDK's own retries are off: each request is sent once. Retries belong to the registry:

```ts
const model = models.model('groq/openai/gpt-oss-120b', { retry: { attempts: 3, backoffMs: 500 } });
```

- `retry` calls the model again after `rate_limited`, `unavailable` (including Groq's 498 when a Flex tier model is
  over capacity) or `timeout`; never after the caller cancels, a failure that would repeat, or once streamed text was
  released.
- `attempts` is 1 to 5, and the model's bound becomes `attempts` times its bound. Every attempt is charged.
- Waits double from `backoffMs` (default 500 ms).

To fall back to another model, use a chain. It is a [model router](../guides/model-routing.md) granted by the name you
choose, and granting it grants every model in it:

```ts
const support = models.chain('support', ['groq/openai/gpt-oss-120b', 'groq/openai/gpt-oss-20b']);
// Grant model:support.
```

## Errors

A failed call ends the run with `MODEL_FAILED` and a `reason` (see [Errors](../guides/model-providers.md#errors) for the
messages):

| `reason` | When |
| --- | --- |
| `authentication` | HTTP 401 or 403: a wrong key, or no access to the model. |
| `rate_limited` | HTTP 429, or 402 for quota. |
| `unavailable` | HTTP 408, 498 (Flex capacity) or 5xx, no connection, or an error inside a stream. |
| `timeout` | No answer within `timeoutMs`. |
| `rejected` | Any other HTTP error, such as 404 for an unknown model or 400 for a request Groq refuses. |
| `refused` | The model refused, or stopped at the output-token limit. |
| `invalid_response` | An answer that is not the required JSON, a tool call or answer Groq could not parse (its 400 with `tool_use_failed` or `output_parse_failed`), a response without usage, or one larger than `maxResponseBytes`. |
| `configuration` | A schema that breaks the strict rules, or media of a type the provider does not send (code `INVALID_CONFIG`). |

Groq's error text, the generation it failed to parse, your key and your headers never appear in outcomes or events.
Options the package cannot use, such as an empty key, an `http://` `baseURL`, a header that would replace
`Authorization`, or `media` with a type other than the four image types, throw `INVALID_CONFIG` when you call `groq()`.
So does a version of the SDK whose environment headers the package cannot remove: it refuses to start rather than send
them. A model name over 128 characters throws `INVALID_CONFIG` when you call `models.model()`.

## How it is tested

- Unit tests run the package through the Groq SDK against a fake Chat Completions API, given through `fetch`. It
  passes the [model adapter conformance suite](../guides/model-registry.md#writing-a-provider-package) from
  `mayura/testing`: response shapes, costs, tool calls, streaming, the reason for each failure, no leaked provider
  text, cancellation, timeouts and strict schemas.
- They also check that nothing comes from the environment (`GROQ_CUSTOM_HEADERS` included) and the SDK logs nothing,
  that `baseURL` and headers are honoured, that 429, 498 and 503 are one request each, the two-request answer with
  tools and its charge, that the free reply is never streamed, Groq's parse failures, that reasoning is sent back and
  never released, images, and the catalog through a registry run.
- This package passed live runs against the real API through a Cloudflare AI Gateway on September 30, 2026 with GPT-OSS 20B and 120B:
  structured output, tools and streaming.
- `scripts/live/provider-groq.mjs`, a structured answer and a tool call through a registry priced from the catalog,
  passed directly against Groq on October 12, 2026.

## Related

- [Model registry](../guides/model-registry.md): ids, prices, the per-call bound, retries and chains.
- [Model routing](../guides/model-routing.md): failover, circuit breakers and accounting.
- [Ollama](provider-ollama.md): the same gpt-oss models on your own machine.
- [Costs and budgets](../concepts/costs-and-budgets.md): how a call's cost is reserved and charged.
