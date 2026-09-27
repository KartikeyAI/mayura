# Route between model providers with failover

`createModelRouter` (from `mayura` or `mayura/runtime`) is a model adapter that tries other adapters in priority
order when one is unavailable. Agents, tools and the runtime do not change: give the router to `defineAgent` like any
other model and grant it once.

```ts
import { createModelRouter, createRuntime, defineAgent } from 'mayura';
import { anthropicMessages } from 'mayura/provider-anthropic';
import { openAIResponses } from 'mayura/provider-openai';

const model = createModelRouter({
  id: 'router.support',
  routes: [
    anthropicMessages({ apiKey: anthropicKey, model: 'claude-...', outputJsonSchema, maxCostMicros: 20_000, pricing: claudePrices }),
    openAIResponses({ apiKey: openaiKey, model: 'gpt-...', outputJsonSchema, maxCostMicros: 20_000, pricing: openaiPrices }),
  ],
  circuit: { failureThreshold: 3, cooldownMs: 30_000 },
  onAttempt: attempt => metrics.count('model.attempt', attempt), // route, model id, outcome, reason, cost: never content
});
const agent = defineAgent({ id: 'support', version: '1', model, /* instructions, tools, input, output */ });
const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:router.support', /* tools */] } });
```

## What it does

- **Fails over** after a timeout, a provider or transport failure, a rate limit, or an unusable response. It never fails
  over after the caller cancels, or after a configuration or authorization error (`INVALID_CONFIG`,
  `PERMISSION_DENIED`, `INVALID_INPUT`), which every route would repeat.
- **Circuit breaker.** A route that fails `failureThreshold` calls in a row is skipped for `cooldownMs`, then tried once;
  success closes it. `router.status()` reports each route. The state is per process.
- **Conservative accounting.** The router's per-call bound is the sum of the bounds of the routes it may try
  (`maxAttempts`, default all). A failed attempt with a confirmed cost is charged that cost; one whose cost is unknown
  (for example a timeout after the request was sent) is charged its full bound. The call's reported usage is the sum,
  so the run budget sees the true worst case. If every route fails, the error carries the confirmed total when every
  cost is known, and otherwise the runtime keeps the full reservation.
- **Continuation stays with its provider.** A run stays on the route that holds its provider continuation (for
  example OpenAI's reasoning items). If that route fails, the call moves to another route with only Mayura's portable
  message history; one provider's protocol state is never sent to another.

## Choose routes deliberately

- **Grants.** Granting `model:<router id>` grants every route. Put only destinations you would grant individually in a
  router.
- **Same contract.** Give every route the same output JSON Schema and tools, and a model that supports strict tool
  calls and structured output. Different models can still answer differently; failover preserves availability, not
  identical output.
- **Cost.** A fallback may be more expensive. Its bound counts toward the run budget even if it is never used.
- **Retries.** The router does not retry the same route; adapters never retry. Add routes (for example a second region
  or deployment of the same model) rather than retries.
