---
title: "Model routing"
description: "Fail over between model providers with createModelRouter: priority order, a circuit breaker and conservative cost accounting."
---

A model router is a model adapter made of other adapters. It tries them in priority order and moves to the next one
when a provider is down, slow, rate-limited or returns an unusable answer. Use it when an agent must keep answering
through a provider outage, or to fall back from one region or deployment to another.

Agents, tools and the runtime do not change: give the router to `defineAgent` like any other model, and grant it once.

```ts
import { createModelRouter, createRuntime, defineAgent } from 'mayura';
import { anthropicMessages } from 'mayura/provider-anthropic';
import { openAIResponses } from 'mayura/provider-openai';

const model = createModelRouter({
  id: 'router.support',
  routes: [
    anthropicMessages({
      apiKey: process.env.ANTHROPIC_API_KEY!, model: process.env.ANTHROPIC_MODEL!, outputJsonSchema,
      maxCostMicros: 20_000, pricing: claudePrices,
    }),
    openAIResponses({
      apiKey: process.env.OPENAI_API_KEY!, model: process.env.OPENAI_MODEL!, outputJsonSchema,
      maxCostMicros: 20_000, pricing: openAIPrices,
    }),
  ],
  circuit: { failureThreshold: 3, cooldownMs: 30_000 },
  onAttempt: attempt => console.log(attempt.modelId, attempt.outcome, attempt.reason ?? '', attempt.costMicros),
});

const agent = defineAgent({ id: 'support', version: '1', instructions, model, tools, input, output });
const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: { allow: ['model:router.support', 'tool:orders.lookup'] },
  limits: { maxCostMicros: 200_000 },
});
```

## Options

| Option | Default | Meaning |
|---|---|---|
| `id` | required | The router's adapter id. The runtime grants it as `model:<id>`. |
| `routes` | required | 1 to 8 adapters in priority order. Each keeps its own destination, key, prices and per-call bound. |
| `maxAttempts` | every route | The most routes tried for one call. |
| `circuit.failureThreshold` | 3 | Consecutive failures after which a route is skipped. |
| `circuit.cooldownMs` | 30,000 | How long a failing route is skipped before it is tried again. |
| `onAttempt` | none | Called after each attempt with metadata only (see below). It cannot change routing, and its errors are ignored. |
| `now` | `Date.now` | Clock for the circuit breaker, for tests. |

## When it fails over

The router moves to the next route after a timeout, a transport or provider failure, a rate limit, or a response it
cannot use. It does **not** fail over when:

- the caller cancels the run: the call ends as cancelled;
- an adapter throws a `MayuraError` with code `INVALID_CONFIG`, `PERMISSION_DENIED` or `INVALID_INPUT`. These are
  errors every route would repeat, so the call fails. Use these codes in your own adapters for such errors.

The built-in provider adapters report every failure as `MODEL_FAILED`, including a rejected key (HTTP 401 or 403), so a
route with a wrong key fails over to the next one rather than stopping the call. Watch `onAttempt` to notice it.

The router does not retry the same route, and adapters never retry. For more attempts, add routes: a second region or
deployment of the same model is a route too.

## Circuit breaker

A route that fails `failureThreshold` calls in a row is skipped for `cooldownMs`. After the cooldown it gets one trial
call: success closes the circuit, failure opens it again. Skipped routes are reported to `onAttempt` with
`outcome: 'skipped'` and `reason: 'circuit_open'`.

`router.status()` returns the state of each route:

```ts
for (const route of model.status()) {
  console.log(route.route, route.modelId, route.state, route.consecutiveFailures, route.openUntilMs);
}
```

`state` is `closed`, `open` or `half_open`. Circuit state lives in the process that created the router. Separate
processes, or separate router instances, keep separate state.

## What each attempt reports

`onAttempt` receives one object per attempt, with no prompt, output, key or provider error text:

| Field | Meaning |
|---|---|
| `route` | The route's index in `routes`. |
| `modelId` | The route's adapter id, for example `anthropic.messages`. |
| `outcome` | `succeeded`, `failed` or `skipped`. |
| `reason` | For failed or skipped attempts: `timeout`, `failed` or `circuit_open`. |
| `costMicros` | The attempt's confirmed cost, or `null` when unknown. |

## Accounting

The router's per-call bound (`router.maxCostMicros`) is the sum of the largest `maxAttempts` route bounds, because one
call may try that many routes. The runtime reserves that amount before each call, so the run's `maxCostMicros` must be
at least that large. With two routes of 20,000 micros each, every model call reserves 40,000.

After the call, the router reports what was actually spent:

- a successful attempt is charged its reported cost;
- a failed attempt with a known cost (the provider reported usage) is charged that cost;
- a failed attempt with an unknown cost, such as a timeout after the request was sent, is charged its full bound.

The run's budget therefore sees the worst case of every attempt. If every route fails and all costs are known, the
known total is charged; if any is unknown, the call keeps its full reservation.

## Streaming and continuation

The router streams when the agent has a stream policy (see [Streaming](streaming.md)). A route without streaming
answers through its ordinary call. The router can fail over only until the first piece of text has been released to
the reader. After that, a failure ends the call instead of splicing a second provider's answer onto the first.

Some providers keep state between the model calls of one run (for example OpenAI's reasoning items). A run stays on
the route that holds that state. If that route fails, the call moves to another route with only Mayura's own message
history; one provider's state is never sent to another.

## Choosing routes

- **Granting the router grants every route.** Put only destinations in a router that you would grant one by one.
- **Give every route the same contract**: the same `outputJsonSchema`, and models that support strict tool calls and
  structured output. Different models can still answer differently; failover keeps the agent available, it does not
  make answers identical.
- **A fallback may cost more.** Its bound counts toward every reservation even when it is never used.

## Related

- [Model providers](model-providers.md)
- [Streaming](streaming.md)
- [Costs and budgets](../concepts/costs-and-budgets.md)
- [Observability](observability.md)
