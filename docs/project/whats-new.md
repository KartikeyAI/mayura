---
title: "What's new in Mayura 1.2"
description: "Persistent threads, exact approvals, agent handoffs, fine-grained authorization, six framework starters, AI gateways and 105 extensions."
---

Mayura **1.2.0 is published** under `latest`: `mayura` plus 105 optional
[integration packages](../reference/integrations.md). All 106 packages were published through trusted publishing
with verified integrity and provenance; existing `next` tags were preserved. See the
[release evidence](../guides/release-readiness.md) for the qualified source and remaining interoperability limits.

## Conversations that continue

[Threads](../guides/threads.md) retain scoped conversation history in your database. A run can pause for an
[exact tool approval](../guides/approvals-and-human-input.md), save a checkpoint, and resume through another host.
Thread/run recording and recovery preserve completed turns without replaying tool writes. Bounded compaction
journals the summary's source, model and cost; uncertain paid work requires inspection rather than another call.

[Agent handoffs](../guides/agent-handoffs.md) continue the thread and budget while switching to separately declared
agent permissions. The initial profile is buffered, text-only, non-speculative root runs.

## Authorization throughout the runtime

[Fine-grained authorization](../guides/authorization.md) adds a shared policy contract, built-in RBAC, audit events
and OpenTelemetry integration. Scoped server routes, agent/tool execution, workflows, memory, retrieval, threads,
approvals and compaction use that contract. Optional adapters cover OpenFGA, Cedar, Permit.io, Oso and an external
HTTP policy service. Resource decisions supplement explicit runtime grants; they do not replace them.

## Start with an application

[Six framework starters](../guides/framework-starters.md) generate working notebooks for
[Next.js](../guides/nextjs.md), [Hono](../guides/hono.md), [React Router](../guides/react-router.md),
[TanStack Start](../guides/tanstack-start.md), [SvelteKit](../guides/sveltekit.md) and [Nuxt](../guides/nuxt.md).
They include scoped threads, exact note approvals, an offline model fixture, a separate indexing worker and
deployment source. [Choose a starter](../guides/choosing-a-starter.md) compares all 11 applications.

[Copy-in React components](../guides/copy-in-ui.md) provide thread history, approval and run controls as source you
own. [Headless stores](../guides/react.md) support native Svelte and Vue views. Hooks and subscriptions observe;
submissions and approval decisions remain explicit actions.

## Gateways and retrieval

Six [AI gateway packages](../guides/ai-gateways.md) connect Vercel AI Gateway, Cloudflare AI Gateway, OpenRouter,
Portkey, Helicone and LiteLLM with scoped models, explicit credentials and bounded costs.

The **experimental [RAG profile](../guides/rag.md)** adds scoped citations, durable ingestion and embedding claims,
parent/contextual retrieval, hybrid/query expansion, six vector adapters, three rerankers and offline evaluation.
Real vector/reranker service interoperability remains unqualified.

The **experimental [AG-UI adapter](../guides/ag-ui.md)** projects run events, thread messages, state snapshots/deltas
and approval interrupts. Durable frontend-tool claims and result outboxes support safe native-owner recovery without
automatically replaying browser writes. Reference-client, CopilotKit and rendered notebook interoperability remain
outside the completed qualification.

## Upgrade and qualification

Install the coordinated release with `npm install mayura@1.2.0`; select matching `@mayurajs/*@1.2.0` packages only
where needed. Review [versioning](versioning.md), [support](support.md) and the
[release validation status](../guides/release-readiness.md) before changing a production host. The full main CI
matrix and V1.1 upgrade check passed; this does not qualify every external provider, browser flow or deployment.

## Mayura 1.1

Mayura 1.1 adds new capabilities to `mayura` and 85 optional [integration packages](../reference/integrations.md) that
connect it to other services. It is a minor release: nothing documented in 1.0 changes, and a 1.0 database works with
1.1 as it is, with no migration. The full list is in `CHANGELOG.md`.

## Models

- **A [model registry](../guides/model-registry.md)** names models as `provider/model`, with dated prices (long-context
  prices too), retries and fallback chains.
