---
title: "Chroma vectors"
description: "Scoped native vector storage for chroma."
package: "@mayurajs/vector-chroma"
vendor: "Chroma"
website: "https://docs.trychroma.com"
area: "vectors"
---

`@mayurajs/vector-chroma` implements the [RAG contracts](../guides/rag.md). Install it alongside `mayura`.
Construction performs no I/O, credential discovery, provisioning or background work. All operations require an
explicit host permission and a nonnegative `costMicros` ceiling. Offline tests and package checks passed locally. Real service behavior remains unqualified; see [release validation status](../guides/release-readiness.md).

`chromaVectorStore` accepts `endpoint`, `headers`, `collection`, `dimensions`, `costMicros`, `permissions`,
`timeoutMs`, `maxConcurrent` and optional test `fetch`. Grant `rag:transport:chroma`. Credentials go in host-owned
headers, never URLs. HTTPS is required except explicit loopback development. There are no automatic retries or
redirects. Response bodies and concurrency are bounded. A timed-out callback retains its slot until settlement.

Provision the collection/index before ingestion and configure **cosine similarity**, self-provided vectors and
matching dimensions. The adapter binds every operation to a hash of project, principal and index space, and
validates returned chunk metadata. Staging is not a cross-service transaction: the authoritative catalog decides
which revision may be disclosed. Partial writes remain hidden and require reconciliation.

Also pass the explicit `tenant` and `database` and the **collection ID** as `collection`; provision a cosine collection.

Protocol reference, reviewed 2026-10-20: [chroma documentation](https://docs.trychroma.com).
