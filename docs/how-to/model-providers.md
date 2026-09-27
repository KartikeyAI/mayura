# Choose a model provider

Every provider is a `ModelAdapter`: agents, tools, guards, budgets and the runtime do not change when you switch. A
runtime grants each adapter explicitly as `model:<adapter id>`.

| Adapter | Package | Adapter id | Streams |
|---|---|---|---|
| `openAIResponses` | `mayura/provider-openai` | `openai.responses` | yes |
| `anthropicMessages` | `mayura/provider-anthropic` | `anthropic.messages` | yes |
| `openAICompatibleChat` (local) | `mayura/provider-openai` | `openai-compatible.chat` | yes |
| `openAICompatibleChat` (remote) | `mayura/provider-openai` | `openai-compatible.<id>` | yes |
| `createModelRouter` | `mayura` | your router id | yes |

All adapters take the output JSON Schema, explicit prices per million tokens and a per-call cost bound. None reads
credentials from the environment, retries, follows redirects or makes a request when it is created.

## OpenAI-compatible providers

Many providers serve the OpenAI Chat Completions API. `openAICompatibleChat` reaches a local server by default
(loopback HTTP only). To send prompts to a remote provider, name it explicitly with `remote`:

```ts
import { openAICompatibleChat } from 'mayura/provider-openai';

const model = openAICompatibleChat({
  endpoint: 'https://api.groq.com/openai/v1/chat/completions',
  remote: { id: 'groq' },                  // adapter id 'openai-compatible.groq'; grant 'model:openai-compatible.groq'
  apiKey: process.env.GROQ_API_KEY!,        // or token: () => freshAccessToken()
  model: '<model name>', outputJsonSchema, maxCostMicros, pricing,
});
```

The endpoint must be HTTPS and end in `/chat/completions`, with no credentials in the URL and no query other than
`api-version`. Each remote provider gets its own adapter id, so granting one never grants another.

Commonly used endpoints (check each provider's current documentation; Mayura has not qualified them against live
accounts):

| Provider | `endpoint` | `remote` |
|---|---|---|
| Groq | `https://api.groq.com/openai/v1/chat/completions` | `{ id: 'groq' }` |
| Together | `https://api.together.xyz/v1/chat/completions` | `{ id: 'together' }` |
| Fireworks | `https://api.fireworks.ai/inference/v1/chat/completions` | `{ id: 'fireworks' }` |
| Mistral | `https://api.mistral.ai/v1/chat/completions` | `{ id: 'mistral' }` |
| DeepSeek | `https://api.deepseek.com/chat/completions` | `{ id: 'deepseek' }` |
| OpenRouter | `https://openrouter.ai/api/v1/chat/completions` | `{ id: 'openrouter' }` |
| xAI | `https://api.x.ai/v1/chat/completions` | `{ id: 'xai' }` |
| Azure OpenAI | `https://<resource>.openai.azure.com/openai/deployments/<deployment>/chat/completions?api-version=<version>` | `{ id: 'azure', auth: 'api-key' }` |
| Gemini (OpenAI compatibility) | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` | `{ id: 'gemini' }` |

Vertex AI's OpenAI-compatible endpoint uses short-lived Google access tokens: pass `token: () => getAccessToken()`
instead of `apiKey`; it is called for every request.

**"Compatible" is partial.** Mayura requires strict tool calls, strict JSON-Schema output (`response_format`), and
reported token usage (for streaming, `stream_options.include_usage`). A provider or model that answers in another
dialect or omits usage is refused rather than guessed at. Verify your provider and model with a live check before
production.

## Qualify a provider against your account

`pnpm providers:live-check` runs structured output, a tool round trip, streaming, cost accounting and router failover
against the providers you select with explicit environment variables, under required price and cost caps. See
[Qualify model providers against live accounts](live-provider-checks.md).

## Native adapters

Use `openAIResponses` for OpenAI and `anthropicMessages` for Anthropic; they support provider features the
compatible layer does not (for example OpenAI's reasoning continuation). AWS Bedrock's native API (SigV4 signing,
Converse) and Vertex AI's native API are not covered by an adapter yet; reach them through an OpenAI-compatible
endpoint where the provider offers one, or implement a `ModelAdapter`.

## Several providers

Wrap adapters in `createModelRouter` to fail over between them. See [Route between model providers](model-routing.md).