- **Eight provider packages:** OpenAI, Anthropic, Google Gemini, Amazon Bedrock, Azure OpenAI, Mistral, Groq and Ollama.

## Voice

**[`mayura/voice`](../guides/voice.md)** transcribes speech and speaks text, with prices and a cost bound checked before
each call. Seven packages: OpenAI, ElevenLabs, Deepgram, AssemblyAI, Google Cloud, Azure Speech and Cartesia.

## Files

- **[`mayura/files`](../guides/files.md)** keeps files in object stores, with conditional writes, versions, tenant
  views and file tools.
  - S3 is built in, which also covers Cloudflare R2, MinIO and Backblaze B2.
  - [Artifacts](../guides/artifacts.md) can live in any file store.
- **Eight packages:** Google Cloud Storage, Azure Blob Storage, R2 through a Workers binding, Vercel Blob, Google Drive,
  AgentFS, Mesa, and any Files SDK provider.

## Storage

[Storage](../guides/storage.md) gains libSQL (Turso), MySQL, MongoDB, Cloudflare D1 and Amazon DynamoDB, beside SQLite
and PostgreSQL. Every store passes the same conformance suites. PostgreSQL can also run on a pool you create, which is
how it runs at the edge.

## Sandboxes and browsers

- **[`mayura/sandbox`](../guides/sandboxes.md)** gives agents isolated Linux machines to run commands and handle files.
  - Docker is built in, locked down by default.
  - Twelve hosted providers: E2B (and E2B Desktop), Vercel, Daytona, Fly.io, AWS AgentCore, Modal, Railway, Northflank,
    CodeSandbox, Cloudflare and Apple container.
- **[`mayura/browser`](../guides/browsers.md)** gives agents real browsers, kept to the origins you allow.
  - It drives the Chrome or Edge already installed, or a hosted browser: Browserbase, Steel, Hyperbrowser, Browserless,
    Kernel, Browser Use, Anchor, BrowserView, Cloudflare and Firecrawl.
  - Also: Stagehand and agent-browser as tools, Cloudflare quick actions, and a live viewer.

## Authentication and API keys

[Authentication and API keys](../guides/authentication.md):

- **`mayura/auth`** verifies tokens from any identity provider on any runtime and maps them to what a caller may do.
  `mayura/auth/better-auth` hosts sign-in with better-auth.
- **Eleven identity provider packages:** Clerk, Auth0, Neon Auth, Supabase, Firebase, WorkOS, Google, Facebook,
  Microsoft Entra ID, Okta and Amazon Cognito.
- **`mayura/keys`** issues, rotates and revokes API keys in any Mayura store, with scopes, expiry, rate limits and
  credits. Keys issued by Unkey or ReqKey work through their packages.

## Observability

[Observability](../guides/observability.md) traces now carry OpenTelemetry GenAI attributes and token counts. They can be
sent through your own OpenTelemetry SDK, or as OTLP JSON or protobuf. Seven service packages: Langfuse, LangSmith,
Datadog, Arize AX and Phoenix, Sentry, Better Stack and PostHog.

## Deploy, and the edge

- **[`mayura deploy`](../cli/deploy.md)** writes a target's files for review, then shows a plan and runs it, after you
  confirm, through the platform's own tools.
  - Docker, Docker Compose and Kubernetes are built in.
  - Eleven platform packages: Fly.io, Railway, Render, Google Cloud Run, AWS ECS and Lambda, Vercel, Azure Container
    Apps, DigitalOcean, Amazon Bedrock AgentCore and Cloudflare.
- **Edge runtimes.** Mayura runs on Cloudflare Workers, Vercel Edge Functions, Deno and Bun, apart from the Node-only
  entry points; see [Deployment](../guides/deployment.md#edge-runtimes) and
  [Support](support.md#edge-and-other-javascript-runtimes).

## Upgrading from 1.0

Install the same version of `mayura` and of every `@mayurajs/*` package you use: they are released together. No code
or storage changes are needed. See [Versioning](versioning.md) for what each release promises.
