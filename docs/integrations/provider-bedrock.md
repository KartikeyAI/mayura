---
title: "Amazon Bedrock models"
description: "Call Claude, Nova, Llama and Mistral models on Amazon Bedrock with @mayurajs/provider-bedrock: model ids, catalog prices, credentials and errors."
package: "@mayurajs/provider-bedrock"
vendor: "Amazon Web Services"
logo: "aws"
website: "https://aws.amazon.com/bedrock/"
area: "providers"
---

[Amazon Bedrock](https://aws.amazon.com/bedrock/) serves models from Anthropic, Amazon, Meta, Mistral and others in
your AWS account. `@mayurajs/provider-bedrock` is a provider package for the
[model registry](../guides/model-registry.md): every Bedrock model or inference profile gets an id such as
`bedrock/global.anthropic.claude-sonnet-5-5`, which you price, bound and grant like any other registry model. It calls
Bedrock's Converse API through the official AWS SDK, `@aws-sdk/client-bedrock-runtime` pinned at 3.1141.0, which is
its only dependency (`mayura` is a peer). The SDK's HTTP handler is replaced with one built on `fetch`, and the package
itself uses no Node built-in modules; its `engines` field names Node.js 22 (22.12 or later) and 24 (24.14.1 or later),
and its tests run on Node.

## Install

```bash
npm install mayura @mayurajs/provider-bedrock
```

## Credentials

Give the package one of:

- **AWS credentials**, used to sign requests with SigV4: an access key id and secret access key (and a session token
  for temporary credentials), or a function that returns fresh ones, for example from your own STS call. Create them
  for an IAM user or role in the [IAM console](https://console.aws.amazon.com/iam/).
- **A Bedrock API key**, sent as a bearer token instead of signing. Create one in the
  [Bedrock console](https://console.aws.amazon.com/bedrock/) under **API keys**.

The package calls only `Converse` and, for streaming, `ConverseStream`, so the identity needs `bedrock:InvokeModel`
and `bedrock:InvokeModelWithResponseStream` on the models and inference profiles you use. Turn on access to each model
in your account first.

The package reads nothing from the environment, AWS config or credentials files, or instance metadata: not
`AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_BEARER_TOKEN_BEDROCK`, `AWS_ENDPOINT_URL`,
`AWS_MAX_ATTEMPTS` or `AWS_AUTH_SCHEME_PREFERENCE`. Pass the region and credentials in yourself, for example from
`AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN`, or `AWS_BEARER_TOKEN_BEDROCK` for an
API key.

## Use it

```ts
import { createModels, createRuntime, defineAgent, z } from 'mayura';
import { bedrock } from '@mayurajs/provider-bedrock';

const models = createModels({
  providers: [bedrock({
    region: 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? '',
    },
  })],
  prices: 'catalog',          // on-demand list prices in us-east-1 on the catalog's date
  maxCallCostMicros: 100_000, // at most $0.10 per model call
});

const id = 'bedrock/global.anthropic.claude-sonnet-5-5';
const agent = defineAgent({
  id: 'support', version: '1', instructions: 'Answer the customer in one or two sentences.',
  model: models.model(id, { retry: { attempts: 2 } }), tools: [],
  input: z.object({ question: z.string() }), output: z.object({ answer: z.string() }),
});

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: { allow: [`model:${id}`] },
  limits: { maxCostMicros: 500_000 }, // at most $0.50 per run
});
try {
  const outcome = await runtime.submit(agent, { input: { question: 'Where is my order?' } }).result();
  console.log(outcome.status === 'succeeded' ? outcome.output.answer : outcome.error);
} finally {
  await runtime.close();
}
```

The adapter's id is the model id, so the run needs `model:bedrock/global.anthropic.claude-sonnet-5-5`, and that grant
admits no other model or profile. A run without it ends `blocked` with `PERMISSION_DENIED` before any request is sent.
See [Permissions](../concepts/permissions.md).

For short-lived credentials, pass a function. It is asked for credentials as the SDK needs them:

```ts
const provider = bedrock({ region: 'eu-west-1', credentials: async () => assumeRole() });
```

## Model ids

A model id is `bedrock/<name>`, where `<name>` is a Bedrock model id or inference profile id as Bedrock takes it: up to
120 letters, digits and `.`, `_`, `:`, `/` or `-`, such as `bedrock/global.anthropic.claude-sonnet-5-5` or
`bedrock/amazon.nova-pro-v1:0`. Inference profiles that start with `global.` route anywhere; those that start with
`us.` stay in the US, at a higher price. Any name works once it has a price; the catalog prices the ones below.

## Catalog prices

`prices: 'catalog'` uses Bedrock's on-demand list prices in US East (N. Virginia) as of **2026-09-29**, from the
[Bedrock pricing page](https://aws.amazon.com/bedrock/pricing/). Other regions can cost more, so the catalog is offered
**only by a provider whose `region` is `us-east-1`**; elsewhere, give every model's price yourself. In US dollars per
million tokens:

| Model or inference profile | Input | Output | Context | Max output |
| --- | --- | --- | --- | --- |
| `global.anthropic.claude-opus-5-5` | $4 | $20 | 1,000,000 | 128,000 |
| `us.anthropic.claude-opus-5-5` | $4.40 | $22 | 1,000,000 | 128,000 |
| `global.anthropic.claude-sonnet-5-5` | $2 | $10 | 1,000,000 | 128,000 |
| `us.anthropic.claude-fable-5-1` | $11 | $55 | 1,000,000 | 128,000 |
| `global.anthropic.claude-haiku-4-5-20251001-v1:0` | $1 | $5 | 200,000 | 64,000 |
| `us.anthropic.claude-haiku-4-5-20251001-v1:0` | $1.10 | $5.50 | 200,000 | 64,000 |
| `global.amazon.nova-2-lite-v1:0` | $0.30 | $2.50 | 1,000,000 | 64,000 |
| `us.amazon.nova-2-lite-v1:0` | $0.33 | $2.75 | 1,000,000 | 64,000 |
| `amazon.nova-premier-v1:0` | $2.50 | $12.50 | 1,000,000 | 25,000 |
| `amazon.nova-pro-v1:0` | $0.80 | $3.20 | 300,000 | 5,000 |
| `amazon.nova-lite-v1:0` | $0.06 | $0.24 | 300,000 | 5,000 |
| `amazon.nova-micro-v1:0` | $0.035 | $0.14 | 128,000 | 5,000 |
| `us.meta.llama4-maverick-17b-instruct-v1:0` | $0.24 | $0.97 | 1,000,000 | 8,000 |
| `us.meta.llama4-scout-17b-instruct-v1:0` | $0.17 | $0.66 | 10,000,000 | 8,000 |
| `us.meta.llama3-3-70b-instruct-v1:0` | $0.72 | $0.72 | 128,000 | 4,000 |
| `mistral.mistral-large-3-675b-instruct` | $0.50 | $1.50 | 256,000 | 32,000 |
| `mistral.ministral-3-8b-instruct` | $0.15 | $0.15 | 128,000 | 8,000 |
| `mistral.devstral-2-123b` | $0.40 | $2 | 256,000 | 32,000 |

Prices change: `models.list()` shows each model's `catalogAsOf`, context and output limits, and the catalog is exported
as `catalog`. A price you give, in `prices` or as `pricing` on one model, always wins, and is the only way to price a
model outside `us-east-1`:

```ts
const models = createModels({
  providers: [bedrock({ region: 'eu-west-1', credentials: async () => assumeRole() })],
  // Check the price in your region on the Bedrock pricing page.
  prices: { 'bedrock/global.anthropic.claude-sonnet-5-5': { inputMicrosPerMillionTokens: 2_000_000, outputMicrosPerMillionTokens: 10_000_000 } },
  maxCallCostMicros: 100_000,
});
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `region` | required | The AWS region, such as `us-east-1`. |
| `credentials` | none | AWS credentials, `{ accessKeyId, secretAccessKey, sessionToken? }`, or a function returning them (with an optional `expiration`). Give this or `apiKey`. |
| `apiKey` | none | A Bedrock API key, sent as a bearer token. Give this or `credentials`. |
| `baseURL` | `https://bedrock-runtime.<region>.amazonaws.com` | Where requests go instead, such as a VPC endpoint. https only. |
| `media` | PNG, JPEG, WebP, GIF and PDF, as bytes | What the models can see, `{ types, urls: false }`; `false` for none. URLs are not accepted. |
| `maxRequestBytes` | 1 MiB | Largest request JSON, not counting media bytes (the run's `maxMediaBytes` bounds those). |
| `maxResponseBytes` | 1 MiB | Largest response body; four times that for a stream. A larger one fails without being read into memory. |
| `timeoutMs` | 60,000 | How long one call may take, unless the registry or the model sets `timeoutMs`. |
| `fetch` | `globalThis.fetch` | The transport, for tests and proxies. Redirects are never followed. |

The registry's `timeoutMs` (on `createModels` or on one model, 100 to 3,600,000 ms) wins over the provider's.

## What it sends and supports

- **Structured output.** Every call asks for the agent's output as JSON Schema (`outputConfig.textFormat` of type
  `json_schema`), and tools are sent with `strict: true` and an `auto` tool choice. The schemas must follow the
  [strict rules](../guides/model-providers.md#json-schemas); `defineAgent` checks them when the agent is defined. Use
  models that Bedrock offers structured output and tool use for.
- **Streaming.** With a [stream policy](../guides/streaming.md) on the agent, the package calls `ConverseStream` and
  reports output text as the model writes it.
- **Reasoning.** Reasoning a model returns with a tool call, its signature and redacted reasoning included, is kept in
  the run's private state and sent back on the next call. It is never released as output or put in events. That state
  names the provider and model, so it never moves to another provider or model.
- **Narration.** Text a model writes before a tool call is not an answer and is dropped.
- **Images and PDFs.** By default the models see PNG, JPEG, WebP, GIF and PDF, sent as bytes. Images a tool returns go
  inside its tool result, PDFs right after it. Media given as a URL fails the call with `configuration`. See
  [Vision](../guides/vision.md).
- **Output tokens.** `inferenceConfig.maxTokens` is the run's `limits.maxOutputTokens` (4,096 unless you set it).

## Costs

Each call's cost is Bedrock's reported usage at your prices, rounded up to a whole micro:

- input tokens at the input rate;
- cache-write tokens at **twice** the input rate and cache-read tokens at the full input rate, so a budget never
  undercounts;
- output tokens at the output rate.

The tokens reported to events and traces count cache writes and reads as input.

`maxCallCostMicros` (or a model's `maxCostMicros`) is reserved before every call, and a call that doesn't fit in the
run's budget never starts. Choose it to cover your largest prompt plus `maxOutputTokens`: on
`global.anthropic.claude-sonnet-5-5`, 20,000 input tokens and 4,096 output tokens cost at most 40,000 + 40,960 = 80,960
micros. A call whose cost is unknown, such as one that timed out after it was sent, is charged its full bound. See
[Costs and budgets](../concepts/costs-and-budgets.md).

## Retries and fallback

The SDK makes one attempt per call (`maxAttempts: 1`). Retries belong to the registry:

```ts
const model = models.model('bedrock/global.anthropic.claude-sonnet-5-5', { retry: { attempts: 3, backoffMs: 500 } });
```

- `retry` calls the model again after `rate_limited` (Bedrock's throttling), `unavailable` or `timeout`; never after
  the caller cancels, a failure that would repeat, or once streamed text was released.
- `attempts` is 1 to 5, and the model's bound becomes `attempts` times its bound. Every attempt is charged.
- Waits double from `backoffMs` (default 500 ms).

To fall back to another model or region, use a chain. It is a [model router](../guides/model-routing.md) granted by the
name you choose, and granting it grants every model in it:

```ts
const support = models.chain('support', ['bedrock/global.anthropic.claude-sonnet-5-5', 'bedrock/global.amazon.nova-2-lite-v1:0']);
// Grant model:support.
```

A second provider in another region is a route too, but the registry takes each provider id once, so register it in a
second registry and combine the adapters with `createModelRouter`.

## Errors

A failed call ends the run with `MODEL_FAILED` and a `reason` (see [Errors](../guides/model-providers.md#errors) for the
messages):

| `reason` | When |
| --- | --- |
| `authentication` | HTTP 401 or 403: credentials Bedrock refuses, or no access to the model. |
| `rate_limited` | HTTP 429 (throttling), 402, or a throttling event inside a stream. |
| `unavailable` | HTTP 408 or 5xx, no connection, or a service, internal, model-stream or model-timeout error inside a stream. |
| `timeout` | No answer within `timeoutMs`. |
| `rejected` | Any other HTTP error, such as a 400 validation error, a validation error inside a stream, or the prompt exceeding the model's context window. |
| `refused` | The model stopped at the output-token limit, or a content filter or guardrail intervened. |
| `invalid_response` | An answer that is not the required JSON, a response without usage, or one larger than `maxResponseBytes`. |
| `configuration` | A schema that breaks the strict rules, or media given as a URL (code `INVALID_CONFIG`). |

Bedrock's error text and your credentials never appear in outcomes or events. Options the package cannot use, such as a
malformed region, both or neither of `credentials` and `apiKey`, credentials without both keys, an `http://` `baseURL`,
or `media` with URLs, throw `INVALID_CONFIG` when you call `bedrock()`; a malformed model id throws it when you call
`models.model()`.

## How it is tested

- Unit tests run the package through the AWS SDK against a fake Converse API, given through `fetch`, including AWS's
  event-stream framing for streams. It passes the
  [model adapter conformance suite](../guides/model-registry.md#writing-a-provider-package) from `mayura/testing`:
  response shapes, costs, tool calls, streaming, the reason for each failure, no leaked provider text, cancellation,
  timeouts and strict schemas.
- They also check that requests are signed with the given credentials in the given region, once, with nothing from
  the environment or AWS config; that an API key is sent as a bearer token; the cache-token charges; that reasoning is
  sent back and never released; and that the catalog is offered only in `us-east-1`.
- It has not been run against a real AWS account yet.

## Related

- [Model registry](../guides/model-registry.md): ids, prices, the per-call bound, retries and chains.
- [Anthropic](provider-anthropic.md): Claude models straight from Anthropic.
- [Model routing](../guides/model-routing.md): failover, circuit breakers and accounting.
- [Costs and budgets](../concepts/costs-and-budgets.md): how a call's cost is reserved and charged.

### RAG embeddings

This provider exports `titanEmbeddings` for scoped RAG ingestion and retrieval. See [the RAG guide](../guides/rag.md) for explicit permissions, cost ceilings and sensitivity profiles. Offline embedding tests passed locally with fake transports. Live embedding service behavior remains unqualified; see [release validation status](../guides/release-readiness.md).
