---
title: "Costs and budgets"
description: "Cap what a run can spend: costs in micros, per-call ceilings, the run cost limit, tool costs and shared budgets."
---

Mayura counts money in **micros**: millionths of a US dollar, as integers. Every model call and tool call declares the
most it can cost. Before a call starts, the runtime reserves that amount from the run's budget; after it finishes, it
charges the actual cost and releases the rest. A call that does not fit in what is left never starts.

The run budget comes from the runtime's `limits.maxCostMicros`, and its default is **0**. Free calls work without it
(the scripted test model costs 0), but a paid model is refused until you set a limit.

## A budgeted agent

```ts
import { createRuntime, defineAgent } from 'mayura';
import { openAIResponses } from 'mayura/provider-openai';
import { z } from 'zod';

const agent = defineAgent({
  id: 'summarizer',
  version: '1',
  instructions: 'Summarize the text in three sentences.',
  input: z.object({ text: z.string().max(40_000) }),
  output: z.object({ summary: z.string() }),
  tools: [],
  model: openAIResponses({
    apiKey: process.env.OPENAI_API_KEY ?? '',
    model: 'gpt-5-mini',
    outputJsonSchema: {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
      additionalProperties: false,
    },
    // Your model's real prices, in micros per million tokens. $0.25 per million = 250_000.
    pricing: { inputMicrosPerMillionTokens: 250_000, outputMicrosPerMillionTokens: 2_000_000 },
    maxCostMicros: 20_000, // one call may cost at most $0.02
  }),
});

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: { allow: ['model:openai.responses'] },
  limits: { maxCostMicros: 50_000, maxModelCalls: 2, maxOutputTokens: 1_024 }, // the whole run: at most $0.05
});

const run = runtime.submit(agent, { input: { text: 'A long article to summarize.' } });
const outcome = await run.result();
console.log(outcome.status, runtime.inspect(run).budget);
await runtime.close();
```

## Micros

| Amount | Micros |
| --- | --- |
| $1 | `1_000_000` |
| 1 cent | `10_000` |
| $0.001 | `1_000` |
| 1 micro | $0.000001 |

Costs are whole numbers, so there is no rounding drift. Values must be non-negative safe integers.

## Model pricing and the per-call ceiling

A provider adapter such as `openAIResponses` takes the model's prices in micros per million tokens and computes each
call's cost from the token counts the provider reports:

```text
cost = (input tokens × input price + output tokens × output price) / 1,000,000, rounded up
```

The adapter's `maxCostMicros` is the ceiling for one call. The runtime reserves it before every call, so choose it from
the worst case: the largest input you expect plus `maxOutputTokens` of output. With the prices above, 20,000 input
tokens and 4,096 output tokens cost 5,000 + 8,192 = 13,192 micros, so a ceiling of 20,000 leaves room.

Mayura cannot stop a provider from charging more than you expected. If a call's actual cost is above its ceiling, the
full cost is still recorded, the run ends as `blocked` with `BUDGET_EXCEEDED`, and the run's budget accepts no further
calls.

The prices are the ones you configure. Mayura does not look them up, and its totals are an estimate from your prices,
not your provider's invoice.

## The run cost limit

`limits.maxCostMicros` caps the total cost of one run, including its child runs. It is per run, not per runtime: every
`submit` starts with a fresh budget of that size.

Before each model call, the runtime checks that the model's `maxCostMicros` fits in what is left. Before running a
batch of tool calls the model asked for, it checks that the `costMicros` of all of them fits. If not, the run ends as
`blocked` with `BUDGET_EXCEEDED`, and the call is not made.

So set the run limit to at least the per-call ceiling times the number of model calls you expect, plus your tools'
costs. In the example above, two calls of at most 20,000 micros fit in 50,000.

## Tool costs

A tool's `costMicros` (default 0) is the most one call can cost, for tools that spend money themselves: a paid API, an
SMS, a search query. It is reserved before the tool runs. If the tool does not say otherwise, a successful call is
charged the full amount. To charge less, report the real cost once from inside `execute`:

```ts
import { defineTool } from 'mayura';
import { z } from 'zod';

export const sendSms = defineTool({
  id: 'sms.send',
  version: '1',
  description: 'Send a text message to the signed-in customer.',
  input: z.object({ text: z.string().max(320) }),
  output: z.object({ segments: z.number() }),
  effects: 'write',
  capabilities: ['sms:send'],
  costMicros: 30_000, // at most 3 cents
  execute: async ({ text }, context) => {
    const sent = await sms.send(context.scope.principalId, text, { signal: context.signal });
    context.reportUsage({ knownCostMicros: sent.segments * 7_500, unknownCostMicros: 0 });
    return { segments: sent.segments };
  },
});
```

Reported cost may not exceed `costMicros`. Reporting `unknownCostMicros` above 0 says part of the cost is not settled,
and the call ends as `outcome_unknown`.

## When the cost is unknown

Sometimes Mayura cannot know what a call cost: a model call failed without the provider reporting usage, or a tool
with effects threw or timed out. Then the call's full ceiling stays reserved. It shows up as `reservedMicros` and still
counts against the budget. A timeout, a cancellation or closing the runtime never turns an unknown cost into zero.

If you write a model adapter, throw `ModelInvocationError` with the known cost when a call fails after the provider
reported usage, so that amount is charged instead of the whole ceiling.

## Reading costs

`runtime.inspect(run).budget` gives the run's totals, including its children, and the `run.completed` event carries
the same numbers:

| Field | What it is |
| --- | --- |
| `spentMicros` | Confirmed cost. A decimal string instead of a number if it ever exceeds the safe integer range. |
| `reservedMicros` | Held for calls in progress, and for calls whose cost is unknown. |
| `calls` | Model and tool calls started. |

## Budgets across runs

The runtime has no budget shared across runs. For a ceiling across many runs or your own calls, Mayura has two
building blocks:

- **`Budget`**, from `mayura`, is an in-memory budget with a cost ceiling and a call ceiling. `reserve(maxMicros)`
  throws `BUDGET_EXCEEDED` if a call does not fit; `settle(actual)` on the returned reservation records what it cost.
  `fork({ id, maxCostMicros, maxCalls })` makes a child budget that spends from the same funds with a lower ceiling.
  `invokeTool`, `invokeBatch` and `runBudgetedTasks` from `mayura/helpers` take a `Budget`.
- **Durable budgets** keep the same kind of ledger in SQLite or PostgreSQL through `store.durableBudgets`, so it
  survives restarts. See [Storage](../guides/storage.md).

```ts
import { Budget } from 'mayura';

const nightly = new Budget(5_000_000, 500); // $5 and 500 calls in total
const perTeam = nightly.fork({ id: 'team-a', maxCostMicros: 1_000_000, maxCalls: 100 });

const reservation = perTeam.reserve(20_000);
reservation.settle(12_400); // the confirmed cost
console.log(nightly.snapshot()); // { spentMicros: 12400, reservedMicros: 0, calls: 1 }
```

Totals of a budget include its children; don't add a parent's and a child's numbers together.

## Good to know

- Costs are checked before each call. A single call can still overrun its ceiling; Mayura records it and stops the
  run, but cannot undo the charge.
- `maxModelCalls`, `maxToolCalls` and `maxSteps` bound a run even when every call is free.
- Workflows take their own cost limits. See [Workflows](./workflows.md).

## Related

- [Runtime](./runtime.md)
- [Tools](./tools.md)
- [Model providers](../guides/model-providers.md)
- [Model routing](../guides/model-routing.md)
- [Helpers](../guides/helpers.md)
