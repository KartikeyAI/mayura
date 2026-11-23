---
title: RAG production qualification
description: Compare the qualified Modal and Pinecone Loki v28 profile with experimental RAG configurations, and see measured scale, recall, and latency.
---

## Qualification matrix

| Configuration | Embeddings | Retrieval and ranking | Release status |
| --- | --- | --- | --- |
| Registered Modal + Pinecone Loki v28 | Pinned Nomic Embed Text v1.5 on Modal, 768 dimensions | Pinecone cosine with self-provided vectors. Modal DeepSeek V4.1 Flash 1017 for candidate ranking and answer generation | **Production-qualified** for the registered Loki software-operations corpus and configuration |
| Modal + Pinecone starter | Nomic Embed Text v1.5 on Modal | Pinecone cosine. Modal DeepSeek for reranking and generation | **Experimental deployment profile**. The starter has its own sample corpus, configuration and smoke test. [Starter guide](rag-modal-pinecone-starter.md) |
| Built-in local stores | Deterministic hashing for offline examples. Host-supplied embeddings through the adapter contract | In-memory exact cosine with lexical scoring or BM25. Native memory with bounded exact vector scans and BM25 | **Local development and conformance**. Production use remains experimental. [RAG API guide](rag.md#architecture) |
| Other vector stores and model combinations | Host-supplied embedders, including OpenAI, Google, Mistral, Azure, Ollama and Bedrock adapters | [pgvector](../integrations/vector-pgvector.md), [libSQL](../integrations/vector-libsql.md), [Qdrant](../integrations/vector-qdrant.md), [Weaviate](../integrations/vector-weaviate.md), [Chroma](../integrations/vector-chroma.md), or Pinecone with a different profile. This includes Cohere, Voyage, Jina and other rerankers | **Experimental**. Evidence varies by adapter. [Vector conformance and model adapters](rag.md#vector-adapters-and-qualification) |

Changing the corpus, model, index, ranker, serving configuration, or operating load calls for separate qualification.

## Qualified production profile

The registered catalog contains 24 normalized documents from 22 Loki documentation source families and
426 verified document embeddings. The semantic holdout contains 16 single-source cases, 16 multi-source cases
and eight abstention cases.

| Check | Scale | Quality | Timing |
| --- | --- | --- | --- |
| Source-reviewed semantic evaluation | 40 Loki cases | Required-fact coverage at three results averaged 98.4375% across answerable cases. Answer fact coverage averaged 98.4375%. All eight abstentions passed. Source review recorded zero unsupported claims. | Acquisition and ranking p95 upper bound of 4.725 s against the 5 s limit |
| Nomic acquisition load | 120/120 queries on the registered Loki catalog | 99.833% mean recall, 90% minimum | 417.127 ms acquisition p95 |
| Pinecone native load | 600/600 timed queries in the separate native vector load profile with observed concurrency of one | 98.333% mean recall, 90% minimum | 45.095 ms native query p95 |
| Recovery and scope security | Seven production recovery checkpoints and the scope security check | Passed | 25.428 s maximum observed recovery |

The semantic gate counts required facts supported within the top three results. The load checks measure recall against
their registered reference neighbors. Each latency figure covers the named phase. Document-level MRR and full-answer
p95 are unpublished for this profile. Use workload-specific
quality and latency targets for your deployment. [Deployment qualification](rag-deployment.md#qualify-the-deployment-you-intend-to-operate)

## Recovery and cleanup evidence

Document preparation reused the verified registered checkpoint. The original 600-query request archive was recovered
and checked. Provider evidence covers 14 owned apps and 23 sandboxes. No owned Pinecone indexes remained.
The pre-existing Modal app was verified by exact ID.

The revised cleanup verifier uses retained provider observations for current owners and original
shutdown receipts for historical owners. Missing records alone provide no cleanup credit. The
original incomplete audit remains in the evidence, including its completed archive verification.
The offline release check made no provider calls and reran no queries. The original quality,
latency, recovery, security and 600-query gates still apply.

The versioned release receipt records the passed gates, phase digests and measured latency.
[Loki v28 release receipt](https://github.com/KartikeyAI/mayura/blob/ff69ac1e559b4360f2befffe35f13aece1b4ba89/compatibility/rag-modal-pinecone-loki-production-v1.json)
