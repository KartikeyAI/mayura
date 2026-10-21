---
title: "Retrieval augmented generation"
description: "Scoped retrieval tools, durable content-addressed ingestion, vector adapters, citations and bounded reranking."
---

`mayura/rag` adds retrieval without giving a model a database connection or letting it choose a principal, project,
index or filter. Host code loads documents, stages embeddings and publishes a revision. A retrieval tool returns
only authorized evidence and exact citation identities. This is an experimental 1.2 surface; source, examples and
regression cases pass local offline validation, including builds, documentation and package checks. Real service qualification remains outstanding; see [release validation status](release-readiness.md).

## Architecture

A `VectorStore` is a trusted infrastructure boundary. Each operation includes a verified scope and a pinned index
space. A separate `RagCatalog` is the authority for the active revision and its exact chunk IDs. Search results
from abandoned, superseded or deleted revisions are discarded before reranking and again before disclosure.
`aggregateRagCatalog` uses the existing compare-and-set aggregate contract on all storage adapters; no new database
schema is needed for the catalog or ingestion journal.

Two built-in vector backends are available: `inMemoryVectorStore` is bounded exact cosine plus lexical overlap;
`nativeMemoryVectorStore` uses the native memory tables in a separate scope, BM25 and a bounded exact vector scan.
Initialize `store.memory` before using the native adapter; declare its `location` and whole-operation `costMicros` ceiling, including the bounded scan's storage reads. Neither backend performs network or model calls.
The hashing embedder is deterministic lexical feature hashing, not a semantic model.

## Durable ingestion

The offline runnable example is `examples/rag.mjs` in the repository. After building the workspace:

```bash
node examples/rag.mjs
```

It loads Markdown, runs a two-step durable workflow, indexes locally, gives an agent a scoped retrieval tool and
returns an answer with exact citations. Its scripted model and hashing embedder perform no inference or network.

Define ingestion with `defineRagIngestion` and submit it to the conservative `createWorkflowRuntime` from
[workflows](../concepts/workflows.md). Pass a host-owned `journal`, `catalog`, vector `store`, priced `embedder`,
`chunking`, scope, sensitivity profile, `maxCostMicros` and `timeoutMs`. Pin the definition ID/version in the host.
The input is exactly `{ document, expectedRevision }`; use `null` only for an absent document. Read the current
catalog revision through trusted host code before submitting an update. No browser-supplied scope is accepted.

The workflow has two steps:

1. `<id>.stage` claims a deterministic revision, loads confirmed cached chunk vectors or embeds new chunks, writes
   immutable vector IDs, and saves a prepared receipt. Its output contains only the publication manifest.
2. `<id>.publish` verifies that prepared receipt and compare-and-sets the catalog from `expectedRevision` to the
   new revision. Concurrent publication or deletion fences a stale writer.

The workflow needs `tool:<id>.stage`, `tool:<id>.publish`, `effect:write` and `rag:index`. Hosted embeddings also
need `rag:embed`. The definition's `RagAccess` has its own explicit grants; the runtime's grants do not replace them.
Use the same durable storage after restart. Supply the same submission key to recover the same workflow.

Content identity includes normalized text, source reference, metadata and sensitivity. Index space pins model,
dimensions, chunking, parent settings and contextualizer identity. An unchanged published document is a no-op only
when `expectedRevision` matches. A scoped embedding cache keys exact embedding input and sensitivity, so unchanged
chunks are not paid for again when another part of the document changes. Changed context, model or settings
creates a different embedding identity. Duplicate text in a batch shares one claim.

Claims are durable **before** paid work. A failed, timed-out or lost acknowledgement leaves the claim uncertain.
A second submission cannot repeat it. `reconcileRagClaim` requires `rag:reconcile`, core authorization and a trusted
verifier of the already completed stage or embedding. It changes only the receipt; it never calls a provider or
writes vectors. Stage verification must confirm every exact staged chunk exists with its intended payload/vector.
Embedding verification must recover the original confirmed vector. If evidence is unavailable, leave the claim
blocked. A new content/index identity is an explicit new ingestion, not recovery of an uncertain call.

