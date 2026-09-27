# Qualify model providers against live accounts

Provider adapters are tested in CI only with fake transports. `pnpm providers:live-check` runs the same adapters
against **your** accounts, through the real runtime, and reports what passed. It sends paid requests. It runs only when
you set the variables below. It never looks for credentials, never reads files, and never prints a credential, a
prompt or a provider error body.

```sh
pnpm providers:live-check             # live: the providers you selected; costs money
pnpm providers:live-check --dry-run   # offline: the same checks against local fake transports; free and deterministic
```

The dry run reads no environment variables and never reaches the network. CI runs it on every push. It qualifies the
harness's own logic, not any provider.

## Configure

Prices and cost caps are required. Without them the harness refuses to run (exit code 2) and lists the variables it
needs. It names the variables, never their values. Check each model's current prices with its provider and set them in
micros (millionths of your billing currency) per million tokens.

| Variable | Required | Meaning |
|---|---|---|
| `MAYURA_LIVE_MAX_CALL_COST_MICROS` | yes | Per-call bound. Every adapter reserves it before each request. |
| `MAYURA_LIVE_MAX_TOTAL_COST_MICROS` | yes | Cap for the whole run, measured as Mayura charges it (see [Cost](#cost)). |
| `MAYURA_LIVE_MAX_OUTPUT_TOKENS` | no (1024) | `max_output_tokens` for every call. |
| `MAYURA_LIVE_TIMEOUT_MS` | no (60000) | Per-request timeout. |
| `MAYURA_LIVE_CHECKS` | no (all) | Comma-separated subset of `structured,tools,streaming,router_failover,router_streaming`. |

A provider is selected only by its model variable. A credential on its own selects nothing. Once a provider is
selected, its credential and both prices are required.

| Provider | Select with | Also required |
|---|---|---|
| OpenAI (`openAIResponses`) | `MAYURA_LIVE_OPENAI_MODEL` | `OPENAI_API_KEY`, `MAYURA_LIVE_OPENAI_INPUT_MICROS_PER_MILLION_TOKENS`, `MAYURA_LIVE_OPENAI_OUTPUT_MICROS_PER_MILLION_TOKENS` |
| Anthropic (`anthropicMessages`) | `MAYURA_LIVE_ANTHROPIC_MODEL` | `ANTHROPIC_API_KEY`, `MAYURA_LIVE_ANTHROPIC_INPUT_MICROS_PER_MILLION_TOKENS`, `MAYURA_LIVE_ANTHROPIC_OUTPUT_MICROS_PER_MILLION_TOKENS` |
| Remote OpenAI-compatible (`openAICompatibleChat` with `remote`) | `MAYURA_LIVE_COMPATIBLE=<id>,<id>…` | per id, below |

For each remote compatible provider, `<ID>` is the id in upper case with `-` replaced by `_`. For example, `groq`
becomes `GROQ`:

| Variable | Meaning |
|---|---|
| `MAYURA_LIVE_COMPATIBLE_<ID>_URL` | The exact HTTPS `/chat/completions` endpoint (see [Choose a model provider](model-providers.md)). |
| `MAYURA_LIVE_COMPATIBLE_<ID>_KEY` | The credential. For a short-lived token (for example Vertex AI), pass a freshly issued token. |
| `MAYURA_LIVE_COMPATIBLE_<ID>_MODEL` | The model name. |
| `MAYURA_LIVE_COMPATIBLE_<ID>_AUTH` | `bearer` (default) or `api-key` (Azure OpenAI). |
| `MAYURA_LIVE_COMPATIBLE_<ID>_INPUT_MICROS_PER_MILLION_TOKENS`, `…_OUTPUT_MICROS_PER_MILLION_TOKENS` | Prices. |

Unselected providers appear in the report as `skipped`, with the reason. They never appear as `passed`. The harness
constructs every adapter before it sends anything, so a refused endpoint or malformed credential stops the run before
any spend.

## What each check proves

Every check runs an agent through `defineAgent` and `createRuntime`, under a run budget and the adapter's grant. The
adapter is not called on its own. Checks run in order for each provider.

| Check | Passes when |
|---|---|
| `structured` | A trivial factual question returns a final answer that the provider produced under the strict output JSON Schema, that the runtime validated against a stricter schema, and that has the expected content. |
| `tools` | The model proposes a call to a local tool. The runtime executes the tool, which returns a random code the model cannot guess. The model's final answer is that exact code. This proves that tool results reach the model. |
| `streaming` | An agent with `stream: { field: ['reply'] }` streams through `adapter.stream()`. The provider sends at least 2 deltas. The released `output.delta` events are in index and sequence order, all from one model call, and each passed the batch guard. Their text concatenates exactly to the final `reply`. The streamed response reports a positive cost. |
| `router_failover` | A router routes first to the same provider with a deliberately invalid key, then to the valid configuration. The first attempt fails with an unknown cost, and the second succeeds. The run is charged the full per-call bound of the refused attempt plus the confirmed cost of the successful one, as [Route between model providers](model-routing.md) documents. |
| `router_streaming` | The same failover with a streaming agent. The refused route fails before any delta, so the router switches routes and the streaming evidence above holds. |
| `cost` | Every confirmed call cost is greater than 0 and within the per-call bound. Each run is charged no more than its budget. Each direct run's budget equals the sum of its reported call costs, and the harness total stays within `MAYURA_LIVE_MAX_TOTAL_COST_MICROS`. |

## What it does not prove

- **Prices.** Costs are computed from the prices you set and the token counts the provider reports. Compare the report
  with the provider's billing dashboard.
- **Other failover causes.** Only an authentication refusal is exercised. Rate limits, 5xx responses, timeouts and a
  stream that breaks after its first delta are covered by fake-transport tests only.
- **Model quality.** The questions are trivial and short. Long contexts, large outputs, parallel tool calls,
  multi-turn tool use, reasoning continuation beyond one tool round trip and other models or regions are not
  exercised.
- **Durability over time.** A pass qualifies this account, model and endpoint today. A provider can change behaviour
  later, so run the check again when you change models or upgrade Mayura.
- **Local compatible servers, token-source callbacks, embeddings and durable workflows** are out of scope.

A failure is a real result, not a harness defect: it tells you what this account, model or endpoint does differently
from what the adapter expects.

## Report and exit codes

The JSON report on stdout lists each provider and each check with `status` (`passed`, `failed` or `skipped`),
`durationMs`, `chargedMicros` and the number of model calls. A failed check has `reasons` and, when the run failed,
the runtime's public error `{ code, message }`. Router checks list each attempt's route, outcome and confirmed cost.
Every configured credential is redacted from the output as a last line of defence.

| Exit | Meaning |
|---|---|
| 0 | Every selected check passed. |
| 1 | A selected check failed, or the total exceeded the cap. |
| 2 | Refused: incomplete configuration, a total cap below the planned worst case, or invalid arguments. Nothing was sent. |

## Cost

Before sending anything, the harness computes a worst case in per-call bounds for each provider: `structured` 1,
`tools` 3, `streaming` 1, `router_failover` 2, `router_streaming` 2. Each router check reserves both of its routes. With
every check selected, that is 9 bounds per provider. The harness refuses to run when
`providers × 9 × MAYURA_LIVE_MAX_CALL_COST_MICROS` exceeds `MAYURA_LIVE_MAX_TOTAL_COST_MICROS`. Each check then runs
under its own run budget, and the harness stops starting checks if the next one could exceed the cap.

Choose the per-call bound so that it covers a full answer:
`MAYURA_LIVE_MAX_OUTPUT_TOKENS × output price / 1,000,000`, plus about 1,000 input tokens. The report warns when it does
not. A call that reports a cost above its bound is blocked by the runtime, and the check fails.

**Example with illustrative prices** (input 2,500,000 and output 10,000,000 micros per million tokens): a per-call
bound of 15,000 covers the default 1,024 output tokens. The total cap must be at least 135,000 per provider. Actual
spend is much lower. The run makes about 6 billable calls of a few hundred tokens each, typically under 10,000 micros
per provider. The refused-key attempts are not billed. The report's `chargedMicros` is higher than the actual spend,
because Mayura conservatively charges each refused attempt its full bound. Reasoning models count reasoning tokens as
output, so they cost more and may need a higher `MAYURA_LIVE_MAX_OUTPUT_TOKENS`.

The router checks send the invalid key `mayura-live-check-deliberately-invalid-key` to the provider's real endpoint.
Expect one failed-authentication entry per router check in the provider's logs.
