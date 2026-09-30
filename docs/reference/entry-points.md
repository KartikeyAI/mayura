---
title: "Entry points"
description: "Every public entry point of the mayura package: what it is for, its key exports and the optional packages it needs."
---

Mayura ships as one npm package, `mayura`. The package root is the core SDK; everything else is a subpath such as
`mayura/workflows` or `mayura/storage-sqlite`. Import only the entry points you use: each one loads only what it
needs, and the heavier ones depend on optional packages that you install yourself.

```ts
import { createRuntime, defineAgent, defineTool } from 'mayura';
import { openAIResponses } from 'mayura/provider-openai';
import { createSqliteStore } from 'mayura/storage-sqlite';
```

Only the paths listed here are public. Importing any other path inside the package (a "deep import") is unsupported
and can break in any release. See [Versioning](../project/versioning.md).

## Optional packages

`mayura` always installs its small pure-JavaScript dependencies. These are optional peers, needed only by the entry
points listed:

| Package | Needed by |
|---|---|
| `better-sqlite3` | `mayura/storage-sqlite`, `mayura/storage` |
| `pg` | `mayura/storage-postgres`, `mayura/storage` |
| `quickjs-emscripten-core` and `@jitl/quickjs-wasmfile-release-sync` | `mayura/adapter-code-quickjs` |
| `react` | `mayura/client-react`, `mayura/client-react/components` |

```bash
npm install mayura better-sqlite3
```

