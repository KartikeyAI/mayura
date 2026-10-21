---
title: "Google Gemini models"
description: "Call Gemini models through the Gemini API with @mayurajs/provider-google: model ids, catalog prices, thinking, media, costs and errors."
package: "@mayurajs/provider-google"
vendor: "Google"
logo: "gemini"
website: "https://ai.google.dev"
area: "providers"
---

[Google](https://ai.google.dev) serves the Gemini models through the Gemini API. `@mayurajs/provider-google` is a
provider package for the [model registry](../guides/model-registry.md): every Gemini model gets an id such as
`google/gemini-3.5-flash`, which you price, bound and grant like any other registry model. It calls the Gemini API
(`generativelanguage.googleapis.com`, API version `v1beta`) through the official `@google/genai` SDK, pinned at
2.24.0, which is its only dependency (`mayura` is a peer). It does not use Vertex AI. The package itself uses no Node
built-in modules and sends every request through `fetch`; its `engines` field names Node.js 22 (22.12 or later) and 24
(24.14.1 or later), and its tests run on Node.

## Install

```bash
npm install mayura @mayurajs/provider-google
```

## Credentials

Create a Gemini API key in [Google AI Studio](https://aistudio.google.com/apikey). It is sent in the `x-goog-api-key`
header. The catalog holds paid-tier prices.

The package reads nothing from the environment: not `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GEMINI_BASE_URL`, nor
the Vertex AI settings (`GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_CLOUD_PROJECT`). Pass the key in yourself, for example
from `GEMINI_API_KEY`.

## Use it

```ts
import { createModels, createRuntime, defineAgent, z } from 'mayura';
import { google } from '@mayurajs/provider-google';

const models = createModels({
  providers: [google({ apiKey: process.env.GEMINI_API_KEY ?? '' })],
  prices: 'catalog',          // the Gemini API's list prices on the catalog's date
  maxCallCostMicros: 100_000, // at most $0.10 per model call
});

const agent = defineAgent({
  id: 'support', version: '1', instructions: 'Answer the customer in one or two sentences.',
  model: models.model('google/gemini-3.5-flash', { retry: { attempts: 2 } }), tools: [],
  input: z.object({ question: z.string() }), output: z.object({ answer: z.string() }),
});

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: { allow: ['model:google/gemini-3.5-flash'] },
  limits: { maxCostMicros: 500_000 }, // at most $0.50 per run
});
try {
  const outcome = await runtime.submit(agent, { input: { question: 'Where is my order?' } }).result();
  console.log(outcome.status === 'succeeded' ? outcome.output.answer : outcome.error);
} finally {
  await runtime.close();
}
```

The adapter's id is the model id, so the run needs `model:google/gemini-3.5-flash`, and that grant admits no other
model. A run without it ends `blocked` with `PERMISSION_DENIED` before any request is sent. See
[Permissions](../concepts/permissions.md).

## Model ids

A model id is `google/<model>`, where `<model>` is the Gemini API's model name (up to 128 characters), such as
`google/gemini-3.5-flash`. Any model name works once it has a price; the catalog prices the models below.

## Catalog prices

`prices: 'catalog'` uses the Gemini API's paid-tier list prices as of **2026-09-29**, from Google's
[pricing page](https://ai.google.dev/gemini-api/docs/pricing). In US dollars per million tokens; every model has a
context of 1,048,576 tokens and up to 65,536 output tokens:

| Model | Input | Output | Input over 200K | Output over 200K |
| --- | --- | --- | --- | --- |
| `gemini-3.8-flash` | $1.50 | $7.50 | | |
| `gemini-3.5-flash` | $1.50 | $9 | | |
| `gemini-3.5-flash-lite` | $0.30 | $2.50 | | |
| `gemini-3.1-flash-lite` | $0.50 | $1.50 | | |
| `gemini-3.1-pro-preview` | $2 | $12 | $4 | $18 |
| `gemini-2.5-pro` | $1.25 | $10 | $2.50 | $15 |

The catalog errs towards charging more, so a budget never undercounts:

- Gemini 3.8 Flash is listed at the price Google has announced from January 1, 2027, twice its price until then.
- Cached input is charged at the full input rate.
- Where a model bills audio input higher than text, the higher rate is listed.
- A prompt over 200K tokens on a model with long-context rates is charged those rates for the whole call.

Prices change: `models.list()` shows each model's `catalogAsOf`, and the catalog is exported as `catalog`. A price you
give, in `prices` or as `pricing` on one model, always wins:

```ts
const models = createModels({
  providers: [google({ apiKey: process.env.GEMINI_API_KEY ?? '' })],
  prices: { 'google/gemini-3.8-flash': { inputMicrosPerMillionTokens: 750_000, outputMicrosPerMillionTokens: 3_750_000 } },
  maxCallCostMicros: 50_000,
});
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `apiKey` | required | Your Gemini API key, sent as `x-goog-api-key`. |
| `baseURL` | `https://generativelanguage.googleapis.com` | Where requests go instead, such as a gateway: an https URL, the part before `/v1beta`. Prompts, tool results and outputs go to this host. |
| `headers` | none | Up to 8 extra headers, such as a gateway's credential. Treated as credentials. They cannot replace `x-goog-api-key`, `Authorization`, `Content-Type`, `Host` or cookies. |
| `media` | PNG, JPEG, WebP and PDF, as bytes | What the models can see, `{ types, urls: false }`; `false` for none. GIF and URLs are not accepted. |
| `maxRequestBytes` | 1 MiB | Largest request body, not counting media (the run's `maxMediaBytes` bounds those). |
| `maxResponseBytes` | 1 MiB | Largest response body; four times that for a stream. A larger one fails without being read into memory. |
| `timeoutMs` | 60,000 | How long one call may take, unless the registry or the model sets `timeoutMs`. |
| `fetch` | `globalThis.fetch` | The transport, for tests and proxies. Redirects are never followed. |

The registry's `timeoutMs` (on `createModels` or on one model, 100 to 3,600,000 ms) wins over the provider's.

## What it sends and supports

- **Structured output.** Every call asks for JSON (`responseMimeType: application/json`) matching the agent's output
  schema (`responseJsonSchema`), and tools are sent as function declarations with their JSON Schema parameters. The
  schemas must follow the [strict rules](../guides/model-providers.md#json-schemas); `defineAgent` checks them when
  the agent is defined.
- **Streaming.** With a [stream policy](../guides/streaming.md) on the agent, output text is reported as Gemini writes
  it. Thought text is never streamed.
- **Thinking.** The model's thoughts and thought signatures are kept, with the rest of its tool-call turn, in the run's
  private state and sent back unchanged on the next call, as Gemini requires. They are never released as output or put
  in events. That state names the provider and model, so it never moves to another provider or model.
- **Tool calls.** A call keeps Gemini's own id when it gives one, and gets `call-<n>` otherwise; a tool result echoes
  the id only when Gemini gave one. Results of several calls go back in one turn.
- **Images and PDFs.** By default the models see PNG, JPEG, WebP and PDF, sent inline as bytes. Media given as a URL
  fails the call with `configuration`. Set `media: false` for none, or list fewer types. See
  [Vision](../guides/vision.md).
- **Output tokens.** `maxOutputTokens` is the run's `limits.maxOutputTokens` (4,096 unless you set it).

## Costs

Each call's cost is Gemini's reported usage at your prices, rounded up to a whole micro:

- input is the prompt tokens plus any tool-use prompt tokens, cached tokens included at the full rate;
- output is the answer tokens plus the **thinking** tokens, which Gemini bills as output;
- the long-context rates apply to the whole call once its input is over the threshold.

`maxCallCostMicros` (or a model's `maxCostMicros`) is reserved before every call, and a call that doesn't fit in the
run's budget never starts. Choose it to cover your largest prompt plus `maxOutputTokens`, and leave room for thinking:
on `gemini-3.5-flash`, 20,000 input tokens and 4,096 output tokens cost 30,000 + 36,864 = 66,864 micros. If a call
reports more than its bound, the cost is still recorded and the run stops with `BUDGET_EXCEEDED`. A call whose cost is
unknown, such as one that timed out after it was sent, is charged its full bound. See
[Costs and budgets](../concepts/costs-and-budgets.md).

## Retries and fallback

The SDK's own retries are off: one call is one HTTP request. Retries belong to the registry:

```ts
const model = models.model('google/gemini-3.5-flash', { retry: { attempts: 3, backoffMs: 1_000 } });
```

- `retry` calls the model again after `rate_limited`, `unavailable` (such as a 503 from a busy model) or
  `timeout`; never after the caller cancels, a failure that would repeat, or once streamed text was released.
- `attempts` is 1 to 5, and the model's bound becomes `attempts` times its bound. Every attempt is charged.
- Waits double from `backoffMs` (default 500 ms).

To fall back to another model when one is busy, use a chain. It is a [model router](../guides/model-routing.md)
granted by the name you choose, and granting it grants every model in it:

```ts
const support = models.chain('support', ['google/gemini-3.5-flash', 'google/gemini-3.5-flash-lite'], {
  circuit: { failureThreshold: 3, cooldownMs: 30_000 },
});
// Grant model:support.
```

## Errors

A failed call ends the run with `MODEL_FAILED` and a `reason` (see [Errors](../guides/model-providers.md#errors) for the
messages):

| `reason` | When |
| --- | --- |
| `authentication` | HTTP 401 or 403: a wrong key, or no access to the model. |
| `rate_limited` | HTTP 429, or 402 for quota. |
| `unavailable` | HTTP 408 or 5xx, or no connection. |
| `timeout` | No answer within `timeoutMs`. |
| `rejected` | Any other HTTP error, such as 404 for an unknown model or 400 for a request Gemini refuses. |
| `refused` | The prompt was blocked, or the answer stopped for `MAX_TOKENS`, `SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, `IMAGE_SAFETY` or `LANGUAGE`. |
| `invalid_response` | An answer that is not the required JSON, a response without usage, or one larger than `maxResponseBytes`. |
| `configuration` | A schema that breaks the strict rules, or media given as a URL (code `INVALID_CONFIG`). |

Google's error text, your key and your headers never appear in outcomes or events. Options the package cannot use,
such as an empty key, an `http://` `baseURL`, a header that would replace `x-goog-api-key`, or `media` with URLs or a
type other than PNG, JPEG, WebP and PDF, throw `INVALID_CONFIG` when you call `google()`; a model name over 128
characters throws it when you call `models.model()`.

## How it is tested

- Unit tests run the package through the Gen AI SDK against a fake Gemini API, given through `fetch`. It passes the
  [model adapter conformance suite](../guides/model-registry.md#writing-a-provider-package) from `mayura/testing`:
  response shapes, costs, tool calls, streaming, the reason for each failure, no leaked provider text, cancellation,
  timeouts and strict schemas.
- They also check that nothing comes from the environment (Vertex AI settings included), that a call is one request,
  that thinking tokens are charged as output and long prompts at the long-context rates, that thoughts and signatures
  are sent back and never released, that a blocked prompt is `refused`, and the catalog through a registry run.
- This package passed live runs against the real API through a Cloudflare AI Gateway on September 30, 2026:
  structured output, tools and streaming.
- `scripts/live/provider-google.mjs`, a structured answer and a tool call through a registry priced from the catalog,
  passed on October 6, 2026 with a Gemini Flash-Lite model. Gemini Flash returned intermittent 503s from Google that
  day.

## Related

- [Model registry](../guides/model-registry.md): ids, prices, the per-call bound, retries and chains.
- [Model routing](../guides/model-routing.md): failover, circuit breakers and accounting.
- [Vision](../guides/vision.md): images and PDFs for agents and tools.
- [OpenAI](provider-openai.md) and [Anthropic](provider-anthropic.md): other provider packages.

### RAG embeddings

This provider exports `googleEmbeddings` for scoped RAG ingestion and retrieval. See [the RAG guide](../guides/rag.md) for explicit permissions, cost ceilings and sensitivity profiles. Offline embedding tests passed locally with fake transports. Live embedding service behavior remains unqualified; see [release validation status](../guides/release-readiness.md).
