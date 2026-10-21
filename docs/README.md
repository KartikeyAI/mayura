---
title: "Mayura documentation"
description: "Every page of the Mayura documentation, in reading order."
---

Mayura is a TypeScript framework for building AI agents, typed tools and durable workflows. New here? Read the
[introduction](introduction.md), then follow the [quickstart](quickstart.md).

## Get started

- [Introduction](introduction.md): what Mayura is and how its parts fit together.
- [Quickstart](quickstart.md): create a project, or add a first agent to your own.
- [Installation](installation.md): requirements, optional packages and TypeScript settings.
- [V1.2 release validation status](guides/release-readiness.md): completed local and CI checks, limitations and remaining release gates.
- [Using Mayura with AI coding agents](ai-agents.md): documentation your assistant can read offline.

## Concepts

- [Agents](concepts/agent.md): instructions, schemas, a model and tools.
- [Tools](concepts/tools.md): typed functions with declared effects.
- [Runtime](concepts/runtime.md): running agents, events, cancellation and limits.
- [Outcomes](concepts/outcomes.md): how a run ends, error codes, and what to do about each.
- [Permissions](concepts/permissions.md): the allow-list every run is checked against.
- [Costs and budgets](concepts/costs-and-budgets.md): prices, cost caps and shared budgets.
- [Workflows](concepts/workflows.md): multi-step work, in memory or durable.

- [Framework starters](guides/framework-starters.md): six notebook applications with scoped threads, exact approvals and workers.

- [Retrieval augmented generation](guides/rag.md): scoped evidence, durable ingestion, vector stores and reranking.

## Agents and models

- [Model providers](guides/model-providers.md): OpenAI, Anthropic and OpenAI-compatible providers.
- [Model registry](guides/model-registry.md): models as provider/model from @mayurajs provider packages, with prices, retries and chains.
- [AI gateways](guides/ai-gateways.md): explicit gateway credentials, scoped models, discovery and reported costs.
- [Model routing](guides/model-routing.md): failover between providers.
- [Streaming](guides/streaming.md): show an answer while it is written.
- [Vision](guides/vision.md): agents that see images and PDFs, from the input or from tools.
- [Voice](guides/voice.md): transcribe speech and speak text, with prices and per-call bounds.
- [Child agents](guides/child-agents.md): agents that delegate to other agents.
- [Agent handoffs](guides/agent-handoffs.md): transfer a conversation with a continuing budget and separate agent permissions.
- [Skills](guides/skills.md): `SKILL.md` folders an agent loads on demand.
- [MCP tools](guides/mcp.md): call tools on an MCP server.
- [Terminal chat and commands](guides/terminal.md): run an agent in a terminal.
- [Testing](guides/testing.md): test agents, tools and workflows offline.

## Workflows

- [Workflow composition](guides/workflow-composition.md): in-memory workflow graphs and workflows as tools.
- [Durable workflows](guides/durable-workflows.md): steps that survive restarts.
- [Approvals and human input](guides/approvals-and-human-input.md): wait for people.
- [Sagas and loops](guides/sagas-and-loops.md): compensation and repetition.
- [Webhooks](guides/webhooks.md): start and signal workflows from signed webhooks.
- [Operating workflows](guides/workflow-operations.md): pause, resume, cancel, versions and migrations.

## Data, safety and extensions

- [Storage](guides/storage.md): SQLite, PostgreSQL, libSQL (Turso), MySQL, MongoDB, D1 and DynamoDB.
- [Threads](guides/threads.md): keep users' conversations and run each message with the conversation so far.
- [Memory and context](guides/memory-and-context.md): what an agent remembers and sees.
- [Fine-grained authorization](guides/authorization.md): scoped resource access with the core policy contract and built-in RBAC.
- [Guardrails](guides/guardrails.md): check, block or redact inputs and outputs.
- [Lifecycle hooks](guides/lifecycle-hooks.md): code that can stop a run at defined points.
- [Artifacts](guides/artifacts.md): store files that runs produce.
- [Files](guides/files.md): files in S3, R2 and other object stores, with versions, tenant views and file tools.
- [Sandboxes](guides/sandboxes.md): isolated Linux machines for agents to run commands and handle files in, on Docker or a hosted provider.
- [Browsers](guides/browsers.md): real browsers for agents to read and use web pages in, on the Chrome or Edge installed here or a hosted service, kept to allowed origins.
- [Code Mode](guides/code-mode.md): run model-written code in a sandbox.
- [Helpers](guides/helpers.md): configuration, secrets, retries and other utilities.