Schemas need no extra package: the root import exports `z` ([Zod](https://zod.dev) 4). Any other Standard Schema
validator works too.

## Core SDK

| Entry point | What it is for | Key exports | Needs |
|---|---|---|---|
| `mayura` | The core SDK: agents, tools, the runtime and core types. Start here. | `defineAgent`, `defineTool`, `createRuntime`, `agentAsTool`, `MayuraError`, `ModelProviderError`, `jsonSchemaOf` | |
| `mayura/sdk` | The same exports as `mayura`. | as `mayura` | |
| `mayura/core` | Core types and primitives only: errors, budgets, JSON values, validation. | `MayuraError`, `Budget`, `validate`, `jsonValue`, `publicError` | |
| `mayura/tools` | Typed tools and calling them directly, including batches. | `defineTool`, `invokeTool`, `invokeBatch`, `ToolRefusal`, `withPreflight` | |
| `mayura/runtime` | Agents, the runtime, model routing and lifecycle hooks. | `defineAgent`, `createRuntime`, `createModelRouter`, `defineHook`, `agentAsTool` | |
| `mayura/testing` | A scripted (and streaming) model, and a helper to test one tool. | `scriptedModel`, `testTool`, `toolGrants` | |

## Models

| Entry point | What it is for | Key exports | Needs |
|---|---|---|---|
| `mayura/provider-openai` | OpenAI Responses, OpenAI-compatible chat completions (Groq, Gemini, Azure OpenAI and others) and embeddings. | `openAIResponses`, `openAICompatibleChat`, `openAIEmbeddings` | |
| `mayura/provider-anthropic` | Anthropic Messages. | `anthropicMessages` | |

## Agent features

| Entry point | What it is for | Key exports | Needs |
|---|---|---|---|
| `mayura/skills` | Agent skills in the `SKILL.md` folder format. | `loadSkills`, `withSkills`, `defineSkill`, `createSkillSet` | |
| `mayura/terminal` | Terminal chat and one-shot agent commands, with a person in the loop. | `runTerminalChat`, `runAgentCommand`, `confirmBeforeRunning`, `askPersonTool` | |
| `mayura/guardrails` | Input and output checks: PII redaction, moderation, protected literals, guarded streaming. | `createPipeline`, `pipelineGuard`, `redactPII`, `createModerationGuard`, `protectLiterals` | |
| `mayura/memory` | Scoped long-term memory with provenance, correction and deletion. | `createMemoryStore`, `createNativeMemory`, `hashingEmbedder` | a storage adapter |
| `mayura/memory-remote` | Mem0, Supermemory and OpenViking as search indexes over native memory. | `createRemoteMemoryBridge`, `mem0Memory`, `supermemory`, `openViking` | |
| `mayura/context` | Selecting context for a model call within a size budget. | `assembleContext`, `byteTokenEstimator`, `createContextCache` | |
| `mayura/artifacts` | Content-addressed storage for files and reports, on local disk or in a file store. | `createLocalArtifactStore`, `createArtifactStore` | |
| `mayura/artifacts/files` | Artifacts in a file store only, without the local store: runs on edge runtimes. | `createArtifactStore` | a file store |
| `mayura/files` | Files in S3, R2 and other object stores, with versions, tenant views and file tools. | `createFileStore`, `s3Files`, `memoryFiles`, `fileTools` | a file backend |
| `mayura/voice` | Speech-to-text and text-to-speech with prices and per-call bounds. | `createVoices`, `transcriptionTool`, `speechTool` | a voice provider package |
| `mayura/adapter-mcp` | Using a tool from an MCP server as a Mayura tool. | `defineMcpTool` | |
| `mayura/helpers` | Small utilities: retries, deadlines, validated configuration, redacted logging. | `retry`, `withDeadline`, `pollUntil`, `validatedEnvironment`, `createRedactedLogger` | |

## Code Mode

| Entry point | What it is for | Key exports | Needs |
|---|---|---|---|
| `mayura/code-mode` | Letting a model write a program that calls your tools, run in a sandbox. | `createCodeMode`, `defineCodeProgram`, `defineSandboxAdapter` | a sandbox adapter |
| `mayura/code-mode-workflows` | Code Mode programs as approval-gated durable workflow steps. | `defineDurableCodeWorkflow`, `createDurableCodeAudit` | |
| `mayura/adapter-code-quickjs` | The QuickJS sandbox: a new, permission-restricted Node.js process per execution. | `createQuickJsSandboxAdapter`, `createQuickJsProtocolAdapter` | `quickjs-emscripten-core`, `@jitl/quickjs-wasmfile-release-sync` |
| `mayura/adapter-code-docker` | The QuickJS sandbox inside a new locked-down Docker container per execution. | `createDockerQuickJsSandboxAdapter`, `createPromotedDockerQuickJsSandboxAdapter`, `issueDockerImagePromotion`, `verifyDockerImagePromotion` | Docker and the sandbox image |

## Workflows

| Entry point | What it is for | Key exports | Needs |
|---|---|---|---|
| `mayura/workflows` | Durable workflows of tool steps and joins, workers, leadership, fleet control and in-flight migrations. | `defineWorkflow`, `createScheduledWorkflowRuntime`, `createWorkflowWorker`, `createWorkflowLeadership`, `defineWorkflowMigration` | a storage adapter |
| `mayura/workflows/lifecycle` | Workflows with agent steps, human steps, timers and signals. | `defineWorkflowLifecycle`, `createWorkflowLifecycleRuntime`, `createWorkflowLifecycleHost`, `agentStep`, `fanOut`, `schemaDigest` | a storage adapter |
| `mayura/workflows/sagas` | Sequential steps with reverse compensation. | `defineWorkflowSaga`, `createWorkflowSagaRuntime` | a storage adapter |
| `mayura/workflows/loops` | Bounded conditional iteration. | `defineWorkflowLoop`, `createWorkflowLoopRuntime` | a storage adapter |
| `mayura/workflows/graphs` | Workflows that wait for other runs to finish. | `defineWorkflowGraph`, `createWorkflowGraphRuntime`, `createWorkflowGraphCoordinator` | a storage adapter |
| `mayura/workflows/children` | Parent workflows with required child workflows. | `defineWorkflowTree`, `createWorkflowTreeRuntime`, `createWorkflowTreeCoordinator` | a storage adapter |
| `mayura/workflows/composites` | Hosting sagas and loops together, with fleet control. | `createWorkflowCompositeHost`, `createWorkflowCompositeFleetRuntime` | a storage adapter |
| `mayura/workflows/agents` | Running an agent as a durable workflow. | `agentAsDurableWorkflow` | a storage adapter |
| `mayura/workflows/ephemeral` | Using a workflow in memory as a tool or an agent, without storage. | `workflowAsTool`, `workflowAsAgent` | |
| `mayura/workstream` | Durable waits on named signals. | `createWorkStream` | a storage adapter |
| `mayura/workstream/executions` | Waiting for a set of workflow runs to finish. | `createExecutionWorkStream` | a storage adapter |
| `mayura/workstream/humans` | Durable requests for a person's answer. | `createHumanWorkStream` | a storage adapter |
| `mayura/workstream/timers` | Durable timers. | `createTimerWorkStream` | a storage adapter |
| `mayura/workstream/webhooks` | Signed webhooks that start durable runs. | `defineWebhookTrigger`, `createWebhookRuntime` | a storage adapter |

## Storage

| Entry point | What it is for | Key exports | Needs |
|---|---|---|---|
| `mayura/storage-sqlite` | SQLite storage, with online backup and verified restore. | `createSqliteStore`, `backupSqliteStore`, `restoreSqliteBackup` | `better-sqlite3` |
| `mayura/storage-postgres` | PostgreSQL storage. | `createPostgresStore` | `pg` |
| `mayura/storage-postgres/driver` | PostgreSQL storage on a pg-compatible pool you own, without `pg`: for edge runtimes. | `createPostgresStore` | |
| `mayura/storage` | Both adapters and the storage contracts from one import. Prefer the specific adapter. | `createSqliteStore`, `createPostgresStore`, `StorageError` | `better-sqlite3` and `pg` |
| `mayura/storage-contracts` | The interfaces a storage adapter implements, for writing your own. | `AggregateStore` (type), `StorageError`, `isStorageError`, `storageError`, `schemaDigest` | |

## Server, client and UI

| Entry point | What it is for | Key exports | Needs |
|---|---|---|---|
| `mayura/server` | The authenticated HTTP API as a Fetch handler, with the operator console. | `createAgentServer` | |
| `mayura/server-node` | Running that API on Node.js: a local server, a production server with TLS or a proxy, and worker probes. | `listenAgentServer`, `listenProductionServer`, `listenProbe` | |
| `mayura/client` | A browser-safe HTTP client for runs, streaming, human requests and workflow commands. | `createClient`, `ClientError`, `escapeHtmlText` | |
| `mayura/client/headless` | Framework-free UI state for runs, run activity and human requests. | `createHeadlessRunStore`, `createRunActivityProjection`, `createHumanRequestView` | |
| `mayura/client/forms` | Forms for answering human requests, with validation. | `defineHumanResponseForm`, `createHumanResponseController`, `validateHumanResponse` | |
| `mayura/client/workflows` | Workflow graph views and command state for UIs. | `createWorkflowGraphProjection`, `createWorkflowCommandController` | |
| `mayura/client-react` | React hooks over the client. | `useMayuraRun`, `useMayuraRunActions`, `useMayuraHumanRequest`, `useMayuraWorkflowGraph`, `useMayuraWorkflowCommand` | `react` |
| `mayura/client-react/components` | Ready-made React components. | `MayuraRunSummary`, `MayuraHumanResponseForm`, `MayuraWorkflowGraph`, `MayuraWorkflowPauseControl`, `MayuraFleetHoldControl` | `react` |
| `mayura/cli` | The CLI as functions: project creation, the application contract and server operations. | `defineMayuraApplication`, `planProject`, `applyProjectPlan`, `inspectWorkflows`, `approveWorkflow` | |

## Observability

| Entry point | What it is for | Key exports | Needs |
|---|---|---|---|
| `mayura/observability` | Metadata-only observation of runs: status, counters and cost. | `createObserver`, `snapshotRunEventMetadata` | |
| `mayura/exporter-otlp` | Exporting logs, traces and metrics over OTLP/HTTP JSON. | `createOtlpHttpJsonLogExporter`, `createOtlpHttpJsonTraceExporter`, `createOtlpHttpJsonMetricExporter`, `agentRunTraceSpans` | |

## For host and adapter authors

These three entry points are for people writing storage adapters, server hosts or other integrations, not for
applications. They are stable under the same rules, but they expose capabilities that must never reach model or guard
code. You do not need them to build agents or workflows.

| Entry point | What it is for | Key exports |
|---|---|---|
| `mayura/core/host` | For hosts and adapter authors: lifecycle evaluation, managed guards, model-call streaming, and strict schemas, tool names and HTTP failures for model adapters. | `evaluateLifecycleControl`, `streamModelCall`, `readServerSentEvents`, `checkStrictDefinition`, `modelToolNames`, `providerHttpFailure` |
| `mayura/tools/host` | Binding a durable budget ticket to a tool call. | `bindToolBudgetTicket` |
| `mayura/storage-sql/host` | The shared SQL engine behind the SQLite and PostgreSQL adapters. | `migrateCommand`, `createCommand`, `schedulerFacade`, `workflowTreeFacade` |

## Related

- [Installation](../installation.md)
- [Versioning](../project/versioning.md)
- [Storage](../guides/storage.md)
- [Code Mode](../guides/code-mode.md)
- [CLI overview](../cli/overview.md)
