# Experimental native scoped memory

Status: first native-record slice; implements part of F10 and V13, not complete supermemory/context. Governing requirements: development-plan sections 13–14. No external service, embedding provider, paid call or new third-party dependency is introduced.

## Scope and public API

`createMemoryStore({ store, scope, permissions, allowedSensitivities? })` consumes an initialized `AggregateStore`. Scope requires a verified `principalId` and `projectId`. The constructor snapshots its policy; untrusted agents must never construct their own privileged service. It is not an authentication server.

The service provides `add`, `correct`, `forget`, `get`, `list`, `search` and `exportSnapshot`. It does not close the caller-owned store. Read operations never create a scope or mutate persistent state. The first admitted add initializes an empty scoped aggregate lazily.

Required grants are exact strings: `memory:read`, `memory:write`, `memory:delete`, `memory:export`. Export requires read plus export. Corrections/adds require write; forgetting requires delete. Sensitivity is one of public/internal/confidential/restricted; the default allowed profile is public/internal. Read, search, export and mutation enforce the configured profile. No scope-wide result is ranked before filtering by the effective scope and sensitivity. The service does not claim team ACLs or cross-project recall.

## Records and provenance

An active record includes stable ID, positive version, explicit scope, category, content, computed content SHA-256, metadata, sensitivity, created/updated timestamps, validity interval and mandatory provenance. Categories are fact/preference/decision/procedure/episode.

Provenance contains source ID, reference, opaque source revision, source SHA-256, author, observed-at timestamp, observed/inferred origin and confidence between zero and one. Source hashes/references are caller assertions from a trusted ingestion boundary; the memory store does not fetch a source or claim that a reference proves its truth. Inferred records remain inferred and never become instructions through retrieval. All timestamps are canonical UTC ISO strings.

`add` accepts a caller-selected bounded stable ID and complete record data. Reusing an existing ID conflicts, including IDs retained by tombstones. `correct` requires the current record version and a complete replacement body/provenance. It increments the version without changing ID/creation time. Each successful write is readable immediately from subsequent store-backed calls.

`forget({id, expectedVersion})` performs a versioned state replacement with a tombstone containing only identity/scope, version, sensitivity and created/updated/deleted times. It removes current content, content hash, metadata, validity and source provenance. Stale correction and repeated add cannot resurrect a tombstone. Tombstones are permanent in this slice; purge/reuse needs a future reviewed migration protocol.

Default get/list omit tombstones; explicit `includeDeleted` exposes only their minimal record. Scoped exports include permitted tombstones so downstream consumers can recognize deletion. Events contain only operation type, record ID/version—not original content, metadata or source references—so a forget operation does not leave retained plaintext copies in the framework event log.

Deletion is logical erasure from current canonical records and all public retrieval/export views. It is not secure physical erasure of database pages, WAL, backups, independent exports, caller-held objects or the original source artifact. Those require separate retention/backup/source ownership controls. No derived cache/index/provider copy exists in this implementation.

## Persistence and bounded scaling

One reserved aggregate per principal/project scope stores the canonical record map. The storage scope is a domain-separated SHA-256 of the validated principal/project pair; the aggregate also records the explicit pair for integrity checks. The source-of-truth store handles atomic snapshot+event updates.

This layout is deliberate because the current generic store supports get/CAS rather than authorized scans. It supplies real atomic deletion, scope isolation and same-scope concurrency without an inconsistent secondary index. It serializes scope writes and copies the bounded snapshot; it is not the production-scale storage/index architecture.

Hard limits: 128 lifetime record IDs per scope including tombstones; 768 KiB aggregate JSON; 4 KiB UTF-8 content; 2 KiB metadata with depth 8; bounded IDs/provenance/reference strings; at most 50 results per list/search page. Once a limit is reached, fail with `LIMIT_EXCEEDED` before mutation. Deleting does not reclaim identity capacity. Sharded records, scalable indexes, retention compaction and migration are future work, not hidden fallbacks.

Operation events contain no content but accumulate with mutations; event retention/compaction is not provided by this slice. Applications should use opaque IDs and apply a reviewed storage/backup retention policy before production deployment. Per-field validation failures use `INVALID_INPUT`; the aggregate/identity capacity failures use `LIMIT_EXCEEDED`.

Read-modify-write uses at most 32 bounded CAS attempts. Contention on an unrelated record reloads and reapplies the requested mutation. A changed target record version is a conflict, never an implicit last-writer-wins correction. Ambiguous storage failures are not retried automatically; inspect the stable record/version before retrying. Database exceptions remain sanitized by the adapter.

## Retrieval and export

List sorts IDs and uses a scope/revision-bound cursor. A changed snapshot invalidates the cursor with `CONFLICT`, preventing silent omissions across concurrent corrections/deletions. Caller mutations to returned JSON cannot change persistent state.

Search is explicitly `mode: lexical`: case-insensitive Unicode letter/number tokens from content only, all query tokens required, score equal to matching token occurrence counts, deterministic ID tie-break. Query bytes/terms and result counts are bounded. Expired/not-yet-valid records are excluded from search; direct authorized get/list remain inspection surfaces for retained records. No vector embeddings, semantic recall, fuzzy meaning, extraction, summarization or graph traversal is claimed.

Export produces a bounded scope/revision-stamped snapshot of currently authorized records/tombstones, with provenance intact for active records. Generic import, provider synchronization and backup restore are not implemented. A context adapter uses memory record ID/version as its current source identity/revision and retains original provenance separately under upstream evidence; observed evidence is not a trusted instruction. Correction changes that authoritative revision and deletion marks it deleted, so prior derived context is excluded. The V13 fixture JSON-round-trips an export into this mapping and proves exact upstream provenance is retained. A stale provider cannot resurrect a tombstone through `add` or `correct`; any future provider adapter must use these same versioned commands rather than a replacement-state write.

## Required conformance evidence

The same public service tests run on SQLite and PostgreSQL: scope/sensitivity denial before retrieval, exact provenance round-trip, read-your-writes and restart persistence, CAS correction races, tombstone no-resurrection, plaintext absence from current state/event/public export after forget, lexical—not semantic—matching, validity filtering, bounded values, stale cursor rejection and immutable returned snapshots. `packages/memory/test/release-gate-v13.test.ts` composes native memory with native context to prove derivative invalidation on correction/deletion, stale-sync no-resurrection and provenance-preserving export migration. These gates close V13 for the native bounded profile, not enterprise-scale semantic memory or an unimplemented external provider adapter.
