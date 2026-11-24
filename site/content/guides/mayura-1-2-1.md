---
title: "Mayura 1.2.1 ships qualified RAG and configurable workflow graphs"
description: "What the Modal and Pinecone qualification covers, how to build a retrieval agent, and how to choose a workflow graph limit."
date: 2026-11-23
tags: release, RAG, workflows, Pinecone
---

Mayura **1.2.1** qualified one production retrieval profile and lets
hosts configure larger workflow graphs across definitions, persistence and recovery. All 106 packages were published
with npm trusted publishing. See the [GitHub release](https://github.com/KartikeyAI/mayura/releases/tag/v1.2.1)
or the [changelog](../../../docs/project/changelog.md) for the current release.

```bash
npm install mayura@1.2.1
```

## A production RAG profile with a defined scope

The registered **Modal and Pinecone Loki v28** profile uses a software-operations workload. Mayura supplies scoped
ingestion and retrieval, and the agent receives evidence with exact citation identities. The qualification covered
held-out source-reviewed cases, real-service load, scope isolation, recovery and campaign cleanup.

| Check | Result |
| --- | --- |
| Semantic evaluation | 40 source-reviewed Loki cases passed |
| Acquisition and ranking | 4.725-second p95 upper bound against the five-second gate |
| Pinecone native load | 600 of 600 timed queries completed, with 45.095 ms p95 |
| Recovery | Seven production checkpoints passed, with maximum recovery of 25.428 seconds |

The latency figures measure two different workloads. The five-second gate covers acquisition and ranking for the
semantic evaluation. The native load figure measures Pinecone queries. Other RAG profiles remain experimental.
Read the [production qualification](../../../docs/guides/rag-production.md) and follow
[Build and deploy a retrieval agent](../../../docs/guides/rag-deployment.md) to get started.

## Larger workflow graphs

The default stays at **128 nodes per graph**. Set `maxNodes` up to 512 where a graph calls for a finite bound.
Trusted hosts can also opt out of the per-graph count limit. Byte, concurrency and workflow-tree bounds continue
to apply. See [configuring graph size](../../../docs/concepts/workflows.md#configuring-graph-size).

The release uses lockstep versions for `mayura` and the 105 optional extensions. If you use extensions, upgrade
the ones your application imports to `1.2.1` as well. For the full release scope, see
[What's new](../../../docs/project/whats-new.md) and [release validation status](../../../docs/guides/release-readiness.md).
