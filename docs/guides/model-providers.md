---
title: "Model providers"
description: "Connect an agent to OpenAI, Anthropic or any OpenAI-compatible endpoint, with explicit keys, prices and a per-call cost limit."
---

A model provider adapter is the object an agent calls to reach a language model. Mayura ships three: OpenAI's
Responses API, Anthropic's Messages API, and a Chat Completions adapter for local servers and the many providers
that speak the OpenAI dialect. Every adapter has the same shape (a `ModelAdapter`), so agents, tools, guards and
budgets stay the same when you switch provider.

Adapters never look for credentials in the environment, never pick a model or a price for you, never retry, never
follow redirects and make no request until an agent calls them. You pass everything explicitly.

```ts
import { createRuntime, defineAgent } from 'mayura';
import { openAIResponses } from 'mayura/provider-openai';
import { z } from 'zod';

const Answer = z.object({ answer: z.string() });

const model = openAIResponses({
  apiKey: process.env.OPENAI_API_KEY!,
  model: process.env.OPENAI_MODEL!,
  maxCostMicros: 20_000, // at most $0.02 per model call
  // Use your model's current prices, in micros per million tokens ($0.40 = 400_000).
  pricing: { inputMicrosPerMillionTokens: 400_000, outputMicrosPerMillionTokens: 1_600_000 },
});

const agent = defineAgent({
  id: 'helper', version: '1', instructions: 'Answer the question in one sentence.',
  model, tools: [], input: z.object({ question: z.string() }), output: Answer,
});

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: { allow: ['model:openai.responses'] },
  limits: { maxCostMicros: 100_000 }, // at most $0.10 per run
});
try {
  const outcome = await runtime.submit(agent, { input: { question: 'What is a haiku?' } }).result();
  console.log(outcome.status === 'succeeded' ? outcome.output.answer : outcome.error);
} finally {
  await runtime.close();
}
```

## The adapters

| Function | Import from | Adapter id | Streams |
|---|---|---|---|
| `openAIResponses` | `mayura/provider-openai` | `openai.responses` | yes |
| `anthropicMessages` | `mayura/provider-anthropic` | `anthropic.messages` | yes |
| `openAICompatibleChat` (local) | `mayura/provider-openai` | `openai-compatible.chat` | yes |
| `openAICompatibleChat` (remote) | `mayura/provider-openai` | `openai-compatible.<id>` | yes |
| `createModelRouter` | `mayura` | the id you give it | yes |

A runtime lets an agent call a model only when its permissions include `model:<adapter id>`, for example
`model:anthropic.messages`. A run without that grant ends `blocked` with `PERMISSION_DENIED` before any request is
sent. To spread calls over several providers with failover, see [Model routing](model-routing.md).

`openAIResponses` sends requests to `https://api.openai.com/v1/responses` with `store: false`, and keeps OpenAI's
reasoning items between the model calls of one run. `anthropicMessages` sends them to
`https://api.anthropic.com/v1/messages`; it does not turn on prompt caching, extended thinking or provider-hosted
tools. Both destinations are fixed.

```ts
import { anthropicMessages } from 'mayura/provider-anthropic';

const claude = anthropicMessages({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  model: process.env.ANTHROPIC_MODEL!,
  maxCostMicros: 30_000,
  pricing: { inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000 },
});
```

## Options

All three adapters take these options. `openAICompatibleChat` adds `endpoint`, `remote` and `token`, and its `apiKey`
is optional.

