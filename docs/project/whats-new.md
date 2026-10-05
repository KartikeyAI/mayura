---
title: "What's new in Mayura 1.1"
description: "Mayura 1.1: a model registry, voice, files, sandboxes, browsers, authentication and API keys, mayura deploy, edge runtimes and 85 integration packages."
---

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
