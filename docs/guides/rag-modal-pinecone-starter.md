---
title: Run the Modal + Pinecone RAG starter
description: Generate the Mayura RAG starter, run its offline demo, and connect private Modal inference and a scoped Pinecone index.
---

The `rag-modal-pinecone` starter ingests Markdown through a durable workflow and returns an answer with exact
source revisions and offsets. It has an offline demo and a hosted mode using Nomic embeddings on Modal,
Pinecone vectors, and Modal DeepSeek for reranking and generation.

## Generate and run the demo

The starter is included in Mayura 1.2.2. Once that version is available on npm, generate the project with the
published CLI.

```sh
npx mayura@1.2.2 init --starter rag-modal-pinecone --directory ./mayura-rag-starter --apply
cd mayura-rag-starter
npm install
npm run dev
npm test
```

For a source checkout, run `pnpm build` and use the built CLI from the workspace root.

```sh
node packages/cli/dist/bin.js init --starter rag-modal-pinecone --directory ../mayura-rag-starter --apply
cd ../mayura-rag-starter
npm install
npm run dev
npm test
```

The demo requires no API key and uses an in-memory vector store. It reads `fixtures/on-call.md` and prints a
JSON answer that includes the incident-summary deadline and a citation with its document, revision, chunk ID,
reference and exact offsets. The tests exercise the hosted protocol with local fixtures.

## Connect Modal and Pinecone

Follow the generated README to deploy `modal-app.py` as a private Modal Function and create a Modal workspace
proxy token before setting up a Shared Endpoint for DeepSeek V4.1 Flash 1017. In
[Pinecone](../integrations/vector-pinecone.md), create a dedicated
768-dimensional cosine index with self-provided vectors. The starter uses the `2025-10` data-plane API.

On Windows PowerShell, set `$env:PYTHONIOENCODING = 'utf-8'` before running `modal deploy` if your console
uses a legacy encoding. Modal streams the model pull's progress characters during the first image build.

Copy the generated `.env.example` to `.env`. Set the data-plane host and key, the Modal environment and SDK
credentials, the Modal inference endpoint hostname and proxy token, and the per-operation USD-micro bounds.
Use a stable principal ID, project ID and persistent SQLite path. Test with the sample public corpus first.

```sh
npm run build
npm run ingest -- --hosted on-call fixtures/on-call.md
npm run ask -- --hosted "When should the incident summary be posted?"
```

Pinecone can acknowledge changes before queries see them. Let the index catch up if the first search abstains.
When updating a source, ingest under its existing source ID and retain the same catalog. If an ingestion
acknowledgement is lost, keep the journal and run ID for [reconciliation](rag.md#durable-ingestion).

The starter shares the embedding model and provider choices of the [qualified Loki profile](rag-production.md).
Its example corpus, prompts and deployment have their own quality and capacity characteristics. Follow
[Build and deploy a retrieval agent](rag-deployment.md) to qualify your actual corpus, concurrency and scope policy.
