---
title: "Mayura vs Mastra"
description: "Two TypeScript frameworks for AI agents and workflows, compared: what each is designed for, how they differ on permissions, budgets and durability, and when to choose which."
date: 2026-09-29
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

*Compared on September 29, 2026: Mastra (`@mastra/core`) 1.71.0 and Mayura 1.0.0.*

## At a glance

| | Mastra | Mayura |
|---|---|---|
| **Maturity** | Since 2024, 1.0 in January 2026; about 28k GitHub stars and 2M weekly npm downloads | 1.0 in September 2026; a new project |
| **License** | Apache-2.0, except `ee/` directories under a source-available enterprise license that requires an agreement for production use | Apache-2.0, all of it |
| **Models** | Built-in router with `provider/model` strings (the docs list 212 providers), fallbacks, and AI SDK providers | OpenAI and Anthropic adapters, plus any OpenAI-compatible endpoint (Gemini, Groq, Mistral, DeepSeek, xAI, OpenRouter and others) |
| **Tool access** | An agent can use the tools you give it; per-call `activeTools`; fine-grained authorization is an enterprise feature | Nothing allowed by default: each model, tool, capability and effect kind is an explicit grant |
| **Cost limits** | `TokenCostControl` processor, documented as approximate (a run may briefly exceed it) | Hard per-run budget: each call's maximum cost is reserved before it starts, and a call that doesn't fit never starts |
| **Human approval** | Tool-call approval (`requireApproval`), and suspend and resume | Approval steps in durable workflows, bound to the exact input by a digest; typed human requests |
| **Workflows** | `createWorkflow` with `.then`, `.branch`, `.parallel` and loops; suspend and resume; snapshots; retries; Inngest and Temporal integrations | Durable graphs persisted at every step; at-most-once dispatch; automatic recovery of abandoned steps; pinned definitions and reviewed migrations |
| **Memory** | Message history, observational and working memory, semantic recall, threads | Scoped long-term memory with provenance and sensitivity, and lexical, semantic and hybrid search |
| **Storage** | 21 providers, from libSQL and PostgreSQL to DynamoDB and Cloudflare D1 | SQLite and PostgreSQL |
| **Evals and tooling** | Evals and scorers, a local Studio, many tracing exporters | Offline tests with scripted models, an operator console, OpenTelemetry export |
| **MCP** | Client and server | Wraps individual MCP tools as ordinary tools, under your permissions and budget |
| **Also** | RAG utilities, 17 voice providers, about 120 listed integrations | Code Mode (model-written programs in a sandbox), vision, artifacts |
| **Runtimes** | Node.js, Bun, Deno and Cloudflare; deployers for Vercel, Netlify and Cloudflare | Node.js 22 and 24: containers, Kubernetes, VMs and serverless functions (Vercel tested). Edge runtimes are planned for 1.1 |

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

- **Breadth.** RAG utilities, voice, evals, a studio, dozens of storage and vector backends, and more than a hundred
  integrations. Mayura has none of RAG, voice or a built-in eval framework.
- **Models.** Mastra's router reaches far more providers out of the box, with fallbacks between them.
- **Runtimes today.** Mastra runs on Bun, Deno and Cloudflare now. Mayura 1.0 is Node.js only, with edge runtimes
  planned for 1.1.
- **Ecosystem.** A larger community, more examples, a hosted platform, and a longer track record.

## When to choose which

**Choose Mastra** if you want the widest set of building blocks in one framework: RAG over your documents, voice,
evals, many models behind one router, and a studio for trying things out. It's also the choice today if you need to
run on Cloudflare Workers.

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
