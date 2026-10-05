---
title: "Integration packages"
description: "Every @mayurajs package: model providers, voice, storage, files, observability, sandboxes, browsers, sign-in, API keys and deploy targets."
---

Beside `mayura`, 85 optional `@mayurajs/*` packages connect it to other services. Each is published with every Mayura
release at the same version, takes `mayura` as a peer, and is installed only if you use it:

```bash
npm install mayura @mayurajs/storage-mysql
```

The packages read no environment variables themselves: you pass credentials in as options, and deploy targets use
the platform's own command-line tool, signed in as you. Each area's guide shows how to use them.

## Model providers

Models as `provider/model` in a model registry, with prices. See [Model providers](../guides/model-registry.md).

| Package | What it does |
| --- | --- |
| `@mayurajs/provider-anthropic` | Anthropic Claude models for Mayura, through the official Anthropic SDK. |
| `@mayurajs/provider-azure` | Azure OpenAI models for Mayura, through the official OpenAI SDK and Azure's v1 API. |
| `@mayurajs/provider-bedrock` | Amazon Bedrock models for Mayura, through the official AWS SDK and the Converse API. |
| `@mayurajs/provider-google` | Google Gemini models for Mayura, through the official Google Gen AI SDK. |
| `@mayurajs/provider-groq` | Groq models for Mayura, through the official Groq SDK. |
| `@mayurajs/provider-mistral` | Mistral models for Mayura, through the official Mistral SDK. |
| `@mayurajs/provider-ollama` | Ollama models for Mayura, local or in Ollama's cloud, through the official Ollama SDK. |
| `@mayurajs/provider-openai` | OpenAI models for Mayura, through the official OpenAI SDK. |

## Voice

Speech-to-text and text-to-speech in the voice registry. See [Voice](../guides/voice.md).

| Package | What it does |
| --- | --- |
| `@mayurajs/voice-assemblyai` | AssemblyAI speech-to-text for Mayura's voice registry, over AssemblyAI's HTTP API. |
| `@mayurajs/voice-azure` | Azure Speech transcription and text-to-speech for Mayura's voice registry, over Azure's HTTP APIs. |
| `@mayurajs/voice-cartesia` | Cartesia speech-to-text and text-to-speech for Mayura's voice registry, over Cartesia's HTTP API. |
| `@mayurajs/voice-deepgram` | Deepgram speech-to-text and text-to-speech for Mayura's voice registry, over Deepgram's HTTP API. |
| `@mayurajs/voice-elevenlabs` | ElevenLabs speech-to-text and text-to-speech for Mayura's voice registry, over ElevenLabs' HTTP API. |
| `@mayurajs/voice-google` | Google Cloud Speech-to-Text and Text-to-Speech for Mayura's voice registry, over Google's HTTP APIs. |
| `@mayurajs/voice-openai` | OpenAI speech-to-text and text-to-speech for Mayura's voice registry, through the official OpenAI SDK. |

## Storage

Databases for runs, workflows, memory and keys, beside the built-in SQLite and PostgreSQL. See [Storage](../guides/storage.md).

| Package | What it does |
| --- | --- |
| `@mayurajs/storage-d1` | Mayura storage on Cloudflare D1, as optimistic transactions over a Worker's D1 binding. |
| `@mayurajs/storage-dynamodb` | Mayura storage on Amazon DynamoDB, as optimistic transactions through the official AWS SDK. |
| `@mayurajs/storage-libsql` | Mayura storage on libSQL (Turso, sqld or a local file), through the official libSQL client. |
| `@mayurajs/storage-mongodb` | Mayura storage on MongoDB, through the official MongoDB driver. |
| `@mayurajs/storage-mysql` | Mayura storage on MySQL 8, through mysql2. |

## Files

Object stores and filesystems for file stores and artifacts, beside the built-in S3. See [Files](../guides/files.md).

