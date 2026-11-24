---
title: Build and deploy a retrieval agent
description: Start offline, connect a scoped vector store, and qualify retrieval and citations on your own workload.
---

Start with the [RAG quickstart](rag-quickstart.md) to ingest, retrieve, verify citations and delete a source
from an npm install. To start with a complete application, generate the
[Modal + Pinecone starter](rag-modal-pinecone-starter.md) with the Mayura 1.2.2 CLI. It includes an offline demo
and an opt-in hosted walkthrough.

The repository also includes a single-file example in `examples/rag.mjs`. It ingests Markdown in a durable workflow, then answers with
citation identities using a scripted model and a deterministic hashing embedder. After building the workspace, run:

```bash
node examples/rag.mjs
```

This exercises the ingestion, publication and retrieval paths without an API key. Use the
[RAG API guide](rag.md) to adapt the example to your application.

## Move from the example to your application

1. **Resolve scope on the server.** Derive the principal and project from the authenticated request. Create the
   [retrieval tool](rag.md#scoped-retrieval-and-tools) with that scope and its permissions. Keep provider credentials in
   host configuration, and keep scope and index selection out of the model's tool arguments.
2. **Pin the index space.** Record the embedder, dimensions, chunking settings and catalog scope together.
   When changing any of these, prepare a new index space. For Pinecone, provision a cosine index with self-provided
   vectors and matching dimensions. See the [Pinecone integration](../integrations/vector-pinecone.md).
3. **Publish from a separate ingestion workflow.** Stage embeddings first, then activate the exact revision through
   the catalog. Keep ingestion credentials and write permission out of the answering path. Preserve the durable
   journal so a restart can reuse completed work and surface uncertain results for reconciliation.
4. **Return evidence the viewer can open.** Resolve citations to the active source revision and check access at
   display time. Keep citation IDs paired with their source offsets. Ask the agent to abstain when it lacks enough
   evidence, and review generated claims against the cited passages.

## Qualify the deployment you intend to operate

Use representative documents and independently reviewed questions. Include single-source and multi-source
answers, insufficient-evidence cases, unpublished revisions and access denials. Evaluate evidence coverage and
answer grounding separately. Measure retrieval latency and full answer latency under expected concurrent load.

Exercise recovery by interrupting ingestion and retrieval. Verify which operations resume, which results are
reused, and how uncertain paid work is reconciled. Check that cleanup receipts account for every resource
allocated by the qualification run and preserve pre-existing resources.

Mayura V1.2.1 qualifies the [registered Modal and Pinecone Loki v28 profile](rag-production.md) within its
tested software-operations workload. Other combinations of corpus, models, providers and deployment settings
need their own evidence. The 4.725-second p95 upper bound applies to acquisition and ranking in the 40-case
evaluation. Use your own end-to-end measurements for an answer-latency target.
