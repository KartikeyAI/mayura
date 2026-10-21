---
title: "Pgvector vectors"
description: "Scoped native vector storage for pgvector."
package: "@mayurajs/vector-pgvector"
vendor: "Pgvector"
website: "https://github.com/pgvector/pgvector"
area: "vectors"
---

`@mayurajs/vector-pgvector` implements the [RAG contracts](../guides/rag.md). Install it alongside `mayura`.
Construction performs no I/O, credential discovery, provisioning or background work. All operations require an
explicit host permission and a nonnegative `costMicros` ceiling. Offline tests and package checks passed locally. Real service behavior remains unqualified; see [release validation status](../guides/release-readiness.md).

`pgvectorStore` accepts an explicit `location: 'local' | 'hosted'`, `dimensions`, `table`, `costMicros`, `permissions` and a host-owned
`execute(sql, parameters, signal)` callback returning row objects. Bind every parameter with the native driver;
keep credentials and pooling in the host. The driver must cooperate with cancellation; an ignored abort can leave
an uncertain write, which ingestion keeps quarantined. The adapter does not close the host driver.

Grant `rag:transport:pgvector` for operations and `rag:admin` for explicit `initialize(signal)`. Initialization
creates only the named table. Provision the vector engine separately. Search uses exact cosine ordering with
scope and metadata predicates inside SQL; it does not claim an approximate index or implicit lexical fallback.
A production host can create a reviewed native index and tune its query plan separately.

Protocol reference, reviewed 2026-10-20: [pgvector documentation](https://github.com/pgvector/pgvector).
