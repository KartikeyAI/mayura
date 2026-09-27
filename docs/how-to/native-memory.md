# Native memory, graph and semantic search

Native memory stores records in dedicated tables of the SQLite or PostgreSQL store, so it scales well past the compact profile's 128 records. The [spec](../specs/native-memory-v1.md) has the full contract.

```ts
import { createSqliteStore } from 'mayura/storage';
import { createNativeMemory, hashingEmbedder } from 'mayura/memory';

const store = createSqliteStore({ filename: 'agent.sqlite' });
await store.initialize(); await store.memory.initialize();

const memory = createNativeMemory({
  store, scope: { principalId: 'user-1', projectId: 'app' },
  permissions: { allow: ['memory:read', 'memory:write', 'memory:delete', 'memory:index', 'memory:export', 'memory:import'] },
  embedder: hashingEmbedder(), // local and deterministic; see below for hosted adapters
});

await memory.add({ id: 'db', content: 'Orders live in PostgreSQL.', provenance });
await memory.add({ id: 'backup', content: 'PostgreSQL is backed up nightly.', provenance });
await memory.relate({ id: 'db-backup', from: 'db', to: 'backup', relation: 'backed_up_by', confidence: 1, provenance });

await memory.index();                                  // embed new or changed records
await memory.hybridSearch('where are orders stored');  // BM25 and cosine fused by reciprocal rank
await memory.traverse('db', { maxDepth: 2 });          // a bounded, authorized subgraph
```

## Retrieval

- **Lexical.** `search` ranks with BM25.
- **Semantic.** `semanticSearch` scans exactly until a scope holds 2,048 vectors for an embedder. Above that it trains an IVF index and probes `nprobe` lists. Every result reports its `mode`.
- **No embedder.** Without an embedder, semantic calls fall back to lexical search and report `limitation: 'semantic_unavailable'`.

Authorization runs inside the storage query. Scope, sensitivity profile, validity and status filter the rows before any ranking, and the results are checked again before return.

## Hosted embeddings

```ts
import { openAIEmbeddings } from 'mayura/provider-openai';
const embedder = openAIEmbeddings({ apiKey, model: 'text-embedding-3-small', dimensions: 512, onUsage: recordCost });
```

A hosted embedder only ever receives records in `embedSensitivities` (default `public` and `internal`), and indexing requires the `memory:index` grant. The embedder id includes the model and dimensions, so changing either re-indexes rather than mixing vectors.

## Supersession, import and export

- **Supersession.** `supersede({ id, expectedVersion, replacement })` keeps the old record as history (`status: 'superseded'`). Search never returns it.
- **Export.** `exportPage` streams records, tombstones and edges.
- **Import.** `importSnapshot(page, { mode: 'merge' })` never resurrects a tombstone and never downgrades a newer version. A compact-profile export (`mayura.memory.export.v1`) imports as-is; this is the migration path to native memory.

## Context cache

```ts
import { createContextCache } from 'mayura/context';
const cache = createContextCache({ ttlMs: 60_000 });
const context = await cache.assemble(options); // a cached assembly is still re-admitted by your hooks
await cache.follow(memory);                    // invalidate entries that selected a changed memory record
```

A cache hit requires every admission input to match: sources and their revisions, scope, policy, time, sensitivity profile, budget and estimator. Use `invalidate({ scope })` or `invalidate({ sourceIds })` when permissions change or content is revoked.

## Speculation

```ts
const result = await runtime.speculate(parentRun, {
  branches: [
    { id: 'plan-a', agent, input, permissions: { allow: ['model:fast'] }, assumptions: { plan: 'a' } },
    { id: 'plan-b', agent, input, permissions: { allow: ['model:fast'] }, assumptions: { plan: 'b' } },
  ],
  verify: ({ assumptionsDigest, output }) => stillValid(assumptionsDigest, output),
});
```

Branches share the parent's budget. The runtime rejects any branch that holds a write, host, delegation or memory-mutation grant. The first branch that succeeds and passes `verify` is promoted, and the others are cancelled. A losing or failed branch never fails the parent. Speculation is opt-in: nothing enables it automatically.
