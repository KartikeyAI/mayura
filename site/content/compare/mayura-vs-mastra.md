---
title: "Mayura vs Mastra"
description: "Compare Mastra's agent platform, Studio, and UI integrations with Mayura's editable React components, permissions, budgets, and durable workflows."
date: 2026-09-29
updated: 2026-11-25
tags: comparison, Mastra, TypeScript
---

Mastra and Mayura are both TypeScript frameworks for building AI agents and workflows, and on a quick read their
feature lists overlap. Underneath, they aim at different things. Mastra is a broad, batteries-included platform:
hundreds of model providers, dozens of storage backends, RAG, voice, evals and a local studio. Mayura is narrower and
stricter: nothing is allowed until you grant it, every run has a hard budget, and a durable step that may have acted is
never run again.

We make Mayura, so read this with that in mind. We checked every statement about Mastra against its own documentation,
repository and npm listing, and link the sources at the end. If something here is wrong or out of date, please
[tell us](https://github.com/KartikeyAI/mayura/issues).

*The September 29, 2026 baseline used Mastra (`@mastra/core`) 1.71.0. Mayura's side reflects 1.4.0. Mastra's Studio,
AI SDK UI, and approval documentation were checked on November 25, 2026. Catalog counts retain the baseline date.*

## The chat frontend in Mayura 1.4

Mayura 1.4 adds [Agent Workspace](../../../docs/integrations/ui.md#agent-workspace), a React 19 chat surface with
thread history, run activity, source inspection, and approval controls. Use `@mayurajs/ui` from npm or install editable
Tailwind components through the [shadcn registry](../../../docs/integrations/ui.md#shadcn-registry). With the Mayura
runtime, the workspace can show the exact proposed change and reattach to a run through a
[read-only observation route](../../../docs/guides/ag-ui.md#reattach-to-an-existing-run). The server authorizes each
approval and tool dispatch.

Mastra [Studio](https://mastra.ai/docs/studio/overview) lets teams build and inspect agents and workflows. For a
customer-facing app, Mastra documents [streaming into AI SDK UI](https://mastra.ai/integrations/agentic-ui/ai-sdk-ui),
including data parts for rendering tool output and workflow progress. You can also keep a Mastra backend and use
Mayura's individual React components with your own data and callbacks. The assembled workspace expects a compatible
AG-UI transport. Check the transport's history, approval and observation support before relying on those features.

## At a glance

| | Mastra | Mayura |
|---|---|---|
| **Release** | Mastra 1.71.0 at the September 29 baseline | Mayura and Mayura UI 1.4.0, published November 25, 2026 |
| **License** | Apache-2.0, except `ee/` directories under a source-available enterprise license that requires an agreement for production use | Apache-2.0, all of it |
| **Models** | Built-in router with `provider/model` strings (the docs list 212 providers), fallbacks, and AI SDK providers | A model registry with `provider/model` strings, dated prices, retries and fallback chains; packages for OpenAI, Anthropic, Google Gemini, Bedrock, Azure OpenAI, Mistral, Groq and Ollama, plus any OpenAI-compatible endpoint (DeepSeek, xAI, OpenRouter and others) |
| **Tool access** | An agent can use the tools you give it; per-call `activeTools`; fine-grained authorization is an enterprise feature | Explicit model/tool/effect grants plus optional resource-level RBAC or external policy authorization; denied by default |
| **Cost limits** | `TokenCostControl` processor, documented as approximate (a run may briefly exceed it) | Hard per-run budget: each call's maximum cost is reserved before it starts, and a call that doesn't fit never starts |
| **Human approval** | Tool-call approval (`requireApproval`), and suspend and resume | Exact-input approvals inside agent runs and durable workflows; stored checkpoints and typed human requests |
| **Frontend** | Studio for development and operations, plus an AI SDK UI integration for application frontends | Standalone React Agent Workspace, typed reply cards, and an AG-UI transport boundary |
| **Workflows** | `createWorkflow` with `.then`, `.branch`, `.parallel` and loops; suspend and resume; snapshots; retries; Inngest and Temporal integrations | Durable graphs persisted at every step; at-most-once dispatch; automatic recovery of abandoned steps; pinned definitions and reviewed migrations |
| **Memory** | Message history, observational and working memory, semantic recall, threads | Scoped conversation threads, journaled compaction and native long-term memory with provenance/sensitivity; lexical, semantic and hybrid search |
| **Storage** | 21 providers, from libSQL and PostgreSQL to DynamoDB and Cloudflare D1 | SQLite, PostgreSQL, libSQL (Turso), MySQL, MongoDB, Cloudflare D1 and DynamoDB |
| **Evals and tooling** | Evals and scorers, a local Studio, many tracing exporters | Offline tests with scripted models, an operator console, OpenTelemetry export, and packages for Langfuse, LangSmith, Datadog, Arize, Sentry, Better Stack and PostHog |
| **MCP** | Client and server | Wraps individual MCP tools as ordinary tools, under your permissions and budget |
| **Also** | RAG utilities, 17 voice providers, about 120 listed integrations | Code Mode (model-written programs in a sandbox), vision, artifacts, 7 voice providers, sandboxes, browsers, file storage, sign-in and API keys; 105 integration packages |
| **Runtimes** | Node.js, Bun, Deno and Cloudflare; deployers for Vercel, Netlify and Cloudflare | Node.js 22 and 24, Bun, Deno, Cloudflare Workers and Vercel Edge (apart from the Node-only entry points); `mayura deploy` to Docker, Kubernetes and eleven platforms |

## Where they differ most

### Permissions: allowed unless removed, or denied unless granted

In Mastra, an agent can call the tools you give it. You narrow them per call with `activeTools` or `toolChoice`, and
resource-level authorization (for example `tools:execute`) is part of the enterprise edition.

In Mayura, a runtime starts with nothing allowed. To call a paid model, an agent needs `model:<adapter>`. To call a
tool, it needs `tool:<id>`, each capability the tool declares (such as `payments:refund`), and `effect:write` if the
tool writes. A missing grant blocks the call before it runs. The point is that a prompt injection, or a model that
simply gets it wrong, can't reach anything you didn't list. See [Permissions](../../../docs/concepts/permissions.md).

### Budgets: approximate or reserved

Mastra's `TokenCostControl` tracks spending per thread or resource over a time window. Its documentation says the
limit is approximate: metrics are persisted asynchronously, so a run may briefly exceed it, and it needs observability
storage.

Mayura's budget is a hard limit per run. Every model and tool call declares the most it can cost, and the runtime
reserves that amount before the call starts. A call that doesn't fit never starts, and a paid model is refused until
you set a limit at all. See [Costs and budgets](../../../docs/concepts/costs-and-budgets.md).

### Durability: resume or never twice

This is the deepest difference.

Mastra persists workflow snapshots in the storage you configure; the default in-memory store loses them on exit. Its
deployment documentation says the default in-process workers don't survive process crashes: a run interrupted during a
step stays `running` until it is restarted, and restarting resumes from the last active step, which runs that step
again. Distributed setups may deliver events more than once, so the docs ask for idempotent handlers. For stronger
guarantees, Mastra integrates with Inngest and Temporal.

Mayura records each step as started before it calls the tool, and never calls it again. If the process dies mid-step,
the next process to advance the run settles that step as unknown once its deadline has passed, and the run stops for
reconciliation rather than paying twice. Runs stay pinned to the definition they started with until an explicit,
reviewed migration moves them. [Never twice](../research/side-effects-never-twice.md) covers the mechanism and its
limits.

Neither approach is free. Re-running a step is right when steps are idempotent, and it recovers without a human.
Never re-running is right when a duplicate is worse than a pause, as with payments, emails or deletions, and it means
someone occasionally reconciles an `outcome_unknown` run.

## Where Mastra is ahead

- **Breadth.** A studio, general agent evals and a broad storage/integration ecosystem. Mayura offers retrieval-specific
  offline evaluation and a [production-qualified Modal + Pinecone profile](../../../docs/guides/rag-production.md).
  The qualification covers the registered stack and workload.
- **Models.** Mastra's router reaches far more providers out of the box.
- **Edge deployments.** Both run on Bun, Deno and Cloudflare. Mayura is tested on them in CI and on a Vercel Edge
  deployment, but deployed Cloudflare Workers and Deno Deploy are still experimental.
- **Ecosystem.** A larger community, more examples, a hosted platform, and a longer track record.

## When to choose which

**Choose Mastra** if you want the widest set of building blocks in one framework: RAG over your documents, voice,
evals, many models behind one router, and a studio for trying things out.

**Choose Mayura** if your agents act on things that matter, like money, customer records or messages, and you want the
framework to enforce the rules: nothing allowed by default, a hard budget on every run, approvals bound to the exact
input, and durable steps that never run twice. Also if you want one Apache-2.0 license for everything.

## Sources

Mastra facts were checked on September 29, 2026:

- [npm: @mastra/core](https://www.npmjs.com/package/@mastra/core) (version 1.71.0, release dates, downloads)
- [GitHub: mastra-ai/mastra](https://github.com/mastra-ai/mastra), [LICENSE.md](https://github.com/mastra-ai/mastra/blob/main/LICENSE.md) and [ee/LICENSE](https://github.com/mastra-ai/mastra/blob/main/ee/LICENSE)
- [Agents](https://mastra.ai/docs/agents/overview), [Tools](https://mastra.ai/docs/agents/tools), [Human in the loop](https://mastra.ai/docs/agents/human-in-the-loop) and [Guardrails](https://mastra.ai/docs/agents/guardrails)
- [Models](https://mastra.ai/models)
- [Workflows](https://mastra.ai/docs/workflows/overview), [Snapshots](https://mastra.ai/docs/workflows/snapshots), [Error handling](https://mastra.ai/docs/workflows/error-handling) and [Workers](https://mastra.ai/docs/deployment/workers)
- [Memory](https://mastra.ai/docs/memory/overview), [Storage](https://mastra.ai/docs/storage) and [Evals](https://mastra.ai/docs/evals/overview)
- [MCP](https://mastra.ai/docs/connections/mcp), [Deployment](https://mastra.ai/docs/deployment/overview) and [Integrations](https://mastra.ai/integrations)
- [Fine-grained authorization](https://mastra.ai/docs/auth/fga)

Mayura facts come from its [documentation](../../../docs/introduction.md).
