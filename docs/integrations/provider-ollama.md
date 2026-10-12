---
title: "Ollama models"
description: "Run local or Ollama cloud models with @mayurajs/provider-ollama: model ids, zero or own prices, thinking, structured output and errors."
package: "@mayurajs/provider-ollama"
vendor: "Ollama"
logo: "ollama"
website: "https://ollama.com"
area: "providers"
---

[Ollama](https://ollama.com) runs open models on your own machine, and serves larger ones in Ollama's cloud.
`@mayurajs/provider-ollama` is a provider package for the [model registry](../guides/model-registry.md): every Ollama
model gets an id such as `ollama/gpt-oss:20b`, which you price, bound and grant like any other registry model. It calls
Ollama's chat API through the official `ollama` SDK, pinned at 0.6.3, using its `fetch`-based browser build; that SDK
is its only dependency (`mayura` is a peer). The package itself uses no Node built-in modules; its `engines` field
names Node.js 22 (22.12 or later) and 24 (24.14.1 or later), and its tests run on Node.

## Install

```bash
npm install mayura @mayurajs/provider-ollama
```

You also need an Ollama server: [install Ollama](https://ollama.com/download) and pull a model
(`ollama pull gpt-oss:20b`), or use Ollama's cloud.

## Credentials

A local server needs none. For Ollama's cloud, create an API key on Ollama's
[keys page](https://ollama.com/settings/keys) and pass it with `host: 'https://ollama.com'`; the package refuses that
host without a key. A key is sent as `Authorization: Bearer`.

The package reads nothing from the environment or the file system: not `OLLAMA_HOST`, nor `OLLAMA_API_KEY`, which the
SDK would otherwise fall back to for `ollama.com`. Pass the host and key in yourself, for example from
`OLLAMA_BASE_URL` and `OLLAMA_API_KEY`.

## Use it

```ts
import { createModels, createRuntime, defineAgent, z } from 'mayura';
import { ollama } from '@mayurajs/provider-ollama';

const models = createModels({
  providers: [ollama({ think: 'low' })], // http://127.0.0.1:11434
  prices: { 'ollama/gpt-oss:20b': { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 } },
  maxCallCostMicros: 1,
});

const agent = defineAgent({
  id: 'support', version: '1', instructions: 'Answer the customer in one or two sentences.',
  model: models.model('ollama/gpt-oss:20b'), tools: [],
  input: z.object({ question: z.string() }), output: z.object({ answer: z.string() }),
});

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: { allow: ['model:ollama/gpt-oss:20b'] },
  limits: { maxCostMicros: 1 },
});
try {
  const outcome = await runtime.submit(agent, { input: { question: 'Where is my order?' } }).result();
  console.log(outcome.status === 'succeeded' ? outcome.output.answer : outcome.error);
} finally {
  await runtime.close();
}
```

The adapter's id is the model id, so the run needs `model:ollama/gpt-oss:20b`, and that grant admits no other model. A
run without it ends `blocked` with `PERMISSION_DENIED` before any request is sent. See
[Permissions](../concepts/permissions.md).

For Ollama's cloud, give the host and your key:

```ts
const cloud = ollama({ host: 'https://ollama.com', apiKey: process.env.OLLAMA_API_KEY ?? '', think: 'medium' });
```

## Model ids

A model id is `ollama/<model>`, where `<model>` is the model's Ollama name with its tag (up to 128 characters), such as
`ollama/gpt-oss:20b` or `ollama/gpt-oss:120b`. A local model must be pulled first.

## Prices

There is no catalog: local models cost nothing, so give every model a price yourself, zero or your own. A model
without one is refused when you call `models.model()`. For a local model, zero prices make every call cost nothing,
and a bound of 1 micro is enough. For Ollama's cloud, give the per-token price you want budgets to count, or zero.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `host` | `http://127.0.0.1:11434` | The Ollama server: `http://` only on `localhost`, `127.0.0.1` or `[::1]`, `https://` anywhere else, such as `https://ollama.com` or a gateway. No credentials, query or fragment. |
| `apiKey` | none | An API key, sent as `Authorization: Bearer`. Required for `https://ollama.com`. |
| `headers` | none | Up to 8 extra headers, such as a gateway's credential. Treated as credentials. They cannot replace `Authorization`, `Accept`, `User-Agent`, `Content-Type`, `Host` or cookies. |
| `think` | not sent | Whether and how hard a thinking model thinks: `true`, `false`, `'low'`, `'medium'` or `'high'`. Leave it unset for a model that does not think. |
| `media` | none | What the models can see, for a vision model: PNG or JPEG images, as bytes, `{ types, urls: false }`. |
| `maxRequestBytes` | 1 MiB | Largest request body, not counting media (the run's `maxMediaBytes` bounds those). |
| `maxResponseBytes` | 1 MiB | Largest response body; four times that for a stream. A larger one fails without being read into memory. |
| `timeoutMs` | 120,000 | How long one call may take, unless the registry or the model sets `timeoutMs`. Longer than other providers, since a local model may need loading first. |
| `fetch` | `globalThis.fetch` | The transport, for tests and proxies. Redirects are never followed. |

The registry's `timeoutMs` (on `createModels` or on one model, 100 to 3,600,000 ms) wins over the provider's.

## What it sends and supports

- **Structured output.** A call without tools sends the agent's output schema as Ollama's `format`. Ollama's cloud
  accepts a format without enforcing it, so such a request also states the schema in the system instructions, and the
  agent's output validator checks the answer either way. The schemas must follow the
  [strict rules](../guides/model-providers.md#json-schemas); `defineAgent` checks them when the agent is defined.
- **Tools.** Tools are sent as functions with their JSON Schema parameters. A format leaves a model no way to call a
  tool, so a call with tools offers the tools alone. When the model calls no more tools, the package makes **one more
  request** in the same model call, with the format and without the tools, and that answer is the output. Both
  requests are counted.
- **Tool call ids.** Ollama gives tool calls no ids, so the package names them `call_1`, `call_2` and so on, unique
  within the run.
- **Streaming.** With a [stream policy](../guides/streaming.md) on the agent, output text is reported as the model
  writes it. With tools, the model's free reply is never streamed, only the answer in the format; thinking is never
  streamed.
- **Thinking.** Set `think` for a thinking model. Thinking a model returns with a tool call is kept in the run's
  private state and sent back on the next call. It is never released as output or put in events. That state names the
  provider and model, so it never moves to another provider or model.
- **Images.** Models see nothing unless you say so. For a vision model, pass `media: { types: ['image/png',
  'image/jpeg'], urls: false }`: images go as base64, and their names follow the message text. Media given as a URL, or
  of another type, fails the call with `configuration`. See [Vision](../guides/vision.md).
- **Output tokens.** `num_predict` is the run's `limits.maxOutputTokens` (4,096 unless you set it).

## Costs

Each request's cost is Ollama's reported prompt and generated token counts at your prices, rounded up to a whole
micro. When the whole prompt was cached, Ollama leaves its count out, and it counts as zero. A model call with tools
that ends in an answer makes two requests, and its cost is the sum of both.

`maxCallCostMicros` (or a model's `maxCostMicros`) is reserved before every call, and the run's `maxCostMicros` must be
at least as large or the first call cannot start. With zero prices, a bound of 1 micro and a run limit of 1 micro are
enough. With your own prices, choose a bound that covers two requests of your largest prompt plus `maxOutputTokens`.
See [Costs and budgets](../concepts/costs-and-budgets.md).

## Retries and fallback

The package sends each request once. Retries belong to the registry:

```ts
const model = models.model('ollama/gpt-oss:20b', { retry: { attempts: 3, backoffMs: 1_000 } });
```

- `retry` calls the model again after `rate_limited`, `unavailable` (such as a server that is not running yet) or
  `timeout`; never after the caller cancels, a failure that would repeat, or once streamed text was released.
- `attempts` is 1 to 5, and the model's bound becomes `attempts` times its bound. Every attempt is charged.
- Waits double from `backoffMs` (default 500 ms).

A chain falls back to another model, for example from a local model to a hosted one when the local server is down. It
is a [model router](../guides/model-routing.md) granted by the name you choose, and granting it grants every model in
it, so the run may send prompts to the hosted model:

```ts
import { createModels } from 'mayura';
import { groq } from '@mayurajs/provider-groq';
import { ollama } from '@mayurajs/provider-ollama';

const models = createModels({
  providers: [ollama(), groq({ apiKey: process.env.GROQ_API_KEY ?? '' })],
  prices: {
    'ollama/gpt-oss:20b': { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 },
    'groq/openai/gpt-oss-20b': { inputMicrosPerMillionTokens: 75_000, outputMicrosPerMillionTokens: 300_000 },
  },
  maxCallCostMicros: 10_000,
});
const support = models.chain('support', ['ollama/gpt-oss:20b', 'groq/openai/gpt-oss-20b']);
// Grant model:support. Each call reserves both bounds: 20,000 micros.
```

## Errors

A failed call ends the run with `MODEL_FAILED` and a `reason` (see [Errors](../guides/model-providers.md#errors) for the
messages):

| `reason` | When |
| --- | --- |
| `authentication` | HTTP 401 or 403: a wrong key, or no access to the model. |
| `rate_limited` | HTTP 429, or 402 for quota. |
| `unavailable` | HTTP 408 or 5xx, a server that cannot be reached (for example Ollama is not running), or an error reported in the middle of a stream. |
| `timeout` | No answer within `timeoutMs`. |
| `rejected` | Any other HTTP error, such as 404 for a model that is not pulled. |
| `refused` | The answer stopped at the output-token limit. |
| `invalid_response` | An answer that is not the required JSON, a response without a generated token count, or one larger than `maxResponseBytes`. |
| `configuration` | A schema that breaks the strict rules, or media as a URL or of another type (code `INVALID_CONFIG`). |

An error status is reported without reading its body, so Ollama's error text, your key and your headers never appear
in outcomes or events. Options the package cannot use, such as plain `http://` to a host that is not loopback, a host
with credentials in it, `https://ollama.com` without `apiKey`, an empty key, a header that would replace
`Authorization`, an unknown `think` value, or `media` with URLs or a type other than PNG and JPEG, throw
`INVALID_CONFIG` when you call `ollama()`. A model name over 128 characters throws it when you call `models.model()`.

## How it is tested

- Unit tests run the package through the Ollama SDK against a fake Ollama server, given through `fetch`. It passes the
  [model adapter conformance suite](../guides/model-registry.md#writing-a-provider-package) from `mayura/testing`:
  response shapes, costs, tool calls, streaming, the reason for each failure, no leaked provider text, cancellation,
  timeouts and strict schemas.
- They also check that nothing comes from the environment, that `ollama.com` takes only the key it is given, that a
  stopped server is `unavailable` and an error body is never read, call ids unique in the run, that thinking is sent
  back and never released, the two-request answer with tools and its charge, the schema in the instructions, images,
  and a run with a zero-priced model.
- It passed live runs against Ollama 0.34.4 in Docker on September 30, 2026, with a 2B vision model: structured
  output, tools, streaming and vision, including an image returned by a tool.
- `scripts/live/provider-ollama.mjs`, a structured answer and a tool call through a registry, passed on Ollama's cloud
  with `gpt-oss:20b` and `gpt-oss:120b` on October 12, 2026. The cloud accepted `format` without enforcing it, which is
  why requests also state the schema in their instructions.

## Related

- [Model registry](../guides/model-registry.md): ids, prices, the per-call bound, retries and chains.
- [Groq](provider-groq.md): the same gpt-oss models, hosted.
- [Model routing](../guides/model-routing.md): failover, circuit breakers and accounting.
- [Model providers](../guides/model-providers.md): `openAICompatibleChat`, which also reaches a local Ollama.
