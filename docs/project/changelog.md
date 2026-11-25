---
title: Mayura changelog
description: Release history for Mayura, including the latest changes, upgrade notes and links to published artifacts.
---

Mayura and its optional [integration packages](../reference/integrations.md) have their own npm versions.
See the [versioning policy](versioning.md) for compatibility and the [GitHub changelog](https://github.com/KartikeyAI/mayura/blob/main/CHANGELOG.md)
for the complete change history.

## 1.4.1

- The [Hono Cloudflare Workers starter](../guides/hono.md) gives each invocation its own agent server and
  persists state in D1 so chat, approvals and observation can continue across requests.
- `mayura` and the optional extensions release independently. The CLI pins generated starters to their
  compatible adapter releases. See the [versioning policy](versioning.md).

## 1.4.0 · November 25, 2026

- **Agent Workspace.** A ready-to-compose React 19 workspace brings together conversation, thread history,
  run activity, exact approval review, citations and artifacts. Supply your own transport and customize the
  sidebar, composer or message rendering. See the [Mayura UI guide](../integrations/ui.md#agent-workspace).
- **Reconnect to a running agent.** With authorized AG-UI observation, reconnecting restores the current
  transcript and pending approval. The observation sends no new prompt, approval decision or tool call.
  The [Mayura AG-UI adapter](../guides/ag-ui.md#reattach-to-an-existing-run) remains experimental.
- **Reply cards.** Render tables, allowlisted downloads and confirmations. Applications can register custom
  renderers and keep authorization for any write at their own endpoint. See [reply cards](../integrations/ui.md#reply-cards).
- **Editable Tailwind v4 source.** Install workspace components through the
  [shadcn registry](../integrations/ui.md#shadcn-registry), or use the npm package with your app's Tailwind build.
  The compiled fallback and [`mayura add ui`](../guides/copy-in-ui.md) remain available.
- **Runnable example.** Try streaming, reconnecting to the same run and reviewing a proposed write in the
  [Next.js Agent Workspace example](../guides/nextjs.md#agent-workspace-example) with no provider credentials.

Published all 107 packages to npm under `latest`, with all 23 existing `next` tags preserved.

[Release artifacts](https://github.com/KartikeyAI/mayura/releases/tag/v1.4.0) ·
[Validation results](../guides/release-readiness.md#v140-publication)

## 1.3.0 · November 25, 2026

- Introduced [`@mayurajs/ui`](../integrations/ui.md) as a standalone React 19 component library with
  chat, threads, activity, citations, artifacts and exact approval review. The AG-UI hook accepts an app-owned transport.
- Opened the [shadcn registry](../integrations/ui.md#shadcn-registry) for installing source into React apps.
- Rechecked identity and run access before native event-stream disclosures. Revoked observations close while
  the underlying run continues.

[Release artifacts](https://github.com/KartikeyAI/mayura/releases/tag/v1.3.0)

## 1.2.2 · November 23, 2026

- Added the [Modal + Pinecone RAG starter](../guides/rag-modal-pinecone-starter.md). Generate it from npm and
  try Markdown ingestion and cited answers with local fixtures.
- Upgraded Zod to 4.6.7, Hono to 4.13.20 and `@hono/node-server` to 2.1.11. Production dependency audits
  cover every published package. High and critical findings block qualification, and moderate findings
  require reviewed, expiring exceptions.
- Added a [RAG quickstart](../guides/rag-quickstart.md), a [qualification matrix](../guides/rag-production.md)
  and installed-package acceptance tests for retrieval, citation grounding, recovery and failure handling.
- Added an archive-size budget, shared identical starter files and checked registry signatures, provenance
  and clean installation before creating the release tag.

[Release artifacts](https://github.com/KartikeyAI/mayura/releases/tag/v1.2.2) ·
[Validation results](../guides/release-readiness.md#v122-publication)

## 1.2.1 · November 23, 2026

- Qualified the [Modal + Pinecone Loki v28 RAG profile](../guides/rag-production.md) for its registered
  software-operations workload. Other RAG profiles remain experimental.
- Made the [workflow graph node limit configurable](../concepts/workflows.md#configuring-graph-size).
  The default is 128 nodes.

[Release artifacts](https://github.com/KartikeyAI/mayura/releases/tag/v1.2.1)

## 1.2.0 · October 23, 2026

- Added persistent threads, exact approvals, agent handoffs, fine-grained authorization, six framework
  starters and AI gateway adapters.
- Introduced the initial experimental RAG and AG-UI profiles.

[Release artifacts](https://github.com/KartikeyAI/mayura/releases/tag/v1.2.0)

## 1.1.0 · October 12, 2026

- Added voice, file stores, hosted sandboxes and browsers, more database adapters, authentication,
  observability and deployment integrations.

[Mayura 1.1 highlights](whats-new.md#mayura-11) ·
[Release artifacts](https://github.com/KartikeyAI/mayura/releases/tag/v1.1.0)