| Package | What it does |
| --- | --- |
| `@mayurajs/filestorage-agentfs` | AgentFS (Turso's filesystem for agents) for Mayura's file stores. |
| `@mayurajs/filestorage-azure-blob` | Azure Blob Storage for Mayura's file stores, over the Blob REST API. |
| `@mayurajs/filestorage-files-sdk` | Any Files SDK provider for Mayura's file stores. |
| `@mayurajs/filestorage-gcs` | Google Cloud Storage for Mayura's file stores, over the Cloud Storage JSON API. |
| `@mayurajs/filestorage-google-drive` | Google Drive for Mayura's file stores, over the Drive API v3. |
| `@mayurajs/filestorage-mesa` | Mesa (mesa.dev), a versioned filesystem for agents, for Mayura's file stores. |
| `@mayurajs/filestorage-r2` | Cloudflare R2 through a Workers binding, for Mayura's file stores. |
| `@mayurajs/filestorage-vercel-blob` | Vercel Blob for Mayura's file stores, over the Blob API with fetch. |

## Observability

Trace exporters for observability services, over OpenTelemetry. See [Observability](../guides/observability.md).

| Package | What it does |
| --- | --- |
| `@mayurajs/observability-arize` | Arize AX for Mayura's traces, with OpenInference attributes beside the GenAI ones. |
| `@mayurajs/observability-betterstack` | Better Stack for Mayura's traces, over a source's OpenTelemetry endpoint. |
| `@mayurajs/observability-datadog` | Datadog APM or LLM Observability for Mayura's traces, over Datadog's OTLP intake. |
| `@mayurajs/observability-langfuse` | Langfuse for Mayura's traces: agent runs, model calls and tool calls over Langfuse's OpenTelemetry endpoint. |
| `@mayurajs/observability-langsmith` | LangSmith for Mayura's traces, with LangSmith's run types, over LangSmith's OpenTelemetry endpoint. |
| `@mayurajs/observability-posthog` | PostHog LLM analytics for Mayura's traces, over PostHog's OpenTelemetry endpoint for AI events. |
| `@mayurajs/observability-sentry` | Sentry for Mayura's traces, with Sentry's gen_ai span ops, over Sentry's OTLP endpoint. |

## Sandboxes

Hosted Linux machines for agents, beside the built-in Docker sandboxes. See [Sandboxes](../guides/sandboxes.md).

| Package | What it does |
| --- | --- |
| `@mayurajs/sandbox-agentcore` | Amazon Bedrock AgentCore Code Interpreter sessions as sandboxes for mayura/sandbox. |
| `@mayurajs/sandbox-apple-container` | Apple container (macOS) sandboxes for mayura/sandbox, through the container command line. |
| `@mayurajs/sandbox-cloudflare` | Cloudflare Sandboxes for mayura/sandbox, through the sandbox bridge Worker. |
| `@mayurajs/sandbox-codesandbox` | CodeSandbox (Together) sandboxes for mayura/sandbox, through the CodeSandbox SDK. |
| `@mayurajs/sandbox-daytona` | Daytona sandboxes for mayura/sandbox, over Daytona's REST and toolbox APIs. |
| `@mayurajs/sandbox-e2b` | E2B sandboxes for mayura/sandbox, over E2B's HTTP APIs. |
| `@mayurajs/sandbox-e2b-desktop` | E2B Desktop sandboxes for mayura/sandbox: a Linux desktop agents can see and use. |
| `@mayurajs/sandbox-fly` | Fly.io Machines as sandboxes for mayura/sandbox, over the Machines API. |
| `@mayurajs/sandbox-modal` | Modal Sandboxes for mayura/sandbox, through Modal's JavaScript SDK. |
| `@mayurajs/sandbox-northflank` | Northflank sandboxes for mayura/sandbox, through Northflank's JavaScript client. |
| `@mayurajs/sandbox-railway` | Railway Sandboxes for mayura/sandbox, through Railway's TypeScript SDK. |
| `@mayurajs/sandbox-vercel` | Vercel Sandbox for mayura/sandbox, over Vercel's REST API. |

## Browsers

Hosted browsers, browser tools and a live viewer, beside the local Chrome or Edge. See [Browsers](../guides/browsers.md).

| Package | What it does |
| --- | --- |
| `@mayurajs/browser-agent-browser` | Vercel Labs' agent-browser CLI as tools on a mayura/browser browser. |
| `@mayurajs/browser-anchor` | Anchor Browser browsers for mayura/browser, over its sessions API. |
| `@mayurajs/browser-browser-use` | Browser Use cloud browsers for mayura/browser, over its browsers API. |
| `@mayurajs/browser-browserbase` | Browserbase browsers for mayura/browser, over its sessions API. |
| `@mayurajs/browser-browserless` | Browserless browsers for mayura/browser, hosted or self-hosted. |
| `@mayurajs/browser-browserview` | BrowserView browsers for mayura/browser, over its sessions API. |
| `@mayurajs/browser-cloudflare` | Cloudflare Browser Run browsers for mayura/browser, over its CDP endpoint. |
| `@mayurajs/browser-firecrawl` | Firecrawl browsers for mayura/browser, and Firecrawl's scrape, map, search, crawl and extract as tools. |
| `@mayurajs/browser-hyperbrowser` | Hyperbrowser browsers for mayura/browser, over its sessions API. |
| `@mayurajs/browser-kernel` | Kernel browsers for mayura/browser, over its browsers API. |
| `@mayurajs/browser-stagehand` | Stagehand's act, extract and observe as tools on a mayura/browser browser. |
| `@mayurajs/browser-steel` | Steel browsers for mayura/browser, over its sessions API. |
| `@mayurajs/browser-viewer` | A live viewer for mayura/browser browsers: a screencast of the active tab, shared by link, optionally interactive. |
| `@mayurajs/cloudflare-quick-action` | Cloudflare Browser Run quick actions (markdown, links, scrape, screenshots, PDFs, JSON, crawls) as a client and as tools. |

## Sign-in providers

Identity provider tokens as server identities. See [Sign-in providers](../guides/authentication.md).

| Package | What it does |
| --- | --- |
| `@mayurajs/auth-auth0` | Auth0 access tokens as Mayura server identities, verified with your tenant's published keys. |
| `@mayurajs/auth-clerk` | Clerk session tokens as Mayura server identities, verified with Clerk's published keys or its PEM key. |
| `@mayurajs/auth-cognito` | Amazon Cognito user pool tokens as Mayura server identities, verified with the pool's published keys. |
| `@mayurajs/auth-entra` | Microsoft Entra ID access tokens for your API as Mayura server identities, single- or multi-tenant. |
| `@mayurajs/auth-facebook` | Facebook Login access tokens (checked with Facebook) and Limited Login tokens as Mayura server identities, and a preset for better-auth's Facebook sign-in. |
| `@mayurajs/auth-firebase` | Firebase Authentication ID tokens as Mayura server identities, verified with Google's published keys. |
| `@mayurajs/auth-google` | Google ID tokens as Mayura server identities, and a least-privilege preset for better-auth's Google sign-in. |
| `@mayurajs/auth-neon` | Neon Auth (managed better-auth) JWTs as Mayura server identities, verified with your project's published keys. |
| `@mayurajs/auth-okta` | Okta access tokens as Mayura server identities, verified with your authorization server's published keys. |
| `@mayurajs/auth-supabase` | Supabase Auth access tokens as Mayura server identities, verified with your project's published keys. |
| `@mayurajs/auth-workos` | WorkOS AuthKit session tokens and Connect machine tokens as Mayura server identities, verified with WorkOS's published keys. |

## API key services

Keys issued by a key service, beside the built-in key manager. See [API key services](../guides/authentication.md#api-keys).

| Package | What it does |
| --- | --- |
| `@mayurajs/km-reqkey` | API keys issued by ReqKey as Mayura server identities, validated with ReqKey's API. |
| `@mayurajs/km-unkey` | API keys issued by Unkey as Mayura server identities, verified with Unkey's API. |

## Deploy targets

Platforms for `mayura deploy`, beside Docker, Compose and Kubernetes. See [mayura deploy](../cli/deploy.md).

| Package | What it does |
| --- | --- |
| `@mayurajs/deploy-agentcore` | Amazon Bedrock AgentCore Runtime as a mayura deploy target: an ARM64 image serving its HTTP contract, then the runtime update. |
| `@mayurajs/deploy-aws-ecs` | Amazon ECS on Fargate as a mayura deploy target: task definitions, a checked migration task, then the services. |
| `@mayurajs/deploy-aws-lambda` | AWS Lambda as a mayura deploy target: one container image, the migration function first, then the API and workflows functions. |
| `@mayurajs/deploy-azure` | Azure Container Apps as a mayura deploy target: a migration job run to success, then the server and worker apps. |
| `@mayurajs/deploy-cloudflare` | Cloudflare as a mayura deploy target: the app in Containers, or the serverless module on Workers, with wrangler. |
| `@mayurajs/deploy-cloudrun` | Google Cloud Run as a mayura deploy target: a migration job, then the server and an always-on worker as services. |
| `@mayurajs/deploy-digitalocean` | DigitalOcean App Platform as a mayura deploy target: a pre-deploy migration, the server and a worker, released by image tag. |
| `@mayurajs/deploy-fly` | Fly.io as a mayura deploy target: server and worker processes, the migration as the release command. |
| `@mayurajs/deploy-railway` | Railway as a mayura deploy target: server and worker services, each migrating before it goes live. |
| `@mayurajs/deploy-render` | Render as a mayura deploy target: a Blueprint with a web service, a background worker and PostgreSQL. |
| `@mayurajs/deploy-vercel` | Vercel Functions as a mayura deploy target: the API, cron-driven workflows, and storage migrated before each release. |