Catalog publication and vector storage are not a distributed transaction. Partially staged vectors stay hidden.
Run cleanup separately using the exact scope, space and chunk IDs, after confirming they are not active. Do not
delete a prepared active revision during a concurrent publication. `deleteRagDocument` first publishes a tombstone
with an expected revision; reads stop disclosing that source immediately. Its returned IDs support later physical
cleanup through `VectorStore.delete`. Deletion does not erase old workflow inputs, provider logs or journal history;
configure retention and storage encryption in the host.

## Loaders and chunkers

`loadText` normalizes line endings and Unicode NFC. `loadMarkdown` keeps the original Markdown syntax as evidence.
`loadJson` extracts only host-selected JSON Pointer string leaves; it never dumps an entire configuration file.
`loadHtml` requires `rag:load:html` and an inert host-installed DOM parser; it removes script/style/template/hidden
nodes before text extraction. `loadPdf` requires `rag:load:pdf` and a host-owned PDF text extractor, bounded bytes,
page limit and abort signal. PDF parsing has a bounded timeout and shared per-parser concurrency; an abort-ignoring parser retains its slot until settlement. PDF engines, sandboxing, fonts and workers remain host dependencies; no heavyweight
parser is installed into the core. Neither loader fetches URLs or executes embedded source content.

Normalized documents are bounded to 32,000 UTF-16 code units. Larger corpora should be split into bounded documents
at acquisition time. `chunkDocument` supports `fixed`, `recursive` and `markdown` modes, explicit character size,
overlap and maximum chunks. It refuses truncation. Offsets are exact UTF-16 positions in normalized loader text,
not byte offsets or original PDF coordinates. Character bounds are not tokenizer counts.

Set `parentChars` to retain a bounded parent passage for each child embedding, and `parentDocuments: true` on the
retriever to release it after the same document authorization checks. A host-owned ingestion `contextualizer`
can produce one bounded retrieval-context string per chunk. Declare its stable ID, location and full-request cost,
grant `rag:contextualize:<id>`, and pin its behavior in the ingestion version. Generated context prefixes embedding
and reranking input but is returned separately as `retrievalContext`; it is not a source quotation. Include it in
your provider input-size budget (at most 1,000 extra characters per chunk).

## Embedding providers and budgets

`ragEmbedder(adapter, { costMicros })` prices any `MemoryEmbedder`-compatible adapter, including `hashingEmbedder`
and the existing OpenAI embedding adapter. Provider packages also export native embedding factories:

| Provider entry | Factory | Admission |
| --- | --- | --- |
| `mayura/provider-openai` or `@mayurajs/provider-openai` | `openAIEmbeddings`, wrapped by `ragEmbedder` | `rag:embed` for hosted use |
| `@mayurajs/provider-google` | `googleEmbeddings` | `rag:transport:google-embeddings` |
| `@mayurajs/provider-mistral` | `mistralEmbeddings` | `rag:transport:mistral-embeddings` |
| `@mayurajs/provider-azure` | `azureEmbeddings` | `rag:transport:azure-embeddings` |
| `@mayurajs/provider-ollama` | `ollamaEmbeddings` | `rag:transport:ollama-embeddings` |
| `@mayurajs/provider-bedrock` | `titanEmbeddings` | `rag:transport:bedrock-embeddings` |

The new HTTP factories require explicit model, dimensions, maximum batch, credentials/endpoint as applicable,
`costMicros`, transport permissions, timeout and concurrency. Azure uses an explicit resource and deployment name.
Ollama requires a declared local/hosted location; local is restricted to loopback. Titan is the explicit text V2
profile, one input at a time, with supplied SigV4 credentials and 256/512/1024 dimensions; close its owned client.
No adapter reads credentials from the environment, selects an embedding model or silently retries.

`costMicros` is a **host-declared maximum for the entire bounded operation**, not a price lookup or billed-cost
estimate. Ingestion reserves maximum embedding batches plus vector writes and contextualization. Retrieval
reserves bounded query expansion, embeddings, vector/lexical searches and reranking before dispatch. Runtime tool
reservations contain those nested operations. Failures conservatively retain the reservation; the source no-op
reports zero. Provider-side billing cannot be enforced by an in-process declaration: configure real service quotas
and an honest bound for the admitted model and input/output lengths.

## Scoped retrieval and tools

Create a retriever with the host's scope, explicit permissions, `allowedSensitivities`, index space, fixed metadata
`filter`, `limit`, `candidateLimit`, `maxQueries`, `maxCostMicros`, `timeoutMs` and `maxConcurrent`. All hosted content
writes/embeddings/reranks require the corresponding sensitivity in `hostedSensitivities` (default empty).

