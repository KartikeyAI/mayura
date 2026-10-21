# mayura/provider-openai

Explicit OpenAI Responses and OpenAI-compatible Chat Completions adapters for Mayura.

`openAIResponses()` uses the fixed OpenAI endpoint, caller-supplied credentials, strict tools and structured output, bounded complete responses, and opaque same-provider continuation. `openAICompatibleChat()` sends complete stateless histories to a Chat Completions server. By default it accepts only an exact HTTP loopback `/v1/chat/completions` URL (local runtimes). With `remote: { id, auth? }` it reaches an explicit HTTPS provider endpoint (Groq, Together, Mistral, Azure OpenAI, Gemini's compatibility endpoint and others) under the adapter id `openai-compatible.<id>`. It never discovers credentials. Both adapters stream. See [Model providers](../../docs/guides/model-providers.md).

Both adapters take a conversation history (`capabilities.history`) and send it before the run's own messages on every call, in the API's own message form: earlier tool calls without reasoning, which history does not carry, and an earlier final answer as assistant text holding its JSON.

Neither adapter retries, follows redirects, selects models or prices, grants tool authority, or performs a network call during import/construction. All proposed tool calls still pass through Mayura's broker.

Compatible Chat Completions supports host-configured long-context prices and optional USD gateway cost fields via `reportedCost`, retaining the maximum charge source even when output parsing fails. See [AI gateways](../../docs/guides/ai-gateways.md).
