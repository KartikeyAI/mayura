---
title: RAG production qualification
description: Production qualification evidence and deployment boundaries for the Modal and Pinecone Loki v28 profile.
---

## Qualified production profile

**The Modal + Pinecone profile for Loki v28 is stable for production within its tested scope.**
The result covers the registered software-operations workload and its pinned configuration.
Other RAG profiles remain experimental. See the [RAG API guide](rag.md) for framework usage.

| Gate | Verified result |
| --- | --- |
| Document preparation | Verified embeddings reused from the registered checkpoint |
| Semantic quality and latency | All 40 Loki cases passed the source-reviewed release gate. Acquisition and ranking p95 upper bound was 4.725 s against the 5 s limit |
| Nomic acquisition load | 120/120 queries on the registered Loki catalog, 417.127 ms acquisition p95 |
| Pinecone native load | 600/600 timed queries, 45.095 ms p95, complete original request archive recovered |
| Recovery and scope security | Seven production recovery checkpoints passed, maximum 25.428 s. Scope security passed |
| Campaign cleanup | Provider evidence covers 14 owned apps and 23 sandboxes. No owned Pinecone indexes remained. The pre-existing Modal app was verified by exact ID |

The revised cleanup verifier uses retained provider observations for current owners and original
shutdown receipts for historical owners. Missing records alone provide no cleanup credit. The
original incomplete audit remains in the evidence, including its completed archive verification.
The offline release check made no provider calls and reran no queries. The original quality,
latency, recovery, security and 600-query gates still apply.

The release receipt is `compatibility/rag-modal-pinecone-loki-production-v1.json` in the
repository. The registered workload does not establish capacity, latency, or semantic quality
for other corpora, providers, models, or deployments.
