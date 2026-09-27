# Native memory and context for v1

Status: **implemented** (D1–D5 in the [v1 release plan](../v1-release-plan.md)). Owner decision (2026-09-27): all memory and context capabilities ship at v1. This spec is governed by [plan §13–14](../create-mayura-agentic-framework-plan.md).

## 1. Two memory profiles

| Profile | Constructor | Storage | Bounds | Use |
|---|---|---|---|---|
| Compact | `createMemoryStore` (existing) | any `AggregateStore`, one aggregate per scope | 128 lifetime record IDs, lexical search | tests, small agents, custom adapters |
| Native | `createNativeMemory` (new) | the `memory` capability of the SQLite/PostgreSQL stores | table-backed; tested at 50,000 records per scope | production |

Both implement `MemoryStore`. `NativeMemory` adds:

- supersession;
- graph edges and traversal;
- semantic and hybrid search;
- streamed import/export;
- a change feed.

The compact profile stays, because it runs over custom aggregate adapters that cannot host indexes.

## 2. Native storage capability (`store.memory`)

The storage layer adds a validated command/result contract in `mayura/storage-contracts`, like the other capabilities. It has one SQL implementation in `mayura/storage-sql`, which the SQLite worker and PostgreSQL adapters expose. Tables use the store prefix and are created idempotently under the schema lock. The storage schema version is unchanged, because these are new tables only.

- **Records** (`scope, id`): version, status (`active`/`superseded`/`deleted`), category, content, content hash, metadata, provenance, sensitivity, validity, timestamps, `superseded_by`. A tombstone keeps no content or provenance.
- **Terms** (`scope, term, record_id, frequency`): the lexical inverted index, maintained in the same transaction as the record.
- **Edges** (`scope, id`): from, to, relation, confidence, provenance, validity, version, status. Edges to deleted records are tombstoned in the same transaction as the deletion.
- **Vectors** (`scope, record_id, embedder_id`): record version, dimensions, IVF list, a little-endian Float32 vector (base64) and its norm. A write for a stale record version is rejected.
- **Centroids** (`scope, embedder_id, list`): the trained IVF index.
- **Changes** (`scope, sequence`): record/edge id, version, change kind. This is the cache-invalidation feed and the source for incremental export. It never holds content.

Every mutation is one transaction with a compare-and-set on the expected version. Reads filter by scope, status, sensitivity profile and validity **inside the query**, so ranking only ever sees authorized rows. Results are rechecked before return.

## 3. D1 — Import and export

- **Export.** `exportSnapshot({ cursor?, limit? })` returns `mayura.memory.export.v2` pages containing records, tombstones and edges, each with full provenance. It also returns a `nextCursor` and the change sequence the export is consistent with.
- **Import.** `importSnapshot(page, { mode })` applies records in order.
  - `mode: 'merge'` keeps the newer version of each ID and never resurrects a tombstone.
  - `mode: 'replace-empty'` requires an empty scope.
  - Import validates every entry before any write, preserves IDs, versions, timestamps, provenance and deletion markers, and re-derives terms. Vectors are re-embedded lazily; they are not trusted from the file.
  - A v1 compact export (`mayura.memory.export.v1`) imports as-is, which is the migration path between the two profiles.
- Round-trip compact to native to export to native must give identical canonical records.

## 4. D3 — Graph memory

- **Edges.**
  - `relate({ id, from, to, relation, confidence, provenance, validity? })` adds an edge; `correctEdge` and `forgetEdge` use the same compare-and-set as records.
  - Relation names are bounded identifiers.
  - Both endpoints must be active records in scope.
  - Inferred edges (`provenance.origin: 'inferred'`) are never promoted into instructions.
- **Traversal.** `neighbors(id, { relation?, direction?, limit? })` and `traverse(id, { maxDepth ≤ 4, maxNodes ≤ 256, relations? })` return bounded, authorized, validity-filtered subgraphs. They include the edges' own provenance, and exclude hidden records along with their edges.

## 5. D4 — Scalable native semantic index

- **Embedder adapter.** `{ id, dimensions, maxBatch, embed(texts, signal) }`.
  - Mayura ships `hashingEmbedder({ dimensions })`, which is local, deterministic, network-free and meant for tests and offline fallback.
  - `mayura/provider-openai` adds an authorized hosted embedding adapter.
  - Restricted records are never sent to a hosted embedder: the `embedSensitivities` profile defaults to `public`/`internal`.
- **Indexing.** `index({ limit })` embeds active records that have no current vector for the embedder, in batches under an explicit budget callback. Corrections and deletions remove stale vectors in the same transaction.
- **Search.** `semanticSearch(query, { limit, minScore?, nprobe? })` uses cosine similarity.
  - Below 2,048 vectors per scope and embedder, the scan is exact.
  - Above that, an IVF-flat index is trained by k-means++ on a bounded sample. It uses √n lists (capped at 1,024), is retrained when the count doubles, and is searched over `nprobe` lists (default 8) with exact reranking.
  - Every result reports `mode: 'exact' | 'ivf'`.
- **Hybrid search.** `hybridSearch` fuses lexical BM25 and semantic ranks by reciprocal-rank fusion.
- **Fallback.** Missing embedder support falls back to lexical search, with `limitation: 'semantic_unavailable'` visible in the result.

## 6. D2 — Context cache invalidation

`createContextCache({ maxEntries, ttlMs })` in `mayura/context` provides:

- `assemble(options)`, which returns a cached `ContextAssembly` only when the complete admission key matches: scope, policy version, `asOf`, the candidate and source-state digest, sensitivity profile, budget and estimator. Any change to a source revision changes the key.
- `invalidate({ scope?, sourceIds? })` for deletion, revocation and permission changes.
- `follow(memory)`, which consumes the native memory change feed and invalidates every entry that selected a changed record.
- Hooks still run on a cache hit, because a cached assembly is re-admitted, not trusted.
- Entries never outlive `ttlMs`.
- The cache holds assemblies, never generated answers or approvals.

## 7. D5 — Speculation

- **Branches.** `speculate(runtime, parent, { branches, verify, maxBranches ≤ 8 })` in `mayura/runtime` runs isolated child branches under the parent's shared budget. Each branch declares an `assumptions` JSON object, whose digest is recorded.
  - Branch permissions are the parent's grants minus every write, host, external, delegation and memory-write capability. A branch that needs one is rejected at admission, never silently narrowed.
  - The first branch to succeed and pass `verify({ assumptionsDigest, output })` against current inputs is promoted. All others are cancelled.
  - Nothing is promoted when verification fails.
  - Speculation is opt-in; nothing enables it automatically.
- **Context prefetch.** `cache.prefetch(options)` assembles in the background with bounded concurrency. The result is only used if a later `assemble` presents the identical admission key.

## 8. Tests required

Each capability needs:

- conformance on SQLite and PostgreSQL: scope isolation, sensitivity filtering before ranking, CAS conflicts, no tombstone resurrection by import or stale vector writes, and edge cleanup on deletion;
- an IVF recall check against exact search (recall@10 ≥ 0.9 at the default `nprobe`): 600 records in the conformance suite, and 20,000 vectors in the performance suite (F1);
- a 50,000-record load and query bound, in the performance suite (F1);
- cache invalidation on revision change, deletion and memory change;
- speculation permission stripping, loser cancellation, and no promotion on failed verification;
- packed consumer type checks.
