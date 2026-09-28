---
title: "Agents"
description: "Define an agent: instructions, a model, typed tools and typed input and output, checked once and reused for every run."
---

An agent in Mayura is a definition: the instructions a model follows, the model adapter it calls, the tools it may
use, and the shape of its input and output. `defineAgent` checks the definition and freezes it. Nothing runs, no
connection opens and no tool is called until you submit the agent to a [runtime](./runtime.md). You define an agent
once, at module load, and submit it as many times as you like.

## A complete agent

This example runs offline. `scriptedModel` from `mayura/testing` is a test model that replays the responses you give
it, so you can see the whole loop without an API key. It does not read the instructions or reason.

```ts
import { createRuntime, defineAgent, defineTool } from 'mayura';
import { scriptedModel } from 'mayura/testing';
import { z } from 'zod';

const add = defineTool({
  id: 'math.add',
  version: '1',
  description: 'Add two numbers.',
  input: z.object({ left: z.number(), right: z.number() }),
  output: z.object({ sum: z.number() }),
  effects: 'none',
  capabilities: [],
  execute: ({ left, right }) => ({ sum: left + right }),
});

const calculator = defineAgent({
  id: 'calculator',
  version: '1',
  instructions: 'Use math.add to answer the question.',
  input: z.object({ question: z.string() }),
  output: z.object({ answer: z.number() }),
  tools: [add],
  model: scriptedModel([
    { type: 'tool_calls', calls: [{ id: 'call-1', toolId: 'math.add', input: { left: 2, right: 3 } }], usage: { costMicros: 0 } },
    { type: 'final', output: { answer: 5 }, usage: { costMicros: 0 } },
  ]),
});

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: { allow: ['model:scripted', 'tool:math.add'] },
});
try {
  const outcome = await runtime.submit(calculator, { input: { question: 'What is 2 + 3?' } }).result();
  if (outcome.status === 'succeeded') console.log(outcome.output.answer); // 5, typed as number
  else console.error(outcome.status, outcome.error.code);
} finally {
  await runtime.close();
}
```

