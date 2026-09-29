---
title: "Model registry"
description: "Name models as provider/model from @mayurajs provider packages, with explicit or catalog prices, a per-call cost bound, safe retries and fallback chains."
---

A model registry turns provider packages into models you can name. Each `@mayurajs/provider-*` package knows how to
call one provider through that provider's official SDK. `createModels` gives every model an id of the form
`<provider>/<model>`, a price and a per-call cost bound, and runtimes grant each model by that id.

```bash
npm install mayura @mayurajs/provider-openai
```

```ts
import { createModels, createRuntime, defineAgent, z } from 'mayura';
import { openai } from '@mayurajs/provider-openai';

const models = createModels({
  providers: [openai({ apiKey: process.env['OPENAI_API_KEY']! })],
  prices: { 'openai/gpt-5.1': { inputMicrosPerMillionTokens: 1_250_000, outputMicrosPerMillionTokens: 10_000_000 } },
  maxCallCostMicros: 50_000, // at most $0.05 per model call
});

const agent = defineAgent({
  id: 'helper', version: '1', instructions: 'Answer in one sentence.',
  model: models.model('openai/gpt-5.1'), tools: [],
  input: z.object({ question: z.string() }), output: z.object({ answer: z.string() }),
});

const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:openai/gpt-5.1'] }, limits: { maxCostMicros: 200_000 } });
```

The adapter's id is the model id, so the grant names the exact model: `model:openai/gpt-5.1`. Granting one model
never grants another.

## Prices

Every model needs a price, in micros per million tokens, and the registry refuses a model without one. There are two
ways to give it:

- **Your own prices**, in `prices` (by model id) or as `pricing` on one model. Use these when the numbers matter: they
  are the prices you pay, including any discount.
- **The provider package's catalog**, with `prices: 'catalog'`. Each provider package ships its provider's list prices
  and the date they were checked. Prices change, so a catalog can be out of date: `registry.list()` shows each model's
  catalog date.

```ts
const models = createModels({ providers: [openai({ apiKey })], prices: 'catalog', maxCallCostMicros: 50_000 });

for (const model of models.list()) console.log(model.id, model.catalogAsOf, model.pricing);
```

A price you give always wins over the catalog. See [Costs and budgets](../concepts/costs-and-budgets.md) for how a
call's cost is reserved and charged.

### Long prompts

Some providers bill long prompts at higher rates: OpenAI, for example, bills a prompt over 272K input tokens at twice
the input rate and one and a half times the output rate, for the whole request. Give those rates as `longContext`,
and provider packages charge them for any call whose input is over the threshold:

```ts
const models = createModels({
  providers: [openai({ apiKey })],
  maxCallCostMicros: 500_000,
  prices: {
    'openai/gpt-6-sol': {
      inputMicrosPerMillionTokens: 2_000_000, outputMicrosPerMillionTokens: 10_000_000,
      longContext: { aboveInputTokens: 272_000, inputMicrosPerMillionTokens: 4_000_000, outputMicrosPerMillionTokens: 15_000_000 },
    },
  },
});
```

Long-context rates must be at least the standard ones. Catalogs include them, and err towards charging more: they
charge cached input at the full input rate, apply the long-context rule wherever it might apply, and leave out
promotional prices, which rise when the promotion ends.

## The per-call bound

`maxCallCostMicros` is the most one model call may cost. The runtime reserves it before every call, and a call that
doesn't fit in the run's budget never starts. It is required: a registry without a bound is refused. A model can have
its own bound:

```ts
const large = models.model('openai/gpt-5.1', { maxCostMicros: 200_000 });
```

## Retries

`retry` calls the same model again after a rate limit, an unavailable provider or a timeout:

```ts
const model = models.model('openai/gpt-5.1', { retry: { attempts: 3, backoffMs: 500 } });
```

- It never retries after the caller cancels, after a failure that would repeat (an authentication error or a refused
  request), or once streamed text has been shown.
- Every attempt is charged: an attempt with a known cost is charged that, and one with an unknown cost its full bound.
  The model's per-call bound becomes `attempts` times its bound, so the reservation covers every attempt.
- Waits double from `backoffMs` (default 500 ms) and end as soon as the call is cancelled.

Model calls change nothing outside Mayura, so retrying them is safe. Tools are different: see
[Outcomes](../concepts/outcomes.md).

Provider packages turn off their SDK's own retries, so the registry is the only place a call is repeated.

## Chains

A chain tries several models in order, for example to keep answering through one provider's outage. It is a
[model router](model-routing.md) over registry models:

```ts
const support = models.chain('support', ['openai/gpt-5.1', 'openai/gpt-5.1-mini'], {
  models: { 'openai/gpt-5.1': { retry: { attempts: 2 } } },
});
```

The chain's id is yours to choose, and it is what runtimes grant: `model:support`. **Granting a chain grants every
model in it**, which is why its name is explicit rather than derived.

## Provider packages

| Package | Provider | Model ids |
|---|---|---|
| `@mayurajs/provider-anthropic` | Anthropic Claude, through the official `@anthropic-ai/sdk` and the Messages API | `anthropic/<model>` |
| `@mayurajs/provider-bedrock` | Amazon Bedrock (Claude, Nova, Llama, Mistral and more), through the official AWS SDK and the Converse API | `bedrock/<model or inference profile id>` |
| `@mayurajs/provider-google` | Google Gemini, through the official `@google/genai` SDK and the Gemini API | `google/<model>` |
| `@mayurajs/provider-openai` | OpenAI, through the official `openai` SDK and the Responses API | `openai/<model>` |

Each package:

- takes its credentials as options and never reads the environment: no API keys, base URLs or organizations are
  discovered;
- turns off its SDK's retries, and uses the time limit the registry gives it;
- sends tool inputs and structured output as strict JSON Schema, and reports why a call failed without passing on
  the provider's own error text;
- bounds request and response sizes;
- is published in step with `mayura`, with `mayura` as its peer dependency.

The packages of the 1.0 releases, `mayura/provider-openai` and `mayura/provider-anthropic`, keep working as before. See
[Model providers](model-providers.md).

## Writing a provider package

A provider is an object with an `id` (lowercase letters, digits and `-`) and a `model(name, settings)` function that
returns a `ModelAdapter`. The adapter must use `settings.id` as its id and `settings.maxCostMicros` as its bound, and
compute each call's cost from `settings.pricing`:

```ts
import type { ModelProvider } from 'mayura';

export const acme: ModelProvider = {
  id: 'acme',
  model: (name, settings) => acmeAdapter({ model: name, ...settings }),
};
```

`mayura/testing` has the contract every adapter must keep, as test cases any test runner can run. Give it a harness
that makes your adapter's transport answer each scenario, usually through your SDK's `fetch` option:

```ts
import { it } from 'vitest';
import { modelAdapterConformance, type ModelAdapterHarness } from 'mayura/testing';

const harness: ModelAdapterHarness = {
  adapter: (scenario, settings) => acme.model('model-1', settings),
};

for (const test of modelAdapterConformance) it(test.name, () => test.run(harness));
```

The cases check response shapes, costs, tool calls, streaming, the reason for each kind of failure, that provider
error text never leaks, cancellation, timeouts and strict schemas.

## Related

- [Model providers](model-providers.md): the adapters of Mayura 1.0, and every option.
- [Model routing](model-routing.md): failover, circuit breakers and accounting.
- [Permissions](../concepts/permissions.md): how `model:<id>` grants work.
