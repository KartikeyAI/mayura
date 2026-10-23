---
title: "Design retrieval around evidence your application can authorize"
description: "Explore Mayura's experimental RAG profile: scoped ingestion, pinned revisions, citation identities, bounded reranking and offline evaluation."
date: 2026-10-23
tags: RAG, experimental, citations, authorization
---

Mayura 1.2 includes an **experimental RAG profile**. The model receives a retrieval tool, not unrestricted access
to a database. Host configuration fixes the verified scope, index space, ingestion limits and retrieval policy.
The result is authorized evidence with citation identities that an application can inspect.

## Separate ingestion from answering

| Boundary | Host responsibility |
| --- | --- |
| Source admission | Verify ownership and document permissions; bound bytes and parsing |
| Embedding | Declare the provider, prices, batch limits and cost ceiling |
| Publication | Activate a catalog revision with exact chunk identities |
| Retrieval | Apply scope, source authorization and bounded search/reranking |
| Answer rendering | Resolve citation identities to authorized source material |

Durable content-hash ingestion and embedding claims retain evidence when a process stops. A job whose paid work is
uncertain must not automatically pay again. Search results from abandoned, superseded or deleted revisions are
discarded before reranking and again before disclosure.

## Begin without a remote service

Use the worked example and configuration in [Retrieval augmented generation](../../../docs/guides/rag.md).
The bounded in-memory vector store provides exact cosine and lexical overlap; native memory offers a local SQLite
path. The deterministic hashing embedder is useful for offline checks, but is not a semantic embedding model.

Keep a small corpus and relevance expectations in your test fixture. Check denied sources, cancellation, stale
revisions, citation identity and budgets as well as the answer's text. An evaluation score over a fixture is not a
claim about arbitrary customer documents.

## Introduce hosted retrieval deliberately

The optional adapters cover six vector stores and three rerankers. Select them from the
[integration catalog](../../../docs/reference/integrations.md), then verify the real service's filtering, revision
visibility, query behavior, cost and limits on the deployment you will operate. Offline fake transports do not prove
remote interoperability or SQL query-plan performance.

Treat retrieved text as untrusted data. A retrieved document must never change agent permissions, choose another
tenant or authorize a write. Combine [resource authorization](../../../docs/guides/authorization.md) with bounded
[memory and context](../../../docs/guides/memory-and-context.md) rather than relying on a prompt alone.

## Present citations honestly

A citation identifies retrieved evidence; it does not prove the model's statement follows from it. Render the
source only after checking the viewer's access, preserve omission markers, and distinguish exact source material
from generated summaries. Keep the experimental label and
[remaining qualifications](../../../docs/guides/release-readiness.md) visible when exposing this profile in a product.
