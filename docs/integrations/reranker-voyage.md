---
title: "Voyage reranking"
description: "Bounded indexed-result reranking with voyage."
package: "@mayurajs/reranker-voyage"
vendor: "Voyage"
website: "https://docs.voyageai.com"
area: "rerankers"
---

`@mayurajs/reranker-voyage` implements the [RAG contracts](../guides/rag.md). Install it alongside `mayura`.
Construction performs no I/O, credential discovery, provisioning or background work. All operations require an
explicit host permission and a nonnegative `costMicros` ceiling. Offline tests and package checks passed locally. Real service behavior remains unqualified; see [release validation status](../guides/release-readiness.md).

`voyageReranker` accepts `apiKey`, `model`, `costMicros`, `permissions`, `timeoutMs`, `maxConcurrent` and
optional test `fetch`. Grant `rag:transport:voyage` on the adapter and `rag:rerank:voyage` on the retriever.
The endpoint is pinned to the native service; no automatic retries or redirects run. The retriever also requires
an explicit hosted sensitivity profile before disclosing authorized document text.

One request ranks at most 100 original documents. The adapter validates unique indexes and finite scores and
returns only index/score pairs. Provider-returned document text cannot amend or inject evidence. The declared
maximum is reserved even when a service fails; configure the ceiling for the admitted batch and model.

Protocol reference, reviewed 2026-10-20: [voyage documentation](https://docs.voyageai.com).
