---
title: "Quickstart"
description: "Create a Mayura project in one command, or add a first agent to your own project and run it offline or on a real model."
---

There are two ways to start: let the CLI create a complete project for you, or add Mayura to a project you already
have. Both take a few minutes.

## Option 1: create a project

```bash
npx mayura init
```

The wizard asks three things:

1. **A starter or a template.** Starters are complete projects with tests: four are servers with a worker, a UI and
   deployment files, and one (`cli-agent`) is an assistant you run in your terminal. Templates are single files that show one feature.
2. **A model provider.** Offline (no key needed; rule-based stand-in models), OpenAI, Anthropic, an
   OpenAI-compatible provider such as Groq, Gemini, Mistral, DeepSeek, xAI, OpenRouter, Together or Fireworks, Azure
   OpenAI, or any other compatible endpoint.
3. **Your API key, prices and spending caps**, for a real provider. The key is typed masked and written only to the
   new project's `.env`, which git ignores.

It shows the plan, writes the files when you confirm, and prints the next steps. For a starter those are:

```bash
cd my-agent
npm install
npm run dev
```

`npm run dev` runs `mayura dev`: it builds the project, starts it, and rebuilds and restarts whenever you save. See
[mayura init](cli/init.md) for every starter and template.

## Option 2: add Mayura to your project

Install Mayura and Zod, the schema library used in these docs (any
[Standard Schema](https://standardschema.dev) validator works):

```bash
npm install mayura zod
```

Mayura is an ES module package, so your project needs `"type": "module"` in `package.json` (or `.mts` files).

### A first agent, offline

This agent uses a tool to add two numbers. It runs on a **scripted model** that replays fixed responses, so it needs
no API key and no network. It's the same way you test agents.

```ts
import { createRuntime, defineAgent, defineTool } from 'mayura';
import { scriptedModel } from 'mayura/testing';
import { z } from 'zod';

const add = defineTool({
  id: 'math.add', version: '1', description: 'Add two numbers.',
  input: z.object({ left: z.number(), right: z.number() }),
  output: z.object({ sum: z.number() }),
  effects: 'none', capabilities: [],
  execute: ({ left, right }) => ({ sum: left + right }),
});

const agent = defineAgent({
  id: 'calculator', version: '1', instructions: 'Use the addition tool to answer.',
  input: z.object({ request: z.string() }), output: z.object({ answer: z.number() }), tools: [add],
  model: scriptedModel([
    { type: 'tool_calls', calls: [{ id: 'add-1', toolId: 'math.add', input: { left: 2, right: 3 } }], usage: { costMicros: 0 } },
    { type: 'final', output: { answer: 5 }, usage: { costMicros: 0 } },
  ]),
});

const runtime = createRuntime({ profile: 'ephemeral', permissions: { allow: ['model:scripted', 'tool:math.add'] } });
try {
  const result = await runtime.submit(agent, { input: { request: 'Add 2 and 3.' } }).result();
  console.log(result); // { status: 'succeeded', output: { answer: 5 } }
} finally {
  await runtime.close();
}
```

Save it as `agent.ts` and run it. Node.js 24 runs TypeScript directly; on Node.js 22, use `npx tsx agent.ts` or
compile with `tsc`.

```bash
node agent.ts
```

Four things happened:

- `defineTool` declared a tool: schemas for its input and output, what kind of **effect** it has (`none`, `read`,
  `write` or `host`), and the function that does the work. Mayura validates the input before calling it and the
  output after.
- `defineAgent` declared an agent: instructions, schemas, tools and a model.
- `createRuntime` created the runtime that runs agents, with an explicit **allow-list**. The agent can use
  `math.add` only because `tool:math.add` is granted; remove it and the run is blocked.
- `runtime.submit` started a run and `result()` waited for its **outcome**. Always check `result.status` before
  reading `result.output`: a run can also end `failed`, `blocked`, `cancelled` or `outcome_unknown`. See
  [Outcomes](concepts/outcomes.md).

### Use a real model

Swap the scripted model for a provider. A real model needs your model's prices and cost caps: a run is allowed to
spend nothing until you set `limits.maxCostMicros`. Costs are in **micros**, millionths of a dollar.

```ts
import { createRuntime, defineAgent, defineTool } from 'mayura';
import { anthropicMessages } from 'mayura/provider-anthropic';
import { z } from 'zod';

const add = defineTool({
  id: 'math.add', version: '1', description: 'Add two numbers.',
  input: z.object({ left: z.number(), right: z.number() }),
  output: z.object({ sum: z.number() }),
  effects: 'none', capabilities: [],
  execute: ({ left, right }) => ({ sum: left + right }),
});

const agent = defineAgent({
  id: 'calculator', version: '1', instructions: 'Use the addition tool to answer.',
  input: z.object({ request: z.string() }), output: z.object({ answer: z.number() }), tools: [add],
  model: anthropicMessages({
    apiKey: process.env.ANTHROPIC_API_KEY!, model: 'claude-sonnet-5',
    pricing: { inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000 }, // check your model's prices
    maxCostMicros: 50_000, // at most 5 cents per model call
  }),
});

const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: { allow: ['model:anthropic.messages', 'tool:math.add'] },
  limits: { maxCostMicros: 200_000 }, // at most 20 cents per run
});
```

The rest of the program is unchanged. The provider needs the tool's input and the agent's output as JSON Schema;
Mayura generates both from your Zod schemas (Zod 4.2 or later). Providers accept only strict schemas, where every
field is present, so use `.nullable()` rather than `.optional()` for a field the model may leave empty.
`defineAgent` checks this and tells you exactly which field to change.

OpenAI (`openAIResponses`) and OpenAI-compatible providers
(`openAICompatibleChat`) work the same way; each is granted as `model:` followed by its adapter id. See
[Model providers](guides/model-providers.md). Mayura never reads API keys from the environment by itself: you pass
them in, so where they come from is up to you.

### Watch a run

A run reports what it's doing as events. `observe()` returns them as an async iterable, and `runtime.inspect` shows
what the run has spent:

```ts
const run = runtime.submit(agent, { input: { request: 'Add 2 and 3.' } });
for await (const event of run.observe()) {
  if (event.type === 'tool.started') console.log('using', event.metadata.toolId);
}
const result = await run.result();
console.log(runtime.inspect(run).budget.spentMicros);
```

Events carry metadata such as ids, steps, statuses and costs, not your prompts or tool inputs and outputs. The one
exception is `output.delta`, which carries streamed answer text (below).

### Stream the answer

To show an answer while it's being written, give the agent a `stream` policy naming the output field to stream, and
print the `output.delta` events:

```ts
import { defineAgent } from 'mayura';

const assistant = defineAgent({
  id: 'assistant', version: '1', instructions: 'Answer helpfully.',
  input, output, tools: [], model,
  stream: { field: ['reply'], guards: [] }, // stream output.reply
});

const run = runtime.submit(assistant, { input: { question: 'What is Mayura?' } });
for await (const event of run.observe()) {
  if (event.type === 'output.delta') process.stdout.write(String(event.metadata.text));
}
```

The final `result()` is still validated against the output schema; the streamed text is a preview. See
[Streaming](guides/streaming.md).

## Next steps

- [Agents](concepts/agent.md), [tools](concepts/tools.md) and the [runtime](concepts/runtime.md) in depth.
- [Durable workflows](guides/durable-workflows.md): steps, approvals and timers that survive restarts.
- [Serve agents over HTTP](guides/server-and-client.md) and call them from a browser or [React](guides/react.md).
- [Chat with an agent in the terminal](guides/terminal.md).
- [Deploy](guides/deployment.md) a Mayura application.
