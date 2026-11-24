---
title: Mayura changelog
description: Release history for Mayura, including the latest changes, upgrade notes and links to published artifacts.
---

Mayura and its optional [integration packages](../reference/integrations.md) ship at coordinated versions.
See the [versioning policy](versioning.md) for compatibility and the [GitHub changelog](https://github.com/KartikeyAI/mayura/blob/main/CHANGELOG.md)
for the complete change history.

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
