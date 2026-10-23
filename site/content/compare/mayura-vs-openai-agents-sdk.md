---
title: "Mayura vs the OpenAI Agents SDK"
description: "The OpenAI Agents SDK for TypeScript and Mayura compared: handoffs, sessions and built-in tracing, versus grants, hard budgets and durable steps that never run twice."
date: 2026-10-12
updated: 2026-10-23
tags: comparison, OpenAI, Agents SDK, TypeScript
---

The OpenAI Agents SDK for JavaScript and TypeScript (`@openai/agents`) is OpenAI's framework for multi-agent apps. An
agent has instructions, a model and tools; agents hand conversations to each other or call each other as tools;
guardrails check input, output and tool calls; a tool can require a person's approval; sessions keep conversation
history; and every run is traced to OpenAI's dashboard. It is built around OpenAI's models and the Responses API, with
OpenAI's hosted tools, voice and realtime agents, and sandbox agents that work in a container.

Mayura is an agent and workflow runtime that is neutral about providers and strict about authority. Nothing is allowed
until you grant it, every run has a hard budget, and a durable step that may have acted is never run again.

We make Mayura, so read this with that in mind. We checked every statement about the Agents SDK against its own
documentation, repository and npm listing, and link the sources at the end. If something here is wrong or out of date,
please [tell us](https://github.com/KartikeyAI/mayura/issues).

*Baseline compared October 12, 2026: the OpenAI Agents SDK (`@openai/agents`) 0.20.0. Mayura's side is updated for
published 1.2.0 on October 23. The SDK version and adoption figures below retain their baseline date; handoff,
session and human-in-the-loop documentation was rechecked on October 23.*

## What changes with Mayura 1.2

Mayura now supports [handoffs](../../../docs/guides/agent-handoffs.md), persistent
[threads](../../../docs/guides/threads.md), journaled compaction and approvals inside agent runs. A handoff keeps
one run and budget while replacing the active agent's permissions with the host-declared target policy. The initial
profile is buffered text-only, non-speculative root runs; conversation branching is not included.

The OpenAI SDK's [handoffs](https://openai.github.io/openai-agents-js/guides/handoffs/),
[sessions](https://openai.github.io/openai-agents-js/guides/sessions/) and
[approval flow](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/) remain first-class parts of its
conversation model. Choose between the actual execution and policy contracts; a handoff checkbox alone does not
describe budget continuity, storage ownership or the treatment of uncertain effects.

## At a glance

| | OpenAI Agents SDK | Mayura |
|---|---|---|
| **Maturity** | Since June 2025, still 0.x; about 3,900 GitHub stars and 2.3M weekly npm downloads | Stable 1.2.0 published October 23, 2026; first 1.0 in September 2026; a new project |
| **License** | MIT | Apache-2.0, all of it |
| **Models** | OpenAI models through the Responses API or Chat Completions; other providers through the AI SDK adapter in `@openai/agents-extensions` (in beta) or your own `ModelProvider` | A model registry with `provider/model` strings, dated prices, retries and fallback chains; packages for OpenAI, Anthropic, Google Gemini, Bedrock, Azure OpenAI, Mistral, Groq and Ollama, plus any OpenAI-compatible endpoint |
| **Tools** | Function tools; OpenAI hosted tools (web search, file search, code interpreter, image generation, tool search); computer use, shell and apply_patch; agents as tools; MCP servers; sandbox capabilities | Typed tools with declared effects and capabilities; Code Mode; sandboxes and browsers; MCP tools wrapped one at a time |
| **Tool access** | A tool on an agent can be called; `needsApproval` and tool guardrails check individual calls | Explicit model/tool/effect grants plus optional resource-level RBAC or external policy authorization; denied by default |
| **Cost limits** | `maxTurns` (10 by default) stops a run; token usage is reported; no spending limit | Hard per-run budget: each call's maximum cost is reserved before it starts, and a call that doesn't fit never starts |
| **Human approval** | `needsApproval` pauses the run with `interruptions`; the serialized `RunState` resumes later, including approvals in nested agents | Exact-input approvals inside agent runs and durable workflows; stored checkpoints and typed human requests |
| **Multi-agent** | Handoffs (another agent takes over the conversation) and agents as tools | Continuing-budget handoffs with separate target permissions; child agents, spawned children and speculative branches under bounded delegation. Initial handoffs are buffered text-only, non-speculative root runs |
| **Durable execution** | No workflow engine; a paused run's state serializes with `toString()` and resumes with `RunState.fromString()`, stored where you choose | Durable graphs persisted at every step; at-most-once dispatch; automatic recovery of abandoned steps; pinned definitions and reviewed migrations |
| **Memory** | Sessions keep conversation history: OpenAI's Conversations API, in-memory, or your own `Session`; sandbox agents can keep lessons from earlier runs | Scoped conversation threads, journaled compaction and native long-term memory with provenance/sensitivity; lexical, semantic and hybrid search |
| **Storage** | None of its own beyond OpenAI's Conversations API; sample session backends | SQLite, PostgreSQL, libSQL (Turso), MySQL, MongoDB, Cloudflare D1 and DynamoDB |
| **Observability** | Built-in tracing, exported to OpenAI's Traces dashboard by default on server runtimes; custom trace processors for other destinations | No telemetry by default; metadata-only run events, OpenTelemetry export, and packages for Langfuse, LangSmith, Datadog, Arize, Sentry, Better Stack and PostHog |
| **Also** | Voice and realtime agents; sandbox agents with Docker and local clients, and hosted providers such as E2B, Daytona, Modal, Vercel and Cloudflare | Vision, artifacts, 7 voice providers, file storage, sign-in and API keys, an HTTP server and operator console; 105 integration packages |
| **Runtimes** | Node.js 22+, Deno 2.35+ and Bun 1.2.5+; Cloudflare Workers with limits (`nodejs_compat`, traces flushed by hand); browsers, without tracing | Node.js 22 and 24, Bun, Deno, Cloudflare Workers and Vercel Edge (apart from the Node-only entry points); `mayura deploy` to Docker, Kubernetes and eleven platforms |

## Where they differ most

### Authority: checks on calls, or grants for everything

In the Agents SDK, the tools you put on an agent are the tools it can call. You narrow that with checks on individual
calls: `needsApproval` (always, or decided by a function over the arguments), tool guardrails that run before and after
each function tool, and input and output guardrails on the first and last agent of a run. These are flexible, and the
SDK is careful at the edges: a `needsApproval` function that receives malformed arguments fails closed and asks for
approval.

In Mayura, a runtime starts with nothing allowed. To call a model, a run needs `model:<id>`. To call a tool, it needs
`tool:<id>`, every capability the tool declares (such as `payments:refund`) and `effect:write` if the tool writes. A
missing grant blocks the call before it runs, and nothing the model, the user or a tool result says can add to the list.
A child agent gets only the grants it asks for that its parent also holds. Tools also receive the run's scope, the user
and project it acts for, set by your code rather than the model, so a tool can keep its reads and writes to that user
whatever the model asks for. See
[Permissions](../../../docs/concepts/permissions.md).

### Spending: count turns, or reserve money

The Agents SDK bounds a run by turns: `maxTurns` defaults to 10 and raises `MaxTurnsExceededError` when it is reached.
It reports token usage for the run, which you can use for your own accounting, but it has no limit in money.

Mayura's budget is a hard limit per run. Every model and tool call declares the most it can cost, and the runtime
reserves that amount before the call starts. A call that doesn't fit never starts, a child run spends from its parent's
budget, and a paid model is refused until you set a limit at all. See
[Costs and budgets](../../../docs/concepts/costs-and-budgets.md).

### Pausing and durability: a serialized run, or a durable workflow

The Agents SDK's approval flow is well thought out. When a tool needs approval, the run pauses at the end of the turn
and returns its `interruptions`. You approve or reject each one on the run state, which can be turned into a string,
stored, and resumed later with `RunState.fromString()`, in another process if you like. Approvals raised inside nested
agents surface on the outer run. Model retries are careful too: the SDK does not replay a request the provider may
already have accepted unless your retry policy explicitly allows it.

What the SDK does not have is a workflow engine. A run executes inside your process; where the state is stored, how a
run interrupted by a crash is recovered, and how timers and scheduled work advance are yours to build.

Mayura supports approvals inside agent runs and as steps of [durable workflows](../../../docs/guides/durable-workflows.md). A workflow waits in
storage, the request is bound by a digest to the exact tool, version and input, the person approving is checked by your
verifier, and the request lapses after a time limit. Workers advance runs after restarts. Each step is recorded as
started before its tool is called, and never called again: if the process dies mid-step, the next process settles that
step as unknown once its deadline has passed, and the run ends `outcome_unknown` for a person to reconcile rather than
paying twice. [Never twice](../research/side-effects-never-twice.md) covers the mechanism and its limits.

For an in-run decision, Mayura 1.2 pauses at the exact pending tool call and can persist a checkpoint for another
host to resume. Use a durable workflow when the business process also needs timers, signals or multiple human
steps, as in [the refund guide](../guides/refund-approval.md). Neither path treats an ambiguous write as permission
to run that write again.

### Where data goes

The Agents SDK traces by default, and on server runtimes its default setup exports traces to OpenAI. Its generation
and function spans can store the inputs and outputs of model and tool calls; `traceIncludeSensitiveData` keeps them out
while still emitting spans. You can disable tracing, or add processors that send traces elsewhere. That default is
useful if you use OpenAI's dashboard, and worth knowing if you don't.

Mayura sends nothing by default. Importing it opens no connection, and its run events carry ids, counts, statuses and
costs, never prompts, tool inputs or outputs. Data leaves your process only through an exporter you construct with an
explicit endpoint. Mayura's OpenAI adapter calls the Responses API with `store: false`. See
[Observability](../../../docs/guides/observability.md).

## Where the Agents SDK is ahead

- **OpenAI's platform.** Hosted web search, file search, code interpreter and image generation, tool search, computer
  use, the Conversations API and server-side compaction, all first-class.
- **Voice and realtime.** Realtime voice agents over WebRTC or WebSocket. Mayura's voice support transcribes speech and
  speaks text; it has no realtime sessions.
- **Conversation breadth.** SDK sessions integrate with OpenAI's Conversations API and handoff model. Mayura 1.2
  supplies its own scoped threads, compaction and bounded handoff profile; it does not implement conversation branching.
- **Approval anywhere.** Any agent run can pause for a person, nested agents included, and resume from a serialized
  state.
- **Sandbox agents.** Agents that work in a sandboxed workspace with snapshots and memory of earlier runs, across
  several hosted providers.
- **Tracing with no setup,** and backing by OpenAI, with a larger community and a longer track record.

## When to choose which

**Choose the OpenAI Agents SDK** if you build on OpenAI's models and platform: hosted tools, the Conversations API,
realtime voice, and traces in OpenAI's dashboard. It is a good fit for conversational, multi-agent apps where a
person approving a tool call in the moment is enough.

**Choose Mayura** if your agents act on things that matter, like money, customer records or messages, and you want the
framework to enforce the rules: nothing allowed by default, a hard budget on every run, approvals bound to the exact
input that wait in storage, and durable steps that never run twice. Also if you want to switch providers freely, keep
telemetry in your own hands, and have one Apache-2.0 license for everything.

**Using both** is possible: an Agents SDK app can call a Mayura server through `mayura/client`, or start a Mayura durable
workflow from a function tool for the one step that must wait for an approval and must not run twice. The Agents SDK
can also use models from the Vercel AI SDK through its adapter; see [Mayura vs the AI SDK](mayura-vs-vercel-ai-sdk.md).

## Sources

OpenAI Agents SDK facts were checked on October 12, 2026:

- [npm: @openai/agents](https://www.npmjs.com/package/@openai/agents) (version 0.20.0, release dates, license, dependencies, downloads)
- [GitHub: openai/openai-agents-js](https://github.com/openai/openai-agents-js) (license, stars)
- [Agents](https://openai.github.io/openai-agents-js/guides/agents/), [Running agents](https://openai.github.io/openai-agents-js/guides/running-agents/) and [Results](https://openai.github.io/openai-agents-js/guides/results/)
- [Tools](https://openai.github.io/openai-agents-js/guides/tools/), [Guardrails](https://openai.github.io/openai-agents-js/guides/guardrails/) and [Human-in-the-loop](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)
- [Handoffs](https://openai.github.io/openai-agents-js/guides/handoffs/) and [Sessions](https://openai.github.io/openai-agents-js/guides/sessions/)
- [Models](https://openai.github.io/openai-agents-js/guides/models/) and [AI SDK integration](https://openai.github.io/openai-agents-js/extensions/ai-sdk/)
- [Tracing](https://openai.github.io/openai-agents-js/guides/tracing/) and [Troubleshooting](https://openai.github.io/openai-agents-js/guides/troubleshooting/) (supported environments)
- [Sandbox clients](https://openai.github.io/openai-agents-js/guides/sandbox-agents/clients/), [Sandbox agent memory](https://openai.github.io/openai-agents-js/guides/sandbox-agents/memory/) and [Voice agents](https://openai.github.io/openai-agents-js/guides/voice-agents/)

Mayura facts come from its [documentation](../../../docs/introduction.md).
