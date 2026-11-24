---
title: "Design retrieval around evidence your application can authorize"
description: "Build a retrieval agent with scoped ingestion, pinned revisions, exact citation identities and the qualified Modal and Pinecone profile."
date: 2026-10-23
updated: 2026-11-24
tags: RAG, citations, authorization, Pinecone
---

Mayura gives the model a retrieval tool. Host configuration fixes the verified scope, index space, ingestion limits
and retrieval policy. The result is authorized evidence with citation identities that an application can inspect.
In 1.2.1, the [Modal and Pinecone Loki v28 profile](../../../docs/guides/rag-production.md) is qualified for production
within its tested scope. Other RAG profiles remain experimental.

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

Generate the [Modal + Pinecone starter](../../../docs/guides/rag-modal-pinecone-starter.md) from the Mayura 1.2.2
CLI to run a complete offline demo. [Build and deploy a retrieval agent](../../../docs/guides/rag-deployment.md)
explains the host configuration for your application.
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
from generated summaries. Evaluate citation accuracy on your application corpus, including cases where the agent
should abstain. Check the [release validation status](../../../docs/guides/release-readiness.md) for the limits
of the available evidence.
