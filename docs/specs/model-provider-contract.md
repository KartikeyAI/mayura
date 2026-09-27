# Optional model adapters and opaque continuation

Status: multi-provider implementation contract. Requirements F01, F04, F17; partial V01, V09, V12, V19.

Model adapters are explicit optional packages. The basic SDK has no provider dependency, ambient API key lookup or hidden model selection. Applications provide credentials, model ID, output JSON Schema, current accounting rates and a conservative per-call bound. No default model/pricing is inferred. Adapter code and custom transports are trusted code.

## Opaque continuity

`ModelResponse.continuation` and the next `ModelRequest.continuation` carry bounded JSON protocol state for the same pinned adapter/run. The runtime stores a private immutable snapshot and never puts it in public events, tool arguments, user results or another run. Its bytes count toward request/response limits. Do not treat it as retrieved instructions or expose provider reasoning to users.

This is needed for provider protocols that require previous output items alongside function results. A provider receives only its own continuation; the framework does not automatically switch providers. Durable provider continuation remains a separate retention/encryption contract; this initial adapter is qualified only in the ephemeral agent runtime.

## OpenAI Responses adapter

Use the Responses endpoint with `store:false`, complete non-streamed responses, explicit strict tool schemas and strict structured final output. Preserve function call IDs and required reasoning protocol items, including encrypted continuation requested from the provider. Function names use a reversible per-definition alias map instead of assuming Mayura IDs fit provider naming restrictions. The app supplies a compatible model; availability is not inferred. [Function calling](https://developers.openai.com/api/docs/guides/function-calling), [Structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)

Do not follow redirects with credentials, retry automatically, invoke built-in provider tools or disclose raw error/response bodies. Bound request/response bytes, call counts, cancellation and timeout. Partial, refused, malformed or unsupported responses fail closed. Complete tool proposals still pass Mayura's broker; provider schema support never grants authority.

Token usage is converted using explicit application-supplied integer micro-USD rates per million tokens, rounding upward. This is configured accounting, not a provider invoice: cached discounts are conservatively ignored and prices can change. The runtime reserves the configured per-call bound; invalid/unknown usage stays reserved. A reported overrun is recorded and stops new admission, but cannot reverse a provider charge. No universal hard billing guarantee is advertised.

## Anthropic Messages adapter

`@mayura/provider-anthropic` uses only the fixed `https://api.anthropic.com/v1/messages` destination and fixed API version header, with an explicit application credential and model. It maps Mayura history to Messages content blocks, uses reversible aliases for client tools, enables strict input schemas, and requests a JSON-Schema final output. Provider-hosted tools, remote MCP, containers, prompt caching, extended thinking, redirects, retries and streaming are not enabled. [Messages API](https://platform.claude.com/docs/en/api/messages/create), [HTTP API](https://platform.claude.com/docs/en/api/http/messages), [strict tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use)

The adapter accepts only `tool_use` as a tool-call terminal reason and `end_turn` as a final terminal reason. Other reasons, mixed tool/text blocks, unknown aliases, duplicate call IDs and malformed structured output fail closed. Confirmed cost includes ordinary input, cache-creation input, cache-read input and output token counts using explicit integer rates. This is conservative configured accounting rather than invoice reconciliation.

## Local compatible adapter

`openAICompatibleChat()` provides an explicitly configured local path without treating “OpenAI compatible” as permission to send credentials or content to arbitrary hosts. It accepts only exact plain-HTTP loopback URLs at `/v1/chat/completions`, rejects user information, query strings, fragments and every non-loopback destination, and never reads ambient credentials. Applications may supply a bounded header credential when their local server requires one. The adapter sends the complete Mayura history on every call and intentionally rejects opaque continuation.

Compatible servers vary. Mayura requires the selected server/model to support Chat Completions tools, strict JSON-Schema response formatting and usage fields; unsupported or partial dialects fail closed. No local server process, model download, GPU runtime or model quality is bundled or qualified.

## Streaming

`ModelAdapter.stream?(request)` yields `{ type: 'output.delta', text }` fragments of the final output's raw text,
then exactly one `{ type: 'response', response }`. The runtime uses it only for agents with a `stream` policy, and
validates and accounts the response exactly as a `generate` result. Adapters never emit tool-argument fragments or
reasoning as deltas; events after the response, a missing response or an unknown event fail the call. The Responses
adapter sends `stream: true` and parses the `response.completed` event's embedded response with the buffered code;
the Messages adapter rebuilds the message from `message_start`, content-block and `message_delta` events. Both read
the stream through the bounded `readServerSentEvents` decoder in `@mayura/core/host` and present it with
`streamModelCall`, which aborts the request when the consumer stops reading. See [Stream an agent's answer](../how-to/streaming.md).

## Provider router

`createModelRouter` is a trusted `ModelAdapter` over 1–8 route adapters in priority order. It is the only place Mayura
switches providers, and it does so only between calls, never within one. Failover follows timeouts (an adapter's own
`CANCELLED` while the caller's signal is live), provider/transport failures and unusable responses; caller
cancellation and `INVALID_CONFIG`/`PERMISSION_DENIED`/`INVALID_INPUT` stop routing. The router's `maxCostMicros` is the
sum of the largest `maxAttempts` route bounds, and reported usage adds each failed attempt's confirmed cost or, when
unknown, its full bound. The router's continuation is `{ router, route, inner? }`: the next call starts on that route
with its own `inner` state, and any other route receives the request without continuation. Circuit state is
per-process. `stream` fails over only until the first delta has been released; a later failure ends the call. See [Route between model providers](../how-to/model-routing.md).

## Qualification

Known usage is accounted independently of content validity. `ModelInvocationError(costMicros)` carries a confirmed cost with a fixed safe message when a provider refuses or returns unusable content. Valid usage on a malformed model envelope still settles; unconfirmed HTTP/transport failures retain reservations. Late completion may settle known usage without reopening a terminal result or exposing raw content.

Inject a deterministic HTTP transport to verify outgoing fields, alias/correlation round trips, continuation rules, usage, oversized bodies, malformed JSON, refusal, timeout, HTTP errors and no redirected credentials. The packed isolated provider profile additionally proves both provider packages install with only core and execute against injected transports without ancestor workspace fallback. These tests make no paid calls. Real-account/model acceptance, local runtime interoperability, provider outage evaluation and live pricing qualification remain release gates and require explicitly configured credentials.
