# @mayura/provider-openai

Explicit OpenAI Responses and loopback-only OpenAI-compatible Chat Completions adapters for Mayura.

`openAIResponses()` uses the fixed OpenAI endpoint, caller-supplied credentials, strict tools and structured output, bounded complete responses, and opaque same-provider continuation. `openAICompatibleChat()` is deliberately narrower: it accepts only an exact HTTP loopback `/v1/chat/completions` URL, never discovers credentials, and sends complete stateless histories for local servers such as explicitly configured developer runtimes. It is not a remote compatible-provider adapter.

Neither adapter retries, follows redirects, selects models or prices, grants tool authority, or performs a network call during import/construction. All proposed tool calls still pass through Mayura's broker.
