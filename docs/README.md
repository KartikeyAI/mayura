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
- [Using Mayura with AI coding agents](ai-agents.md): documentation your assistant can read offline.

## Concepts

- [Agents](concepts/agent.md): instructions, schemas, a model and tools.
- [Tools](concepts/tools.md): typed functions with declared effects.
- [Runtime](concepts/runtime.md): running agents, events, cancellation and limits.
- [Outcomes](concepts/outcomes.md): how a run ends, error codes, and what to do about each.
- [Permissions](concepts/permissions.md): the allow-list every run is checked against.
- [Costs and budgets](concepts/costs-and-budgets.md): prices, cost caps and shared budgets.
- [Workflows](concepts/workflows.md): multi-step work, in memory or durable.

## Agents and models

- [Model providers](guides/model-providers.md): OpenAI, Anthropic and OpenAI-compatible providers.
- [Model registry](guides/model-registry.md): models as provider/model from @mayurajs provider packages, with prices, retries and chains.
- [Model routing](guides/model-routing.md): failover between providers.
- [Streaming](guides/streaming.md): show an answer while it is written.
- [Vision](guides/vision.md): agents that see images and PDFs, from the input or from tools.
- [Voice](guides/voice.md): transcribe speech and speak text, with prices and per-call bounds.
- [Child agents](guides/child-agents.md): agents that delegate to other agents.
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
- [Memory and context](guides/memory-and-context.md): what an agent remembers and sees.
- [Guardrails](guides/guardrails.md): check, block or redact inputs and outputs.
- [Lifecycle hooks](guides/lifecycle-hooks.md): code that can stop a run at defined points.
- [Artifacts](guides/artifacts.md): store files that runs produce.
- [Code Mode](guides/code-mode.md): run model-written code in a sandbox.
- [Helpers](guides/helpers.md): configuration, secrets, retries and other utilities.

## Serve, observe and deploy

- [Server and client](guides/server-and-client.md): serve agents and workflows over HTTP.
- [React](guides/react.md): hooks, components and forms.
- [Observability](guides/observability.md): events, tracing and OpenTelemetry.
- [Operator console](guides/operator-console.md): a UI for runs, workflows and approvals.
- [Deployment](guides/deployment.md): run Mayura in production.

## CLI

- [Overview](cli/overview.md): the `mayura` command.
- [mayura init](cli/init.md): starters and templates.
- [mayura dev](cli/dev.md): develop with rebuild and restart.
- [serve, worker and migrate](cli/run.md): run an application.
- [Operator commands](cli/operations.md): manage a running server.

## Reference

- [Entry points](reference/entry-points.md): every `mayura/...` import.

## Project

- [Versioning and stability](project/versioning.md): what each release promises.
- [Supported platforms](project/support.md): Node.js versions, operating systems and getting help.
- [Security model](project/security.md): what Mayura protects against, and reporting vulnerabilities.
- [Credits](project/credits.md): the open-source projects and standards Mayura is built on.