## Serve, observe and deploy

- [Server and client](guides/server-and-client.md): serve agents and workflows over HTTP.
- [AG-UI adapter](guides/ag-ui.md): scoped run events, stored messages, state snapshots/deltas, permissioned durable frontend tools with native-owner recovery and approval interrupts with the experimental AG-UI 1.0 profile.
- [Authentication and API keys](guides/authentication.md): tokens from identity providers and API keys on your own storage, mapped to what callers may do.
- [React](guides/react.md): hooks, components and forms.
- [Copy-in UI components](guides/copy-in-ui.md): versioned source registry, safe CLI installation and component gallery.
- [Observability](guides/observability.md): events, tracing and OpenTelemetry.
- [Operator console](guides/operator-console.md): a UI for runs, workflows and approvals.
- [Deployment](guides/deployment.md): run Mayura in production.

## CLI

- [Overview](cli/overview.md): the `mayura` command.
- [mayura init](cli/init.md): starters and templates.
- [mayura dev](cli/dev.md): develop with rebuild and restart.
- [serve, worker and migrate](cli/run.md): run an application.
- [mayura deploy](cli/deploy.md): deploy with Docker, Compose, Kubernetes or a platform package.
- [Operator commands](cli/operations.md): manage a running server.

<!-- integrations:start (generated by scripts/integrations-index.mjs) -->

## Integrations: vector stores

- [Chroma](integrations/vector-chroma.md): Scoped native vector storage for chroma.
- [Libsql](integrations/vector-libsql.md): Scoped native vector storage for libsql.
- [Pgvector](integrations/vector-pgvector.md): Scoped native vector storage for pgvector.
- [Pinecone](integrations/vector-pinecone.md): Scoped native vector storage for pinecone.
- [Qdrant](integrations/vector-qdrant.md): Scoped native vector storage for qdrant.
- [Weaviate](integrations/vector-weaviate.md): Scoped native vector storage for weaviate.

## Integrations: rerankers

- [Cohere](integrations/reranker-cohere.md): Bounded indexed-result reranking with cohere.
- [Jina](integrations/reranker-jina.md): Bounded indexed-result reranking with jina.
- [Voyage](integrations/reranker-voyage.md): Bounded indexed-result reranking with voyage.

## Integrations: ai gateways

- [Cloudflare AI Gateway](integrations/gateway-cloudflare.md): Cloudflare AI Gateway models for Mayura, with explicit credentials, bounded calls and gateway cost accounting.
- [Helicone](integrations/gateway-helicone.md): Helicone models for Mayura, with explicit credentials, bounded calls and gateway cost accounting.
- [LiteLLM](integrations/gateway-litellm.md): LiteLLM models for Mayura, with explicit credentials, bounded calls and gateway cost accounting.
- [OpenRouter](integrations/gateway-openrouter.md): OpenRouter models for Mayura, with explicit credentials, bounded calls and gateway cost accounting.
- [Portkey](integrations/gateway-portkey.md): Portkey models for Mayura, with explicit credentials, bounded calls and gateway cost accounting.
- [Vercel AI Gateway](integrations/gateway-vercel.md): Vercel AI Gateway models for Mayura, with explicit credentials, bounded calls and gateway cost accounting.

## Integrations: model providers

- [Amazon Web Services](integrations/provider-bedrock.md): Amazon Bedrock models for Mayura, through the official AWS SDK and the Converse API.
- [Anthropic](integrations/provider-anthropic.md): Anthropic Claude models for Mayura, through the official Anthropic SDK.
- [Google](integrations/provider-google.md): Google Gemini models for Mayura, through the official Google Gen AI SDK.
- [Groq](integrations/provider-groq.md): Groq models for Mayura, through the official Groq SDK.
- [Microsoft Azure](integrations/provider-azure.md): Azure OpenAI models for Mayura, through the official OpenAI SDK and Azure's v1 API.
- [Mistral AI](integrations/provider-mistral.md): Mistral models for Mayura, through the official Mistral SDK.
- [Ollama](integrations/provider-ollama.md): Ollama models for Mayura, local or in Ollama's cloud, through the official Ollama SDK.
- [OpenAI](integrations/provider-openai.md): OpenAI models for Mayura, through the official OpenAI SDK.