`defineRetrievalTool({ id, version, retriever, timeoutMs })` accepts only `{ query }`. Runtime admission needs
`tool:<id>`, `effect:read` and `rag:read`; the retriever also checks its own `rag:read` and hosted `rag:embed` grant.
It checks the actual tool scope against the bound retriever scope. Results contain plain untrusted text, scores,
metadata-only metrics, and citations with document/revision/chunk/reference/start/end. A reference is an opaque
source label, not a fetched or verified URL. Render it as plain text unless your application independently approves
links. Retrieved text never becomes a system instruction.

Pass the existing core `authorization` to evaluate `rag_document` actions: `search` on `collection`, `read` on each
document, `index` on ingestion, `delete` on deletion and `reconcile` for recovery. Embedding-cache recovery uses
`collection` because cache entries may be shared by multiple documents in that scope. The same authorizer emits
its normal metadata-only audit events. Per-document denial withholds evidence before external reranking. Policy
outage/cancellation fails closed and never triggers a weaker fallback. Authorization/publication checks repeat
before releasing results. Candidate limits can reduce recall when many stored candidates are stale or denied;
the retriever does not scan or spend without a bound to refill the result.

## Hybrid search and query expansion

`mode: 'hybrid'` fuses semantic and lexical ranks with reciprocal-rank fusion. Native memory provides BM25;
in-memory lexical scoring is a small deterministic reference implementation. External semantic backends can be
paired with a scoped lexical mirror using `hybridVectorStore({ semantic, lexical })`; ingestion stages into both,
and a partial mirror write remains unpublished. A backend without lexical capability refuses hybrid mode rather
than silently changing retrieval behavior.

`modelQueryTransform` supports rewrite, multi-query and HyDE. It requires a model grant, explicit query mode and
query count. Set `maxQueries` to include the original query for multi-query mode. Expansion makes one bounded model
call, without tools/history or automatic retries. HyDE output is only a search representation and never returned
as evidence. Custom transforms obey the same contract and declare a finite cost.

## Reranking and evaluation

Optional adapters: [Cohere](../integrations/reranker-cohere.md), [Voyage](../integrations/reranker-voyage.md), and
[Jina](../integrations/reranker-jina.md). `modelReranker` uses an explicitly granted model instead. The retriever
requires `rag:rerank:<id>`, checks hosted sensitivities and authorizes input documents before ranking. Each adapter
returns only original-document indexes and finite scores; it cannot replace or inject source text.

`retrievalQuality` returns precision@k, recall@k, reciprocal rank and binary nDCG for one query. `evaluateRetrieval`
macro-averages test-set recall and MRR. `citationCoverage` checks that cited chunk IDs belong to the evidence used;
it does not establish semantic entailment. Retrieval result metrics contain admitted query/candidate/result counts,
declared cost reservation and duration, without raw query text, denied document identities or source content.

## Vector adapters and qualification

Built-in exact stores plus six optional integrations share the `VectorStore` contract:
[pgvector](../integrations/vector-pgvector.md), [libSQL](../integrations/vector-libsql.md),
[Pinecone](../integrations/vector-pinecone.md), [Qdrant](../integrations/vector-qdrant.md),
[Weaviate](../integrations/vector-weaviate.md), and [Chroma](../integrations/vector-chroma.md).
Use explicit infrastructure permissions and an honest cost ceiling for each whole bounded operation. Provision
remote collections with matching dimensions and cosine similarity before ingestion. These adapters manage data,
not infrastructure provisioning. The SQL profiles use host-owned parameterized executors and explicit schema setup.

The shared offline conformance suite passes locally for all eight stores: scope/index isolation, filtering before top-k,
ID replacement, scoped deletion, invalid dimensions and cancellation. Native protocol tests use fake transports;
SQL protocol tests use fake executors, while native-memory tests use local in-memory SQLite. These cases, the offline runnable example, package checks and edge/runtime checks passed locally. Frozen dependency installation also passed with strict peers and lifecycle scripts disabled. Fake transports and executors do not qualify real service compatibility, SQL query plans or deployment limits.

Remote indexes may acknowledge writes before making them searchable. Publication does not promise immediate full recall across eventually consistent services. Real service readiness and deployment behavior remain unqualified.
