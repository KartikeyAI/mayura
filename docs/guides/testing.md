---
title: "Testing"
description: "Test agents, tools and provider settings without a network or an API key, using scriptedModel from mayura/testing."
---

Agents are hard to test against a real model: answers vary, calls cost money, and tests need a key. In Mayura the
model is just an adapter you pass to `defineAgent`, so tests pass a scripted one instead. Everything else stays real:
the runtime checks permissions, validates tool inputs and outputs, runs guards and hooks, and keeps the budget, exactly
as in production.

`mayura/testing` has two helpers: `scriptedModel`, a model adapter that plays back responses you write, in order,
with no inference and no network; and `testTool`, which runs one tool on its own.

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRuntime, defineAgent, defineTool, type ModelAdapter } from 'mayura';
import { scriptedModel } from 'mayura/testing';
import { z } from 'zod';

const lookupOrder = defineTool({
  id: 'orders.lookup', version: '1', description: 'Look up an order by id.',
  input: z.object({ orderId: z.string() }), output: z.object({ status: z.string() }),
  effects: 'read', capabilities: [],
  execute: ({ orderId }) => ({ status: orderId === 'A1' ? 'shipped' : 'unknown' }),
});

const supportAgent = (model: ModelAdapter) => defineAgent({
  id: 'support', version: '1', instructions: 'Answer questions about orders.',
  model, tools: [lookupOrder], input: z.object({ message: z.string() }), output: z.object({ reply: z.string() }),
});

test('looks the order up before answering', async () => {
  const model = scriptedModel([
    // First model call: ask for the tool.
    { type: 'tool_calls', calls: [{ id: 'call-1', toolId: 'orders.lookup', input: { orderId: 'A1' } }], usage: { costMicros: 0 } },
    // Second model call: check what the tool returned, then answer.
    request => {
      const last = request.messages.at(-1);
      if (last?.role !== 'tool') throw new Error('Expected a tool result.');
      assert.deepEqual(last.result, { status: 'shipped' });
      return { type: 'final', output: { reply: 'Your order has shipped.' }, usage: { costMicros: 0 } };
    },
  ]);
  const runtime = createRuntime({
    profile: 'ephemeral', permissions: { allow: ['model:scripted', 'tool:orders.lookup', 'effect:read'] },
  });
  try {
    const outcome = await runtime.submit(supportAgent(model), { input: { message: 'Where is order A1?' } }).result();
    assert.equal(outcome.status, 'succeeded');
    if (outcome.status === 'succeeded') assert.equal(outcome.output.reply, 'Your order has shipped.');
  } finally {
    await runtime.close();
  }
});
```

## scriptedModel

```text
scriptedModel(responses, { id?, maxCostMicros?, streamChunk? })
```

- **`responses`** is a list. Each model call takes the next entry. An entry is either a response object, or a function
  that receives the model request and returns (or resolves to) one. Use a function to assert on what the model was
  sent: `request.messages` holds the input, the agent's earlier tool calls and their results.
- A response is `{ type: 'final', output, usage: { costMicros } }` or
  `{ type: 'tool_calls', calls: [{ id, toolId, input }], usage: { costMicros } }`. The `toolId` is the Mayura tool id.
- **`id`** is the adapter id, `'scripted'` by default, so grant `model:scripted`. Give each model its own id when a
  test has several agents and you want to grant them separately.
- **`maxCostMicros`** is the per-call bound, 0 by default.
- **`streamChunk`** is the size of the streamed pieces (16 characters by default); see "Streaming" below.

Running past the end of the script is an error, never a made-up answer: the run ends `failed` with `MODEL_FAILED`.
A scripted model is consumed as it runs, so create a new one for each test run.

## Patterns

**Test that a permission is required.** Leave a grant out and check the outcome. The tool never runs.

```ts
const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:scripted'] } });
const outcome = await runtime.submit(supportAgent(model), { input: { message: 'Where is order A1?' } }).result();
assert.equal(outcome.status, 'blocked');
if (outcome.status !== 'succeeded') assert.equal(outcome.error.code, 'PERMISSION_DENIED');
```

**Test costs and budgets.** Put costs in the scripted `usage` and read the run's budget afterwards. Remember that the
runtime's `limits.maxCostMicros` defaults to 0, so raise it when the scripted model has a bound above zero.

```ts
const model = scriptedModel(
  [{ type: 'final', output: { reply: 'Done.' }, usage: { costMicros: 1_200 } }],
  { maxCostMicros: 5_000 },
);
const runtime = createRuntime({
  profile: 'ephemeral', permissions: { allow: ['model:scripted'] }, limits: { maxCostMicros: 10_000 },
});
const run = runtime.submit(supportAgent(model), { input: { message: 'Hi' } });
await run.result();
assert.equal(runtime.inspect(run).budget.spentMicros, 1_200);
```

**Test the events a run emits.** `run.observe()` replays the run's retained events and ends when the run does:

```ts
const run = runtime.submit(agent, { input: { message: 'Where is order A1?' } });
await run.result();
const tools: unknown[] = [];
for await (const event of run.observe()) {
  if (event.type === 'tool.started') tools.push(event.metadata['toolId']);
}
assert.deepEqual(tools, ['orders.lookup']);
```

**Test a tool on its own.** `testTool` runs one tool through the same checks a run applies: permissions, input and
output validation, guards, timeout, cost and the `outcome_unknown` rules. By default it grants exactly what the tool
needs (`toolGrants(tool)`) and a budget of the tool's own `costMicros`.

```ts
import { testTool } from 'mayura/testing';