The same file is in the repository as
[examples/first-agent.mjs](https://github.com/KartikeyAI/mayura/blob/main/examples/first-agent.mjs).

## Options

| Option | Required | What it is |
| --- | --- | --- |
| `id` | yes | Stable name of the agent, for example `support.assistant`. |
| `version` | yes | Version of this definition, for example `1` or `2.1.0`. |
| `instructions` | yes | The system instructions sent to the model on every call. At most 64 KiB. |
| `model` | yes | A model adapter, for example `openAIResponses(...)` from `mayura/provider-openai`. |
| `tools` | yes | The tools this agent may call. Pass `[]` for none. At most 256, with unique ids. |
| `input` | yes | Schema for the input you submit. |
| `output` | yes | Schema for the final answer. |
| `guards` | no | `{ input, output }` lists of guards that can allow, block or rewrite content. At most 32 per list. |
| `hooks` | no | Lifecycle hooks created with `defineHook`. |
| `stream` | no | Stream one text field of the final answer while it is written. |
| `outputJsonSchema` | no | The output as JSON Schema for model providers. Generated from `output` when the validator can describe itself (Zod 4.2 and later). |

`defineAgent` throws a `MayuraError` with code `INVALID_CONFIG` if anything is wrong, for example a duplicate tool id,
a model that cannot call tools while `tools` is not empty, or a tool or output schema the model provider would refuse.
The message says what to fix.

## Ids and versions

`id` and `version` must start with a letter or digit and may contain letters, digits, `.`, `_`, `/` and `-`, up to 128
characters. The id appears in run events, in `runtime.inspect()` and in durable records, so treat it as a stable name:
don't rename an agent in production without a reason. Change the version when the behavior changes, for example new
instructions, a new tool or a changed output schema, so records made by the old definition stay distinguishable.

## Instructions

`instructions` is a plain string sent as the system prompt. It guides the model; it does not grant or restrict
anything. What the agent is actually allowed to do comes from the runtime's [permissions](./permissions.md), so a
prompt injection in the user's input or in a tool result cannot give the agent new authority. Don't put secrets in
instructions.

## Input and output schemas

`input` and `output` accept any [Standard Schema](https://standardschema.dev) validator. Zod is the reference
validator and the one used throughout these docs. TypeScript infers the types from the schemas: `submit` checks the
input you pass, and a successful outcome's `output` has the output type.

Mayura validates at every boundary:

- The submitted input is checked before the model is called. Invalid input ends the run with `INVALID_INPUT`.
- The model's final answer is checked against `output` before it is released. An invalid answer ends the run with
  `INVALID_OUTPUT`; a run never reports success with an output that does not match.

Values must be plain JSON: strings, finite numbers, booleans, `null`, arrays and plain objects. Dates, class instances,
`undefined` and `bigint` are rejected. Size limits come from the runtime (`maxInputBytes`, `maxOutputBytes`).

Real model providers also need the output shape as JSON Schema. Mayura generates it from `output` (validators that
implement Standard JSON Schema can describe themselves, as Zod 4.2 and later do) and sends it with every model call;
you can see it as `agent.outputJsonSchema`. Providers accept only strict schemas, so use `.nullable()` rather than
`.optional()` for fields the model may leave empty; `defineAgent` checks this with the model you give it. Pass
`outputJsonSchema` yourself only when your validator cannot describe itself. The validator is still what Mayura
enforces on the answer.

## The model

`model` is a model adapter: an object with an `id`, its capabilities, a per-call cost ceiling (`maxCostMicros`) and a
`generate` function. Mayura never picks a provider for you. The adapter's id is what you allow in the runtime, as
`model:<adapter id>`: `model:openai.responses`, `model:anthropic.messages`, `model:scripted`.

```ts
import { defineAgent } from 'mayura';
import { openAIResponses } from 'mayura/provider-openai';
import { z } from 'zod';

const answerer = defineAgent({
  id: 'answerer',
  version: '1',
  instructions: 'Answer the question in one or two sentences.',
  input: z.object({ question: z.string().min(1).max(2_000) }),
  output: z.object({ answer: z.string() }),
  tools: [],
  model: openAIResponses({
    apiKey: process.env.OPENAI_API_KEY ?? '',
    model: 'gpt-5-mini',
    maxCostMicros: 20_000, // at most $0.02 per model call
    pricing: { inputMicrosPerMillionTokens: 250_000, outputMicrosPerMillionTokens: 2_000_000 },
    timeoutMs: 30_000,
  }),
});
```

Use your model's real prices; the numbers above are placeholders. A paid model also needs a run cost limit on the
runtime, because the default is 0: see [Costs and budgets](./costs-and-budgets.md). Providers, routing between them
and fallbacks are covered in [Model providers](../guides/model-providers.md) and
[Model routing](../guides/model-routing.md).

## Tools

`tools` is the complete list of tools this agent can call. The model only sees these tools, and a request for any
other tool id ends the run with `NOT_FOUND`. Listing a tool does not permit it: the runtime must also allow
`tool:<id>` and the tool's other requirements. See [Tools](./tools.md) and [Permissions](./permissions.md).

## How a run works

When you submit an agent, the runtime loops over steps until the model gives a final answer or a limit is reached:

1. Validate the input against `input`, then run the input guards.
2. Check that `model:<adapter id>` is allowed and that the run's call and cost limits leave room for one more model
   call. The model call's `maxCostMicros` is reserved from the run budget before the call.
3. Call the model with the instructions, the conversation so far and the tool list (id, description and
   `inputJsonSchema` of each tool). Its actual cost is charged.
4. If the model asks for tools, check every requested call first: the tool is registered, allowed, and its input
   matches its schema, and the total cost of the batch fits the budget. Then run the calls one at a time. Each result
   is validated against the tool's output schema and passed through the agent's output guards before the model sees
   it. If any call does not succeed, the run ends with that call's outcome.
5. Go back to step 2 with the tool results added to the conversation.
6. If the model gives a final answer, validate it against `output`, run the output guards and return it.

If `maxSteps` (default 16) is reached without a final answer, the run fails with `LIMIT_EXCEEDED`. Every run ends
with one of the outcomes described in [Outcomes and errors](./outcomes.md).

## Guards, hooks and streaming

- **Guards** check content at the edges of a run. Input guards see the submitted input; output guards see the final
  answer and every tool result before the model does. A guard can allow, block (the run ends as `blocked`) or rewrite,
  for example to redact personal data. See [Guardrails](../guides/guardrails.md).
- **Hooks** run your code at points in the run's life, such as before each tool call or after the run finishes, and
  can stop the run. See [Lifecycle hooks](../guides/lifecycle-hooks.md).
- **Streaming** releases one string field of the final answer in small checked batches while the model writes it.
  Without `stream`, nothing is released until the whole answer has passed validation and guards. See
  [Streaming](../guides/streaming.md).

## Good to know

- A definition is immutable. To change an agent, define a new one (usually with a new version).
- Tools run in your process as ordinary JavaScript. Declaring `effects: 'none'` is a promise you make, not a sandbox.
- An agent can call another agent as a tool, with narrower permissions. See [Child agents](../guides/child-agents.md).
- In tests, `scriptedModel` lets you script the exact tool calls and answers. See [Testing](../guides/testing.md).

## Related

- [Tools](./tools.md)
- [Runtime](./runtime.md)
- [Permissions](./permissions.md)
- [Model providers](../guides/model-providers.md)
- [Quickstart](../quickstart.md)
