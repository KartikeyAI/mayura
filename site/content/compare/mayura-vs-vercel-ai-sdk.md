---
title: "Mayura vs the Vercel AI SDK"
description: "The AI SDK and Mayura compared for production agents: a toolkit for models, streaming and chat UI, and a runtime that enforces grants, budgets and durable steps."
date: 2026-10-12
updated: 2026-10-23
tags: comparison, AI SDK, Vercel, TypeScript
---

The Vercel AI SDK is the most widely used TypeScript library for working with language models. It gives you one API
over many providers for text, structured output, tools, embeddings, images and speech, streams the result, and has UI
hooks such as `useChat` for React, Vue and Svelte. On top of that it has agents: `ToolLoopAgent` in the `ai` package,
and `WorkflowAgent` in `@ai-sdk/workflow`, which runs on Vercel's Workflow SDK so an agent survives restarts.

Mayura is narrower. It is an agent and workflow runtime: you tell it what runs may use, who they act for and how much
they may spend, then submit agents and durable workflows to it. Nothing is allowed until you grant it, every run has a
hard budget, and a durable step that may have acted is never run again.

The two overlap on the agent loop and much less elsewhere. Many agent frameworks build on the AI SDK's providers;
Mayura doesn't, and has its own provider packages. We say below where they can be used together.