const { outcome, spentMicros, receipt } = await testTool(lookupOrder, { orderId: 'A1' });
assert.equal(outcome.status, 'succeeded');
assert.equal(receipt?.execution, 'succeeded');

// Leave a grant out to test the refusal; the tool never runs.
const denied = await testTool(lookupOrder, { orderId: 'A1' }, { permissions: ['tool:orders.lookup'] });
assert.equal(denied.outcome.status, 'blocked');
```

Options: `permissions`, `scope`, `budgetMicros`, `signal`, `runId` and `callId`. The result has the `outcome`, what the
call was charged (`spentMicros`, and `reservedMicros` still held for an uncertain call) and its execution `receipt`.
An agent exposed with `agentAsTool` needs a runtime to start the child; test it inside a runtime.

**Test child agents.** Give the parent and child scripted models with different ids, and grant `agent:delegate` plus
both model ids. The [complete example](https://github.com/KartikeyAI/mayura/blob/main/examples/agent-orchestration.mjs)
runs a parent that calls a child through `agentAsTool`, with no key and no network.

## Streaming

`scriptedModel` streams too. For an agent with a stream policy, a scripted final answer arrives as `output.delta`
pieces of its JSON text, then the complete response, as a provider's would:

```ts
import { defineAgent } from 'mayura';
import { scriptedModel } from 'mayura/testing';
import { z } from 'zod';

const writer = defineAgent({
  id: 'writer', version: '1', instructions: 'Write.', input: z.string(), output: z.object({ reply: z.string() }), tools: [],
  model: scriptedModel([{ type: 'final', output: { reply: 'Hello, streamed.' }, usage: { costMicros: 0 } }], { streamChunk: 4 }),
  stream: { field: ['reply'], guards: [] },
});
```

Collect the `output.delta` events from `run.observe()` and compare their joined text with the final output. To test a
stream that differs from the final answer, or one that fails partway, write an adapter with your own `stream` method.

## Test provider settings without a network

Every provider adapter takes a `fetch` option. Pass a fake one to check what would be sent and how your prices turn
into costs, without a key or a paid call:

```ts
import { openAIResponses } from 'mayura/provider-openai';

const sent: unknown[] = [];
const model = openAIResponses({
  apiKey: 'test-key', model: 'test-model', outputJsonSchema, maxCostMicros: 5_000,
  pricing: { inputMicrosPerMillionTokens: 400_000, outputMicrosPerMillionTokens: 1_600_000 },
  fetch: async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({
      status: 'completed',
      usage: { input_tokens: 1_000, output_tokens: 500 },
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"reply":"Hi"}' }] }],
    }), { headers: { 'content-type': 'application/json' } });
  },
});
const response = await model.generate({
  instructions: 'Be brief.', messages: [{ role: 'user', content: 'Hello' }], tools: [],
  signal: new AbortController().signal, maxOutputTokens: 256,
});
assert.deepEqual(response.usage, { costMicros: 1_200 }); // 1,000 x $0.40/M + 500 x $1.60/M
```

This checks your configuration and Mayura's handling of the provider's format, not the provider itself. Before
relying on a provider, run the agent against it once with a small budget.

## Check that a provider accepts your schemas

Tests usually run on a scripted model, which accepts any schema. To catch a schema a real provider would refuse (an
`.optional()` field, a `z.record`), define the agent once with a real adapter in a test. `defineAgent` checks every
tool and the output against the provider's rules and throws with the field to fix; nothing is sent.

```ts
import { defineAgent } from 'mayura';
import { anthropicMessages } from 'mayura/provider-anthropic';

const offline = anthropicMessages({ apiKey: 'not-used', model: 'not-used', maxCostMicros: 0,
  pricing: { inputMicrosPerMillionTokens: 0, outputMicrosPerMillionTokens: 0 } });
defineAgent({ id: 'support', version: '1', instructions, input, output, tools, model: offline }); // throws if a schema is refused
```

## Good to know

- Scripted responses are fixtures, not a model: they show that your tools, schemas, permissions and guards behave,
  not that a real model will choose the same calls.
- `mayura/testing` works with any test runner; the examples here use Node's built-in `node:test`.
- Close every runtime you create (`await runtime.close()`), so no run outlives its test.

## Related

- [Agents](../concepts/agent.md)
- [Tools](../concepts/tools.md)
- [Outcomes](../concepts/outcomes.md)
- [Model providers](model-providers.md)
- [Streaming](streaming.md)
