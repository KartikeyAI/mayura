# Run the first real-provider agent

This is an opt-in paid-network recipe. It uses the fixed OpenAI Responses endpoint through `mayura/provider-openai`; it has no fixture fallback and ordinary tests never execute it.

Set `OPENAI_API_KEY`, `MAYURA_OPENAI_MODEL`, `MAYURA_QUESTION`, `MAYURA_OPENAI_MAX_CALL_COST_MICROS`, `MAYURA_OPENAI_MAX_RUN_COST_MICROS`, `MAYURA_OPENAI_INPUT_MICROS_PER_MILLION_TOKENS`, and `MAYURA_OPENAI_OUTPUT_MICROS_PER_MILLION_TOKENS` in the process environment, then run `node examples/openai-agent.mjs`. Obtain the current model ID, model capabilities and prices from the provider and review them before setting the values; the example deliberately does not embed changeable pricing or discover credentials.

The adapter sends the credential only in the Authorization header to its fixed HTTPS endpoint. Definitions, events and errors do not contain it. HTTP 401/403 returns a safe authentication/model-access diagnostic; HTTP 429 returns a safe rate-limit diagnostic. Other rejected or malformed responses remain the generic `MODEL_FAILED` boundary. The adapter performs no retry. Application retry policy must respect idempotency, total budget and provider limits.

To qualify an adapter against your account, rather than run one agent, use `pnpm providers:live-check`. It checks structured output, tools, streaming, cost and router failover; see [Qualify model providers against live accounts](live-provider-checks.md).

The configured per-call maximum is reserved before dispatch. The run maximum is a separate total ceiling and must be at least the admitted call maximum. Cancellation stops new Mayura work and aborts the fetch, but cannot prove a provider received no request or incurred no usage.
