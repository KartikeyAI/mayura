# Optional model adapters and opaque continuation

Status: first provider implementation contract. Requirements F01, F04, F17; partial V01, V09, V12, V19.

Model adapters are explicit optional packages. The basic SDK has no provider dependency, ambient API key lookup or hidden model selection. Applications provide credentials, model ID, output JSON Schema, current accounting rates and a conservative per-call bound. No default model/pricing is inferred. Adapter code and custom transports are trusted code.

## Opaque continuity

`ModelResponse.continuation` and the next `ModelRequest.continuation` carry bounded JSON protocol state for the same pinned adapter/run. The runtime stores a private immutable snapshot and never puts it in public events, tool arguments, user results or another run. Its bytes count toward request/response limits. Do not treat it as retrieved instructions or expose provider reasoning to users.

This is needed for provider protocols that require previous output items alongside function results. A provider receives only its own continuation; the framework does not automatically switch providers. Durable provider continuation remains a separate retention/encryption contract; this initial adapter is qualified only in the ephemeral agent runtime.

## OpenAI Responses adapter

Use the Responses endpoint with `store:false`, complete non-streamed responses, explicit strict tool schemas and strict structured final output. Preserve function call IDs and required reasoning protocol items, including encrypted continuation requested from the provider. Function names use a reversible per-definition alias map instead of assuming Mayura IDs fit provider naming restrictions. The app supplies a compatible model; availability is not inferred. [Function calling](https://developers.openai.com/api/docs/guides/function-calling), [Structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)

Do not follow redirects with credentials, retry automatically, invoke built-in provider tools or disclose raw error/response bodies. Bound request/response bytes, call counts, cancellation and timeout. Partial, refused, malformed or unsupported responses fail closed. Complete tool proposals still pass Mayura's broker; provider schema support never grants authority.

Token usage is converted using explicit application-supplied integer micro-USD rates per million tokens, rounding upward. This is configured accounting, not a provider invoice: cached discounts are conservatively ignored and prices can change. The runtime reserves the configured per-call bound; invalid/unknown usage stays reserved. A reported overrun is recorded and stops new admission, but cannot reverse a provider charge. No universal hard billing guarantee is advertised.

## Qualification

Known usage is accounted independently of content validity. `ModelInvocationError(costMicros)` carries a confirmed cost with a fixed safe message when a provider refuses or returns unusable content. Valid usage on a malformed model envelope still settles; unconfirmed HTTP/transport failures retain reservations. Late completion may settle known usage without reopening a terminal result or exposing raw content.

Inject a deterministic HTTP transport to verify outgoing fields, alias/correlation round trips, continuation, usage, oversized bodies, malformed JSON, refusal, timeout, HTTP errors and no redirected credentials. These tests make no paid calls. Real-account/model acceptance, provider outage evaluation and live pricing qualification remain release gates and require explicitly configured credentials.