## Integrations: voice

- [AssemblyAI](integrations/voice-assemblyai.md): AssemblyAI speech-to-text for Mayura's voice registry, over AssemblyAI's HTTP API.
- [Cartesia](integrations/voice-cartesia.md): Cartesia speech-to-text and text-to-speech for Mayura's voice registry, over Cartesia's HTTP API.
- [Deepgram](integrations/voice-deepgram.md): Deepgram speech-to-text and text-to-speech for Mayura's voice registry, over Deepgram's HTTP API.
- [ElevenLabs](integrations/voice-elevenlabs.md): ElevenLabs speech-to-text and text-to-speech for Mayura's voice registry, over ElevenLabs' HTTP API.
- [Google Cloud](integrations/voice-google.md): Google Cloud Speech-to-Text and Text-to-Speech for Mayura's voice registry, over Google's HTTP APIs.
- [Microsoft Azure](integrations/voice-azure.md): Azure Speech transcription and text-to-speech for Mayura's voice registry, over Azure's HTTP APIs.
- [OpenAI](integrations/voice-openai.md): OpenAI speech-to-text and text-to-speech for Mayura's voice registry, through the official OpenAI SDK.

## Integrations: storage

- [Amazon Web Services](integrations/storage-dynamodb.md): Mayura storage on Amazon DynamoDB, as optimistic transactions through the official AWS SDK.
- [Cloudflare](integrations/storage-d1.md): Mayura storage on Cloudflare D1, as optimistic transactions over a Worker's D1 binding.
- [MongoDB](integrations/storage-mongodb.md): Mayura storage on MongoDB, through the official MongoDB driver.
- [MySQL](integrations/storage-mysql.md): Mayura storage on MySQL 8, through mysql2.
- [Turso](integrations/storage-libsql.md): Mayura storage on libSQL (Turso, sqld or a local file), through the official libSQL client.

## Integrations: files

