---
title: "Integration packages"
description: "Every @mayurajs package: model providers, voice, storage, files, observability, sandboxes, browsers, authorization, sign-in, API keys and deploy targets."
---

Beside `mayura`, 105 optional `@mayurajs/*` packages connect it to other services. Each is published with every Mayura
release at the same version, takes `mayura` as a peer, and is installed only if you use it:

```bash
npm install mayura @mayurajs/storage-mysql
```

The packages read no environment variables themselves: you pass credentials in as options, and deploy targets use
the platform's own command-line tool, signed in as you. Each package has its own page, and each area's guide shows
how the packages fit together.

## Vector stores

Scoped vector storage beside built-in memory and native-memory adapters. See [Vector stores](../guides/rag.md).

| Package | What it does |
| --- | --- |
| [`@mayurajs/vector-chroma`](../integrations/vector-chroma.md) | Scoped native vector storage for chroma. |
| [`@mayurajs/vector-libsql`](../integrations/vector-libsql.md) | Scoped native vector storage for libsql. |
| [`@mayurajs/vector-pgvector`](../integrations/vector-pgvector.md) | Scoped native vector storage for pgvector. |
| [`@mayurajs/vector-pinecone`](../integrations/vector-pinecone.md) | Scoped native vector storage for pinecone. |
| [`@mayurajs/vector-qdrant`](../integrations/vector-qdrant.md) | Scoped native vector storage for qdrant. |
| [`@mayurajs/vector-weaviate`](../integrations/vector-weaviate.md) | Scoped native vector storage for weaviate. |

## Rerankers

Bounded reranking of authorized evidence by original document index. See [Rerankers](../guides/rag.md).

| Package | What it does |
| --- | --- |
| [`@mayurajs/reranker-cohere`](../integrations/reranker-cohere.md) | Bounded indexed-result reranking with cohere. |
| [`@mayurajs/reranker-jina`](../integrations/reranker-jina.md) | Bounded indexed-result reranking with jina. |
| [`@mayurajs/reranker-voyage`](../integrations/reranker-voyage.md) | Bounded indexed-result reranking with voyage. |

## AI gateways

Registry providers for explicitly configured gateways, with bounded calls and reported-cost accounting. See [AI gateways](../guides/ai-gateways.md).

| Package | What it does |
| --- | --- |
| [`@mayurajs/gateway-cloudflare`](../integrations/gateway-cloudflare.md) | Cloudflare AI Gateway models for Mayura, with explicit credentials, bounded calls and gateway cost accounting. |
| [`@mayurajs/gateway-helicone`](../integrations/gateway-helicone.md) | Helicone models for Mayura, with explicit credentials, bounded calls and gateway cost accounting. |
| [`@mayurajs/gateway-litellm`](../integrations/gateway-litellm.md) | LiteLLM models for Mayura, with explicit credentials, bounded calls and gateway cost accounting. |
| [`@mayurajs/gateway-openrouter`](../integrations/gateway-openrouter.md) | OpenRouter models for Mayura, with explicit credentials, bounded calls and gateway cost accounting. |
| [`@mayurajs/gateway-portkey`](../integrations/gateway-portkey.md) | Portkey models for Mayura, with explicit credentials, bounded calls and gateway cost accounting. |
| [`@mayurajs/gateway-vercel`](../integrations/gateway-vercel.md) | Vercel AI Gateway models for Mayura, with explicit credentials, bounded calls and gateway cost accounting. |

## Model providers

Models as `provider/model` in a model registry, with prices. See [Model providers](../guides/model-registry.md).

| Package | What it does |
| --- | --- |
| [`@mayurajs/provider-anthropic`](../integrations/provider-anthropic.md) | Anthropic Claude models for Mayura, through the official Anthropic SDK. |
| [`@mayurajs/provider-azure`](../integrations/provider-azure.md) | Azure OpenAI models for Mayura, through the official OpenAI SDK and Azure's v1 API. |
| [`@mayurajs/provider-bedrock`](../integrations/provider-bedrock.md) | Amazon Bedrock models for Mayura, through the official AWS SDK and the Converse API. |
| [`@mayurajs/provider-google`](../integrations/provider-google.md) | Google Gemini models for Mayura, through the official Google Gen AI SDK. |
| [`@mayurajs/provider-groq`](../integrations/provider-groq.md) | Groq models for Mayura, through the official Groq SDK. |
| [`@mayurajs/provider-mistral`](../integrations/provider-mistral.md) | Mistral models for Mayura, through the official Mistral SDK. |
| [`@mayurajs/provider-ollama`](../integrations/provider-ollama.md) | Ollama models for Mayura, local or in Ollama's cloud, through the official Ollama SDK. |
| [`@mayurajs/provider-openai`](../integrations/provider-openai.md) | OpenAI models for Mayura, through the official OpenAI SDK. |

