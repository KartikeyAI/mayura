# Modal + Pinecone RAG starter

Run a cited answer against the bundled public on-call guide. The local demo uses SQLite, the in-memory vector store,
a hashing embedder and a scripted extractive answer. It needs no credentials.

```sh
npm install
npm run dev
npm test
```

Use Node 24.14.1 or a later supported 24.x release. The demo prints a JSON answer, its source revision, and
exact offsets into the normalized Markdown. It stores no state between demo runs.

## Connect hosted providers

1. In a dedicated Pinecone project or index, provision a **768-dimensional cosine index with self-provided vectors**.
   Copy its HTTPS data-plane host and API key. The starter uses Pinecone API version `2025-10`.
2. Create a workspace proxy token in Modal, then create a Shared Endpoint for **DeepSeek V4.1 Flash 1017** in the US
   West inference region. Copy the endpoint hostname used as the Chat Completions model. The
   [Modal model page](https://modal.com/library/deepseek/deepseek-v4-1-flash-1017) lists pricing.
3. Install the [Modal Python CLI](https://modal.com/docs/guide) and deploy the private Nomic worker in a named Modal
   environment you own. The image stages the pinned `nomic-embed-text:v1.5` weights. Use that environment name
   in the next step.

   ```sh
   modal deploy --env main modal-app.py
   ```

4. Copy `.env.example` to `.env` and fill in the values. Set `RAG_MODAL_ENVIRONMENT` to the deployment environment.
   Use Modal SDK credentials for the embedding worker and the workspace proxy token for inference. Use host-owned
   principal and project IDs, a persistent SQLite path, and conservative positive USD-micro bounds for Modal
   embedding, Pinecone and inference calls. For token prices enter USD micros per million tokens.
5. Build, ingest the same public fixture, then ask a question.

   ```sh
   npm run build
   npm run ingest -- --hosted on-call fixtures/on-call.md
   npm run ask -- --hosted "When should the incident summary be posted?"
   ```

Pinecone data can take time to become searchable after publication. If the first question abstains immediately
after ingestion, let the index catch up and submit a new question. An abstention is represented by
`{"answer":null,"citations":[]}`.

## Operate the starter

Keep the same SQLite catalog, scope, index and source ID across restarts. For a revision, ingest the updated file
under the same source ID. The source key and durable workflow prevent repeating a completed or uncertain stage.
Keep the run ID and catalog if ingestion fails. Reconcile the retained claim before authorizing new work.
The app uses one query embedding, one vector query, up to one ranked list and one answer call per question.
The two model operations each use the declared per-call cap. Configure account-side service limits separately.

The CLI assumes a trusted operator and sends only the public corpus to hosted providers. Replace the local
identity setup with verified tenant scoping before adding an HTTP interface or private documents.
Delete or stop only infrastructure created for this sample when finished. Keep the SQLite journal for recovery.

The sample uses the same Nomic model, Pinecone protocol and Modal DeepSeek family as the Loki qualification.
Its corpus, private Modal Function, ranking/answer prompts and operating limits are starter settings.
See the installed Mayura production qualification guide for the evidence and scope of the registered Loki run.