- [Cloudflare](integrations/filestorage-r2.md): Cloudflare R2 through a Workers binding, for Mayura's file stores.
- [Files SDK](integrations/filestorage-files-sdk.md): Any Files SDK provider for Mayura's file stores.
- [Google Cloud](integrations/filestorage-gcs.md): Google Cloud Storage for Mayura's file stores, over the Cloud Storage JSON API.
- [Google Drive](integrations/filestorage-google-drive.md): Google Drive for Mayura's file stores, over the Drive API v3.
- [Mesa](integrations/filestorage-mesa.md): Mesa (mesa.dev), a versioned filesystem for agents, for Mayura's file stores.
- [Microsoft Azure](integrations/filestorage-azure-blob.md): Azure Blob Storage for Mayura's file stores, over the Blob REST API.
- [Turso](integrations/filestorage-agentfs.md): AgentFS (Turso's filesystem for agents) for Mayura's file stores.
- [Vercel](integrations/filestorage-vercel-blob.md): Vercel Blob for Mayura's file stores, over the Blob API with fetch.

## Integrations: observability

- [Arize](integrations/observability-arize.md): Arize AX for Mayura's traces, with OpenInference attributes beside the GenAI ones.
- [Better Stack](integrations/observability-betterstack.md): Better Stack for Mayura's traces, over a source's OpenTelemetry endpoint.
- [Datadog](integrations/observability-datadog.md): Datadog APM or LLM Observability for Mayura's traces, over Datadog's OTLP intake.
- [Langfuse](integrations/observability-langfuse.md): Langfuse for Mayura's traces: agent runs, model calls and tool calls over Langfuse's OpenTelemetry endpoint.
- [LangSmith](integrations/observability-langsmith.md): LangSmith for Mayura's traces, with LangSmith's run types, over LangSmith's OpenTelemetry endpoint.
- [PostHog](integrations/observability-posthog.md): PostHog LLM analytics for Mayura's traces, over PostHog's OpenTelemetry endpoint for AI events.
- [Sentry](integrations/observability-sentry.md): Sentry for Mayura's traces, with Sentry's gen_ai span ops, over Sentry's OTLP endpoint.

## Integrations: sandboxes

- [Apple](integrations/sandbox-apple-container.md): Apple container (macOS) sandboxes for mayura/sandbox, through the container command line.
- [AWS](integrations/sandbox-agentcore.md): Amazon Bedrock AgentCore Code Interpreter sessions as sandboxes for mayura/sandbox.
- [Cloudflare](integrations/sandbox-cloudflare.md): Cloudflare Sandboxes for mayura/sandbox, through the sandbox bridge Worker.
- [CodeSandbox](integrations/sandbox-codesandbox.md): CodeSandbox (Together) sandboxes for mayura/sandbox, through the CodeSandbox SDK.
- [Daytona](integrations/sandbox-daytona.md): Daytona sandboxes for mayura/sandbox, over Daytona's REST and toolbox APIs.
- [E2B](integrations/sandbox-e2b.md): E2B sandboxes for mayura/sandbox, over E2B's HTTP APIs.
- [E2B](integrations/sandbox-e2b-desktop.md): E2B Desktop sandboxes for mayura/sandbox: a Linux desktop agents can see and use.
- [Fly.io](integrations/sandbox-fly.md): Fly.io Machines as sandboxes for mayura/sandbox, over the Machines API.
- [Modal](integrations/sandbox-modal.md): Modal Sandboxes for mayura/sandbox, through Modal's JavaScript SDK.
- [Northflank](integrations/sandbox-northflank.md): Northflank sandboxes for mayura/sandbox, through Northflank's JavaScript client.
- [Railway](integrations/sandbox-railway.md): Railway Sandboxes for mayura/sandbox, through Railway's TypeScript SDK.
- [Vercel](integrations/sandbox-vercel.md): Vercel Sandbox for mayura/sandbox, over Vercel's REST API.

## Integrations: browsers

- [agent-browser](integrations/browser-agent-browser.md): Vercel Labs' agent-browser CLI as tools on a mayura/browser browser.
- [Anchor Browser](integrations/browser-anchor.md): Anchor Browser browsers for mayura/browser, over its sessions API.
- [Browser Use](integrations/browser-browser-use.md): Browser Use cloud browsers for mayura/browser, over its browsers API.
- [Browserbase](integrations/browser-browserbase.md): Browserbase browsers for mayura/browser, over its sessions API.
- [Browserless](integrations/browser-browserless.md): Browserless browsers for mayura/browser, hosted or self-hosted.
- [BrowserView](integrations/browser-browserview.md): BrowserView browsers for mayura/browser, over its sessions API.
- [Cloudflare](integrations/browser-cloudflare.md): Cloudflare Browser Run browsers for mayura/browser, over its CDP endpoint.
- [Cloudflare](integrations/cloudflare-quick-action.md): Cloudflare Browser Run quick actions (markdown, links, scrape, screenshots, PDFs, JSON, crawls) as a client and as tools.
- [Firecrawl](integrations/browser-firecrawl.md): Firecrawl browsers for mayura/browser, and Firecrawl's scrape, map, search, crawl and extract as tools.
- [Hyperbrowser](integrations/browser-hyperbrowser.md): Hyperbrowser browsers for mayura/browser, over its sessions API.
- [Kernel](integrations/browser-kernel.md): Kernel browsers for mayura/browser, over its browsers API.
- [Mayura](integrations/browser-viewer.md): A live viewer for mayura/browser browsers: a screencast of the active tab, shared by link, optionally interactive.
- [Stagehand](integrations/browser-stagehand.md): Stagehand's act, extract and observe as tools on a mayura/browser browser.
- [Steel](integrations/browser-steel.md): Steel browsers for mayura/browser, over its sessions API.

## Integrations: authorization policies

- [Cedar](integrations/authz-cedar.md): Scoped local Cedar authorization with pinned policies, trusted attributes and core audit integration.
- [HTTP authorization](integrations/authz-http.md): Bounded HTTP authorization policies with scoped fail-closed decisions and core audit integration.
- [OpenFGA](integrations/authz-openfga.md): Scoped OpenFGA authorization checks with pinned models, bounded transport and core audit integration.
- [Oso](integrations/authz-oso.md): Scoped Oso Cloud authorization checks with bounded transport and shared core audit integration.
- [Permit.io](integrations/authz-permit.md): Scoped Permit.io PDP checks with explicit environment credentials, bounded transport and core audit integration.

## Integrations: sign-in providers

- [Amazon Cognito](integrations/auth-cognito.md): Amazon Cognito user pool tokens as Mayura server identities, verified with the pool's published keys.
- [Auth0](integrations/auth-auth0.md): Auth0 access tokens as Mayura server identities, verified with your tenant's published keys.
- [Clerk](integrations/auth-clerk.md): Clerk session tokens as Mayura server identities, verified with Clerk's published keys or its PEM key.
- [Facebook](integrations/auth-facebook.md): Facebook Login access tokens (checked with Facebook) and Limited Login tokens as Mayura server identities, and a preset for better-auth's Facebook sign-in.
- [Firebase](integrations/auth-firebase.md): Firebase Authentication ID tokens as Mayura server identities, verified with Google's published keys.
- [Google](integrations/auth-google.md): Google ID tokens as Mayura server identities, and a least-privilege preset for better-auth's Google sign-in.
- [Microsoft Entra ID](integrations/auth-entra.md): Microsoft Entra ID access tokens for your API as Mayura server identities, single- or multi-tenant.
- [Neon](integrations/auth-neon.md): Neon Auth (managed better-auth) JWTs as Mayura server identities, verified with your project's published keys.
- [Okta](integrations/auth-okta.md): Okta access tokens as Mayura server identities, verified with your authorization server's published keys.
- [Supabase](integrations/auth-supabase.md): Supabase Auth access tokens as Mayura server identities, verified with your project's published keys.
- [WorkOS](integrations/auth-workos.md): WorkOS AuthKit session tokens and Connect machine tokens as Mayura server identities, verified with WorkOS's published keys.

## Integrations: api key services

- [ReqKey](integrations/km-reqkey.md): API keys issued by ReqKey as Mayura server identities, validated with ReqKey's API.
- [Unkey](integrations/km-unkey.md): API keys issued by Unkey as Mayura server identities, verified with Unkey's API.

## Integrations: deploy targets

- [Amazon Bedrock AgentCore](integrations/deploy-agentcore.md): Amazon Bedrock AgentCore Runtime as a mayura deploy target: an ARM64 image serving its HTTP contract, then the runtime update.
- [Amazon ECS](integrations/deploy-aws-ecs.md): Amazon ECS on Fargate as a mayura deploy target: task definitions, a checked migration task, then the services.
- [AWS Lambda](integrations/deploy-aws-lambda.md): AWS Lambda as a mayura deploy target: one container image, the migration function first, then the API and workflows functions.
- [Azure Container Apps](integrations/deploy-azure.md): Azure Container Apps as a mayura deploy target: a migration job run to success, then the server and worker apps.
- [Cloudflare](integrations/deploy-cloudflare.md): Cloudflare as a mayura deploy target: the app in Containers, or the serverless module on Workers, with wrangler.
- [DigitalOcean App Platform](integrations/deploy-digitalocean.md): DigitalOcean App Platform as a mayura deploy target: a pre-deploy migration, the server and a worker, released by image tag.
- [Fly.io](integrations/deploy-fly.md): Fly.io as a mayura deploy target: server and worker processes, the migration as the release command.
- [Google Cloud Run](integrations/deploy-cloudrun.md): Google Cloud Run as a mayura deploy target: a migration job, then the server and an always-on worker as services.
- [Railway](integrations/deploy-railway.md): Railway as a mayura deploy target: server and worker services, each migrating before it goes live.
- [Render](integrations/deploy-render.md): Render as a mayura deploy target: a Blueprint with a web service, a background worker and PostgreSQL.
- [Vercel](integrations/deploy-vercel.md): Vercel Functions as a mayura deploy target: the API, cron-driven workflows, and storage migrated before each release.

<!-- integrations:end -->

## Reference

- [Entry points](reference/entry-points.md): every `mayura/...` import.
- [Integration packages](reference/integrations.md): every `@mayurajs/*` package, by area.

## Project

- [What's new in 1.1](project/whats-new.md): the capabilities and integration packages that 1.1 adds.
- [Versioning and stability](project/versioning.md): what each release promises.
- [Supported platforms](project/support.md): Node.js versions, operating systems and getting help.
- [Security model](project/security.md): what Mayura protects against, and reporting vulnerabilities.
- [Credits](project/credits.md): the open-source projects and standards Mayura is built on.
