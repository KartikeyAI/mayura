# @mayura/provider-openai

Explicit OpenAI Responses and OpenAI-compatible Chat Completions adapters for Mayura.

`openAIResponses()` uses the fixed OpenAI endpoint, caller-supplied credentials, strict tools and structured output, bounded complete responses, and opaque same-provider continuation. `openAICompatibleChat()` sends complete stateless histories to a Chat Completions server. By default it accepts only an exact HTTP loopback `/v1/chat/completions` URL (local runtimes). With `remote: { id, auth? }` it reaches an explicit HTTPS provider endpoint (Groq, Together, Mistral, Azure OpenAI, Gemini's compatibility endpoint and others) under the adapter id `openai-compatible.<id>`. It never discovers credentials. Both adapters stream. See docs/how-to/model-providers.md.

Neither adapter retries, follows redirects, selects models or prices, grants tool authority, or performs a network call during import/construction. All proposed tool calls still pass through Mayura's broker.