## Voice

Speech-to-text and text-to-speech in the voice registry. See [Voice](../guides/voice.md).

| Package | What it does |
| --- | --- |
| [`@mayurajs/voice-assemblyai`](../integrations/voice-assemblyai.md) | AssemblyAI speech-to-text for Mayura's voice registry, over AssemblyAI's HTTP API. |
| [`@mayurajs/voice-azure`](../integrations/voice-azure.md) | Azure Speech transcription and text-to-speech for Mayura's voice registry, over Azure's HTTP APIs. |
| [`@mayurajs/voice-cartesia`](../integrations/voice-cartesia.md) | Cartesia speech-to-text and text-to-speech for Mayura's voice registry, over Cartesia's HTTP API. |
| [`@mayurajs/voice-deepgram`](../integrations/voice-deepgram.md) | Deepgram speech-to-text and text-to-speech for Mayura's voice registry, over Deepgram's HTTP API. |
| [`@mayurajs/voice-elevenlabs`](../integrations/voice-elevenlabs.md) | ElevenLabs speech-to-text and text-to-speech for Mayura's voice registry, over ElevenLabs' HTTP API. |
| [`@mayurajs/voice-google`](../integrations/voice-google.md) | Google Cloud Speech-to-Text and Text-to-Speech for Mayura's voice registry, over Google's HTTP APIs. |
| [`@mayurajs/voice-openai`](../integrations/voice-openai.md) | OpenAI speech-to-text and text-to-speech for Mayura's voice registry, through the official OpenAI SDK. |

## Storage

Databases for runs, workflows, memory and keys, beside the built-in SQLite and PostgreSQL. See [Storage](../guides/storage.md).

| Package | What it does |
| --- | --- |
| [`@mayurajs/storage-d1`](../integrations/storage-d1.md) | Mayura storage on Cloudflare D1, as optimistic transactions over a Worker's D1 binding. |
| [`@mayurajs/storage-dynamodb`](../integrations/storage-dynamodb.md) | Mayura storage on Amazon DynamoDB, as optimistic transactions through the official AWS SDK. |
| [`@mayurajs/storage-libsql`](../integrations/storage-libsql.md) | Mayura storage on libSQL (Turso, sqld or a local file), through the official libSQL client. |
| [`@mayurajs/storage-mongodb`](../integrations/storage-mongodb.md) | Mayura storage on MongoDB, through the official MongoDB driver. |
| [`@mayurajs/storage-mysql`](../integrations/storage-mysql.md) | Mayura storage on MySQL 8, through mysql2. |

## Files

Object stores and filesystems for file stores and artifacts, beside the built-in S3. See [Files](../guides/files.md).

