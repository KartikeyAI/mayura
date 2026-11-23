---
title: RAG quickstart
description: Install Mayura, ingest Markdown, retrieve and verify an exact citation, then delete the source locally.
---

Use `mayura/rag` to publish a Markdown source, retrieve a passage with a citation, and revoke the source's
visibility. This example uses SQLite for the workflow journal and catalog, a deterministic hashing embedder,
and an in-memory vector store. It runs without API keys or model calls.

## Install and run

Use [a supported Node.js version](../installation.md). From an empty project directory, install Mayura and its
optional SQLite dependency.

```sh
npm init -y
npm install mayura better-sqlite3@13
```

Save this as `rag-quickstart.mts`.

```ts
import { hashingEmbedder } from 'mayura/memory';
import {
  aggregateRagCatalog, createRetriever, defineRagIngestion, deleteRagDocument,
  inMemoryVectorStore, loadMarkdown, ragEmbedder, ragIndexSpace, type RagAccess,
} from 'mayura/rag';
import { createSqliteStore } from 'mayura/storage-sqlite';
import { createWorkflowRuntime } from 'mayura/workflows';

const scope = { principalId: 'demo-reader', projectId: 'handbook' };
const readAccess: RagAccess = {
  scope, permissions: { allow: ['rag:read'] }, allowedSensitivities: ['internal'],
};
const writeAccess: RagAccess = {
  scope, permissions: { allow: ['rag:index'] }, allowedSensitivities: ['internal'],
};
const db = createSqliteStore({ filename: ':memory:' });
const catalog = aggregateRagCatalog(db);
const embedder = ragEmbedder(hashingEmbedder({ dimensions: 64 }), { costMicros: 0 });
const vectors = inMemoryVectorStore({ dimensions: 64, maxVectors: 100 });
const chunking = { mode: 'markdown', maxChars: 512, overlapChars: 64, maxChunks: 8 } as const;
const document = loadMarkdown('## Returns\nUnopened items can be returned within 30 days with a receipt.', {
  id: 'returns', reference: 'handbook/returns.md', sensitivity: 'internal',
});

await db.initialize();
const runtime = createWorkflowRuntime({
  store: db, scope, policyVersion: 'handbook-v1', maxCostMicros: 0,
  permissions: { allow: ['effect:write', 'rag:index', 'tool:handbook.ingest.stage', 'tool:handbook.ingest.publish'] },
});
try {
  const ingestion = defineRagIngestion({
    ...writeAccess, id: 'handbook.ingest', version: '1', journal: db, catalog,
    store: vectors, embedder, chunking, maxCostMicros: 0, timeoutMs: 5_000,
  });
  const submission = await runtime.submit(ingestion, {
    input: { document, expectedRevision: null },
    idempotencyKey: 'returns-v1',
  });
  const outcome = await runtime.runUntilSettled(ingestion, submission.id);
  if (outcome.status !== 'succeeded') throw new Error('Ingestion did not publish.');

  const retriever = createRetriever({
    ...readAccess, catalog, store: vectors, embedder, space: ragIndexSpace(embedder, chunking),
    mode: 'hybrid', limit: 3, candidateLimit: 10, maxQueries: 1, maxCostMicros: 0,
    timeoutMs: 5_000, maxConcurrent: 2,
  });
  const query = 'returns receipt';
  const { hits } = await retriever.retrieve(query);
  const hit = hits[0];
  if (!hit) throw new Error('Expected a returns passage.');
  const { chunk } = hit;
  const citation = {
    documentId: chunk.documentId, revision: chunk.revision, chunkId: chunk.id,
    reference: chunk.reference, start: chunk.start, end: chunk.end,
  };
  const passage = document.text.slice(citation.start, citation.end);
  if (passage !== chunk.text) throw new Error('Citation did not match the source.');
  console.log(JSON.stringify({ passage, citation }, null, 2));

  const active = await catalog.read(scope, document.id, AbortSignal.timeout(5_000));
  if (!active || active.deleted || active.revision !== citation.revision) {
    throw new Error('The cited revision is no longer active.');
  }
  const tombstone = await deleteRagDocument({
    ...writeAccess, catalog, documentId: document.id, expectedRevision: active.revision,
    signal: AbortSignal.timeout(5_000),
  });
  if ((await retriever.retrieve(query)).hits.length !== 0) {
    throw new Error('The deleted source is still visible.');
  }
  await vectors.delete(scope, tombstone.space, tombstone.chunkIds, AbortSignal.timeout(5_000));
  console.log('Source hidden and vectors removed.');
} finally {
  try { await runtime.close(); } finally { await db.close(); }
}
```

```sh
node --experimental-strip-types rag-quickstart.mts
```

The first output contains the returns passage and its document, revision, chunk ID, source reference and exact UTF-16
offsets in the normalized Markdown. The second confirms the catalog tombstone hid the passage before vector cleanup.

## Connect an agent or persist the corpus

Bind `defineRetrievalTool` to the scoped retriever to expose a query-only search tool. Derive the scope on the host
from trusted request identity. Treat returned passages as untrusted evidence and verify access to the cited revision
again when displaying it. [Scoped retrieval and tools](rag.md#scoped-retrieval-and-tools)

For restart recovery, use a file-backed journal and catalog plus a persistent vector store. Reuse the same submission
key, storage, index space and workflow version when recovering known work. Keep the journal for reconciliation when
an acknowledgement is uncertain. Catalog deletion changes what readers can see before vector cleanup. Configure
retention separately for workflow inputs and journal history. [Durable ingestion](rag.md#durable-ingestion)

To try a hosted setup, follow the [deployment guide](rag-deployment.md) and check which exact configurations the
[qualification matrix](rag-production.md#qualification-matrix) covers.
