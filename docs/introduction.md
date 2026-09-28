---
title: "Introduction"
description: "What Mayura is, the ideas behind it, and how its parts fit together."
---

Mayura is a TypeScript framework for building AI agents, typed tools and durable workflows. You describe an agent
with schemas for what goes in and what comes out, give it tools, and run it on OpenAI, Anthropic or any
OpenAI-compatible provider. When one run isn't enough, the same agents and tools become steps in workflows that wait
for people, timers and events, and carry on after a restart.

Mayura is one npm package, `mayura`, with a CLI of the same name. The core has no infrastructure dependencies: no
database, server or hosted account is needed to run an agent. Storage, servers, UI and sandboxes are separate entry
points you import only when you need them.

## The building blocks

| Block | What it is | Start here |
|---|---|---|
| **Tool** | A typed function an agent can call: input and output schemas, its effect (`none`, `read`, `write`, `host`) and the code that runs. | [Tools](concepts/tools.md) |
| **Agent** | Instructions, input and output schemas, a model and the tools it may use. | [Agents](concepts/agent.md) |
| **Model adapter** | The connection to a model provider, with its prices and a cost cap per call. | [Model providers](guides/model-providers.md) |
| **Runtime** | Runs agents under an allow-list of permissions and limits on cost, steps, tool calls and time. | [Runtime](concepts/runtime.md) |
| **Outcome** | How a run ended: `succeeded`, `failed`, `blocked`, `cancelled` or `outcome_unknown`. | [Outcomes](concepts/outcomes.md) |
| **Workflow** | Steps (tools, agents, people, timers, signals) that run in order or in parallel, in memory or durably in SQLite or PostgreSQL. | [Workflows](concepts/workflows.md) |
| **Application** | Your agents and workflows packaged for `mayura serve` and `mayura worker`: an HTTP server with authentication, and a worker that runs durable workflows. | [Server and client](guides/server-and-client.md) |

## Ideas behind Mayura

**Nothing is allowed by default.** A run can use a model, a tool or an effect only when the runtime grants it
(`model:openai.responses`, `tool:orders.refund`, `effect:write`). Registering a tool does not grant it. Child agents
and workflow steps can only narrow what they inherit, never widen it. See [Permissions](concepts/permissions.md).

**Every run has limits.** Cost, model calls, tool calls, steps, duration and output size are capped for every run.
Model calls are priced from the token counts the provider reports and your prices, and a run is allowed to spend
nothing until you give it a budget. See [Costs and budgets](concepts/costs-and-budgets.md).

**Types at every boundary.** Agent input and output, and every tool's input and output, are validated at runtime
with your schemas, and TypeScript infers the types from the same schemas. A model can't hand a tool something its
schema rejects, and your code can't receive an output the agent's schema rejects.

**Honest outcomes.** If a tool with side effects fails midway, Mayura can't know whether the effect happened, so the
run ends `outcome_unknown` instead of pretending it failed cleanly or retrying blindly. Your code decides how to
reconcile. See [Outcomes](concepts/outcomes.md).

**Your keys, your data.** Adapters never read credentials from the environment on their own, never retry to another
destination, and Mayura sends no telemetry. What leaves your process is what you configured.

**Progressive.** Start with one agent in one file. Add streaming, guardrails, memory, child agents, durable workflows,
an HTTP server, a React UI and an operator console when you need them. Each is its own entry point, and each optional
native dependency (SQLite, PostgreSQL, QuickJS, React) is installed only by projects that use it.

## How the parts fit

```text
            your code
               │
   ┌───────────▼───────────┐      mayura/provider-openai
   │ runtime.submit(agent) │─────► mayura/provider-anthropic ──► model provider
   └───────────┬───────────┘
               │ tool calls, checked against permissions and limits
               ▼
          your tools ──► your databases and APIs

   mayura/workflows/*   run agents and tools as durable steps (mayura/storage-sqlite or -postgres)
   mayura/server        serves agents and workflows over HTTP; mayura/client and mayura/client-react call them
   mayura (CLI)         init, dev, serve, worker, migrate, and operator commands
```

## Where to go next

- [Quickstart](quickstart.md): a working agent in a few minutes.
- [Installation](installation.md): requirements, optional peers and TypeScript settings.
- [Entry points](reference/entry-points.md): every `mayura/...` import and what it's for.
- [Using Mayura with AI coding agents](ai-agents.md): documentation your assistant can read offline.