We make Mayura, so read this with that in mind. We checked every statement about the AI SDK against its own
documentation, repository and npm listing, and link the sources at the end. If something here is wrong or out of date,
please [tell us](https://github.com/KartikeyAI/mayura/issues).

*Compared on October 12, 2026: the AI SDK (`ai`) 7.0.137, `@ai-sdk/workflow` 2.0.69 and the Workflow SDK (`workflow`)
5.2.0. Mayura's side is updated for published 1.2.0 on October 23. AI SDK versions, adoption figures and other details
retain the baseline date; the tool approval documentation was rechecked on October 23.*

## What changes with Mayura 1.2

Mayura now includes persistent threads, approvals inside agent runs, React conversation source and headless stores
used by six framework notebooks. It also ships explicit gateway adapters, including Vercel AI Gateway, and
experimental RAG and AG-UI profiles. See [the release overview](../../../docs/project/whats-new.md).

The AI SDK documents [tool approval](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling) alongside tool
execution and streaming. Both can gate a proposed action for review. Compare who verifies identity, where pending
work is persisted, how spending is bounded and what happens after an uncertain write; neither a UI hook nor an
approval button establishes all four by itself.

## At a glance

| | AI SDK | Mayura |
|---|---|---|
| **Maturity** | Since 2023, version 7 in June 2026; about 27,000 GitHub stars and 31M weekly npm downloads for `ai` | Stable 1.2.0 published October 23, 2026; first 1.0 in September 2026; a new project |
| **License** | Apache-2.0 (`ai`, `@ai-sdk/workflow` and `workflow`) | Apache-2.0, all of it |
| **Models** | A provider specification with more than 40 official provider packages and about 60 listed community providers; the Vercel AI Gateway is the default global provider, with `provider/model` strings | A model registry with `provider/model` strings, dated prices, retries and fallback chains; packages for OpenAI, Anthropic, Google Gemini, Bedrock, Azure OpenAI, Mistral, Groq and Ollama, plus any OpenAI-compatible endpoint |
| **Scope** | Model calls of many kinds (text, structured output, embeddings, images, video, speech, transcription, reranking), streaming, chat UI hooks, agents | Agents, typed tools, durable workflows, memory, guardrails, an HTTP server and client, plus voice, vision, files, sandboxes, browsers, sign-in and API keys |
| **Tool access** | Tools run when the model calls them; `toolApproval` can approve, deny or ask a person per call, and `@ai-sdk/policy-opa` moves those rules into OPA policies | Explicit model/tool/effect grants plus optional resource-level RBAC or external policy authorization; denied by default |
| **Cost limits** | Stop conditions checked after each step: `ToolLoopAgent` stops after 20 steps by default, `WorkflowAgent` has no default limit; a custom condition can estimate cost from token usage | Hard per-run budget: each call's maximum cost is reserved before it starts, and a call that doesn't fit never starts |
| **Human approval** | `user-approval` through `toolApproval` on `ToolLoopAgent`; `needsApproval` on `WorkflowAgent` tools survives suspension | Exact-input approvals inside agent runs and durable workflows; stored checkpoints and typed human requests |
| **Durable execution** | `ToolLoopAgent` runs in memory and loses progress on a crash; `WorkflowAgent` makes each tool call a durable step with automatic retries | Every step recorded before and after it runs; at-most-once dispatch; abandoned steps settled as unknown, never re-run; pinned definitions |
| **Workflows** | Patterns written in code (sequential, parallel, routing, orchestrator-worker, evaluator loops); durable functions with the Workflow SDK's `'use workflow'` and `'use step'` | Durable graphs declared as data, with approvals, human requests, timers, signals, sagas and loops |
| **Memory** | Provider memory tools (such as Anthropic's), memory providers (Letta, Mem0, Supermemory, Hindsight, MongoDB) or a tool you write | Scoped conversation threads, journaled compaction and native long-term memory with provenance/sensitivity; lexical, semantic and hybrid search |
| **Storage** | None in `ai`; Workflow SDK "Worlds" for local development, Vercel, PostgreSQL and community backends | SQLite, PostgreSQL, libSQL (Turso), MySQL, MongoDB, Cloudflare D1 and DynamoDB |
| **Observability** | OpenTelemetry through `@ai-sdk/otel`; about 20 observability integrations listed | Metadata-only run events, OpenTelemetry export, and packages for Langfuse, LangSmith, Datadog, Arize, Sentry, Better Stack and PostHog |
| **MCP** | Client over HTTP, SSE or stdio, with tools, resources and prompts; MCP apps | Wraps individual MCP tools as ordinary tools, under your permissions and budget |
| **Runtimes** | AI SDK Core in any JavaScript environment (Node.js, Deno, browsers); UI hooks for React, Vue and Svelte; Workflow SDK on Vercel or a self-hosted World | Node.js 22 and 24, Bun, Deno, Cloudflare Workers and Vercel Edge (apart from the Node-only entry points); `mayura deploy` to Docker, Kubernetes and eleven platforms |

## Where they differ most

### A toolkit you call, or a runtime you configure

The AI SDK is a set of functions and classes you call from your own code: `generateText`, `streamText`, a
`ToolLoopAgent`'s `generate` or `stream`. You own the process, the request, the storage and the authorization around
it. Its centre is the model call and the stream back to a user interface, and it is very good at both.

Mayura is a [runtime](../../../docs/concepts/runtime.md) you configure once with permissions, a scope (who the run acts
for) and limits, and then submit agents to. It validates the input before the model is called and the output before it
is released, ends every run with one typed [outcome](../../../docs/concepts/outcomes.md), and comes with the pieces a
production service needs around that: an HTTP server and client, workers for durable workflows, storage and an
operator console.

### Tool access: run unless stopped, or denied unless granted

The AI SDK documentation states the default plainly: tools with an `execute` function run automatically when the model
calls them. `toolApproval` changes that per tool or per call, with four statuses: run normally, approve automatically,
deny, or wait for a person. `@ai-sdk/policy-opa` moves those rules into Open Policy Agent policies, which also see the
run's message history, so a policy can count earlier writes or deny a second irreversible action. You can build a
default-deny policy this way; it is yours to write.

In Mayura, default-deny is the starting point. A runtime allows nothing until you list it: `model:<id>` for each model,
`tool:<id>` for each tool, every capability the tool declares (such as `payments:refund`) and `effect:write` if it
writes. A missing grant blocks the call before it runs, and nothing the model, the user or a tool result says can add
to the list. Child agents get the intersection of their own grants and their parent's. See
[Permissions](../../../docs/concepts/permissions.md).

### Budgets: stop after, or reserve before

The AI SDK bounds an agent with stop conditions, which are checked after a step that produced tool results.
`ToolLoopAgent` stops after 20 steps unless you choose otherwise; `WorkflowAgent` has no default limit. The loop
control guide shows a custom condition that adds up token usage and stops once an estimated cost passes $0.50, and OPA
policies can deny calls once a running total is reached. In both cases the check sees what has already been spent, so
the step that crosses the line has already been paid for.

Mayura checks before the call. Every model and tool call declares the most it can cost, the runtime reserves that
amount from the run's budget, and a call that doesn't fit never starts. A paid model is refused until you set a limit
at all, and a child run's cost counts against its parent's budget. See
[Costs and budgets](../../../docs/concepts/costs-and-budgets.md).

### Durability: retry the step, or never run it twice

A `ToolLoopAgent` runs in memory; the AI SDK documentation says that if the process crashes, all progress is lost. For
durability it offers `WorkflowAgent`, which runs inside a workflow of the Workflow SDK: each model call and tool call
becomes a durable step, completed steps are reused on replay, failed tool calls are retried automatically, and
approvals survive suspension. The Workflow SDK retries a step up to three times by default and asks for side effects
such as payments and emails to be idempotent. The `WorkflowAgent` guide is explicit that completed-step replay "does
not guarantee exactly-once effects for an interrupted attempt".

Mayura records each workflow step as started before it calls the tool, and never calls it again. If the process dies
mid-step, the next process to advance the run settles the step as unknown once its deadline has passed, and the run
ends `outcome_unknown` for a person to reconcile instead of paying twice. There are no automatic retries, and every run
stays pinned to the workflow definition it started with. [Never twice](../research/side-effects-never-twice.md) covers
the mechanism and its limits.

Neither approach is free. Retrying recovers from transient failures without a human, and is right when steps are
idempotent. Never retrying is right when a duplicate is worse than a pause, as with payments, emails or deletions, and
it means someone occasionally reconciles a run.

## Where the AI SDK is ahead

- **Models.** Far more providers out of the box, one interface across them, and the AI Gateway for reaching many
  through one key.
- **User interfaces.** `useChat` and related hooks for React, Vue and Svelte, a stream protocol, resumable streams and
  generative UI. Mayura 1.2 includes React thread history/approval source and headless stores for other frameworks;
  it does not provide the AI SDK's full generative UI and modality surface.
- **Modalities.** Image and video generation, reranking and realtime, besides text, speech and transcription. Mayura
  has voice and vision, and no image or video generation.
- **Conversation UI.** Agents work on message arrays, with chat hooks across frameworks. Mayura now has scoped
  persistent threads, compaction and notebook interfaces, with a deliberately bounded conversation contract.
- **Approval inside an agent.** `toolApproval` pauses an ordinary `ToolLoopAgent` before selected tool calls. In
  Mayura 1.2, an agent run can pause for an exact-input approval and resume from a stored checkpoint. Workflow
  approvals remain available for a longer business process, as in [the refund guide](../guides/refund-approval.md).
- **Reach.** Harnesses that run Claude Code or Codex behind the same interface, a much larger community, and a longer
  track record. Other agent frameworks build on its providers, so what you learn carries over.

## When to choose which

**Choose the AI SDK** if the centre of your app is a conversation with a model: a chat interface, streaming answers,
many providers behind one API, or generated images and audio. Its agents are a good fit when the tools are safe to run
when the model asks, and its `WorkflowAgent` when a long agent should survive restarts and its steps are safe to retry.

**Choose Mayura** if your agents act on things that matter, like money, customer records or messages, and you want the
framework to enforce the rules: nothing allowed by default, a hard budget on every run, approvals bound to the exact
input, and durable steps that never run twice. Also if you want one Apache-2.0 license for everything.

**Using both** works, because they sit at different layers. Mayura's model adapter interface is documented for
[wrapping an SDK you already use](../../../docs/guides/model-providers.md#writing-your-own-adapter), so an AI SDK model
can become a Mayura model, with the prices and per-call ceiling you give it; Mayura doesn't ship such an adapter. In the
other direction, an AI SDK app can keep its chat interface and call a Mayura server through `mayura/client`, or start a
Mayura durable workflow from a tool for the one step that needs an approval and must not run twice.

## Sources

AI SDK facts were checked on October 12, 2026:

- [npm: ai](https://www.npmjs.com/package/ai) (version 7.0.137, release dates, license, downloads), [@ai-sdk/workflow](https://www.npmjs.com/package/@ai-sdk/workflow) and [workflow](https://www.npmjs.com/package/workflow)
- [GitHub: vercel/ai](https://github.com/vercel/ai) (stars, repository history)
- [Agents overview](https://ai-sdk.dev/docs/agents/overview), [Loop control](https://ai-sdk.dev/docs/agents/loop-control) and [Workflow patterns](https://ai-sdk.dev/docs/agents/workflows)
- [Tool approvals](https://ai-sdk.dev/docs/agents/tool-approvals) and [Policy tool approvals](https://ai-sdk.dev/docs/agents/policy-tool-approvals)
- [WorkflowAgent](https://ai-sdk.dev/docs/agents/workflow-agent)
- [Memory](https://ai-sdk.dev/docs/agents/memory)
- [Providers and models](https://ai-sdk.dev/docs/foundations/providers-and-models), [Choosing a provider](https://ai-sdk.dev/docs/getting-started/choosing-a-provider) and [Navigating the library](https://ai-sdk.dev/docs/getting-started/navigating-the-library)
- [Telemetry](https://ai-sdk.dev/docs/ai-sdk-core/telemetry), [MCP tools](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools) and [Harnesses](https://ai-sdk.dev/docs/ai-sdk-harnesses/overview)
- Workflow SDK: [Deploying and Worlds](https://workflow-sdk.dev/docs/deploying) and [Errors and retries](https://workflow-sdk.dev/docs/foundations/errors-and-retries)

Mayura facts come from its [documentation](../../../docs/introduction.md).
