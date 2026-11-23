# mayura/rag

Publish a scoped source, retrieve an exact citation, and revoke its visibility using `mayura/rag`.

## Quickstart

In a Node.js project, install Mayura and the optional SQLite peer.

```sh
npm install mayura better-sqlite3@13
```

Copy the [complete quickstart](../../docs/guides/rag-quickstart.md#install-and-run) into `rag-quickstart.mts`
and run it locally.

```sh
node --experimental-strip-types rag-quickstart.mts
```

The script publishes Markdown through a workflow, verifies the retrieved citation against the normalized source,
then checks that a catalog tombstone hides the source before removing its vectors. It requires no API keys.
The [agent example](../../examples/rag.mjs) adds a scoped search tool and a scripted model.

See the [RAG API guide](../../docs/guides/rag.md) for recovery and authorization, or the
[qualification matrix](../../docs/guides/rag-production.md#qualification-matrix) for tested production configurations.
