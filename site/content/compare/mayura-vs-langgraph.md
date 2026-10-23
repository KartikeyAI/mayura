---
title: "Mayura vs LangGraph.js"
description: "LangGraph.js and Mayura compared for production TypeScript agents: graphs and checkpoints, versus grants, hard budgets and steps that never run twice."
date: 2026-10-12
updated: 2026-10-23
tags: comparison, LangGraph, durable workflows, TypeScript
---

LangGraph.js is LangChain's low-level orchestration framework for stateful agents. You build a graph of nodes, each an
ordinary function that reads and updates a shared state, and a checkpointer saves that state after every step. A
thread can then pause for a person, resume after a crash, be inspected, and be rewound to an earlier checkpoint.

Mayura covers some of the same ground (durable runs, human approval, long-term memory) but starts from a different
question: what may this run do, how much may it spend, and what happens if the process dies in the middle of a
payment? Nothing is allowed until you grant it, every run has a hard budget, and a durable step that may have acted is
never run again.

We make Mayura, so read this with that in mind. We checked every statement about LangGraph.js against its own
documentation, repository and npm listing, and link the sources at the end. If something here is wrong or out of date,
please [tell us](https://github.com/KartikeyAI/mayura/issues).

*Baseline compared October 12, 2026: LangGraph.js (`@langchain/langgraph`) 1.4.21. Mayura's side is updated for
published 1.2.0 on October 23. Version/adoption figures and other LangGraph details retain the baseline date;
its persistence and interrupt documentation was rechecked on October 23.*

## What changes with Mayura 1.2

Mayura adds scoped [threads and compaction](../../../docs/guides/threads.md), exact approvals inside agent runs,
[handoffs](../../../docs/guides/agent-handoffs.md) and resource authorization across execution and data access.
It now ships six framework notebooks and an experimental bounded AG-UI adapter. It still does not offer time travel
or conversation branching, and experimental client interoperability remains unqualified.

LangGraph's [persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) distinguishes
thread checkpoints from cross-thread stores; [interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)
pause for external input and resume through a command. Both frameworks can retain conversation state and wait for a
person. Their graph expressiveness and handling of side-effect replay remain the architectural decisions to compare.

## At a glance

| | LangGraph.js | Mayura |
|---|---|---|
| **Maturity** | Since January 2024, 1.0 in October 2025; about 3,300 GitHub stars on the JavaScript repository and 3.8M weekly npm downloads; an equivalent Python library | Stable 1.2.0 published October 23, 2026; first 1.0 in September 2026; a new project |
| **License** | MIT. LangSmith (tracing, evaluation, Studio and managed deployment) is a separate LangChain platform | Apache-2.0, all of it |
| **Models** | Any model you call from a node; the docs use LangChain's chat model integrations, and `@langchain/core` is a peer dependency | A model registry with `provider/model` strings, dated prices, retries and fallback chains; packages for OpenAI, Anthropic, Google Gemini, Bedrock, Azure OpenAI, Mistral, Groq and Ollama, plus any OpenAI-compatible endpoint |
| **Graph shape** | Nodes are arbitrary code; edges may loop; conditional edges, `Send` fan-out and subgraphs | A fixed graph declared as data: at most 128 nodes, no cycles, no code between steps; parallel slots, conditions, and sagas and loops as separate constructs |
| **Tool access** | No permission model: a tool you give the model can be called. LangChain's `createAgent` adds middleware for approvals and call limits | Explicit model/tool/effect grants plus optional resource-level RBAC or external policy authorization; denied by default |
| **Cost limits** | No spending limit. `recursionLimit` caps super-steps (25 by default); LangChain middleware caps the number of model and tool calls | Hard per-run budget: each call's maximum cost is reserved before it starts, and a call that doesn't fit never starts |
| **Human approval** | `interrupt()` anywhere in a node, resumed with a `Command`; needs a checkpointer and a thread id | Exact-input approvals inside agent runs and durable workflows; stored checkpoints and typed human requests |
| **Durability** | A checkpoint after every super-step, in three durability modes; a resumed node restarts from its beginning; retries are opt-in per node | Every step recorded before and after it runs; at-most-once dispatch; abandoned steps settled as unknown, never re-run; no automatic retries |
| **Versions** | The latest graph code applies to every thread, new or resumed | Each run is pinned to the definition it started with; reviewed migrations move runs to a new version |
| **Memory** | Threads hold conversation state; time travel; a store for long-term memory with optional semantic search | Scoped conversation threads, journaled compaction and native long-term memory with provenance/sensitivity; lexical, semantic and hybrid search |
| **Storage** | Checkpointers for memory, SQLite, PostgreSQL, MongoDB and Redis; stores for PostgreSQL, Redis and MongoDB | SQLite, PostgreSQL, libSQL (Turso), MySQL, MongoDB, Cloudflare D1 and DynamoDB |
| **Observability** | LangSmith tracing and Studio | Metadata-only run events, OpenTelemetry export, and packages for Langfuse, LangSmith, Datadog, Arize, Sentry, Better Stack and PostHog |
| **Deployment** | Guides for Next.js, SvelteKit, Nuxt, Cloudflare Workers and Deno Deploy; LangSmith Deployment as cloud, hybrid or self-hosted | Node.js 22 and 24, Bun, Deno, Cloudflare Workers and Vercel Edge (apart from the Node-only entry points); `mayura deploy` to Docker, Kubernetes and eleven platforms |

## Where they differ most

### Control flow: code in nodes, or steps declared as data

A LangGraph node is a function. It receives the current state and returns an update; edges, including conditional
ones, decide which node runs next, and they may loop. The classic agent is itself a cycle: call the model, run the
tools it asked for, call the model again. Anything you can write in a function can go in a node, and the graph can be
as dynamic as you need.

Mayura splits this into two things. An [agent run](../../../docs/concepts/agent.md) is the loop: the model decides which
tools to call, within the run's limits. A [workflow](../../../docs/concepts/workflows.md) is a fixed graph declared as
data: each step is a typed [tool](../../../docs/concepts/tools.md) with declared effects and its own permission, steps
are ordered by `dependsOn`, and no code runs between them. A workflow has at most 128 nodes and no cycles. Repetition is
an explicit construct, a [loop](../../../docs/guides/sagas-and-loops.md) that repeats a durable workflow up to a fixed
number of times.

Mayura's form is less expressive, and that is deliberate: because every step is a declared tool call, the engine knows
which steps may have changed something outside, and can refuse to repeat them.

### Resuming: replay from the node, or never run again

LangGraph saves a checkpoint at each super-step boundary. If one node in a super-step fails, the writes of the nodes
that succeeded are kept and are not recomputed. How promptly checkpoints are written depends on the durability mode:
`exit` saves only when the run ends or pauses, `async` saves while the next step runs (with a small risk of losing a
checkpoint in a crash), and `sync` saves before the next step starts.

Resuming starts from a checkpoint, not from the line where execution stopped. After an `interrupt()`, the docs say the
runtime "restarts the entire node from the beginning", so code before the interrupt runs again, and they ask for side
effects before an interrupt to be idempotent, or moved after it or into their own node. In the Functional API, replay
starts at the top of the entrypoint and restores completed tasks from the checkpoint, but a task that started and did
not finish may run again. Retries are opt-in, with a `retryPolicy` per node.

Mayura records each workflow step as started before it calls the tool, and never calls it again. If the process dies
mid-step, the next process to advance the run settles that step as unknown once its deadline has passed, and the run
ends `outcome_unknown` for a person to reconcile instead of paying twice. There are no automatic retries.
[Never twice](../research/side-effects-never-twice.md) covers the mechanism and its limits.

Neither approach is free. Replaying is right when steps are idempotent or cheap, and it recovers without a human.
Never replaying is right when a duplicate is worse than a pause, as with payments, emails or deletions, and it means
someone occasionally reconciles a run.

### Versions: the latest code, or the code the run started with

LangGraph's documentation on backward compatibility is direct about its choice: unlike workflow engines that pin a run
to the code it started with, it applies the latest graph to every thread, new or resumed. Bug fixes reach in-flight
conversations without ceremony. The cost is that every deploy must stay compatible with saved state: renaming or
removing a node breaks threads paused at it, and tightening a state field can make old checkpoints fail to load.

Mayura pins every durable run to the exact definition it started with: its id, its version and a digest of its steps.
To change a workflow you register a new version beside the old one, and in-flight runs either finish on the old version
or move through an explicit, reviewed migration. See [Operating workflows](../../../docs/guides/workflow-operations.md).

### Authority and spending

LangGraph leaves both to you. There is no permission model: a tool you bind to the model can be called with whatever
arguments the model produces. `recursionLimit` stops a graph after a number of super-steps, 25 by default. LangChain's
`createAgent`, which is built on LangGraph, adds middleware that caps the number of model and tool calls per run or per
thread and pauses before selected tool calls for approval. None of these is a limit in money.

In Mayura, a runtime starts with nothing allowed. A model needs `model:<id>`; a tool needs `tool:<id>`, every
capability it declares and `effect:write` if it writes. A missing grant blocks the call before it runs, so a prompt
injection can't reach anything you didn't list. Every model and tool call declares the most it can cost, the runtime
reserves that amount from the run's budget before the call, and a call that doesn't fit never starts. A paid model is
refused until you set a limit at all. See [Permissions](../../../docs/concepts/permissions.md) and
[Costs and budgets](../../../docs/concepts/costs-and-budgets.md).

## Where LangGraph is ahead

- **Expressiveness.** Cycles, arbitrary code in nodes, dynamic fan-out with `Send`, subgraphs, and state you can read
  and edit between steps. Mayura's workflows are deliberately more rigid.
- **Conversations and time travel.** A thread keeps multi-turn conversation state for you, and you can replay or fork a
  thread from an earlier checkpoint. Mayura has persistent threads and journaled compaction, but no time travel or
  conversation branching.
- **Approval inside an agent.** `interrupt()` works in any node, and LangChain's human-in-the-loop middleware pauses an
  ordinary agent before selected tool calls, with approve, edit and reject. Mayura 1.2 can pause agent runs directly
  for exact-input approval as well as use durable workflow approvals; changing the proposed input requires a new
  bound proposal rather than editing an approved call.
- **Ecosystem.** LangChain's integrations, Deep Agents, prebuilt chat UI, LangSmith Studio and evaluations, a Python
  library with the same design, and far wider adoption.
- **A managed platform.** LangSmith Deployment runs graphs with persistence handled for you, in the cloud, hybrid or
  self-hosted.

## When to choose which

**Choose LangGraph.js** if your agent's control flow is the hard part: loops, branches and sub-agents that you want to
write as code, conversations that persist per thread, and the option to inspect, edit or rewind state. Also if you
already use LangChain or LangSmith.

**Choose Mayura** if your agents act on things that matter, like money, customer records or messages, and you want the
framework to enforce the rules: nothing allowed by default, a hard budget on every run, approvals bound to the exact
input, runs pinned to the code they started with, and durable steps that never run twice. Also if you want one
Apache-2.0 license for everything.

**Using both** is possible at the edges. Mayura's [LangSmith package](../../../docs/integrations/observability-langsmith.md)
sends Mayura's traces to LangSmith, so one team can watch both in one place. A LangGraph node can also submit a Mayura
workflow for the one step that must not run twice, at the cost of running two persistence layers.

## Sources

LangGraph.js facts were checked on October 12, 2026:

- [npm: @langchain/langgraph](https://www.npmjs.com/package/@langchain/langgraph) (version 1.4.21, release dates, dependencies, downloads)
- [GitHub: langchain-ai/langgraphjs](https://github.com/langchain-ai/langgraphjs) (README, license, stars)
- [Overview](https://docs.langchain.com/oss/javascript/langgraph/overview) and [Install](https://docs.langchain.com/oss/javascript/langgraph/install)
- [Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence), [Checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers) (super-steps, pending writes, durability modes, checkpointer libraries) and [Stores](https://docs.langchain.com/oss/javascript/langgraph/stores)
- [Store integrations](https://docs.langchain.com/oss/javascript/integrations/long-term-memory/index)
- [Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts) and [Functional API](https://docs.langchain.com/oss/javascript/langgraph/functional-api) (determinism, idempotency, side effects)
- [Fault tolerance](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance) and [Graph API](https://docs.langchain.com/oss/javascript/langgraph/graph-api) (recursion limit)
- [Backward compatibility](https://docs.langchain.com/oss/javascript/langgraph/backward-compatibility)
- [Deployment](https://docs.langchain.com/oss/javascript/langgraph/deploy)
- [LangChain prebuilt middleware](https://docs.langchain.com/oss/javascript/langchain/middleware/built-in) (human-in-the-loop, model and tool call limits)

Mayura facts come from its [documentation](../../../docs/introduction.md).