| Option | Required | Meaning |
|---|---|---|
| `apiKey` | yes | The provider credential. Sent only in the request header. |
| `model` | yes | The provider's model id (up to 128 characters). |
| `outputJsonSchema` | no | JSON Schema of the final output. Leave it out: the runtime sends each agent's own (see below). |
| `maxCostMicros` | yes | The most one model call may cost. Reserved from the run budget before each call. |
| `pricing` | yes | `inputMicrosPerMillionTokens` and `outputMicrosPerMillionTokens`, as non-negative integers. |
| `timeoutMs` | no | Deadline for one call. Default 30,000. |
| `maxRequestBytes` | no | Largest request body, not counting images and PDFs (bounded by the run's `maxMediaBytes`). Default 1 MiB. |
| `media` | no | What the model can see, `{ types, urls }`. `openAIResponses` and `anthropicMessages` see every type and URLs unless told otherwise (`false` for a model that cannot see); `openAICompatibleChat` sees nothing unless told. See [Vision](vision.md). |
| `maxResponseBytes` | no | Largest response body. Default 1 MiB. |
| `fetch` | no | A `fetch`-compatible function to send requests through, for tests or a proxy. The destination does not change. |

Cost is computed from the token usage the provider reports and your prices, rounded up to a whole micro. Anthropic
cache-creation and cache-read tokens are charged at the input price. This is your own accounting, not the provider's
invoice: keep `pricing` current.

`maxCostMicros` is a per-call bound. The runtime's run limit (`limits.maxCostMicros`, default 0) must be at least as
large, or the first call cannot start. If a call reports a cost above its bound, the cost is still recorded and the
run stops with `BUDGET_EXCEEDED`. The runtime also sends `limits.maxOutputTokens` (default 4,096) as the provider's
output-token limit, so pick a bound that covers your largest prompt plus that many output tokens. See
[Costs and budgets](../concepts/costs-and-budgets.md).

## JSON Schemas

A provider needs the agent's output, and every tool's input, as JSON Schema. You don't write them: `defineAgent` and
`defineTool` generate them from your Zod schemas (any validator that implements Standard JSON Schema works; Zod 4.2
and later does), and the runtime sends the agent's output schema with every call. So one adapter can serve many agents.
Give `outputJsonSchema` to the adapter, or to `defineAgent`, only when your validator cannot describe itself.

Adapters ask the provider for strict structured output and strict tool calls, so the schemas must follow the strict
rules:

- the root is `type: 'object'`;
- every object lists all of its properties in `required` and sets `additionalProperties: false` (an object with no
  properties, such as the input of a tool that takes none, may leave `required` out).

In Zod terms: make a field the model may leave empty `.nullable()`, not `.optional()` or `.default()`, and avoid
`z.record`. Transforms are fine; the schema describes what the model writes. `defineAgent` checks every tool and the
output against these rules with the adapter you give it, and throws `INVALID_CONFIG` with the field and the fix:

```text
Agent support: The output schema: the object at /properties/tags must set additionalProperties to false; model
providers accept no open objects, records or maps.
```

The agent's `output` validator still checks the provider's answer after it arrives, so it may be stricter than the
JSON Schema.

Mayura sends each tool under its own id, made safe for provider function names: letters, digits, `_` and `-`, at most
64 characters. So `orders.list` reaches the model as `orders_list`, and instructions that name tools by id still
match. Two ids that come out the same (`orders.list` and `orders/list`) get `_2`, `_3` and so on. Mayura maps the
names back, and a call to a name that is not one of the agent's tools ends the run. Write descriptions that say what
each tool does and when to use it: the model chooses by name and description.

## OpenAI-compatible providers

Many providers and local model servers accept the OpenAI Chat Completions API. `openAICompatibleChat` talks to them.

**Local servers.** Without `remote`, the endpoint must be plain HTTP on `localhost`, `127.0.0.1` or `[::1]`, with the
exact path `/v1/chat/completions`. A key is optional.

```ts
import { openAICompatibleChat } from 'mayura/provider-openai';

const local = openAICompatibleChat({
  endpoint: 'http://127.0.0.1:11434/v1/chat/completions', // for example, Ollama's default port
  model: 'my-local-model',
  maxCostMicros: 0,
  pricing: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 },
});
```

**Remote providers.** Sending prompts to another host is a decision you make explicitly with `remote`. The endpoint
must be HTTPS and end in `/chat/completions`, with no credentials in the URL and no query other than `api-version`.
`remote.id` (lower-case letters, digits and hyphens) becomes part of the adapter id, so each provider is granted
separately: `remote: { id: 'groq' }` is granted as `model:openai-compatible.groq`. A remote provider needs `apiKey` or
`token`.

```ts
import { openAICompatibleChat } from 'mayura/provider-openai';

const groq = openAICompatibleChat({
  endpoint: 'https://api.groq.com/openai/v1/chat/completions',
  remote: { id: 'groq' },
  apiKey: process.env.GROQ_API_KEY!,
  model: process.env.GROQ_MODEL!,
  maxCostMicros: 10_000,
  pricing: { inputMicrosPerMillionTokens: 100_000, outputMicrosPerMillionTokens: 300_000 },
});
```

Commonly used endpoints (check each provider's current documentation):

| Provider | `endpoint` | `remote` |
|---|---|---|
| Groq | `https://api.groq.com/openai/v1/chat/completions` | `{ id: 'groq' }` |
| Together | `https://api.together.xyz/v1/chat/completions` | `{ id: 'together' }` |
| Fireworks | `https://api.fireworks.ai/inference/v1/chat/completions` | `{ id: 'fireworks' }` |
| Mistral | `https://api.mistral.ai/v1/chat/completions` | `{ id: 'mistral' }` |
| DeepSeek | `https://api.deepseek.com/beta/chat/completions` (with `output: 'json_object'`, `strictTools: true`; see below) | `{ id: 'deepseek' }` |
| OpenRouter | `https://openrouter.ai/api/v1/chat/completions` | `{ id: 'openrouter' }` |
| xAI | `https://api.x.ai/v1/chat/completions` | `{ id: 'xai' }` |
| Azure OpenAI | `https://<resource>.openai.azure.com/openai/deployments/<deployment>/chat/completions?api-version=<version>` | `{ id: 'azure', auth: 'api-key' }` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` | `{ id: 'gemini' }` |
| Cloudflare AI Gateway | `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/compat/chat/completions` (see below) | `{ id: 'cloudflare' }` |

**Check your provider with a small budget before you rely on it** (`pnpm providers:live-check` in the Mayura repository does this through the real runtime). Mayura's CI runs against fake servers; DeepSeek and Cloudflare AI Gateway have also passed the live check. The
adapter needs tool calls, structured output and reported token usage (for streaming, `stream_options.include_usage`).
A provider that answers differently, or leaves out usage, fails the call with a clear reason rather than being guessed
at. Providers that differ from OpenAI in known ways are configured with these options:

| Option | What it is for |
|---|---|
| `output: 'json_object'` | Providers with JSON mode but no JSON Schema output, such as DeepSeek. The schema goes into the instructions; Mayura still validates the answer. The default is `'json_schema'`. |
| `strictTools: true` | Sends `strict: true` on every function, for providers with strict tool calls (DeepSeek's `/beta` endpoint). |
| `tokenLimitField: 'max_completion_tokens'` | Sends the output-token limit as `max_completion_tokens`. OpenAI's newer models, directly or as `openai/...` through a gateway, refuse `max_tokens` (the default). |
| `headers` | Extra headers, such as Cloudflare AI Gateway's `cf-aig-authorization`. Treated as credentials; they cannot replace the key header, `Content-Type`, `Host` or cookies. |
| `body` | Extra request fields a provider defines, such as DeepSeek's `thinking`. They cannot replace the fields the adapter sets. |
| `media` | What the model can see, such as `{ types: ['image/png', 'image/jpeg'], urls: true }`. Images are sent as `image_url` parts; PDFs, if listed, as `file` parts and only as bytes. See [Vision](vision.md). |

**Thinking models.** Some providers return the model's reasoning with a tool call and require it back on the next
request (DeepSeek answers 400 without it). The adapter keeps each such turn, reasoning included, in the run's private
state and sends it back, so thinking models can use tools. The reasoning is never released as output or put in
events. `anthropicMessages` does the same for Claude's signed `thinking` and `redacted_thinking` blocks, which Claude
models may return before a tool call or an answer.

**DeepSeek.** It offers JSON mode but not JSON Schema output, and strict tool calls on its beta endpoint:

```ts
import { openAICompatibleChat } from 'mayura/provider-openai';

const deepseek = openAICompatibleChat({
  endpoint: 'https://api.deepseek.com/beta/chat/completions',
  remote: { id: 'deepseek' },
  apiKey: process.env.DEEPSEEK_API_KEY!,
  model: 'deepseek-flash',
  output: 'json_object',
  strictTools: true,
  maxCostMicros: 10_000,
  pricing, // check DeepSeek's current prices
});
```

Grant it as `model:openai-compatible.deepseek`. To turn thinking off, add `body: { thinking: { type: 'disabled' } }`.

**Cloudflare AI Gateway** fronts many providers with one OpenAI-compatible endpoint. Models are named
`provider/model`, such as `deepseek/deepseek-flash`. An authenticated gateway takes its token in `cf-aig-authorization`;
when the gateway stores the provider's key, no `apiKey` is needed. Use the dialect of the provider behind it:

```ts
import { openAICompatibleChat } from 'mayura/provider-openai';

const gateway = openAICompatibleChat({
  endpoint: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/compat/chat/completions`,
  remote: { id: 'cloudflare' },
  headers: { 'cf-aig-authorization': `Bearer ${process.env.CF_AIG_TOKEN}` },
  model: 'deepseek/deepseek-flash',
  output: 'json_object', // DeepSeek behind the gateway
  strictTools: true,
  maxCostMicros: 10_000,
  pricing,
});
```

For an OpenAI model behind the gateway (`openai/...`), leave `output` at its default, set
`tokenLimitField: 'max_completion_tokens'`, and check the model's own rules: some of OpenAI's reasoning models accept
function tools on Chat Completions only with reasoning turned off, which `body: { reasoning_effort: 'none' }` does. The
provider's 400 names the setting it refused.

`mayura init` sets up both: pick DeepSeek or Cloudflare AI Gateway in the wizard.

**Azure OpenAI** sends the key in the `api-key` header instead of `Authorization: Bearer`; set `auth: 'api-key'`.

**Vertex AI** uses short-lived Google access tokens. Pass `token` instead of `apiKey`: it is called before every
request, so each call gets a fresh token.

```ts
const vertex = openAICompatibleChat({
  endpoint: vertexChatCompletionsUrl, // Vertex AI's OpenAI-compatible endpoint for your project and region
  remote: { id: 'vertex' },
  token: () => getAccessToken(), // for example from google-auth-library
  model: process.env.VERTEX_MODEL!,
  maxCostMicros: 20_000,
  pricing,
});
```

The compatible adapter sends the whole conversation on every call. For OpenAI itself, use `openAIResponses`, which
keeps OpenAI's reasoning items between calls.

## Errors

A failed call ends the run with `MODEL_FAILED` and a message that says why (see [Outcomes](../concepts/outcomes.md)):

| Reason | For example | Message begins |
|---|---|---|
| `authentication` | HTTP 401 or 403 | The model provider refused the credentials or access to this model (HTTP 401). |
| `rate_limited` | HTTP 429, or 402 for quota | The model provider's rate limit or quota was reached (HTTP 429). |
| `unavailable` | HTTP 5xx or 408, Anthropic's 529, or no connection | The model provider was unavailable. |
| `timeout` | no answer within `timeoutMs` | The model provider did not answer in time. |
| `rejected` | any other HTTP error, such as 404 for an unknown model | The model provider rejected the request (HTTP 404). |
| `refused` | the model refused, or stopped at its token limit | The model refused to answer, or stopped before finishing. |
| `invalid_response` | an answer that is not the required JSON, or no token usage | The model provider returned a response Mayura could not use. |
| `configuration` | a schema the provider refuses (code `INVALID_CONFIG`) | The model adapter could not send this request. |

The messages are Mayura's own. Provider error bodies and your key never appear in outcomes or events. Cancelling a run aborts the request in flight, but cannot prove the
provider did no work, so an unconfirmed call keeps its full reservation.

## Writing your own adapter

Any object with this shape is a model adapter. Implement one for a provider Mayura does not cover, or to wrap an SDK
you already use:

```ts
import { MayuraError, type JsonValue, type ModelAdapter, type ModelRequest, type ModelResponse } from 'mayura';

export const myModel: ModelAdapter = {
  id: 'my-provider.chat', // granted as model:my-provider.chat
  capabilities: { tools: true, structuredOutput: true },
  maxCostMicros: 20_000,
  async generate(request: ModelRequest): Promise<ModelResponse> {
    // request.instructions, request.messages and request.tools describe the call; honour request.signal.
    const answer = await callMyProvider(request, { signal: request.signal }) as {
      readonly toolCalls: { readonly id: string; readonly toolId: string; readonly input: JsonValue }[];
      readonly output: JsonValue;
      readonly costMicros: number;
    };
    if (!answer) throw new MayuraError('MODEL_FAILED', 'The provider returned no answer.');
    if (answer.toolCalls.length > 0) {
      return { type: 'tool_calls', calls: answer.toolCalls, usage: { costMicros: answer.costMicros } };
    }
    return { type: 'final', output: answer.output, usage: { costMicros: answer.costMicros } };
  },
};
```

- `generate` returns either tool calls (each with its own `id`, the Mayura `toolId` and the input) or a final output,
  with the call's cost in micros. Mayura validates both before using them.
- To say why a call failed, throw `new ModelProviderError(reason, { httpStatus, costMicros })` with one of the reasons
  above: the outcome then carries Mayura's message for that reason. Pass `costMicros` when the provider reported
  usage before failing, so the known cost is charged; otherwise the call keeps its full `maxCostMicros` reservation.
  Any other error is reported with a generic message, since an adapter's own text never reaches an outcome.
- `capabilities.media`, `{ types, urls }`, declares the images and PDFs the model can see. Messages then carry
  `media` (bytes as `data`, or a `url`); `bytesToBase64`, `mediaDataUrl` and `encodedMediaBytes` from
  `mayura/core/host` help encode them. Leave it out for a model that cannot see. See [Vision](vision.md).
- An optional `checkDefinition(definition)` method lets `defineAgent` check the agent's tools and output schema once,
  so a problem shows when the agent is defined. `checkStrictDefinition` from `mayura/core/host` implements the strict
  rules above.
- An optional `stream(request)` method yields `{ type: 'output.delta', text }` fragments of the final output's JSON
  text, then exactly one `{ type: 'response', response }`. See [Streaming](streaming.md).
- `continuation` on a response is opaque state the runtime hands back on the next call of the same run.

For tests, `scriptedModel` from `mayura/testing` is a ready-made adapter; see [Testing](testing.md).

## Embeddings

`openAIEmbeddings({ apiKey, model, dimensions })` from `mayura/provider-openai` is an embedding adapter for native
memory, not a chat model. See [Memory and context](memory-and-context.md).

## Related

- [Model routing](model-routing.md)
- [Streaming](streaming.md)
- [Costs and budgets](../concepts/costs-and-budgets.md)
- [Permissions](../concepts/permissions.md)
- [Testing](testing.md)
