# Mayura

[![npm](https://img.shields.io/npm/v/mayura?label=npm)](https://www.npmjs.com/package/mayura)
[![CI](https://github.com/KartikeyAI/mayura/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/KartikeyAI/mayura/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Mayura is a TypeScript framework for building AI agents, typed tools and durable workflows. You describe an agent with
schemas for what goes in and what comes out, give it tools, and run it on any major model provider. Mayura enforces
the rest: an agent can use only the models and tools you allow, every run has cost, step and time limits, inputs and
outputs are validated at every boundary, and when something can't be known for sure (did that payment go through?)
Mayura says so rather than guessing. When a task outgrows a single run, the same agents and tools become steps in
durable workflows that wait for people, timers and events, and survive restarts. It is one npm package, `mayura`,
with a CLI that scaffolds, runs and operates your project.

## Features

- **Typed agents and tools.** Schemas for inputs and outputs with the built-in `z` (Zod), or any Standard Schema
  validator, validated at runtime and inferred in TypeScript.
- **Any model.** OpenAI, Anthropic, and OpenAI-compatible providers such as Groq, Gemini, Mistral, DeepSeek, xAI,
  OpenRouter, Together, Fireworks, Azure OpenAI and local servers. Route between providers with automatic failover.
- **Explicit permissions.** A run can use only the models, tools and effects you grant; nothing is implied by
  registering a tool.
- **Cost control.** Model prices, per-call and per-run cost caps, and step, tool-call and time limits on every run;
  budgets shared across agents and workflows.
- **Durable workflows.** Steps, approvals, timers, signals, fan-out, sagas and loops that survive restarts, on SQLite
  or PostgreSQL.
- **People in the loop.** Approvals and typed questions for people, answered from code, the CLI, a React form or the
  operator console.
- **Streaming.** Stream an agent's answer as it is written, with guards on every batch.
- **Vision.** Agents that see images and PDFs, with the input or from tools such as screenshots; checked by their
  own bytes, limited, and never shown to hooks or logs.
- **Guardrails and hooks.** Input and output guards, PII redaction, moderation, and lifecycle hooks that can stop a
  run.
- **Memory and context.** Native memory with keyword, semantic and hybrid search, plus Mem0, Supermemory and
  OpenViking adapters.
- **Skills, MCP and Code Mode.** Load `SKILL.md` skills on demand, call MCP tools, and run model-written code in a
  QuickJS or Docker sandbox.
- **Multi-agent.** Child agents, agents as tools and speculative branches under one shared budget.
- **Serve it anywhere.** An authenticated HTTP server with live events, a browser client, React hooks and components,
  an operator console, and terminal chat or one-shot commands.
- **Observability.** Run events, workflow tracing and OpenTelemetry (OTLP) export. Nothing is sent anywhere unless you
  configure it.
- **Test offline.** Scripted models run agents, tools and workflows without a network or an API key.

## Quickstart

Mayura runs on Node.js 22 (22.12 or later) or 24 (24.14.1 or later).

```bash
npm install mayura
```

An agent that answers weather questions with a tool, on OpenAI:

```ts
import { createRuntime, defineAgent, defineTool, z } from 'mayura';
import { openAIResponses } from 'mayura/provider-openai';

const getWeather = defineTool({
  id: 'weather.get', version: '1', description: 'Current weather for a city.',
  input: z.object({ city: z.string() }),
  output: z.object({ celsius: z.number(), sky: z.string() }),
  effects: 'read', capabilities: [],
  execute: async ({ city }) => ({ celsius: 21, sky: 'clear' }), // call your weather API here
});

const agent = defineAgent({
  id: 'weather-assistant', version: '1',
  instructions: 'Answer questions about the weather. Use the weather tool.',
  input: z.object({ question: z.string() }), output: z.object({ reply: z.string() }), tools: [getWeather],
  model: openAIResponses({
    apiKey: process.env.OPENAI_API_KEY!, model: 'gpt-5-mini',
    // Your model's prices, in micros (millionths of a dollar) per million tokens, and a cap per model call.
    pricing: { inputMicrosPerMillionTokens: 250_000, outputMicrosPerMillionTokens: 2_000_000 },
    maxCostMicros: 20_000,
  }),
});

// Nothing is allowed unless you allow it, and every run has limits (here, at most 10 cents).
const runtime = createRuntime({
  profile: 'ephemeral',
  permissions: { allow: ['model:openai.responses', 'tool:weather.get', 'effect:read'] },
  limits: { maxCostMicros: 100_000 },
});

const result = await runtime.submit(agent, { input: { question: 'Do I need an umbrella in Paris?' } }).result();
if (result.status === 'succeeded') console.log(result.output.reply);
else console.error(result.status, result.error.message);
await runtime.close();
```

Mayura turns your Zod schemas into the JSON Schema the model provider needs. If a schema can't be sent to the
provider (for example a field is `.optional()`; use `.nullable()`), `defineAgent` tells you which field and how to fix
it before anything runs.

No API key yet? Swap the model for a scripted one and everything else runs offline, which is also how you test
agents:

```ts
import { scriptedModel } from 'mayura/testing';

const model = scriptedModel([
  { type: 'tool_calls', calls: [{ id: 'call-1', toolId: 'weather.get', input: { city: 'Paris' } }], usage: { costMicros: 0 } },
  { type: 'final', output: { reply: 'Clear skies and 21°C, so no umbrella needed.' }, usage: { costMicros: 0 } },
]);
// Grant 'model:scripted' instead of 'model:openai.responses'.
```

Anthropic (`anthropicMessages` from `mayura/provider-anthropic`) and OpenAI-compatible providers
(`openAICompatibleChat` from `mayura/provider-openai`) are drop-in replacements for the model. The
[quickstart](docs/quickstart.md) goes further: streaming, a durable workflow, and serving the agent over HTTP.

## CLI

The `mayura` command comes with the package. Start a new project with the interactive wizard: pick a starter, pick a
model provider and paste its API key (it goes into the project's `.env`, never anywhere else).

```bash
npx mayura init
```

Or without prompts, for scripts and CI:

```bash
npx mayura starters
npx mayura init --starter support-agent --directory my-agent
npx mayura init --starter support-agent --directory my-agent --apply
```

`init` always shows its plan first and writes only with `--apply`. Four starters are complete server projects with a
worker, tests and deployment files: `support-agent`, `approval-workflow`, `research-team` and `event-automation`. The
fifth, `cli-agent`, is a command-line assistant you chat with in a terminal. There are also eight small single-file
templates (`mayura templates`).

Inside a project:

```bash
mayura dev
mayura migrate --app dist/src/app.js
mayura serve --app dist/src/app.js
mayura worker --app dist/src/app.js
```

`mayura dev` builds, runs and restarts on every change, and loads `.env`. `migrate`, `serve` and `worker` run your
application in production. The CLI also operates a running server: runs, workflows, approvals and fleet control. The
token is always piped, never typed as an argument:

```bash
echo "$MAYURA_OPERATOR_TOKEN" | mayura workflow-list --url https://agents.example.com --token-stdin
```

Output is readable in a terminal and JSON when piped (or with `--json`). `mayura --help` lists every command.

## Documentation

- [Introduction](docs/introduction.md): what Mayura is and how its parts fit together.
- [Quickstart](docs/quickstart.md): from `npm install` to a served agent.
- [Concepts](docs/README.md#concepts): agents, tools, the runtime, outcomes, permissions, costs and workflows.
- [Guides](docs/README.md): model providers, streaming, durable workflows, storage, memory, guardrails, servers,
  React, deployment and more.
- [CLI](docs/cli/overview.md) and the [entry point reference](docs/reference/entry-points.md).
- [Using Mayura with AI coding agents](docs/ai-agents.md): `llms.txt`, and documentation that ships inside the package.

The documentation also ships in the npm package (`node_modules/mayura/docs`), so your editor's AI assistant can read
the docs for the exact version you have installed.

## Author and team

Mayura is created by **Aryabh** ([dev@rokad.co](mailto:dev@rokad.co)). The team section is coming soon.

Mayura is open source under the [Apache-2.0 license](LICENSE). See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute,
[SECURITY.md](SECURITY.md) to report a vulnerability and [SUPPORT.md](SUPPORT.md) for support.
