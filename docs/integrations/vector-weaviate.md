---
title: "Weaviate vectors"
description: "Scoped native vector storage for weaviate."
package: "@mayurajs/vector-weaviate"
vendor: "Weaviate"
website: "https://docs.weaviate.io"
area: "vectors"
---

`@mayurajs/vector-weaviate` implements the [RAG contracts](../guides/rag.md). Install it alongside `mayura`.
Construction performs no I/O, credential discovery, provisioning or background work. All operations require an
explicit host permission and a nonnegative `costMicros` ceiling. Offline tests and package checks passed locally. Real service behavior remains unqualified; see [release validation status](../guides/release-readiness.md).

`weaviateVectorStore` accepts `endpoint`, `headers`, `collection`, `dimensions`, `costMicros`, `permissions`,
`timeoutMs`, `maxConcurrent` and optional test `fetch`. Grant `rag:transport:weaviate`. Credentials go in host-owned
headers, never URLs. HTTPS is required except explicit loopback development. There are no automatic retries or
redirects. Response bodies and concurrency are bounded. A timed-out callback retains its slot until settlement.

Provision the collection/index before ingestion and configure **cosine similarity**, self-provided vectors and
matching dimensions. The adapter binds every operation to a hash of project, principal and index space, and
validates returned chunk metadata. Staging is not a cross-service transaction: the authoritative catalog decides
which revision may be disclosed. Partial writes remain hidden and require reconciliation.

Use a self-provided vector collection with a valid capitalized class name. Define `mayuraNamespace`, `mayuraId`, `mayuraChunk` and every filter property explicitly. Namespace and string filter properties need **field tokenization** for exact equality. This profile uses a shared collection with mandatory namespace predicates, not automatic tenant provisioning. Batch operations can partially fail; those failures never publish a revision.

Protocol reference, reviewed 2026-10-20: [weaviate documentation](https://docs.weaviate.io).