| Package | What it does |
| --- | --- |
| [`@mayurajs/filestorage-agentfs`](../integrations/filestorage-agentfs.md) | AgentFS (Turso's filesystem for agents) for Mayura's file stores. |
| [`@mayurajs/filestorage-azure-blob`](../integrations/filestorage-azure-blob.md) | Azure Blob Storage for Mayura's file stores, over the Blob REST API. |
| [`@mayurajs/filestorage-files-sdk`](../integrations/filestorage-files-sdk.md) | Any Files SDK provider for Mayura's file stores. |
| [`@mayurajs/filestorage-gcs`](../integrations/filestorage-gcs.md) | Google Cloud Storage for Mayura's file stores, over the Cloud Storage JSON API. |
| [`@mayurajs/filestorage-google-drive`](../integrations/filestorage-google-drive.md) | Google Drive for Mayura's file stores, over the Drive API v3. |
| [`@mayurajs/filestorage-mesa`](../integrations/filestorage-mesa.md) | Mesa (mesa.dev), a versioned filesystem for agents, for Mayura's file stores. |
| [`@mayurajs/filestorage-r2`](../integrations/filestorage-r2.md) | Cloudflare R2 through a Workers binding, for Mayura's file stores. |
| [`@mayurajs/filestorage-vercel-blob`](../integrations/filestorage-vercel-blob.md) | Vercel Blob for Mayura's file stores, over the Blob API with fetch. |

## Observability

Trace exporters for observability services, over OpenTelemetry. See [Observability](../guides/observability.md).

| Package | What it does |
| --- | --- |
| [`@mayurajs/observability-arize`](../integrations/observability-arize.md) | Arize AX for Mayura's traces, with OpenInference attributes beside the GenAI ones. |
| [`@mayurajs/observability-betterstack`](../integrations/observability-betterstack.md) | Better Stack for Mayura's traces, over a source's OpenTelemetry endpoint. |
| [`@mayurajs/observability-datadog`](../integrations/observability-datadog.md) | Datadog APM or LLM Observability for Mayura's traces, over Datadog's OTLP intake. |
| [`@mayurajs/observability-langfuse`](../integrations/observability-langfuse.md) | Langfuse for Mayura's traces: agent runs, model calls and tool calls over Langfuse's OpenTelemetry endpoint. |
| [`@mayurajs/observability-langsmith`](../integrations/observability-langsmith.md) | LangSmith for Mayura's traces, with LangSmith's run types, over LangSmith's OpenTelemetry endpoint. |
| [`@mayurajs/observability-posthog`](../integrations/observability-posthog.md) | PostHog LLM analytics for Mayura's traces, over PostHog's OpenTelemetry endpoint for AI events. |
| [`@mayurajs/observability-sentry`](../integrations/observability-sentry.md) | Sentry for Mayura's traces, with Sentry's gen_ai span ops, over Sentry's OTLP endpoint. |

## Sandboxes

Hosted Linux machines for agents, beside the built-in Docker sandboxes. See [Sandboxes](../guides/sandboxes.md).

| Package | What it does |
| --- | --- |
| [`@mayurajs/sandbox-agentcore`](../integrations/sandbox-agentcore.md) | Amazon Bedrock AgentCore Code Interpreter sessions as sandboxes for mayura/sandbox. |
| [`@mayurajs/sandbox-apple-container`](../integrations/sandbox-apple-container.md) | Apple container (macOS) sandboxes for mayura/sandbox, through the container command line. |
| [`@mayurajs/sandbox-cloudflare`](../integrations/sandbox-cloudflare.md) | Cloudflare Sandboxes for mayura/sandbox, through the sandbox bridge Worker. |
| [`@mayurajs/sandbox-codesandbox`](../integrations/sandbox-codesandbox.md) | CodeSandbox (Together) sandboxes for mayura/sandbox, through the CodeSandbox SDK. |
| [`@mayurajs/sandbox-daytona`](../integrations/sandbox-daytona.md) | Daytona sandboxes for mayura/sandbox, over Daytona's REST and toolbox APIs. |
| [`@mayurajs/sandbox-e2b`](../integrations/sandbox-e2b.md) | E2B sandboxes for mayura/sandbox, over E2B's HTTP APIs. |
| [`@mayurajs/sandbox-e2b-desktop`](../integrations/sandbox-e2b-desktop.md) | E2B Desktop sandboxes for mayura/sandbox: a Linux desktop agents can see and use. |
| [`@mayurajs/sandbox-fly`](../integrations/sandbox-fly.md) | Fly.io Machines as sandboxes for mayura/sandbox, over the Machines API. |
| [`@mayurajs/sandbox-modal`](../integrations/sandbox-modal.md) | Modal Sandboxes for mayura/sandbox, through Modal's JavaScript SDK. |
| [`@mayurajs/sandbox-northflank`](../integrations/sandbox-northflank.md) | Northflank sandboxes for mayura/sandbox, through Northflank's JavaScript client. |
| [`@mayurajs/sandbox-railway`](../integrations/sandbox-railway.md) | Railway Sandboxes for mayura/sandbox, through Railway's TypeScript SDK. |
| [`@mayurajs/sandbox-vercel`](../integrations/sandbox-vercel.md) | Vercel Sandbox for mayura/sandbox, over Vercel's REST API. |

## Browsers

Hosted browsers, browser tools and a live viewer, beside the local Chrome or Edge. See [Browsers](../guides/browsers.md).

| Package | What it does |
| --- | --- |
| [`@mayurajs/browser-agent-browser`](../integrations/browser-agent-browser.md) | Vercel Labs' agent-browser CLI as tools on a mayura/browser browser. |
| [`@mayurajs/browser-anchor`](../integrations/browser-anchor.md) | Anchor Browser browsers for mayura/browser, over its sessions API. |
| [`@mayurajs/browser-browser-use`](../integrations/browser-browser-use.md) | Browser Use cloud browsers for mayura/browser, over its browsers API. |
| [`@mayurajs/browser-browserbase`](../integrations/browser-browserbase.md) | Browserbase browsers for mayura/browser, over its sessions API. |
| [`@mayurajs/browser-browserless`](../integrations/browser-browserless.md) | Browserless browsers for mayura/browser, hosted or self-hosted. |
| [`@mayurajs/browser-browserview`](../integrations/browser-browserview.md) | BrowserView browsers for mayura/browser, over its sessions API. |
| [`@mayurajs/browser-cloudflare`](../integrations/browser-cloudflare.md) | Cloudflare Browser Run browsers for mayura/browser, over its CDP endpoint. |
| [`@mayurajs/browser-firecrawl`](../integrations/browser-firecrawl.md) | Firecrawl browsers for mayura/browser, and Firecrawl's scrape, map, search, crawl and extract as tools. |
| [`@mayurajs/browser-hyperbrowser`](../integrations/browser-hyperbrowser.md) | Hyperbrowser browsers for mayura/browser, over its sessions API. |
| [`@mayurajs/browser-kernel`](../integrations/browser-kernel.md) | Kernel browsers for mayura/browser, over its browsers API. |
| [`@mayurajs/browser-stagehand`](../integrations/browser-stagehand.md) | Stagehand's act, extract and observe as tools on a mayura/browser browser. |
| [`@mayurajs/browser-steel`](../integrations/browser-steel.md) | Steel browsers for mayura/browser, over its sessions API. |
| [`@mayurajs/browser-viewer`](../integrations/browser-viewer.md) | A live viewer for mayura/browser browsers: a screencast of the active tab, shared by link, optionally interactive. |
| [`@mayurajs/cloudflare-quick-action`](../integrations/cloudflare-quick-action.md) | Cloudflare Browser Run quick actions (markdown, links, scrape, screenshots, PDFs, JSON, crawls) as a client and as tools. |

## Authorization policies

External policy decisions through the scoped core authorization and audit contracts. See [Authorization policies](../guides/authorization.md).

| Package | What it does |
| --- | --- |
| [`@mayurajs/authz-cedar`](../integrations/authz-cedar.md) | Scoped local Cedar authorization with pinned policies, trusted attributes and core audit integration. |
| [`@mayurajs/authz-http`](../integrations/authz-http.md) | Bounded HTTP authorization policies with scoped fail-closed decisions and core audit integration. |
| [`@mayurajs/authz-openfga`](../integrations/authz-openfga.md) | Scoped OpenFGA authorization checks with pinned models, bounded transport and core audit integration. |
| [`@mayurajs/authz-oso`](../integrations/authz-oso.md) | Scoped Oso Cloud authorization checks with bounded transport and shared core audit integration. |
| [`@mayurajs/authz-permit`](../integrations/authz-permit.md) | Scoped Permit.io PDP checks with explicit environment credentials, bounded transport and core audit integration. |

## Sign-in providers

Identity provider tokens as server identities. See [Sign-in providers](../guides/authentication.md).

| Package | What it does |
| --- | --- |
| [`@mayurajs/auth-auth0`](../integrations/auth-auth0.md) | Auth0 access tokens as Mayura server identities, verified with your tenant's published keys. |
| [`@mayurajs/auth-clerk`](../integrations/auth-clerk.md) | Clerk session tokens as Mayura server identities, verified with Clerk's published keys or its PEM key. |
| [`@mayurajs/auth-cognito`](../integrations/auth-cognito.md) | Amazon Cognito user pool tokens as Mayura server identities, verified with the pool's published keys. |
| [`@mayurajs/auth-entra`](../integrations/auth-entra.md) | Microsoft Entra ID access tokens for your API as Mayura server identities, single- or multi-tenant. |
| [`@mayurajs/auth-facebook`](../integrations/auth-facebook.md) | Facebook Login access tokens (checked with Facebook) and Limited Login tokens as Mayura server identities, and a preset for better-auth's Facebook sign-in. |
| [`@mayurajs/auth-firebase`](../integrations/auth-firebase.md) | Firebase Authentication ID tokens as Mayura server identities, verified with Google's published keys. |
| [`@mayurajs/auth-google`](../integrations/auth-google.md) | Google ID tokens as Mayura server identities, and a least-privilege preset for better-auth's Google sign-in. |
| [`@mayurajs/auth-neon`](../integrations/auth-neon.md) | Neon Auth (managed better-auth) JWTs as Mayura server identities, verified with your project's published keys. |
| [`@mayurajs/auth-okta`](../integrations/auth-okta.md) | Okta access tokens as Mayura server identities, verified with your authorization server's published keys. |
| [`@mayurajs/auth-supabase`](../integrations/auth-supabase.md) | Supabase Auth access tokens as Mayura server identities, verified with your project's published keys. |
| [`@mayurajs/auth-workos`](../integrations/auth-workos.md) | WorkOS AuthKit session tokens and Connect machine tokens as Mayura server identities, verified with WorkOS's published keys. |

## API key services

Keys issued by a key service, beside the built-in key manager. See [API key services](../guides/authentication.md#api-keys).

| Package | What it does |
| --- | --- |
| [`@mayurajs/km-reqkey`](../integrations/km-reqkey.md) | API keys issued by ReqKey as Mayura server identities, validated with ReqKey's API. |
| [`@mayurajs/km-unkey`](../integrations/km-unkey.md) | API keys issued by Unkey as Mayura server identities, verified with Unkey's API. |

## Deploy targets

Platforms for `mayura deploy`, beside Docker, Compose and Kubernetes. See [mayura deploy](../cli/deploy.md).

| Package | What it does |
| --- | --- |
| [`@mayurajs/deploy-agentcore`](../integrations/deploy-agentcore.md) | Amazon Bedrock AgentCore Runtime as a mayura deploy target: an ARM64 image serving its HTTP contract, then the runtime update. |
| [`@mayurajs/deploy-aws-ecs`](../integrations/deploy-aws-ecs.md) | Amazon ECS on Fargate as a mayura deploy target: task definitions, a checked migration task, then the services. |
| [`@mayurajs/deploy-aws-lambda`](../integrations/deploy-aws-lambda.md) | AWS Lambda as a mayura deploy target: one container image, the migration function first, then the API and workflows functions. |
| [`@mayurajs/deploy-azure`](../integrations/deploy-azure.md) | Azure Container Apps as a mayura deploy target: a migration job run to success, then the server and worker apps. |
| [`@mayurajs/deploy-cloudflare`](../integrations/deploy-cloudflare.md) | Cloudflare as a mayura deploy target: the app in Containers, or the serverless module on Workers, with wrangler. |
| [`@mayurajs/deploy-cloudrun`](../integrations/deploy-cloudrun.md) | Google Cloud Run as a mayura deploy target: a migration job, then the server and an always-on worker as services. |
| [`@mayurajs/deploy-digitalocean`](../integrations/deploy-digitalocean.md) | DigitalOcean App Platform as a mayura deploy target: a pre-deploy migration, the server and a worker, released by image tag. |
| [`@mayurajs/deploy-fly`](../integrations/deploy-fly.md) | Fly.io as a mayura deploy target: server and worker processes, the migration as the release command. |
| [`@mayurajs/deploy-railway`](../integrations/deploy-railway.md) | Railway as a mayura deploy target: server and worker services, each migrating before it goes live. |
| [`@mayurajs/deploy-render`](../integrations/deploy-render.md) | Render as a mayura deploy target: a Blueprint with a web service, a background worker and PostgreSQL. |
| [`@mayurajs/deploy-vercel`](../integrations/deploy-vercel.md) | Vercel Functions as a mayura deploy target: the API, cron-driven workflows, and storage migrated before each release. |
