---
title: "Pinecone vectors"
description: "Scoped native vector storage for pinecone."
package: "@mayurajs/vector-pinecone"
vendor: "Pinecone"
website: "https://docs.pinecone.io"
area: "vectors"
---

`@mayurajs/vector-pinecone` implements the [RAG contracts](../guides/rag.md). Install it alongside `mayura`.
Construction performs no I/O, credential discovery, provisioning or background work. All operations require an
explicit host permission and a nonnegative `costMicros` ceiling. Offline tests and package checks passed locally. Real service behavior remains unqualified; see [release validation status](../guides/release-readiness.md).

`pineconeVectorStore` accepts `endpoint`, `headers`, `collection`, `dimensions`, `costMicros`, `permissions`,
`timeoutMs`, `maxConcurrent` and optional test `fetch`. Grant `rag:transport:pinecone`. Credentials go in host-owned
headers, never URLs. HTTPS is required except explicit loopback development. There are no automatic retries or
redirects. Response bodies and concurrency are bounded. A timed-out callback retains its slot until settlement.

Provision the collection/index before ingestion and configure **cosine similarity**, self-provided vectors and
matching dimensions. The adapter binds every operation to a hash of project, principal and index space, and
validates returned chunk metadata. Staging is not a cross-service transaction: the authoritative catalog decides
which revision may be disclosed. Partial writes remain hidden and require reconciliation.

`endpoint` is the data-plane index host. Supply `Api-Key` and the reviewed `X-Pinecone-API-Version` header. `collection` is a host label; namespaces isolate scope and index space.

Protocol reference, reviewed 2026-10-20: [pinecone documentation](https://docs.pinecone.io).
